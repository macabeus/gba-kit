/**
 * GBA Scripting Engine
 *
 * Platform-agnostic scripting API for driving the GBA emulator.
 * Takes a ScriptingHost interface for I/O operations (file writes, logging).
 * Both web and Node.js consumers provide their own ScriptingHost implementation.
 */
import { disassembleArm, disassembleThumb } from '@gba-kit/arm-emulator/disassembler';

import { Gba } from './gba.js';
import type { CpuSnapshot, GbaSnapshot } from './savestate.js';
import { GbaButton } from './types.js';
import { captureOrigin } from './write-source.js';

// ─── ScriptingHost Interface ─────────────────────────────────────────

/** Platform-specific I/O adapter for the scripting engine */
export interface ScriptingHost {
  writeScreenshot(name: string, rgbaData: Uint8Array, width: number, height: number): Promise<void>;
  writeMemorySnapshot(name: string, data: Record<string, unknown>): Promise<void>;
  writeSaveState(name: string, snapshot: GbaSnapshot): Promise<void>;
  readSaveState(path: string): Promise<GbaSnapshot>;
  log(message: string): void;
}

// ─── Button Name Mapping ─────────────────────────────────────────────

const BUTTON_MAP: Record<string, GbaButton> = {
  a: GbaButton.A,
  b: GbaButton.B,
  select: GbaButton.Select,
  start: GbaButton.Start,
  right: GbaButton.Right,
  left: GbaButton.Left,
  up: GbaButton.Up,
  down: GbaButton.Down,
  r: GbaButton.R,
  l: GbaButton.L,
};

type ButtonName = 'a' | 'b' | 'select' | 'start' | 'right' | 'left' | 'up' | 'down' | 'r' | 'l';

function resolveButton(name: string): GbaButton {
  const button = BUTTON_MAP[name.toLowerCase()];
  if (button === undefined) {
    throw new Error(`Unknown button: "${name}". Valid buttons: ${Object.keys(BUTTON_MAP).join(', ')}`);
  }
  return button;
}

// ─── Wait Condition Types ────────────────────────────────────────────

interface WaitFrames {
  frames: number;
}

interface WaitMemory {
  memory: {
    address: number;
    equals?: number;
    lessThan?: number;
    greaterThan?: number;
    bitSet?: number;
  };
  timeout?: number;
}

interface WaitPC {
  pc: number;
  timeout?: number;
}

interface WaitPixel {
  pixel: {
    x: number;
    y: number;
    r: number;
    g: number;
    b: number;
  };
  timeout?: number;
}

type WaitCondition = WaitFrames | WaitMemory | WaitPC | WaitPixel;

// ─── Memory Snapshot Types ───────────────────────────────────────────

interface MemorySnapshotRegion {
  name: string;
  region: 'iwram' | 'ewram' | 'vram' | 'oam' | 'palette' | 'io' | 'sram';
}

interface MemorySnapshotRange {
  name: string;
  address: number;
  length: number;
}

type MemorySnapshotOptions = MemorySnapshotRegion | MemorySnapshotRange;

// ─── Assert Types ────────────────────────────────────────────────────

interface AssertMemory {
  memory: {
    address: number;
    equals: number;
  };
}

interface AssertRegister {
  register: {
    name: string;
    equals: number;
  };
}

type AssertCondition = AssertMemory | AssertRegister;

// ─── Recording Types ────────────────────────────────────────────────

interface RecordingState {
  name: string;
  interval: number;
  columns: number;
  frameCounter: number;
  frames: Uint32Array[];
}

/**
 * A recorded write captured by a data watchpoint. For a `dma*` source, `pc` /
 * `instructionAddress` refer to the instruction that started the DMA.
 */
export interface WatchHit {
  /** CPU PC (pipeline-ahead of the instruction). */
  pc: number;
  /** Address of the responsible instruction (pc-2 in Thumb, pc-4 in ARM). */
  instructionAddress: number;
  /** The watched byte that was written. */
  address: number;
  /** Value committed, masked to the access size. */
  value: number;
  /** Access size in bytes (1, 2 or 4). */
  size: number;
  thumb: boolean;
  source: 'cpu' | 'dma0' | 'dma1' | 'dma2' | 'dma3';
}

// ─── Scripting Engine ────────────────────────────────────────────────

