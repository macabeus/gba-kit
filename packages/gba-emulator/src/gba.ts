/**
 * GBA System Coordinator
 *
 * Wires up all subsystems and runs the main emulation loop.
 * The CPU runs until the next scheduled event, then the event fires
 * and may schedule further events.
 *
 * Execution is owned here, not by the CPU: timers, DMA, the PPU's scanline
 * chain, IRQ delivery and HALT all advance together. A debugger stops the
 * machine through `StopPredicate` — checked before each instruction and while
 * the CPU is halted — so a stop never charges a cycle for an instruction that
 * did not run, and the next `runFrame` finishes the same hardware frame.
 */
import { ArmCpu } from '@gba-kit/arm-emulator/arm-cpu';

import { Apu } from './apu/apu.js';
import { type BiosEnv, handleSwi } from './bios.js';
import { DmaController, type DmaTransferInfo } from './dma.js';
import { InputController } from './input.js';
import { InterruptController } from './interrupts.js';
import { Ppu } from './ppu/ppu.js';
import type { GbaSnapshot } from './savestate.js';
import { Scheduler } from './scheduler.js';
import { GbaSystemBus } from './system-bus.js';
import { TimerController } from './timers.js';
import {
  BIOS_IRQ_STUB_PUSH,
  BOOT_STACK_POINTERS,
  CYCLES_PER_SCANLINE,
  DmaStartTiming,
  EventId,
  GbaButton,
  HBLANK_CYCLES,
  HDRAW_CYCLES,
  IrqFlag,
  TOTAL_SCANLINES,
  VISIBLE_SCANLINES,
} from './types.js';
import { captureOrigin } from './write-source.js';

/** PPU rendering interface */
export interface PpuInterface {
  /** Render a single scanline */
  renderScanline(line: number, bus: GbaSystemBus): void;
  /** Called at VBlank start */
  onVBlank?(): void;
  /** Get the framebuffer */
  getFramebuffer(): Uint32Array;
  /** Reset */
  reset(): void;
}

/**
 * Asked before every instruction, and while the CPU is halted before advancing to
 * the next event. Return true to stop: the instruction at `armCpu.registers[15]`
 * has NOT executed and no cycle has been charged.
 */
export type StopPredicate = () => boolean;

/**
 * How a run ended:
 * - `done`: the requested extent (a frame, a scanline) completed;
 * - `stopped`: the predicate or a CPU debug hook stopped it first;
 * - `halted`: the CPU stopped itself at the sentinel return address and cannot continue;
 * - `stalled`: the CPU is halted and no event is scheduled to wake it.
 */
export type RunOutcome = 'done' | 'stopped' | 'halted' | 'stalled';

/**
 * A hardware event, delivered as it happens and carrying no timestamp: a sink that needs one
 * reads the machine's cycle, frame and scanline when it fires.
 */
export type HardwareEvent =
  | { kind: 'irq-request'; flag: number }
  | { kind: 'irq-enter'; pc: number }
  | { kind: 'dma'; channel: number; info: DmaTransferInfo }
  | { kind: 'mmio-write'; address: number; value: number; size: 1 | 2 | 4 }
  | { kind: 'vblank' }
  | { kind: 'hblank'; scanline: number }
  | { kind: 'halt' };

export class Gba {
  readonly scheduler: Scheduler;
  readonly interrupts: InterruptController;
  readonly timers: TimerController;
  readonly dma: DmaController;
  readonly input: InputController;
  readonly bus: GbaSystemBus;
  readonly ppu: Ppu;
  readonly apu: Apu;
  readonly armCpu: ArmCpu;

  #currentScanline = 0;
  #frameCount = 0;
  #running = false;
  /** Set when a `StopPredicate` or a CPU debug hook refused an instruction during the current run. */
  #stopped = false;
  /** Tracks whether the CPU is currently inside the BIOS IRQ handler */
  #inIrqHandler = false;
  readonly #biosEnv: BiosEnv;
  #eventSink: ((event: HardwareEvent) => void) | null = null;

