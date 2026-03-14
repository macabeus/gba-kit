/**
 * GBA Emulator Bridge
 *
 * Wraps the GBA emulator for browser use.
 * Manages the emulation loop, screen rendering, and keyboard input.
 */
import type { DebugHooks } from '@gba-kit/arm-emulator';
import { ArmCpu } from '@gba-kit/arm-emulator/arm-cpu';
import { disassembleArm, disassembleThumb } from '@gba-kit/arm-emulator/disassembler';
import { Gba } from '@gba-kit/gba-emulator';
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';

/** Keyboard mapping: key → GBA button bit */
const KEY_MAP: Record<string, number> = {
  ArrowRight: 4,
  ArrowLeft: 5,
  ArrowUp: 6,
  ArrowDown: 7,
  z: 0, // A
  x: 1, // B
  Backspace: 2, // Select
  Enter: 3, // Start
  a: 8, // R
  s: 9, // L
};

export type EmulatorState = 'idle' | 'running' | 'paused';

export interface Breakpoint {
  address: number;
  enabled: boolean;
}

export interface EmulatorCallbacks {
  onStateChange: (state: EmulatorState) => void;
  onFrame: () => void;
  onBreakpoint: (address: number) => void;
}

export class EmulatorBridge {
  #gba = new Gba();
  #ctx: CanvasRenderingContext2D | null = null;
  #state: EmulatorState = 'idle';
  #animFrameId = 0;
  #callbacks: EmulatorCallbacks | null = null;
  #breakpoints: Map<number, Breakpoint> = new Map();
  #hitBreakpoint = false;

  /** Persistent framebuffer image, always up-to-date with the last rendered frame.
   *  Decoupled from any DOM canvas so mode switches never lose the current frame. */
  readonly #framebufferImage = new ImageData(240, 160);

  // Audio output
  #audioCtx: AudioContext | null = null;
  #audioNode: ScriptProcessorNode | null = null;
  #audioEnabled = false;

  constructor() {}

  get gba(): Gba {
    return this.#gba;
  }

  get cpu(): ArmCpu {
    return this.#gba.armCpu;
  }

  get state(): EmulatorState {
    return this.#state;
  }

  /** Attach callbacks for state updates */
  setCallbacks(callbacks: EmulatorCallbacks): void {
    this.#callbacks = callbacks;
  }

  /** Attach a canvas element for rendering. Immediately shows the last frame. */
  attachCanvas(canvas: HTMLCanvasElement): void {
    canvas.width = 240;
    canvas.height = 160;
    this.#ctx = canvas.getContext('2d')!;
    // Immediately blit the persistent framebuffer so the canvas is never blank
    this.#ctx.putImageData(this.#framebufferImage, 0, 0);
  }

  /** Detach the current canvas (call when a view unmounts) */
  detachCanvas(): void {
    this.#ctx = null;
  }

  /** Load a ROM from an ArrayBuffer */
  loadRom(data: ArrayBuffer): void {
    this.stop();
    this.#gba.reset();
    this.#gba.loadRom(new Uint8Array(data));

    const cpu = this.#gba.armCpu;

    // Set up initial CPU state matching post-BIOS boot:
    // The GBA BIOS normally initializes stacks and then jumps to ROM.
    // Since we skip the BIOS, we replicate the post-boot state.

    // Set up IRQ mode stack pointer
    cpu.switchMode(0x12); // MODE_IRQ
    cpu.registers[13] = 0x03007fa0;

    // Set up SVC mode stack pointer
    cpu.switchMode(0x13); // MODE_SVC
    cpu.registers[13] = 0x03007fe0;

    // Switch to System mode (privileged, but uses USR registers)
    cpu.switchMode(0x1f); // MODE_SYS

    // Set USR/SYS stack pointer
    cpu.registers[13] = 0x03007f00;

    // Enable IRQs (clear I bit), keep FIQ disabled, System mode
    // CPSR: 0x1F (SYS mode) with I=0, F=0, T=0 (ARM state initially)
    cpu.cpsr = 0x1f; // SYS mode, IRQs enabled, ARM state

    // PC to ROM entry point
    cpu.registers[15] = 0x08000000;

    // Read the ROM header to determine entry mode
    // GBA ROMs start with an ARM branch instruction at 0x08000000
    // The branch usually jumps to Thumb code, but the entry is always ARM

    this.#setState('paused');
  }

  /** Start/resume emulation */
  run(): void {
    if (this.#state === 'running') {
      return;
    }
    this.#setState('running');
    this.#hitBreakpoint = false;

    // Install breakpoint hooks if any breakpoints are set
    this.#updateDebugHooks();

    this.#emulationLoop();
  }