export class ScriptingEngine {
  readonly #gba: Gba;
  readonly #host: ScriptingHost;
  #actionsExecuted = 0;
  #recording: RecordingState | null = null;
  #onFrameCallback: ((frame: number) => void) | null = null;
  #frameCount = 0;
  /** Disposers for watchpoints created via this engine (so clearWatchpoints() only clears ours). */
  readonly #watchDisposers = new Set<() => void>();

  /** CPU interface — set externally since Gba doesn't expose full CPU */
  cpuRegisters: Uint32Array | undefined;
  cpuCpsr: (() => number) | undefined;
  cpuSerialize: (() => CpuSnapshot) | undefined;
  cpuDeserialize: ((snapshot: CpuSnapshot) => void) | undefined;

  constructor(gba: Gba, host: ScriptingHost) {
    this.#gba = gba;
    this.#host = host;
  }

  get actionsExecuted(): number {
    return this.#actionsExecuted;
  }

  /** Runs one frame, fires hooks, and captures if recording */
  #runFrame(): void {
    this.#gba.runFrame();
    this.#frameCount++;
    if (this.#recording) {
      this.#recording.frameCounter++;
      if (this.#recording.frameCounter % this.#recording.interval === 0) {
        this.#recording.frames.push(new Uint32Array(this.#gba.ppu.getFramebuffer()));
      }
    }
    if (this.#onFrameCallback) {
      this.#onFrameCallback(this.#frameCount);
    }
  }

  // ─── Timing / Flow Control ───────────────────────────────────────

  async wait(condition: WaitCondition): Promise<void> {
    this.#actionsExecuted++;

    if ('frames' in condition) {
      for (let i = 0; i < condition.frames; i++) {
        this.#runFrame();
      }
      return;
    }

    const timeout = condition.timeout ?? 600;

    if ('memory' in condition) {
      const { address, equals, lessThan, greaterThan, bitSet } = condition.memory;
      for (let i = 0; i < timeout; i++) {
        this.#runFrame();
        const value = this.#gba.bus.read8(address);
        if (equals !== undefined && value === equals) {
          return;
        }
        if (lessThan !== undefined && value < lessThan) {
          return;
        }
        if (greaterThan !== undefined && value > greaterThan) {
          return;
        }
        if (bitSet !== undefined && (value & bitSet) !== 0) {
          return;
        }
      }
      throw new Error(`wait({ memory }) timed out after ${timeout} frames at address 0x${address.toString(16)}`);
    }

    if ('pc' in condition) {
      const targetPC = condition.pc;
      for (let i = 0; i < timeout; i++) {
        this.#runFrame();
        if (this.#gba.armCpu.registers[15] === targetPC) {
          return;
        }
      }
      throw new Error(`wait({ pc }) timed out after ${timeout} frames waiting for PC=0x${condition.pc.toString(16)}`);
    }

    if ('pixel' in condition) {
      const { x, y, r, g, b } = condition.pixel;
      const framebuffer = this.#gba.ppu.getFramebuffer();
      for (let i = 0; i < timeout; i++) {
        this.#runFrame();
        const abgr = framebuffer[y * 240 + x]!;
        if ((abgr & 0xff) === r && ((abgr >> 8) & 0xff) === g && ((abgr >> 16) & 0xff) === b) {
          return;
        }
      }
      throw new Error(
        `wait({ pixel }) timed out after ${timeout} frames at (${x}, ${y}) waiting for rgb(${r}, ${g}, ${b})`,
      );
    }
  }

  // ─── Input ───────────────────────────────────────────────────────

  async press(buttons: ButtonName | ButtonName[], options?: { hold?: number }): Promise<void> {
    this.#actionsExecuted++;

    const buttonList = Array.isArray(buttons) ? buttons : [buttons];
    const holdFrames = options?.hold ?? 1;

    // Press all buttons
    for (const name of buttonList) {
      this.#gba.pressButton(resolveButton(name));
    }

    // Hold for the specified number of frames
    for (let i = 0; i < holdFrames; i++) {
      this.#runFrame();
    }

    // Release all buttons
    for (const name of buttonList) {
      this.#gba.releaseButton(resolveButton(name));
    }
  }

  async pressSequence(inputs: [string | null, number][]): Promise<void> {
    this.#actionsExecuted++;

    for (const [input, frames] of inputs) {
      if (input === null) {
        // No buttons — just wait
        for (let i = 0; i < frames; i++) {
          this.#runFrame();
        }
        continue;
      }

      const buttons = input.split('+').map((b) => resolveButton(b.trim()));

      for (const btn of buttons) {
        this.#gba.pressButton(btn);
      }
      for (let i = 0; i < frames; i++) {
        this.#runFrame();
      }
      for (const btn of buttons) {
        this.#gba.releaseButton(btn);
      }
    }
  }

  release(button: ButtonName): void {
    this.#gba.releaseButton(resolveButton(button));
  }

  // ─── State Extraction ────────────────────────────────────────────

  async takeScreenshot(options: { name: string }): Promise<void> {
    this.#actionsExecuted++;

    const framebuffer = this.#gba.ppu.getFramebuffer();
    const rgba = new Uint8Array(240 * 160 * 4);

    for (let i = 0; i < 240 * 160; i++) {
      const abgr = framebuffer[i]!;
      const offset = i * 4;
      rgba[offset] = abgr & 0xff; // R
      rgba[offset + 1] = (abgr >> 8) & 0xff; // G
      rgba[offset + 2] = (abgr >> 16) & 0xff; // B
      rgba[offset + 3] = 0xff; // A (always opaque)
    }

    await this.#host.writeScreenshot(options.name, rgba, 240, 160);
  }

  async takeMemorySnapshot(options: MemorySnapshotOptions): Promise<void> {
    this.#actionsExecuted++;

    let data: Uint8Array;
    let address: number;

    if ('region' in options) {
      const bus = this.#gba.bus;
      switch (options.region) {
        case 'iwram':
          data = new Uint8Array(bus.iwram);
          address = 0x03000000;
          break;
        case 'ewram':
          data = new Uint8Array(bus.ewram);
          address = 0x02000000;
          break;
        case 'vram':
          data = new Uint8Array(bus.vram);
          address = 0x06000000;
          break;
        case 'oam':
          data = new Uint8Array(bus.oam);
          address = 0x07000000;
          break;
        case 'palette':
          data = new Uint8Array(bus.palette);
          address = 0x05000000;
          break;
        case 'io':
          data = new Uint8Array(bus.mmioRegisters);
          address = 0x04000000;
          break;
        case 'sram':
          data = new Uint8Array(bus.sram);
          address = 0x0e000000;
          break;
        default:
          throw new Error(`Unknown memory region: "${(options as MemorySnapshotRegion).region}"`);
      }
    } else {
      data = new Uint8Array(options.length);
      address = options.address;
      for (let i = 0; i < options.length; i++) {
        data[i] = this.#gba.bus.read8(options.address + i);
      }
    }

    await this.#host.writeMemorySnapshot(options.name, {
      address: `0x${address.toString(16).padStart(8, '0')}`,
      length: data.length,
      data: Array.from(data),
    });
  }

  getRegisters(): Record<string, number> {
    const result: Record<string, number> = {};
    if (this.cpuRegisters) {
      for (let i = 0; i <= 15; i++) {
        result[`r${i}`] = this.cpuRegisters[i]!;
      }
    }
    if (this.cpuCpsr) {
      result['cpsr'] = this.cpuCpsr();
    }
    return result;
  }

  getMemory(address: number, length: number): Uint8Array {
    const data = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      data[i] = this.#gba.bus.read8(address + i);
    }
    return data;
  }

  /**
   * Watch a memory range; each write appends a {@link WatchHit} to the returned
   * handle's `hits` array, recording which code performed it. The core primitive
   * for finding where a value is written.
   *
   * @example
   *   const w = watchMemory({ address: 0x030055C0 });
   *   await press('right', { hold: 60 }); // take a hit
   *   for (const h of w.hits) console.log(h.source, hex(h.instructionAddress), h.value);
   *   w.stop();
   */
  watchMemory(options: {
    address: number;
    length?: number;
    /**
     * Keep a hit only when this returns true — watch a wide region but record only
     * what matters. A throw is treated as `false` (never aborts the emulation).
     */
    filter?: (hit: WatchHit) => boolean;
    /**
     * Cap recorded hits (first `maxHits` kept); guards memory on wide/long watches.
     * The watchpoint stays active — call `stop()` to remove it.
     */
    maxHits?: number;
  }): {
    hits: WatchHit[];
    stop: () => void;
  } {
    const length = options.length ?? 1;
    const filter = options.filter;
    const maxHits = options.maxHits;
    const hits: WatchHit[] = [];
    const busDispose = this.#gba.bus.addWriteWatchpoint(
      options.address,
      length,
      ({ address, value, size, dmaChannel, dmaOrigin }) => {
        if (maxHits !== undefined && hits.length >= maxHits) {
          return;
        }
        // DMA: the captured trigger instruction; CPU: the live PC + CPSR.
        const origin = dmaOrigin ?? captureOrigin(this.#gba.armCpu.registers[15]!, this.#gba.armCpu.cpsr);
        const hit: WatchHit = {
          pc: origin.pc,
          instructionAddress: origin.instructionAddress,
          address,
          value: value >>> 0,
          size,
          thumb: origin.thumb,
          source: dmaChannel >= 0 ? (`dma${dmaChannel}` as WatchHit['source']) : 'cpu',
        };
        if (filter) {
          let keep = false;
          try {
            keep = filter(hit);
          } catch {
            keep = false; // a throwing filter must not abort emulation
          }
          if (!keep) {
            return;
          }
        }
        hits.push(hit);
      },
    );
    const stop = (): void => {
      if (this.#watchDisposers.delete(busDispose)) {
        busDispose();
      }
    };
    this.#watchDisposers.add(busDispose);
    return { hits, stop };
  }

  /** Remove the data watchpoints created via this engine's `watchMemory`. */
  clearWatchpoints(): void {
    for (const dispose of this.#watchDisposers) {
      dispose();
    }
    this.#watchDisposers.clear();
  }

  read16(address: number): number {
    return this.#gba.bus.read16(address);
  }

  read32(address: number): number {
    return this.#gba.bus.read32(address);
  }

  disassemble(
    address: number,
    count?: number,
    mode?: 'thumb' | 'arm',
  ): { address: number; instruction: string; bytes: number }[] {
    const n = count ?? 10;
    const isThumb =
      mode === 'thumb' || (mode === undefined && (address & 1 || (this.cpuCpsr && (this.cpuCpsr() & 0x20) !== 0)));
    const bus = this.#gba.bus;
    const results: { address: number; instruction: string; bytes: number }[] = [];
    let addr = address & ~(isThumb ? 1 : 3);

    for (let i = 0; i < n; i++) {
      if (isThumb) {
        const opcode = bus.read16(addr);
        results.push({ address: addr, instruction: disassembleThumb(opcode, addr), bytes: 2 });
        addr += 2;
      } else {
        const opcode = bus.read32(addr);
        results.push({ address: addr, instruction: disassembleArm(opcode, addr), bytes: 4 });
        addr += 4;
      }
    }
    return results;
  }

  /** Disassemble a complete function, stopping at return instructions */
  disassembleFunction(
    address: number,
    mode?: 'thumb' | 'arm',
  ): { address: number; instruction: string; bytes: number }[] {
    const isThumb =
      mode === 'thumb' || (mode === undefined && (address & 1 || (this.cpuCpsr && (this.cpuCpsr() & 0x20) !== 0)));
    const bus = this.#gba.bus;
    const results: { address: number; instruction: string; bytes: number }[] = [];
    let addr = address & ~(isThumb ? 1 : 3);
    const maxInstructions = 500;

    for (let i = 0; i < maxInstructions; i++) {
      if (isThumb) {
        const opcode = bus.read16(addr);
        const text = disassembleThumb(opcode, addr);
        results.push({ address: addr, instruction: text, bytes: 2 });
        addr += 2;
        // Detect Thumb return: bx lr (0x4770) or pop {... pc} (0xBDxx)
        if (opcode === 0x4770 || (opcode & 0xff00) === 0xbd00) {
          break;
        }
      } else {
        const opcode = bus.read32(addr);
        const text = disassembleArm(opcode, addr);
        results.push({ address: addr, instruction: text, bytes: 4 });
        addr += 4;
        // Detect ARM return: bx lr (0xE12FFF1E) or mov pc, lr variants
        if (opcode === 0xe12fff1e) {
          break;
        }
        // ldmfd sp!, {..., pc} — pop with PC
        if ((opcode & 0x0fff0000) === 0x08bd0000 && opcode & 0x8000) {
          break;
        }
      }
    }
    return results;
  }

  /** Read a null-terminated string from memory */
  readString(address: number, maxLen?: number): string {
    const limit = maxLen ?? 256;
    const chars: number[] = [];
    for (let i = 0; i < limit; i++) {
      const byte = this.#gba.bus.read8(address + i);
      if (byte === 0) {
        break;
      }
      chars.push(byte);
    }
    return String.fromCharCode(...chars);
  }

  getPixel(x: number, y: number): { r: number; g: number; b: number } {
    const framebuffer = this.#gba.ppu.getFramebuffer();
    const abgr = framebuffer[y * 240 + x]!;
    return {
      r: abgr & 0xff,
      g: (abgr >> 8) & 0xff,
      b: (abgr >> 16) & 0xff,
    };
  }

  getScreenRegion(x: number, y: number, width: number, height: number): Uint8Array {
    const framebuffer = this.#gba.ppu.getFramebuffer();
    const rgba = new Uint8Array(width * height * 4);

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const abgr = framebuffer[(y + row) * 240 + (x + col)]!;
        const offset = (row * width + col) * 4;
        rgba[offset] = abgr & 0xff;
        rgba[offset + 1] = (abgr >> 8) & 0xff;
        rgba[offset + 2] = (abgr >> 16) & 0xff;
        rgba[offset + 3] = 0xff;
      }
    }

    return rgba;
  }

  // ─── Recording ─────────────────────────────────────────────────

  record(options: { name: string; interval?: number; columns?: number }): { stopRecording: () => Promise<void> } {
    this.#recording = {
      name: options.name,
      interval: options.interval ?? 1,
      columns: options.columns ?? 10,
      frameCounter: 0,
      frames: [],
    };

    return {
      stopRecording: async () => {
        const state = this.#recording;
        if (!state) {
          return;
        }
        this.#recording = null;
        await this.#writeSpriteSheet(state);
      },
    };
  }

  async #writeSpriteSheet(state: RecordingState): Promise<void> {
    const frameCount = state.frames.length;
    if (frameCount === 0) {
      return;
    }

    const cols = Math.min(state.columns, frameCount);
    const rows = Math.ceil(frameCount / cols);
    const sheetWidth = 240 * cols;
    const sheetHeight = 160 * rows;
    const rgba = new Uint8Array(sheetWidth * sheetHeight * 4);

    for (let f = 0; f < frameCount; f++) {
      const framebuffer = state.frames[f]!;
      const col = f % cols;
      const row = Math.floor(f / cols);
      const baseX = col * 240;
      const baseY = row * 160;

      for (let y = 0; y < 160; y++) {
        for (let x = 0; x < 240; x++) {
          const abgr = framebuffer[y * 240 + x]!;
          const offset = ((baseY + y) * sheetWidth + (baseX + x)) * 4;
          rgba[offset] = abgr & 0xff;
          rgba[offset + 1] = (abgr >> 8) & 0xff;
          rgba[offset + 2] = (abgr >> 16) & 0xff;
          rgba[offset + 3] = 0xff;
        }
      }
    }

    await this.#host.writeScreenshot(state.name, rgba, sheetWidth, sheetHeight);
  }

  // ─── GBA Hardware Introspection ─────────────────────────────────

  /** Parse OAM into structured sprite entries */
  readOAM(): {
    index: number;
    x: number;
    y: number;
    tileId: number;
    width: number;
    height: number;
    palette: number;
    priority: number;
    hFlip: boolean;
    vFlip: boolean;
    enabled: boolean;
    mode: number;
  }[] {
    const oam = this.#gba.bus.oam;
    const view = new DataView(oam.buffer, oam.byteOffset, oam.byteLength);

    // OAM size lookup: shape (2 bits) × size (2 bits) → [width, height] in pixels
    const sizes: [number, number][][] = [
      /* Square */ [
        [8, 8],
        [16, 16],
        [32, 32],
        [64, 64],
      ],
      /* Horizontal */ [
        [16, 8],
        [32, 8],
        [32, 16],
        [64, 32],
      ],
      /* Vertical */ [
        [8, 16],
        [8, 32],
        [16, 32],
        [32, 64],
      ],
      /* Prohibited */ [
        [8, 8],
        [8, 8],
        [8, 8],
        [8, 8],
      ],
    ];

    const sprites = [];
    for (let i = 0; i < 128; i++) {
      const base = i * 8;
      const attr0 = view.getUint16(base, true);
      const attr1 = view.getUint16(base + 2, true);
      const attr2 = view.getUint16(base + 4, true);

      const objMode = (attr0 >> 8) & 0x3;
      const enabled = objMode !== 2; // mode 2 = disabled/hidden
      const shape = (attr0 >> 14) & 0x3;
      const size = (attr1 >> 14) & 0x3;
      const [w, h] = sizes[shape]![size]!;

      let y = attr0 & 0xff;
      if (y >= 160) {
        y -= 256;
      }
      let x = attr1 & 0x1ff;
      if (x >= 240) {
        x -= 512;
      }

      sprites.push({
        index: i,
        x,
        y,
        tileId: attr2 & 0x3ff,
        width: w,
        height: h,
        palette: (attr2 >> 12) & 0xf,
        priority: (attr2 >> 10) & 0x3,
        hFlip: !!(attr1 & (1 << 12)),
        vFlip: !!(attr1 & (1 << 13)),
        enabled,
        mode: objMode,
      });
    }
    return sprites;
  }

  /** Read background scroll registers (camera position) */
  readBgScroll(layer: number): { x: number; y: number } {
    const mmio = this.#gba.bus.mmioRegisters;
    const view = new DataView(mmio.buffer, mmio.byteOffset, mmio.byteLength);
    const offset = 0x10 + layer * 4; // BG0HOFS=0x10, BG1HOFS=0x14, etc.
    return {
      x: view.getUint16(offset, true) & 0x1ff,
      y: view.getUint16(offset + 2, true) & 0x1ff,
    };
  }

  /** Read background tilemap as a grid of tile entries */
  readBgTilemap(layer: number): {
    width: number;
    height: number;
    tileSize: number;
    tiles: { id: number; hFlip: boolean; vFlip: boolean; palette: number }[];
  } {
    const mmio = this.#gba.bus.mmioRegisters;
    const view = new DataView(mmio.buffer, mmio.byteOffset, mmio.byteLength);
    const bgcnt = view.getUint16(0x08 + layer * 2, true);

    const screenBase = ((bgcnt >> 8) & 0x1f) * 0x800;
    const sizeFlag = (bgcnt >> 14) & 0x3;
    const is8bpp = !!(bgcnt & (1 << 7));

    // Tilemap dimensions in tiles (32x32 per screen block)
    const widthTiles = sizeFlag & 1 ? 64 : 32;
    const heightTiles = sizeFlag & 2 ? 64 : 32;

    const vram = this.#gba.bus.vram;
    const tiles: { id: number; hFlip: boolean; vFlip: boolean; palette: number }[] = [];

    for (let row = 0; row < heightTiles; row++) {
      for (let col = 0; col < widthTiles; col++) {
        // Handle screen block layout for 64-wide and 64-tall maps
        let screenBlock = 0;
        let localCol = col;
        let localRow = row;
        if (col >= 32) {
          screenBlock += 1;
          localCol -= 32;
        }
        if (row >= 32) {
          screenBlock += sizeFlag & 1 ? 2 : 1;
          localRow -= 32;
        }

        const entryOffset = screenBase + screenBlock * 0x800 + (localRow * 32 + localCol) * 2;
        if (entryOffset + 1 >= vram.length) {
          tiles.push({ id: 0, hFlip: false, vFlip: false, palette: 0 });
          continue;
        }
        const entry = vram[entryOffset]! | (vram[entryOffset + 1]! << 8);
        tiles.push({
          id: entry & 0x3ff,
          hFlip: !!(entry & (1 << 10)),
          vFlip: !!(entry & (1 << 11)),
          palette: (entry >> 12) & 0xf,
        });
      }
    }

    return { width: widthTiles, height: heightTiles, tileSize: is8bpp ? 8 : 8, tiles };
  }

  /** Parse DISPCNT to show active display configuration */
  readDisplayControl(): {
    mode: number;
    bg: [boolean, boolean, boolean, boolean];
    obj: boolean;
    win0: boolean;
    win1: boolean;
    objWin: boolean;
    frameSelect: number;
  } {
    const mmio = this.#gba.bus.mmioRegisters;
    const dispcnt = mmio[0]! | (mmio[1]! << 8);
    return {
      mode: dispcnt & 0x7,
      bg: [!!(dispcnt & (1 << 8)), !!(dispcnt & (1 << 9)), !!(dispcnt & (1 << 10)), !!(dispcnt & (1 << 11))],
      obj: !!(dispcnt & (1 << 12)),
      win0: !!(dispcnt & (1 << 13)),
      win1: !!(dispcnt & (1 << 14)),
      objWin: !!(dispcnt & (1 << 15)),
      frameSelect: (dispcnt >> 4) & 1,
    };
  }

  /** Fast hash of a screen region for change detection */
  hashRegion(x: number, y: number, width: number, height: number): number {
    const framebuffer = this.#gba.ppu.getFramebuffer();
    // FNV-1a 32-bit hash
    let hash = 0x811c9dc5;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const pixel = framebuffer[(y + row) * 240 + (x + col)]!;
        hash ^= pixel & 0xff;
        hash = Math.imul(hash, 0x01000193);
        hash ^= (pixel >> 8) & 0xff;
        hash = Math.imul(hash, 0x01000193);
        hash ^= (pixel >> 16) & 0xff;
        hash = Math.imul(hash, 0x01000193);
      }
    }
    return hash >>> 0; // ensure unsigned
  }

  /** Register a per-frame callback fired during wait/press/pressSequence */
  onFrame(callback: ((frame: number) => void) | null): void {
    this.#onFrameCallback = callback;
  }

  // ─── Memory Search ─────────────────────────────────────────────

  searchMemory(options: { value: number; size?: 8 | 16 | 32; region?: 'iwram' | 'ewram' | 'both' }): number[] {
    const size = options.size ?? 8;
    const region = options.region ?? 'both';
    const results: number[] = [];

    const regions: { base: number; data: Uint8Array }[] = [];
    const bus = this.#gba.bus;
    if (region === 'iwram' || region === 'both') {
      regions.push({ base: 0x03000000, data: bus.iwram });
    }
    if (region === 'ewram' || region === 'both') {
      regions.push({ base: 0x02000000, data: bus.ewram });
    }

    for (const { base, data } of regions) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const step = size >> 3;
      const limit = data.length - step + 1;
      for (let i = 0; i < limit; i++) {
        let val: number;
        if (size === 8) {
          val = data[i]!;
        } else if (size === 16) {
          val = view.getUint16(i, true);
        } else {
          val = view.getUint32(i, true);
        }
        if (val === options.value) {
          results.push(base + i);
        }
      }
    }

    return results;
  }

  filterMemory(addresses: number[], options: { value: number; size?: 8 | 16 | 32 }): number[] {
    const size = options.size ?? 8;
    const results: number[] = [];

    for (const addr of addresses) {
      let val: number;
      if (size === 8) {
        val = this.#gba.bus.read8(addr);
      } else if (size === 16) {
        val = this.#gba.bus.read16(addr);
      } else {
        val = this.#gba.bus.read32(addr);
      }
      if (val === options.value) {
        results.push(addr);
      }
    }

    return results;
  }

  // ─── State Management ────────────────────────────────────────────

  async saveState(options: { name: string }): Promise<void> {
    this.#actionsExecuted++;
    const snapshot = this.#gba.serialize();
    if (this.cpuSerialize) {
      snapshot.cpu = this.cpuSerialize();
    }
    await this.#host.writeSaveState(options.name, snapshot);
  }

  async loadState(path: string): Promise<void> {
    this.#actionsExecuted++;
    const snapshot = await this.#host.readSaveState(path);
    this.#gba.deserialize(snapshot);
    if (this.cpuDeserialize && snapshot.cpu) {
      this.cpuDeserialize(snapshot.cpu);
    }
  }

  // ─── Assertions ──────────────────────────────────────────────────

  assert(condition: AssertCondition): void {
    if ('memory' in condition) {
      const { address, equals } = condition.memory;
      const actual = this.#gba.bus.read8(address);
      if (actual !== equals) {
        throw new Error(
          `Assertion failed: memory[0x${address.toString(16)}] expected ${equals} (0x${equals.toString(16)}), got ${actual} (0x${actual.toString(16)})`,
        );
      }
      return;
    }

    if ('register' in condition) {
      const { name, equals } = condition.register;
      const regs = this.getRegisters();
      const actual = regs[name];
      if (actual === undefined) {
        throw new Error(`Assertion failed: unknown register "${name}"`);
      }
      if (actual !== equals) {
        throw new Error(
          `Assertion failed: ${name} expected ${equals} (0x${equals.toString(16)}), got ${actual} (0x${actual.toString(16)})`,
        );
      }
      return;
    }
  }
}