  constructor() {
    this.scheduler = new Scheduler();
    this.interrupts = new InterruptController();
    this.timers = new TimerController(this.scheduler, this.interrupts);
    this.dma = new DmaController(this.scheduler, this.interrupts);
    this.input = new InputController(this.interrupts);
    this.bus = new GbaSystemBus();
    this.ppu = new Ppu();
    this.apu = new Apu();

    // Wire subsystem references
    this.bus.connect({
      interrupts: this.interrupts,
      timers: this.timers,
      dma: this.dma,
      input: this.input,
      apu: this.apu,
    });

    // Connect APU to timers for DirectSound FIFO playback
    this.apu.connectTimers(this.timers);
    // Connect APU to DMA for sound FIFO refills
    this.apu.connectDma(this.dma);

    // Wire PPU ref point reload: when the game writes BG2X/BG2Y/BG3X/BG3Y,
    // the PPU must reload its internal accumulators (for per-scanline affine effects).
    this.ppu.mmioRegisters = this.bus.mmioRegisters;
    this.bus.onBgRefPointWrite = (bgIndex, isX) => {
      this.ppu.reloadBgRefPoint(bgIndex, isX);
    };

    // DMA needs memory access through the bus
    this.dma.setMemoryAccess({
      read16: (addr) => this.bus.read16(addr),
      read32: (addr) => this.bus.read32(addr),
      write16: (addr, val) => this.bus.write16(addr, val),
      write32: (addr, val) => this.bus.write32(addr, val),
      // Data-watchpoint attribution for DMA writes (armCpu is created below; invoked during DMA).
      getOrigin: () => captureOrigin(this.armCpu.registers[15]!, this.armCpu.cpsr),
      setDmaSource: (channel, origin) => this.bus.setDmaSource(channel, origin),
      clearDmaSource: () => this.bus.clearDmaSource(),
    });

    // The HLE BIOS reaches this machine's interrupt controller and no other.
    this.#biosEnv = {
      onIntrWait: (flags) => {
        this.interrupts.intrWaitFlags = flags;
      },
    };