  /** Pause emulation */
  pause(): void {
    if (this.#state !== 'running') {
      return;
    }
    cancelAnimationFrame(this.#animFrameId);
    this.#setState('paused');
  }

  /** Stop emulation and reset */
  stop(): void {
    cancelAnimationFrame(this.#animFrameId);
    this.disableAudio();
    this.#setState('idle');
  }

  /** Execute a single CPU instruction */
  stepInstruction(): void {
    if (this.#state !== 'paused') {
      return;
    }
    this.#gba.armCpu.step();
    this.#gba.scheduler.tick(1);
    this.#gba.apu.tick(1);
    this.#renderFrame();
    this.#callbacks?.onFrame();
  }

  /** Run a single emulation frame and render to the attached canvas. */
  runOneFrame(): void {
    this.#gba.runFrame();
    this.#renderFrame();
    this.#callbacks?.onFrame();
  }

  /** Step over: run until PC advances past the current instruction */
  stepOver(): void {
    if (this.#state !== 'paused') {
      return;
    }
    const currentPC = this.#gba.armCpu.registers[15]!;
    const instrSize = this.#gba.armCpu.getT() ? 2 : 4;
    const targetPC = currentPC + instrSize;

    // Run until we reach the next instruction or hit a breakpoint
    let cyclesRun = 0;
    for (let i = 0; i < 100_000; i++) {
      this.#gba.armCpu.step();
      this.#gba.scheduler.tick(1);
      cyclesRun++;
      if (this.#gba.armCpu.registers[15]! === targetPC) {
        break;
      }
      if (this.#breakpoints.has(this.#gba.armCpu.registers[15]!)) {
        break;
      }
    }
    this.#gba.apu.tick(cyclesRun);

    this.#renderFrame();
    this.#callbacks?.onFrame();
  }

  /** Run until a specific address is reached */
  runToAddress(address: number): void {
    if (this.#state !== 'paused') {
      return;
    }
    let cyclesRun = 0;
    for (let i = 0; i < 10_000_000; i++) {
      this.#gba.armCpu.step();
      this.#gba.scheduler.tick(1);
      cyclesRun++;
      if (this.#gba.armCpu.registers[15]! === address) {
        break;
      }
    }
    this.#gba.apu.tick(cyclesRun);
    this.#renderFrame();
    this.#callbacks?.onFrame();
  }

  // ─── Breakpoints ──────────────────────────────────────────────────

  addBreakpoint(address: number): void {
    this.#breakpoints.set(address, { address, enabled: true });
    this.#updateDebugHooks();
  }

  removeBreakpoint(address: number): void {
    this.#breakpoints.delete(address);
    this.#updateDebugHooks();
  }

  toggleBreakpoint(address: number): void {
    const bp = this.#breakpoints.get(address);
    if (bp) {
      bp.enabled = !bp.enabled;
    }
    this.#updateDebugHooks();
  }

  getBreakpoints(): Breakpoint[] {
    return Array.from(this.#breakpoints.values());
  }

  // ─── Disassembly ──────────────────────────────────────────────────

  /** Disassemble instructions around the given address */
  disassembleAt(address: number, count: number): Array<{ address: number; mnemonic: string; isThumb: boolean }> {
    const result: Array<{ address: number; mnemonic: string; isThumb: boolean }> = [];
    const isThumb = this.#gba.armCpu.getT();
    let addr = address;

    for (let i = 0; i < count; i++) {
      if (isThumb) {
        const instr = this.#gba.bus.read16(addr);
        result.push({ address: addr, mnemonic: disassembleThumb(instr, addr), isThumb: true });
        addr += 2;
      } else {
        const instr = this.#gba.bus.read32(addr);
        result.push({ address: addr, mnemonic: disassembleArm(instr, addr), isThumb: false });
        addr += 4;
      }
    }

    return result;
  }

  // ─── Keyboard Input ───────────────────────────────────────────────

  handleKeyDown(e: KeyboardEvent): void {
    const button = KEY_MAP[e.key];
    if (button !== undefined) {
      e.preventDefault();
      this.#gba.input.press(button);
    }
  }

  handleKeyUp(e: KeyboardEvent): void {
    const button = KEY_MAP[e.key];
    if (button !== undefined) {
      e.preventDefault();
      this.#gba.input.release(button);
    }
  }

  // ─── Audio ──────────────────────────────────────────────────────────

  /** Whether audio output is currently enabled */
  get audioEnabled(): boolean {
    return this.#audioEnabled;
  }

  /** Enable audio output. Creates an AudioContext on first call (requires user gesture). */
  enableAudio(): void {
    if (this.#audioEnabled) {
      return;
    }

    if (!this.#audioCtx) {
      this.#audioCtx = new AudioContext({ sampleRate: 32768 });
      // ScriptProcessorNode: pulls samples from the APU ring buffer
      this.#audioNode = this.#audioCtx.createScriptProcessor(2048, 0, 2);
      this.#audioNode.onaudioprocess = (e) => {
        const left = e.outputBuffer.getChannelData(0);
        const right = e.outputBuffer.getChannelData(1);
        const interleaved = new Float32Array(left.length * 2);
        this.#gba.apu.readSamples(interleaved);
        for (let i = 0; i < left.length; i++) {
          left[i] = interleaved[i * 2]!;
          right[i] = interleaved[i * 2 + 1]!;
        }
      };
    }

    this.#audioNode!.connect(this.#audioCtx.destination);
    if (this.#audioCtx.state === 'suspended') {
      this.#audioCtx.resume();
    }
    this.#audioEnabled = true;
  }

  /** Disable audio output (mute). The AudioContext is kept alive for quick re-enable. */
  disableAudio(): void {
    if (!this.#audioEnabled) {
      return;
    }
    this.#audioNode?.disconnect();
    this.#audioEnabled = false;
  }

  /** Toggle audio on/off. Returns the new state. */
  toggleAudio(): boolean {
    if (this.#audioEnabled) {
      this.disableAudio();
    } else {
      this.enableAudio();
    }
    return this.#audioEnabled;
  }

  // ─── Memory Access ────────────────────────────────────────────────

  readMemory(address: number, size: number): Uint8Array {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      data[i] = this.#gba.bus.read8(address + i);
    }
    return data;
  }

  // ─── Save States ────────────────────────────────────────────────

  /** Create a snapshot of the current emulator state plus a thumbnail. */
  async saveState(): Promise<{ snapshot: GbaSnapshot; thumbnail: Blob }> {
    const wasRunning = this.#state === 'running';
    if (wasRunning) {
      this.pause();
    }

    // Serialize GBA state
    const snapshot = this.#gba.serialize();
    // Serialize CPU into the snapshot
    snapshot.cpu = this.#gba.armCpu.serialize();

    // Generate thumbnail (60x40)
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 60;
    thumbCanvas.height = 40;
    const thumbCtx = thumbCanvas.getContext('2d')!;

    // Create a temporary canvas with the full framebuffer to scale from
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = 240;
    srcCanvas.height = 160;
    const srcCtx = srcCanvas.getContext('2d')!;
    srcCtx.putImageData(this.#framebufferImage, 0, 0);

    thumbCtx.imageSmoothingEnabled = false;
    thumbCtx.drawImage(srcCanvas, 0, 0, 60, 40);

    const thumbnail = await new Promise<Blob>((resolve) => {
      thumbCanvas.toBlob((blob) => resolve(blob!), 'image/png');
    });

    return { snapshot, thumbnail };
  }

  /** Load a snapshot, restoring the full emulator state. */
  loadState(snapshot: GbaSnapshot): void {
    cancelAnimationFrame(this.#animFrameId);

    // Restore GBA subsystems
    this.#gba.deserialize(snapshot);
    // Restore CPU
    this.#gba.armCpu.deserialize(snapshot.cpu);

    // Re-render frame from restored framebuffer
    this.#renderFrame();
    this.#callbacks?.onFrame();

    this.#setState('paused');
  }

  // ─── Internal ─────────────────────────────────────────────────────

  #emulationLoop = (): void => {
    if (this.#state !== 'running') {
      return;
    }

    this.#gba.runFrame();
    this.#renderFrame();
    this.#callbacks?.onFrame();

    if (this.#hitBreakpoint) {
      this.#setState('paused');
      this.#callbacks?.onBreakpoint(this.#gba.armCpu.registers[15]!);
      return;
    }

    this.#animFrameId = requestAnimationFrame(this.#emulationLoop);
  };

  #renderFrame(): void {
    const framebuffer = this.#gba.ppu.getFramebuffer();
    const pixels = new Uint8ClampedArray(this.#framebufferImage.data.buffer);

    // Copy ABGR framebuffer to RGBA ImageData (always update the persistent buffer)
    for (let i = 0; i < 240 * 160; i++) {
      const abgr = framebuffer[i]!;
      const offset = i * 4;
      pixels[offset] = abgr & 0xff; // R
      pixels[offset + 1] = (abgr >> 8) & 0xff; // G
      pixels[offset + 2] = (abgr >> 16) & 0xff; // B
      pixels[offset + 3] = (abgr >> 24) & 0xff; // A
    }

    // Blit to the attached canvas if one exists
    this.#ctx?.putImageData(this.#framebufferImage, 0, 0);
  }

  #setState(state: EmulatorState): void {
    this.#state = state;
    this.#callbacks?.onStateChange(state);
  }

  #updateDebugHooks(): void {
    const hasBreakpoints = Array.from(this.#breakpoints.values()).some((bp) => bp.enabled);

    if (hasBreakpoints) {
      const hooks: DebugHooks = {
        onInstructionPre: (address: number) => {
          const bp = this.#breakpoints.get(address);
          if (bp?.enabled) {
            this.#hitBreakpoint = true;
            return 'break';
          }
          return 'continue';
        },
      };
      this.#gba.armCpu.setDebugHooks(hooks);
    } else {
      this.#gba.armCpu.setDebugHooks(undefined);
    }
  }
}