    // Create CPU with GBA BIOS SWI handler
    this.armCpu = new ArmCpu(this.bus, { swiHandler: (cpu, swiNumber) => handleSwi(cpu, swiNumber, this.#biosEnv) });
    for (const [mode, sp] of BOOT_STACK_POINTERS) {
      this.armCpu.setBankedSP(mode, sp);
    }

    // Install HLE BIOS IRQ handler stub
    this.#installBiosStub();

    // Schedule initial HBlank
    this.#scheduleHDraw();
  }

  /** Load a ROM into the system */
  loadRom(data: Uint8Array): void {
    this.bus.loadRom(data);
  }

  /** Press a button */
  pressButton(button: GbaButton): void {
    this.input.press(button);
  }

  /** Release a button */
  releaseButton(button: GbaButton): void {
    this.input.release(button);
  }

  /**
   * Observe hardware events (interrupt requests and entries, DMA transfers, I/O
   * writes, VBlank/HBlank, halts). One sink, or null to stop observing; the
   * subsystems' hooks stay unset when nobody listens so the hot paths pay nothing.
   */
  set onHardwareEvent(sink: ((event: HardwareEvent) => void) | null) {
    this.#eventSink = sink;
    this.interrupts.onRequest = sink ? (flag) => sink({ kind: 'irq-request', flag }) : null;
    this.dma.onTransfer = sink ? (channel, info) => sink({ kind: 'dma', channel, info }) : null;
    this.bus.onMmioWrite = sink ? (address, value, size) => sink({ kind: 'mmio-write', address, value, size }) : null;
  }

  get onHardwareEvent(): ((event: HardwareEvent) => void) | null {
    return this.#eventSink;
  }

  /** Hardware frames completed since reset (a frame ends when the scanline wraps to 0). */
  get frameCount(): number {
    return this.#frameCount;
  }

  /** The scanline the PPU is on (0–227; 160–227 is VBlank). */
  get scanline(): number {
    return this.#currentScanline;
  }

  /**
   * Run until the current hardware frame ends (the scanline wraps to 0), or until
   * `shouldStop` says so. After a stop, the next call finishes the SAME frame: frames
   * stay aligned to the hardware however often the debugger interrupts them.
   */
  runFrame(shouldStop?: StopPredicate): RunOutcome {
    const target = this.#frameCount + 1;
    return this.#run(() => this.#frameCount >= target, shouldStop);
  }

  /** Run until the PPU moves to the next scanline (or the frame ends), or until `shouldStop`. */
  runScanline(shouldStop?: StopPredicate): RunOutcome {
    const line = this.#currentScanline;
    const frame = this.#frameCount;
    return this.#run(() => this.#currentScanline !== line || this.#frameCount !== frame, shouldStop);
  }

  /** The emulation loop: advance the whole machine until `done`, `shouldStop`, or the CPU gives up. */
  #run(done: () => boolean, shouldStop?: StopPredicate): RunOutcome {
    this.#running = true;
    this.#stopped = false;
    let outcome: RunOutcome = 'done';

    while (this.#running && !done()) {
      // If halted, fast-forward to next event (but keep APU running)
      if (this.interrupts.halted) {
        if (shouldStop?.()) {
          outcome = 'stopped';
          break;
        }
        const skip = this.scheduler.cyclesUntilNextEvent();
        if (skip === Infinity) {
          outcome = 'stalled';
          break;
        }
        this.scheduler.tick(skip);
        this.apu.tick(skip);
        continue;
      }

      // Run CPU until next event
      const cyclesToNext = this.scheduler.cyclesUntilNextEvent();
      if (cyclesToNext === Infinity) {
        // No events scheduled — run a batch of CPU cycles
        this.#runCpuCycles(CYCLES_PER_SCANLINE, shouldStop);
      } else if (cyclesToNext <= 0) {
        // Events are due — process them
        this.scheduler.tick(0);
      } else {
        this.#runCpuCycles(cyclesToNext, shouldStop);
      }

      if (this.#stopped) {
        outcome = 'stopped';
        break;
      }
      if (!this.#running) {
        outcome = 'halted';
        break;
      }
    }

    this.#running = false;
    return outcome;
  }

  /** Run CPU for approximately the given number of cycles */
  #runCpuCycles(cycles: number, shouldStop?: StopPredicate): void {
    const cpu = this.armCpu;
    let cyclesRun = 0;

    while (cyclesRun < cycles) {
      // Check for pending IRQ before each instruction
      if (this.interrupts.irqPending()) {
        this.#handleIrq();
      }

      // If halted (e.g. by SWI Halt/VBlankIntrWait), stop running CPU
      // The outer loop will fast-forward to the next event
      if (this.interrupts.halted) {
        this.#eventSink?.({ kind: 'halt' });
        break;
      }

      // The debugger's turn: the instruction at PC has not run and costs nothing.
      if (shouldStop?.()) {
        this.#stopped = true;
        break;
      }

      // Track PC before step to detect BIOS IRQ handler return
      let pcBeforeStep = 0;
      if (this.#inIrqHandler) {
        pcBeforeStep = cpu.registers[15]!;
      }

      const ok = cpu.step();
      if (!ok) {
        // Either the CPU halted itself, or a debug hook refused the instruction. In
        // both cases nothing executed, so nothing is charged.
        if (cpu.halted) {
          this.#running = false;
        } else {
          this.#stopped = true;
        }
        break;
      }
      cyclesRun += 1;

      // Detect BIOS IRQ handler return: the SUBS PC, LR, #4 at address 0x94
      // returns from IRQ mode to the interrupted context. After this executes,
      // we check if we need to re-halt for IntrWait (matching real BIOS behavior
      // where the IntrWait loop re-halts after each non-matching interrupt).
      if (this.#inIrqHandler && pcBeforeStep === 0x94) {
        this.#inIrqHandler = false;

        if (this.interrupts.intrWaitFlags !== 0) {
          const biosIf = this.bus.read16(0x03007ff8);
          if (biosIf & this.interrupts.intrWaitFlags) {
            // IntrWait satisfied — clear flags and let game code continue
            this.bus.write16(0x03007ff8, biosIf & ~this.interrupts.intrWaitFlags);
            this.interrupts.intrWaitFlags = 0;
          } else {
            // Not satisfied — re-halt (IntrWait loop continues waiting)
            this.interrupts.halted = true;
            break;
          }
        }
      }
    }

    // Advance the scheduler clock and APU
    this.scheduler.tick(cyclesRun);
    this.apu.tick(cyclesRun);
  }

  /** Handle an IRQ by switching the CPU to the IRQ handler */
  #handleIrq(): void {
    // Don't fire if CPU has IRQs disabled (CPSR I bit)
    if (this.armCpu.irqDisabled()) {
      return;
    }

    // Update BIOS IF mirror at 0x03007FF8 before entering the handler.
    // This matches real GBA BIOS behavior: the BIOS reads IE & IF, ANDs them,
    // and ORs the result into the mirror. The user handler may then acknowledge
    // IF, but the mirror preserves which interrupts actually fired.
    // IntrWait checks this mirror to decide when the waited interrupt has occurred.
    const pending = this.interrupts.ie & this.interrupts.if_;
    const currentMirror = this.bus.read16(0x03007ff8);
    this.bus.write16(0x03007ff8, currentMirror | pending);

    this.#inIrqHandler = true;
    this.#eventSink?.({ kind: 'irq-enter', pc: this.armCpu.registers[15]! });
    this.armCpu.enterIrq();
  }

  // ─── Scanline Timing ──────────────────────────────────────────────

  #scheduleHDraw(): void {
    // Render the scanline at the START of HDraw (not at HBlank).
    // On real GBA, the PPU reads VRAM during HDraw. Games write sprite tile
    // data during HBlank/VBlank and may clear it during HDraw (expecting the
    // PPU to have already consumed it). Rendering here ensures the PPU sees
    // the correct VRAM state before the CPU can modify it.
    if (this.#currentScanline < VISIBLE_SCANLINES) {
      this.ppu.renderScanline(this.#currentScanline, this.bus);
    }

    this.scheduler.schedule(EventId.HBlank, HDRAW_CYCLES, () => {
      this.#onHBlank();
    });
  }

  #onHBlank(): void {
    this.#eventSink?.({ kind: 'hblank', scanline: this.#currentScanline });
    // Set HBlank flag in DISPSTAT
    const dispstat = this.bus.mmioRegisters[4]! | (this.bus.mmioRegisters[5]! << 8);
    this.bus.mmioRegisters[4] = (dispstat | 0x02) & 0xff; // Set HBlank bit

    // HBlank IRQ
    if (dispstat & (1 << 4)) {
      this.interrupts.requestInterrupt(IrqFlag.HBlank);
    }

    // HBlank DMA (PPU already rendered at the start of HDraw)
    if (this.#currentScanline < VISIBLE_SCANLINES) {
      this.dma.trigger(DmaStartTiming.HBlank);
    }

    // Schedule end of HBlank
    this.scheduler.schedule(EventId.HBlankEnd, HBLANK_CYCLES, () => {
      this.#onHBlankEnd();
    });
  }

  #onHBlankEnd(): void {
    // Clear HBlank flag
    this.bus.mmioRegisters[4] = this.bus.mmioRegisters[4]! & ~0x02;

    // Advance scanline
    this.#currentScanline++;

    // Update VCOUNT
    this.bus.mmioRegisters[6] = this.#currentScanline & 0xff;

    // Check VCount match
    const dispstat = this.bus.mmioRegisters[4]! | (this.bus.mmioRegisters[5]! << 8);
    const vcountTarget = (dispstat >> 8) & 0xff;
    if (this.#currentScanline === vcountTarget) {
      // Set VCount flag
      this.bus.mmioRegisters[4] = this.bus.mmioRegisters[4]! | 0x04;
      if (dispstat & (1 << 5)) {
        this.interrupts.requestInterrupt(IrqFlag.VCount);
      }
    } else {
      this.bus.mmioRegisters[4] = this.bus.mmioRegisters[4]! & ~0x04;
    }

    if (this.#currentScanline === VISIBLE_SCANLINES) {
      // Enter VBlank
      this.#onVBlankStart();
    } else if (this.#currentScanline >= TOTAL_SCANLINES) {
      // End of frame — wrap back to scanline 0
      this.#currentScanline = 0;
      this.bus.mmioRegisters[6] = 0;
      this.#frameCount++;
      // Clear VBlank flag
      this.bus.mmioRegisters[4] = this.bus.mmioRegisters[4]! & ~0x01;
    }

    // Schedule next HDraw
    this.#scheduleHDraw();
  }

  #onVBlankStart(): void {
    this.#eventSink?.({ kind: 'vblank' });
    // Set VBlank flag in DISPSTAT
    this.bus.mmioRegisters[4] = this.bus.mmioRegisters[4]! | 0x01;

    // VBlank IRQ
    const dispstat = this.bus.mmioRegisters[4]! | (this.bus.mmioRegisters[5]! << 8);
    if (dispstat & (1 << 3)) {
      this.interrupts.requestInterrupt(IrqFlag.VBlank);
    }

    // Trigger VBlank DMA
    this.dma.trigger(DmaStartTiming.VBlank);

    // Notify PPU
    this.ppu.onVBlank?.();
  }

  // ─── Save State ─────────────────────────────────────────────────

  /** Serialize the entire emulator state to a snapshot. */
  serialize(): GbaSnapshot {
    return {
      version: 1,
      cpu: this.armCpu.serialize(),
      currentScanline: this.#currentScanline,
      frameCount: this.#frameCount,
      inIrqHandler: this.#inIrqHandler,
      scheduler: this.scheduler.serialize(),
      interrupts: this.interrupts.serialize(),
      timers: this.timers.serialize(),
      dma: this.dma.serialize(),
      input: this.input.serialize(),
      bus: this.bus.serialize(),
      ppu: (this.ppu as Ppu).serialize(),
      apu: this.apu.serialize(),
    };
  }

  /**
   * Restore from a snapshot. ROM/BIOS must already be loaded.
   *
   * Scheduled events come back at exactly the cycles the snapshot recorded — only
   * their callbacks (which cannot be serialized) are reattached. Running K frames
   * from a restored snapshot therefore yields the same machine as running K frames
   * from the original — what replay-based rewind relies on.
   */
  deserialize(snap: GbaSnapshot): void {
    this.#running = false;
    this.#stopped = false;
    this.#currentScanline = snap.currentScanline;
    this.#frameCount = snap.frameCount ?? 0;
    this.#inIrqHandler = snap.inIrqHandler;

    // Restore subsystems
    this.interrupts.deserialize(snap.interrupts);
    this.input.deserialize(snap.input);
    this.scheduler.deserialize(snap.scheduler);
    this.timers.deserialize(snap.timers);
    this.dma.deserialize(snap.dma);
    this.bus.deserialize(snap.bus);
    this.ppu.deserialize(snap.ppu);
    if (snap.apu) {
      this.apu.deserialize(snap.apu);
    }

    // Restore CPU state
    if (snap.cpu) {
      this.armCpu.deserialize(snap.cpu);
    }

    this.#reattachSchedulerCallbacks();
  }

  /** Give every pending event its callback back, without moving it. */
  #reattachSchedulerCallbacks(): void {
    if (this.scheduler.isScheduled(EventId.HBlank)) {
      this.scheduler.reattach(EventId.HBlank, () => this.#onHBlank());
    }
    if (this.scheduler.isScheduled(EventId.HBlankEnd)) {
      this.scheduler.reattach(EventId.HBlankEnd, () => this.#onHBlankEnd());
    }
    this.timers.reattachEvents();
    this.dma.reattachEvents();
  }

  /** Stop emulation */
  stop(): void {
    this.#running = false;
  }

  /** Reset the entire system */
  reset(): void {
    this.#running = false;
    this.#stopped = false;
    this.#currentScanline = 0;
    this.#frameCount = 0;
    this.#inIrqHandler = false;
    this.scheduler.reset();
    this.interrupts.reset();
    this.timers.reset();
    this.dma.reset();
    this.input.reset();
    this.bus.reset();
    this.ppu.reset();
    this.apu.reset();
    this.#installBiosStub();
    this.#scheduleHDraw();
  }

  /**
   * Install a minimal HLE BIOS stub.
   *
   * Matches the real GBA BIOS IRQ handler behavior:
   * The BIOS just saves registers, calls the user handler from [0x03FFFFFC],
   * restores registers, and returns. It does NOT acknowledge IF or update
   * the BIOS IF mirror — the game's own IRQ handler is responsible for that.
   *
   * SWI handler at 0x08: handled in HLE (bios.ts), but we need a
   * return path. The SWI handler just needs MOVS PC, LR to return.
   */
  #installBiosStub(): void {
    // ─── UND handler (at 0x04) ─────────────────────────────────────
    this.bus.writeBios32(0x04, 0xe1b0f00e); // MOVS PC, LR

    // ─── SWI handler (at 0x08) ─────────────────────────────────────
    this.bus.writeBios32(0x08, 0xe1b0f00e); // MOVS PC, LR

    // ─── IRQ vector (at 0x18) ────────────────────────────────────
    // B 0x80: offset = (0x80 - 0x18 - 8) / 4 = 0x18
    this.bus.writeBios32(0x18, 0xea000018); // B 0x80

    // ─── IRQ handler (at 0x80) ───────────────────────────────────
    // Matches real GBA BIOS (and mGBA's HLE stub): save regs, call user
    // handler via LDR PC, restore, return. The BIOS does NOT acknowledge
    // IF or update the BIOS IF mirror — that's the user handler's job.
    // 0x80: STMFD SP!, {R0-R3, R12, LR}   — save regs to IRQ stack
    this.bus.writeBios32(0x80, BIOS_IRQ_STUB_PUSH);
    // 0x84: MOV R0, #0x04000000            — IO register base
    this.bus.writeBios32(0x84, 0xe3a00301);
    // 0x88: ADD LR, PC, #0                 — LR = 0x88+8 = 0x90 (return point)
    this.bus.writeBios32(0x88, 0xe28fe000);
    // 0x8C: LDR PC, [R0, #-4]             — PC = [0x03FFFFFC] = user handler
    this.bus.writeBios32(0x8c, 0xe510f004);
    // — user handler returns here (0x90) —
    // 0x90: LDMFD SP!, {R0-R3, R12, LR}   — restore regs from IRQ stack
    this.bus.writeBios32(0x90, 0xe8bd500f);
    // 0x94: SUBS PC, LR, #4               — return from IRQ, restore CPSR
    this.bus.writeBios32(0x94, 0xe25ef004);
  }
}
