/**
 * GBA System Bus
 *
 * Implements MemoryBus and dispatches reads/writes to the
 * appropriate subsystem based on address ranges.
 *
 * Memory map:
 *   0x00000000-0x00003FFF  BIOS (16 KB, readable only while the CPU executes in it)
 *   0x02000000-0x0203FFFF  EWRAM (256 KB)
 *   0x03000000-0x03007FFF  IWRAM (32 KB)
 *   0x04000000-0x040003FE  I/O Registers (MMIO)
 *   0x04000800             Internal Memory Control (mirrored every 64 KB)
 *   0x05000000-0x050003FF  Palette RAM (1 KB)
 *   0x06000000-0x06017FFF  VRAM (96 KB)
 *   0x07000000-0x070003FF  OAM (1 KB)
 *   0x08000000-0x09FFFFFF  Game Pak ROM (up to 32 MB)
 *   0x0E000000-0x0E00FFFF  Game Pak SRAM (32 KB, mirrored) or flash (one 64 KB bank)
 *
 * Reads of unmapped memory return open bus: the last opcode the CPU fetched.
 *
 * References: GBATEK "GBA Memory Map", "GBA I/O Map", "GBA Unpredictable Things";
 * mGBA src/gba/memory.c and src/gba/io.c; NanoBoyAdvance src/nba/src/bus.
 */
import type { MemoryBus } from '@gba-kit/arm-emulator';

import type { Apu } from './apu/apu.js';
import type { DisplayStatus } from './display-status.js';
import type { DmaController } from './dma.js';
import { ERASED_BYTE, FLASH_BANK_BYTES, GbaFlash } from './flash.js';
import type { InputController } from './input.js';
import type { InterruptController } from './interrupts.js';
import type { EepromSnapshot, SystemBusSnapshot } from './savestate.js';
import { type SerialPort, isSerialRegister } from './serial.js';
import type { TimerController } from './timers.js';
import { BIOS_LATCH_AFTER_BOOT, MMIO } from './types.js';
import type { WriteOrigin } from './write-source.js';

/** A committed write reported to a data watchpoint. */
export interface WatchpointWrite {
  /** The watched byte that was written (within the access, clamped to the watch range). */
  address: number;
  /** Value committed, masked to `size` bytes. */
  value: number;
  /** Access size in bytes (1, 2 or 4). */
  size: number;
  /** Active DMA channel (0-3) if a DMA performed the write, else -1 (a CPU/BIOS store). */
  dmaChannel: number;
  /** The DMA's start instruction when `dmaChannel >= 0`, else null. */
  dmaOrigin: WriteOrigin | null;
}

/** A read reported to a data watchpoint. */
export interface WatchpointRead {
  /** The watched byte that was read (within the access, clamped to the watch range). */
  address: number;
  /** Value the load returned, masked to `size` bytes — the whole access, not just the watched bytes. */
  value: number;
  /** Access size in bytes (1, 2 or 4). */
  size: number;
  /** Active DMA channel (0-3) if a DMA performed the read, else -1 (a CPU/BIOS load). */
  dmaChannel: number;
  /** The DMA's start instruction when `dmaChannel >= 0`, else null. */
  dmaOrigin: WriteOrigin | null;
}

/** The kinds of battery-backed save a cartridge can declare. */
export type SaveType = 'eeprom' | 'sram' | 'flash512' | 'flash1m';

/** What a cartridge's ROM says about its save, from the SDK string the build embeds. */
export interface CartridgeSave {
  /** null when the ROM declares nothing, as homebrew usually does */
  type: SaveType | null;
  /** the string as it stands in the ROM (`EEPROM_V121`, `FLASH1M_V103`), so a message can name it */
  id: string | null;
}

/**
 * The SDK's save-type strings, GBATEK "GBA Cart Backup IDs"; no one of them is a prefix of
 * another, so the order is free.
 */
const SAVE_TYPE_STRINGS: ReadonlyArray<readonly [string, SaveType]> = [
  ['EEPROM_V', 'eeprom'],
  ['SRAM_F_V', 'sram'],
  ['SRAM_V', 'sram'],
  ['FLASH1M_V', 'flash1m'],
  ['FLASH512_V', 'flash512'],
  ['FLASH_V', 'flash512'],
];

/** The shortest prefix there is, so the scan stops once no room is left for one. */
const MIN_SAVE_PREFIX = Math.min(...SAVE_TYPE_STRINGS.map(([prefix]) => prefix.length));

/** The version digits the SDK appends to the prefix (`SRAM_V113`). */
const SAVE_VERSION_DIGITS = 3;

/** The EEPROM chip's array: 64 Kbit, which a 4 Kbit cartridge uses the first 512 bytes of. */
const EEPROM_BYTES = 0x2000;

/**
 * The CPU as the bus sees it: where it executes, which decides whether the BIOS is readable, and
 * the opcodes in its prefetch pipeline, which are what an open-bus read returns. `ArmCpu` is one.
 */
export interface BusCpu {
  readonly registers: Uint32Array;
  readonly cpsr: number;
  /** [$+8] in ARM state, [$+4] in Thumb state while the instruction at $ executes */
  readonly prefetchedOpcode: number;
  /** [$+4] in ARM state, [$+2] in Thumb state */
  readonly decodedOpcode: number;
}

const BIOS_SIZE = 0x4000;
const CPSR_THUMB = 1 << 5;

const IO_BASE = 0x04000000;

/** The I/O register file: offsets 0x000-0x3FF. Above it the region is unmapped but for memory control. */
const IO_SIZE = 0x400;

/**
 * GBATEK "Memory Control - 4000800h": a 32-bit register, mirrored every 64 KB of the I/O region.
 * The BIOS leaves it at 0D000020h. Bits 0-3, 5, 24-31 are read/write; the others read 0.
 */
const MEMORY_CONTROL = 0x800;
const MEMORY_CONTROL_RESET = 0x0d000020;
const MEMORY_CONTROL_MASK = 0xff00002f;

/**
 * Wait states (GBATEK "GBA System Control - Waitstate Control"; mGBA memory.c GBAAdjustWaitstates).
 * WAITCNT sets the game pak's: SRAM and the first access (N) of each ROM mirror take 4, 3, 2 or 8
 * waits, and a sequential access (S) to wait state 0, 1 or 2 takes 2/4/8 waits or 1. The ROM, EWRAM
 * and SRAM buses are 16 bits wide (SRAM 8), so a 32-bit access there is two accesses, the second
 * sequential; palette RAM and VRAM add one wait to a 32-bit access, and IWRAM, I/O and OAM have none.
 */
const ROM_N_WAITS = [4, 3, 2, 8] as const;
const ROM_S_WAITS = [
  [2, 1],
  [4, 1],
  [8, 1],
] as const;

/** Where the game pak's ROM mirrors begin, and SRAM, which is beyond them. */
const CARTRIDGE_BASE = 0x08000000;
const SRAM_REGION = 0x0e;

/** WAITCNT bit 14: the game pak prefetch buffer. */
const WAITCNT_PREFETCH = 1 << 14;

/** The prefetch buffer holds 8 halfwords (GBATEK "GBA GamePak Prefetch"). */
const PREFETCH_HALFWORDS = 8;

/** The halfwords the APU decodes: SOUND1CNT_L-SOUNDBIAS (0x8C and 0x8E are unused) and wave RAM. */
function isApuRegister(offset: number): boolean {
  return offset >= 0x60 && offset < 0xa0 && offset !== 0x8c && offset !== 0x8e;
}

const FIFO_A = 0xa0;
const FIFO_B = 0xa4;
const DMA_FIRST = 0xb0;
const DMA_END = 0xe0;
const TIMERS_FIRST = 0x100;
const TIMERS_END = 0x110;

/** An I/O halfword a write sets and a read sees as open bus; a debugger still sees the write. */
const WRITE_ONLY = -1;
/** An unused I/O halfword: writes go nowhere, reads see open bus. */
const UNUSED = -2;

/**
 * How each I/O halfword the register file stores reads back: the mask of its readable bits,
 * WRITE_ONLY or UNUSED. A mask of 0 is an unused halfword that reads 0. The registers a subsystem
 * owns (DISPSTAT/VCOUNT, sound, DMA, timers, serial port, keypad, interrupts, WAITCNT, POSTFLG) are
 * decoded before this table. GBATEK "GBA I/O Map"; mGBA io.c GBAIORead.
 */
const IO_READ_MASKS = ((): Int32Array => {
  const table = new Int32Array(IO_SIZE >> 1).fill(UNUSED);
  const set = (offset: number, mask: number, halfwords = 1): void => {
    table.fill(mask, offset >> 1, (offset >> 1) + halfwords);
  };
  set(0x000, 0xffff); // DISPCNT
  set(0x002, 0x0001); // green swap
  set(0x008, 0xdfff, 2); // BG0CNT, BG1CNT: bit 13 (area overflow) exists on BG2 and BG3 only
  set(0x00c, 0xffff, 2); // BG2CNT, BG3CNT
  set(0x010, WRITE_ONLY, 0x1c); // BGxHOFS/VOFS, BG2/BG3 PA-PD, X, Y, WIN0H-WIN1V
  set(0x048, 0x3f3f, 2); // WININ, WINOUT
  set(0x04c, WRITE_ONLY); // MOSAIC
  set(0x050, 0x3fff); // BLDCNT
  set(0x052, 0x1f1f); // BLDALPHA
  set(0x054, WRITE_ONLY); // BLDY
  set(FIFO_A, WRITE_ONLY, 4); // FIFO_A, FIFO_B
  set(0x136, 0);
  set(0x142, 0);
  set(0x15a, 0);
  set(0x206, 0); // the high half of WAITCNT's word
  set(0x20a, 0); // the high half of IME's word
  set(0x302, 0);
  return table;
})();

/** The halfword `value` writes into `current` through the byte lanes `mask` selects. */
function merge(current: number, value: number, mask: number): number {
  return ((current & ~mask) | (value & mask)) >>> 0;
}

/** The SRAM chip: 32 KB, mirrored through the 64 KB window (mGBA GBA_SIZE_SRAM, NBA SRAM::Read). */
const SRAM_BYTES = 0x8000;

function matchesAt(rom: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (rom[at + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function digitsAt(rom: Uint8Array, at: number, count: number): boolean {
  for (let i = 0; i < count; i++) {
    const byte = rom[at + i] ?? 0;
    if (byte < 0x30 || byte > 0x39) {
      return false;
    }
  }
  return true;
}

/**
 * The I/O register file at power-on: BG2/BG3 PA and PD hold 0x0100 (the identity transform),
 * everything else 0. mGBA src/gba/io.c GBAIOInit.
 */
function powerOnIoRegisters(): Uint8Array {
  const io = new Uint8Array(IO_SIZE);
  for (const register of [MMIO.BG2PA, MMIO.BG2PD, MMIO.BG3PA, MMIO.BG3PD]) {
    io[(register & 0x3ff) + 1] = 0x01;
  }
  return io;
}

export class GbaSystemBus implements MemoryBus {
  /** BIOS ROM (16 KB) — set via loadBios() */
  #bios = new Uint8Array(0x4000);

  /** External Work RAM (256 KB) */
  readonly ewram = new Uint8Array(0x40000);

  /** Internal Work RAM (32 KB) */
  readonly iwram = new Uint8Array(0x8000);

  /** Palette RAM (1 KB) */
  readonly palette = new Uint8Array(0x400);

  /** Video RAM (96 KB) */
  readonly vram = new Uint8Array(0x18000);

  /** Object Attribute Memory (1 KB) */
  readonly oam = new Uint8Array(0x400);

  /** Game Pak ROM — set via loadRom() */
  #rom = new Uint8Array(0);

  /** Game Pak SRAM (32 KB), erased */
  readonly sram = new Uint8Array(SRAM_BYTES).fill(ERASED_BYTE);

  /** Game Pak EEPROM */
  readonly #eeprom = new GbaEeprom();

  /** Game Pak flash; holds a chip when the ROM declares one */
  readonly #flash = new GbaFlash();

  /** What the cartridge's ROM declares about its save; cartridge identity, like #rom */
  #save: CartridgeSave = { type: null, id: null };

  /** WAITCNT register */
  #waitcnt = 0;

  /** POSTFLG register */
  #postflg = 0;

  /**
   * The BIOS read-protection latch: the last BIOS word read while the CPU executed in the BIOS,
   * which is what a BIOS read from anywhere else returns (GBATEK "BIOS Memory"). The real BIOS
   * leaves [0DCh+8] in it at boot.
   */
  #biosLatch = BIOS_LATCH_AFTER_BOOT;

  /** Internal Memory Control (0x04000800) */
  #memoryControl = MEMORY_CONTROL_RESET;

  /**
   * What one access costs in each region (address bits 24-31), wait states included: N and S
   * accesses of 16 bits (8-bit accesses cost the same) and of 32 bits. Rebuilt from WAITCNT and
   * memory control whenever either changes.
   */
  readonly #cyclesN16 = new Uint8Array(256);
  readonly #cyclesS16 = new Uint8Array(256);
  readonly #cyclesN32 = new Uint8Array(256);
  readonly #cyclesS32 = new Uint8Array(256);

  /**
   * The game pak prefetch buffer: the address of the last opcode halfword it has fetched ahead of
   * the CPU, or 0 when a branch emptied it (mGBA `lastPrefetchedPc`).
   */
  #prefetchEnd = 0;

  // Subsystem references (set during GBA construction)
  #interrupts!: InterruptController;
  #timers!: TimerController;
  #dma!: DmaController;
  #input!: InputController;
  #apu!: Apu;
  #display!: DisplayStatus;
  #serial!: SerialPort;

  /** Until a CPU is connected, the bus sees one held in reset: at PC 0 with an empty pipeline. */
  #cpu: BusCpu = { registers: new Uint32Array(16), cpsr: 0xd3, prefetchedOpcode: 0, decodedOpcode: 0 };

  /**
   * The I/O register file. Display registers are stored here and the PPU reads them from it; the
   * bytes of a write-only register hold the last value written, which debug views show.
   */
  readonly mmioRegisters = powerOnIoRegisters();

  /** Callback when BG2/BG3 reference point registers are written (for PPU ref point reload) */
  onBgRefPointWrite?: (bgIndex: 2 | 3, isX: boolean) => void;

  /** Observer for every write into the I/O register file (an event log's MMIO rows). */
  onMmioWrite: ((address: number, value: number, size: 1 | 2 | 4) => void) | null = null;

  /** Data watchpoints: fire when a write commits to [start, end). Empty until set. */
  readonly #watchpoints: Array<{
    start: number;
    end: number;
    onWrite: (info: WatchpointWrite) => void;
  }> = [];

  /** Read watchpoints: fire when a load returns from [start, end). Empty until set. */
  readonly #readWatchpoints: Array<{
    start: number;
    end: number;
    onRead: (info: WatchpointRead) => void;
  }> = [];

  /** DMA channel (0-3) currently transferring, or -1 for CPU accesses; attributes hits. */
  #dmaChannel = -1;
  #dmaOrigin: WriteOrigin | null = null;

  /** Attribute subsequent committed writes to a DMA channel (called by the DMA controller). */
  setDmaSource(channel: number, origin: WriteOrigin): void {
    this.#dmaChannel = channel;
    this.#dmaOrigin = origin;
  }

  clearDmaSource(): void {
    this.#dmaChannel = -1;
    this.#dmaOrigin = null;
  }

  /**
   * Register a write watchpoint over [address, address+length); returns a disposer.
   * `length` is clamped to >= 1.
   */
  addWriteWatchpoint(address: number, length: number, onWrite: (info: WatchpointWrite) => void): () => void {
    const len = length >= 1 ? length : 1;
    const wp = { start: address >>> 0, end: (address + len) >>> 0, onWrite };
    this.#watchpoints.push(wp);
    return () => {
      const i = this.#watchpoints.indexOf(wp);
      if (i >= 0) {
        this.#watchpoints.splice(i, 1);
      }
    };
  }

  /** Remove every registered write watchpoint. */
  clearWriteWatchpoints(): void {
    this.#watchpoints.length = 0;
  }

  /**
   * Register a read watchpoint over [address, address+length); returns a disposer.
   * Fires after the load, with the value it returned. Every load through the bus
   * counts, the CPU's instruction fetch included; a debugger's `peek` does not.
   */
  addReadWatchpoint(address: number, length: number, onRead: (info: WatchpointRead) => void): () => void {
    const len = length >= 1 ? length : 1;
    const wp = { start: address >>> 0, end: (address + len) >>> 0, onRead };
    this.#readWatchpoints.push(wp);
    return () => {
      const i = this.#readWatchpoints.indexOf(wp);
      if (i >= 0) {
        this.#readWatchpoints.splice(i, 1);
      }
    };
  }

  /** Remove every registered read watchpoint. */
  clearReadWatchpoints(): void {
    this.#readWatchpoints.length = 0;
  }

  /** Whether any write watchpoint is registered (hot-path gate). */
  hasWatchpoints(): boolean {
    return this.#watchpoints.length > 0;
  }

  /** Whether any read watchpoint is registered (hot-path gate). */
  hasReadWatchpoints(): boolean {
    return this.#readWatchpoints.length > 0;
  }

  /** Notify read watchpoints overlapping a load of `size` bytes at `base` that returned `value`. */
  #notifyRead(base: number, value: number, size: number): void {
    const lo = base >>> 0;
    const hi = (lo + size) >>> 0;
    const list = this.#readWatchpoints.length === 1 ? this.#readWatchpoints : this.#readWatchpoints.slice();
    for (const wp of list) {
      if (lo < wp.end && hi > wp.start) {
        const address = (lo > wp.start ? lo : wp.start) >>> 0;
        wp.onRead({ address, value, size, dmaChannel: this.#dmaChannel, dmaOrigin: this.#dmaOrigin });
      }
    }
  }

  /**
   * Notify watchpoints overlapping a committed write of `value` (masked to `size`)
   * at canonical base `base`. Callers gate on `hasWatchpoints()` first.
   */
  #notifyWrite(base: number, value: number, size: number): void {
    const wps = this.#watchpoints;
    const lo = base >>> 0;
    const hi = (lo + size) >>> 0;
    const dmaChannel = this.#dmaChannel;
    const dmaOrigin = this.#dmaOrigin;
    // Snapshot when several exist, so a callback may dispose/clear mid-notify safely.
    const list = wps.length === 1 ? wps : wps.slice();
    for (const wp of list) {
      if (lo < wp.end && hi > wp.start) {
        const address = (lo > wp.start ? lo : wp.start) >>> 0; // the watched byte, not the access base
        wp.onWrite({ address, value, size, dmaChannel, dmaOrigin });
      }
    }
  }

  constructor() {
    this.#updateWaitStates();
  }

  /** Wire up subsystem references */
  connect(parts: {
    interrupts: InterruptController;
    timers: TimerController;
    dma: DmaController;
    input: InputController;
    apu: Apu;
    display: DisplayStatus;
    serial: SerialPort;
    cpu: BusCpu;
  }): void {
    this.#interrupts = parts.interrupts;
    this.#timers = parts.timers;
    this.#dma = parts.dma;
    this.#input = parts.input;
    this.#apu = parts.apu;
    this.#display = parts.display;
    this.#serial = parts.serial;
    this.#cpu = parts.cpu;
  }

  /**
   * Set the BIOS read-protection latch to the opcode the BIOS fetched last, for BIOS code the
   * HLE runs without fetching it (an SWI, which the real BIOS leaves through the same code).
   */
  latchBiosOpcode(opcode: number): void {
    this.#biosLatch = opcode >>> 0;
  }

  /** Load BIOS ROM data */
  loadBios(data: Uint8Array): void {
    this.#bios = new Uint8Array(0x4000);
    this.#bios.set(data.subarray(0, 0x4000));
  }

  /** Write a 32-bit value to the BIOS region (for installing HLE stubs) */
  writeBios32(address: number, value: number): void {
    const offset = address & 0x3fff;
    this.#bios[offset] = value & 0xff;
    this.#bios[offset + 1] = (value >>> 8) & 0xff;
    this.#bios[offset + 2] = (value >>> 16) & 0xff;
    this.#bios[offset + 3] = (value >>> 24) & 0xff;
  }

  /** Load Game Pak ROM data */
  loadRom(data: Uint8Array): void {
    this.#rom = new Uint8Array(data.length);
    this.#rom.set(data);
    this.#detectSaveType(data);
  }

  /**
   * The save type from the SDK string the build embeds, and the chip that goes with it.
   * The string is word-aligned. The SDK ends it in three version digits, and a string that
   * has them wins over any bare prefix, which keeps a chance run of letters elsewhere in
   * the ROM — inside compressed data, most of all — from outvoting the declaration. A ROM
   * whose strings all lack the digits, as homebrew and test ROMs write them (`SRAM_V`),
   * takes the first bare prefix, the way NanoBoyAdvance matches (loader/rom.cc GetBackupType).
   */
  #detectSaveType(rom: Uint8Array): void {
    this.#save = this.#findSaveDeclaration(rom);
    const type = this.#save.type;
    this.#flash.insert(type === 'flash1m' ? 2 : type === 'flash512' ? 1 : 0);
  }

  #findSaveDeclaration(rom: Uint8Array): CartridgeSave {
    let barePrefix: CartridgeSave | null = null;
    for (let i = 0; i + MIN_SAVE_PREFIX <= rom.length; i += 4) {
      for (const [prefix, type] of SAVE_TYPE_STRINGS) {
        if (!matchesAt(rom, i, prefix)) {
          continue;
        }
        const end = i + prefix.length;
        if (digitsAt(rom, end, SAVE_VERSION_DIGITS)) {
          return { type, id: String.fromCharCode(...rom.subarray(i, end + SAVE_VERSION_DIGITS)) };
        }
        barePrefix ??= { type, id: prefix };
      }
    }
    return barePrefix ?? { type: null, id: null };
  }

  /** What the cartridge's ROM declares about its battery-backed save. */
  get save(): CartridgeSave {
    return this.#save;
  }

  /**
   * How many bytes the cartridge's EEPROM holds — 512 for 4 Kbit, 8192 for 64 Kbit —
   * or 0 while nothing has said which of the two it is.
   */
  get eepromSaveBytes(): number {
    return this.#eeprom.saveBytes;
  }

  /**
   * The cartridge's battery-backed memory, whole, in the byte order a `.sav` file uses:
   * the EEPROM, the SRAM or the flash chip with bank 0 first. A copy — unlike a read
   * through the bus, this clocks no serial protocol and answers no flash command. Null
   * when the ROM declares no save, because then there is no chip to read.
   */
  readBackup(): Uint8Array | null {
    switch (this.#save.type) {
      case null:
        return null;
      case 'eeprom':
        return this.#eeprom.read8();
      case 'sram':
        return new Uint8Array(this.sram);
      case 'flash512':
      case 'flash1m':
        return this.#flash.readAll();
    }
  }

  /**
   * Install a `.sav` as the cartridge's battery-backed memory, filling what `bytes` does
   * not reach with the value an erased chip holds. Which files belong in which chip is
   * settled before here: this refuses only what it cannot hold at all.
   */
  writeBackup(bytes: Uint8Array): void {
    if (this.#save.type === null) {
      throw new Error('this ROM declares no save type');
    }
    const type = this.#save.type;
    const target = type === 'eeprom' ? EEPROM_BYTES : type === 'sram' ? this.sram.length : this.#flash.size;
    if (bytes.length > target) {
      throw new Error(`${bytes.length} bytes do not fit in ${target}`);
    }
    switch (type) {
      case 'eeprom':
        this.#eeprom.install(bytes);
        return;
      case 'sram':
        this.sram.fill(ERASED_BYTE);
        this.sram.set(bytes);
        return;
      case 'flash512':
      case 'flash1m':
        this.#flash.install(bytes);
    }
  }

  // ─── Memory Map Classification ────────────────────────────────────

  /**
   * Debugger read: `length` bytes starting at `address`, taken from the backing
   * arrays without any of the bus's side effects (an EEPROM read through the bus
   * clocks its serial protocol; this never does). `readable` counts the leading
   * bytes that map to something; the rest of `data` is zero and must not be shown
   * as memory contents. Mirrors resolve to their canonical bytes. The BIOS reads
   * whole, whatever its read protection would give the CPU. MMIO is decoded the way
   * a CPU read sees it, side-effect free, except that a write-only register shows
   * the value last written to it and an unused one shows 0, where the CPU would
   * read open bus.
   */
  peek(address: number, length: number): { data: Uint8Array; readable: number } {
    const data = new Uint8Array(length);
    let readable = 0;
    for (let i = 0; i < length; i++) {
      const value = this.#peekByte((address + i) >>> 0);
      if (value === null) {
        break;
      }
      data[i] = value;
      readable++;
    }
    return { data, readable };
  }

  #peekByte(addr: number): number | null {
    const offset = addr & 0x00ffffff;
    switch ((addr >>> 24) & 0xff) {
      case 0x00:
        return offset < BIOS_SIZE ? this.#bios[offset]! : null;
      case 0x02:
        return this.ewram[addr & 0x3ffff]!;
      case 0x03:
        return this.iwram[addr & 0x7fff]!;
      case 0x04:
        return this.#isIoMapped(offset) ? (this.#ioRead16(offset & ~1, true) >>> ((offset & 1) * 8)) & 0xff : null;
      case 0x05:
        return this.palette[addr & 0x3ff]!;
      case 0x06: {
        const vramOffset = this.#vramOffset(addr);
        return vramOffset < 0 ? 0 : this.vram[vramOffset]!;
      }
      case 0x07:
        return this.oam[addr & 0x3ff]!;
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
      case 0x0c: {
        const romOffset = addr & 0x01ffffff;
        return romOffset < this.#rom.length ? this.#rom[romOffset]! : null;
      }
      case 0x0e:
      case 0x0f:
        // what a CPU read returns, which for a flash chip in ID mode is its ID
        return this.#hasSaveWindow() ? this.#readSave8(addr) : null;
      default:
        return null; // EEPROM (a protocol, not bytes), and everything unmapped
    }
  }

  /**
   * Debugger write: store `bytes` at `address` in the backing arrays, bypassing the
   * hardware's write rules (a byte write to OAM is dropped by the bus, to VRAM it is
   * duplicated; a hex editor means the byte it typed) and without notifying data
   * watchpoints. MMIO goes through the bus so the register's side effects apply.
   * BIOS, ROM and EEPROM are refused. Returns how many leading bytes were written.
   */
  poke(address: number, bytes: Uint8Array): number {
    let written = 0;
    for (let i = 0; i < bytes.length; i++) {
      const addr = (address + i) >>> 0;
      const value = bytes[i]!;
      switch ((addr >>> 24) & 0xff) {
        case 0x02:
          this.ewram[addr & 0x3ffff] = value;
          break;
        case 0x03:
          this.iwram[addr & 0x7fff] = value;
          break;
        case 0x04:
          if (!this.#isIoMapped(addr & 0x00ffffff)) {
            return written;
          }
          this.#mmioWrite8(addr, value);
          break;
        case 0x05:
          this.palette[addr & 0x3ff] = value;
          break;
        case 0x06: {
          const vramOffset = this.#vramOffset(addr);
          if (vramOffset < 0) {
            return written;
          }
          this.vram[vramOffset] = value;
          break;
        }
        case 0x07:
          this.oam[addr & 0x3ff] = value;
          break;
        case 0x0e:
        case 0x0f:
          if (this.#save.type === 'sram') {
            this.sram[addr & (SRAM_BYTES - 1)] = value;
          } else if (this.#flash.size > 0) {
            this.#flash.poke8(addr, value); // the bank the window shows, outside the command protocol
          } else {
            return written;
          }
          break;
        default:
          return written;
      }
      written++;
    }
    return written;
  }

  /**
   * The region this bus decodes `address` to, or `null` when it decodes nothing.
   *
   * The `read*` methods below are the HARDWARE interface: they answer every address,
   * because the console does — an undecoded one reads as open bus, which on real
   * silicon is a value, not a fault. That is correct for the CPU and wrong for a
   * human or an agent, who gets a plausible number back from a question that had no
   * answer. Debug-facing callers use this first so they can refuse instead
   * (see `ScriptingEngine.read16`/`read32`/`readBytes`).
   *
   * "Decoded" is the test, not "distinct". The RAM regions mirror a small store
   * across their whole 16 MB window, and a read from a mirror is a real read — so
   * this reports the region rather than claiming the address is a mistake. What it
   * does catch is space nothing answers for: the holes in the BIOS and I/O regions,
   * region 0x01, everything from 0x10 up, and an offset past the end of the
   * cartridge actually loaded.
   *
   * Side-effect free — unlike a read, which can advance the EEPROM serial state.
   */
  describeAddress(address: number): { region: string } | null {
    const addr = address >>> 0;
    const offset = addr & 0x00ffffff;
    switch ((addr >>> 24) & 0xff) {
      case 0x00:
        return offset < BIOS_SIZE ? { region: 'BIOS' } : null;
      case 0x02:
        return { region: 'EWRAM' };
      case 0x03:
        return { region: 'IWRAM' };
      case 0x04:
        // The register file and the memory-control register mirrored above it; the rest
        // of the region decodes nothing.
        return this.#isIoMapped(offset) ? { region: 'MMIO' } : null;
      case 0x05:
        return { region: 'palette RAM' };
      case 0x06:
        return { region: 'VRAM' };
      case 0x07:
        return { region: 'OAM' };
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
      case 0x0c:
        // The wait-state mirrors all address the same cartridge, so what decides is
        // the offset into it — past the end of the loaded ROM nothing answers, and a read
        // there returns the address the cartridge bus last carried.
        return (addr & 0x01ffffff) < this.#rom.length ? { region: 'ROM' } : null;
      case 0x0d:
        // Not cartridge data: a wide read here is an EEPROM serial transaction that
        // returns one data bit. Decoded, so not refused — but it is its own region.
        return { region: 'EEPROM' };
      case 0x0e:
      case 0x0f:
        // Reported whether or not a save chip was detected. Detection is a pattern
        // scan of the ROM, and a guard must not be more certain than its evidence:
        // gating on it would turn a missed heuristic into a hard refusal of a
        // legitimate read.
        return { region: 'SRAM' };
      default:
        return null;
    }
  }

  // ─── MemoryBus Implementation ─────────────────────────────────────

  read8(address: number): number {
    const value = this.#read8(address);
    if (this.#readWatchpoints.length > 0) {
      this.#notifyRead(this.#canonicalAddress(address), value & 0xff, 1);
    }
    return value;
  }

  #read8(address: number): number {
    const region = (address >>> 24) & 0xff;
    switch (region) {
      case 0x00:
        return (this.#readBios32(address & ~3) >>> ((address & 3) * 8)) & 0xff;
      case 0x02:
        return this.ewram[address & 0x3ffff]!;
      case 0x03:
        return this.iwram[address & 0x7fff]!;
      case 0x04:
        return this.#mmioRead8(address);
      case 0x05:
        return this.palette[address & 0x3ff]!;
      case 0x06: {
        const offset = this.#vramOffset(address);
        return offset < 0 ? 0 : this.vram[offset]!;
      }
      case 0x07:
        return this.oam[address & 0x3ff]!;
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
      case 0x0c:
        return this.#readRom8(address);
      case 0x0d:
        // EEPROM region — but 8-bit reads just return ROM data
        return this.#readRom8(address);
      case 0x0e:
      case 0x0f:
        return this.#readSave8(address);
      default:
        return (this.#openBus() >>> ((address & 3) * 8)) & 0xff;
    }
  }

  read16(address: number): number {
    const value = this.#read16(address);
    if (this.#readWatchpoints.length > 0) {
      this.#notifyRead(this.#canonicalAddress(address & ~1), value & 0xffff, 2);
    }
    return value;
  }

  #read16(address: number): number {
    const addr = address & ~1; // Force halfword alignment
    const region = (addr >>> 24) & 0xff;
    switch (region) {
      case 0x00:
        return (this.#readBios32(addr & ~3) >>> ((addr & 2) * 8)) & 0xffff;
      case 0x02:
        return this.#read16From(this.ewram, addr & 0x3ffff);
      case 0x03:
        return this.#read16From(this.iwram, addr & 0x7fff);
      case 0x04:
        return this.#mmioRead16(addr);
      case 0x05:
        return this.#read16From(this.palette, addr & 0x3ff);
      case 0x06: {
        const offset = this.#vramOffset(addr);
        return offset < 0 ? 0 : this.#read16From(this.vram, offset);
      }
      case 0x07:
        return this.#read16From(this.oam, addr & 0x3ff);
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
      case 0x0c:
        return this.#readRom16(addr);
      case 0x0d:
        // EEPROM serial read — return data bit in bit 0
        return this.#eeprom.read();
      case 0x0e:
      case 0x0f: {
        // The save chip sits on an 8-bit bus: a wider read returns its byte on every lane
        const byte = this.#readSave8(address);
        return byte | (byte << 8);
      }
      default:
        return (this.#openBus() >>> ((addr & 2) * 8)) & 0xffff;
    }
  }

  read32(address: number): number {
    const value = this.#read32(address);
    if (this.#readWatchpoints.length > 0) {
      // `#read32` assembles with `<< 24`, so its result is signed; watchpoints
      // report the loaded word unsigned, as the write side does.
      this.#notifyRead(this.#canonicalAddress(address & ~3), value >>> 0, 4);
    }
    return value;
  }

  #read32(address: number): number {
    const addr = address & ~3; // Force word alignment
    const region = (addr >>> 24) & 0xff;
    switch (region) {
      case 0x00:
        return this.#readBios32(addr);
      case 0x02:
        return this.#read32From(this.ewram, addr & 0x3ffff);
      case 0x03:
        return this.#read32From(this.iwram, addr & 0x7fff);
      case 0x04:
        return this.#mmioRead32(addr);
      case 0x05:
        return this.#read32From(this.palette, addr & 0x3ff);
      case 0x06: {
        const offset = this.#vramOffset(addr);
        return offset < 0 ? 0 : this.#read32From(this.vram, offset);
      }
      case 0x07:
        return this.#read32From(this.oam, addr & 0x3ff);
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
      case 0x0c:
        return this.#readRom32(addr);
      case 0x0d:
        // EEPROM serial read
        return this.#eeprom.read();
      case 0x0e:
      case 0x0f: {
        // The save chip sits on an 8-bit bus: a wider read returns its byte on every lane
        const byte = this.#readSave8(address);
        return (byte | (byte << 8) | (byte << 16) | (byte << 24)) >>> 0;
      }
      default:
        return this.#openBus();
    }
  }

  write8(address: number, value: number): void {
    const region = (address >>> 24) & 0xff;
    let committed = true;
    switch (region) {
      case 0x02:
        this.ewram[address & 0x3ffff] = value;
        break;
      case 0x03:
        this.iwram[address & 0x7fff] = value;
        break;
      case 0x04:
        this.onMmioWrite?.(address >>> 0, value & 0xff, 1);
        this.#mmioWrite8(address, value);
        break;
      case 0x05:
        // Palette: 8-bit writes duplicate the byte to both halves
        {
          const a = address & 0x3fe;
          this.palette[a] = value;
          this.palette[a + 1] = value;
        }
        break;
      case 0x06:
        // VRAM: an 8-bit write stores the byte on both halves of its halfword in BG VRAM,
        // and OBJ VRAM drops it.
        {
          const a = this.#vramOffset(address);
          if (a < 0 || a >= this.#objVramBoundary()) {
            committed = false;
            break;
          }
          const aligned = a & ~1;
          this.vram[aligned] = value;
          this.vram[aligned + 1] = value;
        }
        break;
      case 0x0e:
      case 0x0f:
        committed = this.#writeSave8(address, value & 0xff);
        break;
      // OAM (0x07) ignores 8-bit writes; ROM/BIOS/unmapped regions are read-only.
      default:
        committed = false;
        break;
    }
    if (committed && this.#watchpoints.length > 0) {
      this.#notifyWrite(this.#canonicalAddress(address), value & 0xff, 1);
    }
  }

  write16(address: number, value: number): void {
    const addr = address & ~1;
    const region = (addr >>> 24) & 0xff;
    let committed = true;
    switch (region) {
      case 0x02:
        this.#write16To(this.ewram, addr & 0x3ffff, value);
        break;
      case 0x03:
        this.#write16To(this.iwram, addr & 0x7fff, value);
        break;
      case 0x04:
        this.onMmioWrite?.(addr >>> 0, value & 0xffff, 2);
        this.#mmioWrite16(addr, value);
        break;
      case 0x05:
        this.#write16To(this.palette, addr & 0x3ff, value);
        break;
      case 0x06: {
        const offset = this.#vramOffset(addr);
        if (offset < 0) {
          committed = false;
          break;
        }
        this.#write16To(this.vram, offset, value);
        break;
      }
      case 0x07:
        this.#write16To(this.oam, addr & 0x3ff, value);
        break;
      case 0x0d:
        // EEPROM serial write — only bit 0 matters; serial port, no addressable byte.
        this.#eeprom.write(value & 1);
        committed = false;
        break;
      case 0x0e:
      case 0x0f:
        // The save chip sits on an 8-bit bus: a halfword store hands it the byte on the lane A0
        // selects (mGBA GBAStore16: `if (address & 1) value >>= 8`).
        committed = this.#writeSave8(address, (value >>> ((address & 1) * 8)) & 0xff);
        break;
      // ROM/BIOS/unmapped regions are read-only.
      default:
        committed = false;
        break;
    }
    if (committed && this.#watchpoints.length > 0) {
      this.#notifyWrite(this.#canonicalAddress(addr), value & 0xffff, 2);
    }
  }

  write32(address: number, value: number): void {
    const addr = address & ~3;
    const region = (addr >>> 24) & 0xff;
    let committed = true;
    switch (region) {
      case 0x02:
        this.#write32To(this.ewram, addr & 0x3ffff, value);
        break;
      case 0x03:
        this.#write32To(this.iwram, addr & 0x7fff, value);
        break;
      case 0x04:
        this.onMmioWrite?.(addr >>> 0, value >>> 0, 4);
        this.#mmioWrite32(addr, value);
        break;
      case 0x05:
        this.#write32To(this.palette, addr & 0x3ff, value);
        break;
      case 0x06: {
        const offset = this.#vramOffset(addr);
        if (offset < 0) {
          committed = false;
          break;
        }
        this.#write32To(this.vram, offset, value);
        break;
      }
      case 0x07:
        this.#write32To(this.oam, addr & 0x3ff, value);
        break;
      case 0x0d:
        // EEPROM serial write — serial port, no addressable byte.
        this.#eeprom.write(value & 1);
        committed = false;
        break;
      case 0x0e:
      case 0x0f:
        // The save chip sits on an 8-bit bus: a word store hands it the byte on the lane A1-A0
        // select (mGBA STORE_SRAM: `value >> (8 * (address & 3))`).
        committed = this.#writeSave8(address, (value >>> ((address & 3) * 8)) & 0xff);
        break;
      // ROM/BIOS/unmapped regions are read-only.
      default:
        committed = false;
        break;
    }
    if (committed && this.#watchpoints.length > 0) {
      this.#notifyWrite(this.#canonicalAddress(addr), value >>> 0, 4);
    }
  }

  // ─── Cartridge Save Window (0x0E) ─────────────────────────────────

  /** Whether a chip answers in the 0x0E window: SRAM and flash do, EEPROM is serial on 0x0D. */
  #hasSaveWindow(): boolean {
    return this.#save.type === 'sram' || this.#flash.size > 0;
  }

  /**
   * The byte the chip behind the 0x0E window drives at `address`: SRAM mirrored every
   * 32 KB, the flash chip by its protocol, and 0xFF when no chip answers (mGBA GBALoad8,
   * jsmolka gba-tests save/none).
   */
  #readSave8(address: number): number {
    if (this.#save.type === 'sram') {
      return this.sram[address & (SRAM_BYTES - 1)]!;
    }
    return this.#flash.size > 0 ? this.#flash.read8(address) : 0xff;
  }

  /** Hand one byte to the chip behind the 0x0E window; false when no chip takes it. */
  #writeSave8(address: number, value: number): boolean {
    if (this.#save.type === 'sram') {
      this.sram[address & (SRAM_BYTES - 1)] = value;
      return true;
    }
    if (this.#flash.size > 0) {
      this.#flash.write8(address, value);
      return true;
    }
    return false;
  }

  // ─── Access Timing ────────────────────────────────────────────────

  accessCycles(address: number, width: 1 | 2 | 4, sequential: boolean): number {
    const region = address >>> 24;
    if (width === 4) {
      return sequential ? this.#cyclesS32[region]! : this.#cyclesN32[region]!;
    }
    return sequential ? this.#cyclesS16[region]! : this.#cyclesN16[region]!;
  }

  /** An opcode fetch costs what a data access does; a nonsequential one (a branch) empties the prefetch buffer. */
  fetchCycles(address: number, width: 2 | 4, sequential: boolean): number {
    if (!sequential) {
      this.#prefetchEnd = 0;
    }
    return this.accessCycles(address, width, sequential);
  }

  /**
   * The game pak prefetch buffer (GBATEK "GBA GamePak Prefetch"): while code runs from ROM with
   * WAITCNT bit 14 set, the cartridge fetches the next opcodes, up to 8 halfwords, during any cycle
   * the CPU leaves the cartridge bus alone. Those opcodes then come out of the buffer without wait
   * states. This prices that the way mGBA's GBAMemoryStall does: the cycles of the stall go to
   * sequential halfword fetches past `fetchAddress`, the stall lasts at least as long as they do,
   * the fetch after it becomes sequential, and the fetches the buffer completed are refunded now,
   * since the CPU pays for each one as it executes it.
   */
  stallCycles(cycles: number, fetchAddress: number, dataAddress?: number): number {
    const codeRegion = fetchAddress >>> 24;
    if (
      (this.#waitcnt & WAITCNT_PREFETCH) === 0 ||
      fetchAddress < CARTRIDGE_BASE ||
      codeRegion >= SRAM_REGION ||
      (dataAddress !== undefined && dataAddress >>> 0 >= CARTRIDGE_BASE)
    ) {
      return cycles;
    }
    const seqWaits = this.#cyclesS16[codeRegion]! - 1;
    const nonseqWaits = this.#cyclesN16[codeRegion]! - 1;

    // Halfwords already buffered ahead of the fetch take room in the buffer.
    let buffered = 0;
    let room = PREFETCH_HALFWORDS;
    const ahead = (this.#prefetchEnd - fetchAddress) >>> 0;
    if (ahead < PREFETCH_HALFWORDS * 2) {
      buffered = ahead >>> 1;
      room -= buffered;
    }

    let stall = seqWaits + 1;
    let loads = 1;
    while (stall < cycles && loads < room) {
      stall += seqWaits;
      loads++;
    }
    this.#prefetchEnd = (fetchAddress + 2 * (loads + buffered - 1)) >>> 0;

    return Math.max(cycles, stall) - (nonseqWaits - seqWaits) - stall;
  }

  /**
   * Rebuild the access prices from WAITCNT and memory control. EWRAM takes 15 minus memory control
   * bits 24-27 waits (GBATEK "Memory Control"; the BIOS's 0x0D gives 2); the value 15 locks the
   * console up, and the bus keeps the fastest timing, 1 wait, there.
   */
  #updateWaitStates(): void {
    const n16 = this.#cyclesN16;
    const s16 = this.#cyclesS16;
    const n32 = this.#cyclesN32;
    const s32 = this.#cyclesS32;
    n16.fill(1);
    s16.fill(1);
    n32.fill(1);
    s32.fill(1);

    const ewramWaits = Math.max(1, 15 - ((this.#memoryControl >>> 24) & 0xf));
    n16[0x02] = s16[0x02] = 1 + ewramWaits;
    n32[0x02] = s32[0x02] = 2 * (1 + ewramWaits);
    for (const region of [0x05, 0x06]) {
      n32[region] = s32[region] = 2;
    }

    const waitcnt = this.#waitcnt;
    for (let ws = 0; ws < 3; ws++) {
      const n = 1 + ROM_N_WAITS[(waitcnt >>> (2 + ws * 3)) & 3]!;
      const s = 1 + ROM_S_WAITS[ws]![(waitcnt >>> (4 + ws * 3)) & 1]!;
      for (const region of [0x08 + ws * 2, 0x09 + ws * 2]) {
        n16[region] = n;
        s16[region] = s;
        n32[region] = n + s;
        s32[region] = 2 * s;
      }
    }

    const sram = 1 + ROM_N_WAITS[waitcnt & 3]!;
    for (const region of [SRAM_REGION, SRAM_REGION + 1]) {
      n16[region] = s16[region] = sram;
      n32[region] = s32[region] = 2 * sram;
    }
  }

  // ─── Open Bus ─────────────────────────────────────────────────────

  /**
   * What a read of unmapped memory returns: the bus still carries the CPU's last instruction
   * fetch (GBATEK "GBA Unpredictable Things"; mGBA GBALoadBad; NanoBoyAdvance Bus::ReadOpenBus).
   * In ARM state that is [$+8]. In Thumb state the fetch is the halfword [$+4], and the other half
   * of the word comes from the bus the code runs from: a 16-bit bus repeats [$+4], the 32-bit BIOS
   * and OAM buses and IWRAM keep the neighbouring halfword of the same word.
   */
  #openBus(): number {
    const cpu = this.#cpu;
    const fetched = cpu.prefetchedOpcode;
    if ((cpu.cpsr & CPSR_THUMB) === 0) {
      return fetched >>> 0;
    }
    // registers[15] is $+2 while the instruction at $ executes
    const pc = (cpu.registers[15]! - 2) >>> 0;
    const decoded = cpu.decodedOpcode;
    switch (pc >>> 24) {
      case 0x00:
      case 0x07: {
        if (pc & 2) {
          return (decoded | (fetched << 16)) >>> 0; // [$+2], [$+4]
        }
        const next =
          pc >>> 24 === 0x00
            ? this.#read16From(this.#bios, (pc + 6) & 0x3ffe)
            : this.#read16From(this.oam, (pc + 6) & 0x3fe);
        return (fetched | (next << 16)) >>> 0; // [$+4], [$+6]
      }
      case 0x03:
        return pc & 2 ? (decoded | (fetched << 16)) >>> 0 : (fetched | (decoded << 16)) >>> 0;
      default:
        return (fetched | (fetched << 16)) >>> 0;
    }
  }

  /** The open-bus halfword on the lane `address` selects. */
  #openBus16(address: number): number {
    return (this.#openBus() >>> ((address & 2) * 8)) & 0xffff;
  }

  // ─── BIOS Access ──────────────────────────────────────────────────

  /**
   * The BIOS word at `address` (word-aligned). The BIOS answers only while the CPU executes in
   * it, and each such read sets the protection latch; a read from code anywhere else returns the
   * latch (GBATEK "BIOS Memory"; NanoBoyAdvance Bus::ReadBIOS). Past 16 KB nothing answers.
   */
  #readBios32(address: number): number {
    if (address >= BIOS_SIZE) {
      return this.#openBus();
    }
    if (this.#cpuInBios()) {
      this.#biosLatch = this.#read32From(this.#bios, address);
    }
    return this.#biosLatch;
  }

  /** Whether the CPU executes in the BIOS: registers[15], $+width while $ runs, is inside it. */
  #cpuInBios(): boolean {
    return this.#cpu.registers[15]! < BIOS_SIZE;
  }

  // ─── ROM Access ───────────────────────────────────────────────────

  // Past the end of the cartridge, nothing drives the shared address/data lines, and a halfword
  // read returns the low 16 bits of the halfword address that was latched on them:
  // (address / 2) & 0xFFFF (GBATEK "GBA Unpredictable Things"; mGBA LOAD_CART).

  #readRom8(address: number): number {
    const offset = address & 0x01ffffff;
    return offset < this.#rom.length ? this.#rom[offset]! : ((address >>> 1) >>> ((address & 1) * 8)) & 0xff;
  }

  #readRom16(address: number): number {
    const offset = address & 0x01fffffe;
    if (offset + 1 < this.#rom.length) {
      return this.#rom[offset]! | (this.#rom[offset + 1]! << 8);
    }
    return (address >>> 1) & 0xffff;
  }

  #readRom32(address: number): number {
    const offset = address & 0x01fffffc;
    if (offset + 3 < this.#rom.length) {
      return (
        (this.#rom[offset]! |
          (this.#rom[offset + 1]! << 8) |
          (this.#rom[offset + 2]! << 16) |
          (this.#rom[offset + 3]! << 24)) >>>
        0
      );
    }
    return (((address >>> 1) & 0xffff) | (((address + 2) >>> 1) << 16)) >>> 0;
  }

  // ─── VRAM Mirroring ───────────────────────────────────────────────

  /**
   * Canonical (un-mirrored) address of the byte an access touches, so a read or write
   * through a region mirror matches watchpoints registered on the canonical address.
   */
  #canonicalAddress(address: number): number {
    switch ((address >>> 24) & 0xff) {
      case 0x02:
        return (0x02000000 | (address & 0x3ffff)) >>> 0;
      case 0x03:
        return (0x03000000 | (address & 0x7fff)) >>> 0;
      case 0x05:
        return (0x05000000 | (address & 0x3ff)) >>> 0;
      case 0x06: {
        const offset = this.#vramOffset(address);
        return offset < 0 ? address >>> 0 : (0x06000000 | offset) >>> 0;
      }
      case 0x07:
        return (0x07000000 | (address & 0x3ff)) >>> 0;
      case 0x0e:
      case 0x0f:
        return (0x0e000000 | (address & ((this.#save.type === 'sram' ? SRAM_BYTES : FLASH_BANK_BYTES) - 1))) >>> 0;
      default:
        return address >>> 0;
    }
  }

  /** Where OBJ VRAM starts: 0x10000 in the tile modes (0-2), 0x14000 in the bitmap modes (3-5). */
  #objVramBoundary(): number {
    return (this.mmioRegisters[0]! & 7) >= 3 ? 0x14000 : 0x10000;
  }

  /**
   * The VRAM byte `address` selects, or -1 where nothing answers. VRAM is 96 KB in a 128 KB
   * window: 0x18000-0x1FFFF mirrors the 32 KB OBJ area at 0x10000-0x17FFF. In the bitmap modes
   * the frame buffers reach 0x14000, and the first half of that mirror, 0x18000-0x1BFFF, would land
   * on bitmap memory below the OBJ boundary; there reads return 0 and writes are dropped
   * (mGBA LOAD_VRAM/STORE_VRAM; NanoBoyAdvance ReadVRAM_OBJ).
   */
  #vramOffset(address: number): number {
    const offset = address & 0x1ffff;
    if (offset < 0x18000) {
      return offset;
    }
    if (offset < 0x1c000 && this.#objVramBoundary() === 0x14000) {
      return -1;
    }
    return offset - 0x8000;
  }

  // ─── I/O Registers ────────────────────────────────────────────────

  // I/O sits on a 16-bit bus, so every access reaches a register through #ioRead16 and #ioWrite16
  // whatever its width: a byte access drives one byte lane of the halfword, and a word access two
  // halfwords (GBATEK "GBA I/O Map"; mGBA GBAIOWrite8/GBAIOWrite32). A register owned by a
  // subsystem is decoded by that subsystem; display registers live in mmioRegisters.

  /** Whether `offset` (into the I/O region) decodes to a register. */
  #isIoMapped(offset: number): boolean {
    return offset < IO_SIZE || (offset & 0xfffc) === MEMORY_CONTROL;
  }

  #mmioRead8(address: number): number {
    return (this.#ioRead16(address & 0x00fffffe, false) >>> ((address & 1) * 8)) & 0xff;
  }

  #mmioRead16(address: number): number {
    return this.#ioRead16(address & 0x00fffffe, false);
  }

  #mmioRead32(address: number): number {
    const offset = address & 0x00fffffc;
    return (this.#ioRead16(offset, false) | (this.#ioRead16(offset + 2, false) << 16)) >>> 0;
  }

  /**
   * The I/O halfword at `offset` (even) as the CPU reads it. With `peek`, as a debugger sees it:
   * the same value without side effects, the last write for a write-only register, and 0 where
   * the CPU would read open bus.
   */
  #ioRead16(offset: number, peek: boolean): number {
    if (offset >= IO_SIZE) {
      if ((offset & 0xfffc) === MEMORY_CONTROL) {
        return (this.#memoryControl >>> ((offset & 2) * 8)) & 0xffff;
      }
      return peek ? 0 : this.#openBus16(offset);
    }
    switch (IO_BASE | offset) {
      case MMIO.DISPSTAT:
        return this.#display.readDispstat();
      case MMIO.VCOUNT:
        return this.#display.readVcount();
      case MMIO.KEYINPUT:
        return this.#input.readKeyInput();
      case MMIO.KEYCNT:
        return this.#input.readKeyCnt();
      case MMIO.IE:
        return this.#interrupts.readIe();
      case MMIO.IF:
        return this.#interrupts.readIf();
      case MMIO.IME:
        return this.#interrupts.readIme();
      case MMIO.WAITCNT:
        return this.#waitcnt;
      case MMIO.POSTFLG:
        return this.#postflg; // HALTCNT, the high byte, reads 0
    }
    if (offset >= TIMERS_FIRST && offset < TIMERS_END) {
      const index = (offset - TIMERS_FIRST) >> 2;
      return offset & 2 ? this.#timers.readControl(index) : this.#timers.readCounter(index);
    }
    if (offset >= DMA_FIRST && offset < DMA_END) {
      return this.#dmaRead16(offset, peek);
    }
    if (isApuRegister(offset)) {
      return this.#apu.readRegister16(offset);
    }
    if (isSerialRegister(offset)) {
      return this.#serial.read16(offset);
    }
    const mask = IO_READ_MASKS[offset >> 1]!;
    if (mask >= 0) {
      return this.#latch16(offset) & mask;
    }
    if (peek) {
      return mask === WRITE_ONLY ? this.#latch16(offset) : 0;
    }
    return this.#openBus16(offset);
  }

  /** DMA registers: SAD and DAD are write-only, CNT_L reads 0, CNT_H is readable (GBATEK "DMA Transfers"). */
  #dmaRead16(offset: number, peek: boolean): number {
    const index = ((offset - DMA_FIRST) / 12) | 0;
    const register = (offset - DMA_FIRST) % 12;
    switch (register) {
      case 0:
      case 2:
        return peek ? (this.#dma.readSrcLatch(index) >>> (register * 8)) & 0xffff : this.#openBus16(offset);
      case 4:
      case 6:
        return peek ? (this.#dma.readDstLatch(index) >>> ((register - 4) * 8)) & 0xffff : this.#openBus16(offset);
      case 8:
        return peek ? this.#dma.readWordCountLatch(index) : 0;
      default:
        return this.#dma.readControl(index);
    }
  }

  /** The halfword the register file holds at `offset`. */
  #latch16(offset: number): number {
    return this.mmioRegisters[offset]! | (this.mmioRegisters[offset + 1]! << 8);
  }

  #mmioWrite8(address: number, value: number): void {
    const byte = value & 0xff;
    this.#ioWrite16(address & 0x00fffffe, byte | (byte << 8), address & 1 ? 0xff00 : 0x00ff);
  }

  #mmioWrite16(address: number, value: number): void {
    this.#ioWrite16(address & 0x00fffffe, value & 0xffff, 0xffff);
  }

  #mmioWrite32(address: number, value: number): void {
    const offset = address & 0x00fffffc;
    // The sound FIFOs take a whole word at once.
    if (offset === FIFO_A || offset === FIFO_B) {
      this.#storeLatch(offset, value & 0xffff, 0xffff);
      this.#storeLatch(offset + 2, value >>> 16, 0xffff);
      this.#apu.writeRegister32(offset, value);
      return;
    }
    this.#ioWrite16(offset, value & 0xffff, 0xffff);
    this.#ioWrite16(offset + 2, value >>> 16, 0xffff);
  }

  /**
   * Write the byte lanes `mask` selects of the I/O halfword at `offset` (even). The register keeps
   * its other byte: each case merges the written lanes into what the register holds and hands its
   * owner the whole halfword. The owners whose bytes act on their own (IF, the serial port, the
   * sound registers) take the written lanes instead.
   */
  #ioWrite16(offset: number, value: number, mask: number): void {
    if (offset >= IO_SIZE) {
      if ((offset & 0xfffc) === MEMORY_CONTROL) {
        const shift = (offset & 2) * 8;
        this.#memoryControl = (merge(this.#memoryControl, value << shift, mask << shift) & MEMORY_CONTROL_MASK) >>> 0;
        this.#updateWaitStates();
      }
      return;
    }
    switch (IO_BASE | offset) {
      case MMIO.DISPSTAT:
        this.#display.writeDispstat(merge(this.#display.readDispstat(), value, mask));
        return;
      case MMIO.VCOUNT:
      case MMIO.KEYINPUT:
        return; // read-only
      case MMIO.KEYCNT:
        this.#input.writeKeyCnt(merge(this.#input.readKeyCnt(), value, mask));
        return;
      case MMIO.IE:
        this.#interrupts.writeIe(merge(this.#interrupts.readIe(), value, mask));
        return;
      case MMIO.IF:
        // Writing 1 acknowledges, so the lanes not written acknowledge nothing.
        this.#interrupts.writeIf(value & mask);
        return;
      case MMIO.IME:
        this.#interrupts.writeIme(merge(this.#interrupts.readIme(), value, mask));
        return;
      case MMIO.WAITCNT:
        this.#waitcnt = merge(this.#waitcnt, value, mask) & 0x5fff;
        this.#updateWaitStates();
        return;
      case MMIO.POSTFLG:
        // Two byte registers only BIOS code can write: POSTFLG, which the boot code sets once, and
        // HALTCNT, whose bit 7 picks Stop over Halt (GBATEK "System Control"; NanoBoyAdvance
        // io.cc and mGBA io.c take these writes only while the CPU executes in the BIOS).
        if (!this.#cpuInBios()) {
          return;
        }
        if (mask & 0x00ff) {
          this.#postflg |= value & 1;
        }
        if (mask & 0xff00) {
          if (value & 0x8000) {
            this.#interrupts.stop();
          } else {
            this.#interrupts.halt();
          }
        }
        return;
    }
    if (offset >= TIMERS_FIRST && offset < TIMERS_END) {
      const index = (offset - TIMERS_FIRST) >> 2;
      if (offset & 2) {
        this.#timers.writeControl(index, merge(this.#timers.readControl(index), value, mask));
      } else {
        this.#timers.writeReload(index, merge(this.#timers.readReload(index), value, mask));
      }
      return;
    }
    if (offset >= DMA_FIRST && offset < DMA_END) {
      this.#dmaWrite16(offset, value, mask);
      return;
    }
    if (isApuRegister(offset)) {
      this.#apuWrite16(offset, value, mask);
      return;
    }
    if (isSerialRegister(offset)) {
      // JOYCNT mixes acknowledge-on-1 flags with a read/write bit, so the port takes the lanes.
      this.#serial.write16(offset, value, mask);
      return;
    }
    if (offset >= FIFO_A && offset < FIFO_A + 8) {
      this.#storeLatch(offset, value, mask);
      this.#apuWrite16(offset, value, mask);
      return;
    }
    if (IO_READ_MASKS[offset >> 1] === UNUSED) {
      return;
    }
    this.#storeLatch(offset, value, mask);
    // A write to BG2X/BG2Y/BG3X/BG3Y, of any width, reloads the PPU's internal reference point
    // (how per-scanline affine effects like Mode 7 floors work).
    if (offset >= 0x28 && offset <= 0x2e) {
      this.onBgRefPointWrite?.(2, offset < 0x2c);
    } else if (offset >= 0x38 && offset <= 0x3e) {
      this.onBgRefPointWrite?.(3, offset < 0x3c);
    }
  }

  /**
   * Sound registers and FIFOs: each byte has its own effect (a store to NRx3 sets frequency bits
   * only, and only the NRx4 byte restarts a channel), so the APU takes the lanes written at their
   * own width rather than a merged halfword (mGBA io.c GBAIOWrite8).
   */
  #apuWrite16(offset: number, value: number, mask: number): void {
    if (mask === 0xffff) {
      this.#apu.writeRegister16(offset, value);
    } else if (mask === 0x00ff) {
      this.#apu.writeRegister8(offset, value & 0xff);
    } else {
      this.#apu.writeRegister8(offset + 1, value >>> 8);
    }
  }

  /** DMA registers: SAD and DAD are 32-bit latches written a halfword at a time. */
  #dmaWrite16(offset: number, value: number, mask: number): void {
    const index = ((offset - DMA_FIRST) / 12) | 0;
    const register = (offset - DMA_FIRST) % 12;
    switch (register) {
      case 0:
      case 2: {
        const shift = register * 8;
        this.#dma.writeSrcAddr(index, merge(this.#dma.readSrcLatch(index), value << shift, mask << shift));
        return;
      }
      case 4:
      case 6: {
        const shift = (register - 4) * 8;
        this.#dma.writeDstAddr(index, merge(this.#dma.readDstLatch(index), value << shift, mask << shift));
        return;
      }
      case 8:
        this.#dma.writeWordCount(index, merge(this.#dma.readWordCountLatch(index), value, mask));
        return;
      default:
        this.#dma.writeControl(index, merge(this.#dma.readControl(index), value, mask));
        return;
    }
  }

  /** Merge the written lanes into the register file's halfword at `offset`; returns the halfword. */
  #storeLatch(offset: number, value: number, mask: number): number {
    const halfword = merge(this.#latch16(offset), value, mask);
    this.mmioRegisters[offset] = halfword & 0xff;
    this.mmioRegisters[offset + 1] = halfword >>> 8;
    return halfword;
  }

  // ─── Byte Array Helpers ───────────────────────────────────────────

  #read16From(arr: Uint8Array, offset: number): number {
    return arr[offset]! | (arr[offset + 1]! << 8);
  }

  #read32From(arr: Uint8Array, offset: number): number {
    // `>>> 0`: a word with bit 31 set would otherwise be a negative number, and a
    // caller comparing it against an opcode or a search value would never match.
    return (arr[offset]! | (arr[offset + 1]! << 8) | (arr[offset + 2]! << 16) | (arr[offset + 3]! << 24)) >>> 0;
  }

  #write16To(arr: Uint8Array, offset: number, value: number): void {
    arr[offset] = value & 0xff;
    arr[offset + 1] = (value >> 8) & 0xff;
  }

  #write32To(arr: Uint8Array, offset: number, value: number): void {
    arr[offset] = value & 0xff;
    arr[offset + 1] = (value >> 8) & 0xff;
    arr[offset + 2] = (value >> 16) & 0xff;
    arr[offset + 3] = (value >> 24) & 0xff;
  }

  /** Serialize to a plain snapshot (excludes bios and rom). */
  serialize(): SystemBusSnapshot {
    return {
      ewram: new Uint8Array(this.ewram),
      iwram: new Uint8Array(this.iwram),
      palette: new Uint8Array(this.palette),
      vram: new Uint8Array(this.vram),
      oam: new Uint8Array(this.oam),
      sram: new Uint8Array(this.sram),
      mmioRegisters: new Uint8Array(this.mmioRegisters),
      hasSram: this.#hasSaveWindow(),
      waitcnt: this.#waitcnt,
      postflg: this.#postflg,
      lastBiosRead: this.#biosLatch,
      memoryControl: this.#memoryControl,
      prefetchEnd: this.#prefetchEnd,
      eeprom: this.#eeprom.serialize(),
      flash: this.#flash.serialize(),
    };
  }

  /** Restore from a snapshot. BIOS and ROM must already be loaded. */
  deserialize(snap: SystemBusSnapshot): void {
    this.ewram.set(snap.ewram);
    this.iwram.set(snap.iwram);
    this.palette.set(snap.palette);
    this.vram.set(snap.vram);
    this.oam.set(snap.oam);
    this.sram.set(snap.sram.subarray(0, SRAM_BYTES));
    this.mmioRegisters.set(snap.mmioRegisters);
    // `snap.hasSram` is passed over: what is behind the 0x0E window is the cartridge's to
    // say, like #rom, and a state of a cartridge without one must not take this one's away.
    // A snapshot from before the flash chip kept a flash cartridge's bytes in `sram`.
    this.#flash.deserialize(snap.flash ?? { data: snap.sram, unlock: 0, command: 0, bank: 0 });
    this.#waitcnt = snap.waitcnt;
    this.#postflg = snap.postflg;
    this.#biosLatch = snap.lastBiosRead >>> 0;
    this.#memoryControl = snap.memoryControl ?? MEMORY_CONTROL_RESET;
    this.#prefetchEnd = snap.prefetchEnd ?? 0;
    this.#updateWaitStates();
    this.#eeprom.deserialize(snap.eeprom);
  }

  /** Reset all memory and registers */
  reset(): void {
    this.ewram.fill(0);
    this.iwram.fill(0);
    this.palette.fill(0);
    this.vram.fill(0);
    this.oam.fill(0);
    this.sram.fill(ERASED_BYTE);
    this.#eeprom.reset();
    this.#flash.reset();
    this.mmioRegisters.set(powerOnIoRegisters());
    this.#waitcnt = 0;
    this.#postflg = 0;
    this.#biosLatch = BIOS_LATCH_AFTER_BOOT;
    this.#memoryControl = MEMORY_CONTROL_RESET;
    this.#prefetchEnd = 0;
    this.#updateWaitStates();
  }
}

// ─── EEPROM ───────────────────────────────────────────────────────────

/**
 * GBA EEPROM — Serial EEPROM accessed via DMA at address region 0x0D.
 *
 * Supports both 4Kbit (512 bytes, 6-bit address) and 64Kbit (8KB, 14-bit address).
 * Which of the two a cartridge is, only the cartridge says: the length of the read
 * request it makes carries the address width, and a write takes 4Kbit until a read
 * has said otherwise.
 *
 * Protocol:
 * - Write command: 1,0, <address>, <64 data bits>, 0 (stop)
 * - Read command:  1,1, <address>, 0 (stop)
 * - Read response: 4 dummy bits, then 64 data bits
 */
const enum EepromState {
  Idle = 0,
  ReceivingCommand = 1,
  ReceivingAddress = 2,
  ReceivingData = 3,
  ReceivingStopBit = 4,
  SendingData = 5,
  WriteReady = 6,
}

class GbaEeprom {
  /** EEPROM data — 8KB max (64Kbit). 4Kbit uses only first 512 bytes. */
  readonly #data = new Uint8Array(EEPROM_BYTES);

  /** Address bit length: 6 for 4Kbit, 14 for 64Kbit. 0 = not yet detected. */
  #addrBits = 0;

  /** How long an installed `.sav` was, which stands in for the chip's size until a transfer settles it. */
  #installedBytes = 0;

  #state: EepromState = EepromState.Idle;
  #command = 0; // 0=write, 1=read
  #address = 0;
  #bitBuffer = 0n; // 64-bit data buffer
  #bitsReceived = 0;
  #sendBuffer = 0n;
  #sendPos = 0;

  reset(): void {
    this.#data.fill(0xff); // EEPROM defaults to all 1s
    this.#addrBits = 0;
    this.#installedBytes = 0;
    this.#idle();
  }

  /** Nothing in flight on the serial line: no half-clocked command carries over. */
  #idle(): void {
    this.#state = EepromState.Idle;
    this.#command = 0;
    this.#address = 0;
    this.#bitBuffer = 0n;
    this.#bitsReceived = 0;
    this.#sendBuffer = 0n;
    this.#sendPos = 0;
  }

  serialize(): EepromSnapshot {
    return {
      data: new Uint8Array(this.#data),
      addrBits: this.#addrBits,
      installedBytes: this.#installedBytes,
      state: this.#state,
      command: this.#command,
      address: this.#address,
      bitBuffer: this.#bitBuffer.toString(),
      bitsReceived: this.#bitsReceived,
      sendBuffer: this.#sendBuffer.toString(),
      sendPos: this.#sendPos,
    };
  }

  deserialize(snap: EepromSnapshot): void {
    this.#data.set(snap.data);
    this.#addrBits = snap.addrBits;
    this.#installedBytes = snap.installedBytes ?? 0;
    this.#state = snap.state as EepromState;
    this.#command = snap.command;
    this.#address = snap.address;
    this.#bitBuffer = BigInt(snap.bitBuffer);
    this.#bitsReceived = snap.bitsReceived;
    this.#sendBuffer = BigInt(snap.sendBuffer);
    this.#sendPos = snap.sendPos;
  }

  /**
   * How many bytes this chip holds: 512 for a 4 Kbit cartridge, 8192 for a 64 Kbit one,
   * 0 while nothing has said which it is. The address width a transfer settles is what
   * says it; before any transfer there is only the length of the file someone installed,
   * which a padded `.sav` overstates — but overstating it is better than having no answer.
   */
  get saveBytes(): number {
    if (this.#addrBits !== 0) {
      return this.#addrBits === 6 ? 512 : EEPROM_BYTES;
    }
    return this.#installedBytes;
  }

  /** The chip's contents, as a `.sav` file holds them. */
  read8(): Uint8Array {
    return new Uint8Array(this.#data);
  }

  /**
   * Put a `.sav` in the chip, erased past its end and with nothing in flight on the
   * line. The address width is left where it was — a file's size is no evidence of it,
   * since a 4 Kbit save padded out to 8 KB is a file several emulators write, and a
   * width taken from one is a width the cartridge then has to be wrong about. Only the
   * length is kept, for `saveBytes` to answer with until a transfer settles the width.
   */
  install(bytes: Uint8Array): void {
    this.#data.fill(0xff);
    this.#data.set(bytes);
    this.#installedBytes = bytes.length;
    this.#idle();
  }

  /** Write a single bit to the EEPROM serial interface */
  write(bit: number): void {
    switch (this.#state) {
      case EepromState.Idle:
        if (bit === 1) {
          // Start bit received — next bit is the command
          this.#state = EepromState.ReceivingCommand;
          this.#bitsReceived = 0;
        }
        break;

      case EepromState.ReceivingCommand:
        this.#command = bit;
        this.#state = EepromState.ReceivingAddress;
        this.#address = 0;
        this.#bitsReceived = 0;
        break;

      case EepromState.ReceivingAddress: {
        this.#address = (this.#address << 1) | bit;
        this.#bitsReceived++;

        // A read's address phase ends when the game turns around and reads, so `read`
        // closes it and the transfer's own length says how wide the address was. A write
        // has 64 data bits behind the address and no such turn, so it needs the width up
        // front: whatever a read has settled, or 4 Kbit while no read has.
        if (this.#command === 1) {
          // no chip takes an address this long, so what is coming in is not a request: the
          // line goes idle for the next start bit to resync it, rather than swallowing
          // everything after a read the game never came back for
          if (this.#bitsReceived > 15) {
            this.#idle();
          }
          break;
        }
        if (this.#addrBits === 0) {
          this.#addrBits = 6;
        }
        if (this.#bitsReceived === this.#addrBits) {
          this.#finishAddressPhase();
        }
        break;
      }

      case EepromState.ReceivingData:
        this.#bitBuffer = (this.#bitBuffer << 1n) | BigInt(bit);
        this.#bitsReceived++;
        if (this.#bitsReceived === 64) {
          this.#state = EepromState.ReceivingStopBit;
        }
        break;

      case EepromState.ReceivingStopBit:
        // Stop bit received — execute the pending command
        if (this.#command === 0) {
          // Write: store 64 bits (8 bytes) at address * 8
          this.#executeWrite();
        }
        this.#state = EepromState.Idle;
        break;

      case EepromState.SendingData:
        // Writes during read phase are ignored
        break;

      case EepromState.WriteReady:
        // After write completion, return to idle on any write
        this.#state = EepromState.Idle;
        break;
    }
  }

  /** Read a single bit from the EEPROM serial interface */
  read(): number {
    if (this.#state === EepromState.ReceivingAddress && this.#command === 1) {
      this.#settleAddressWidth();
    }
    if (this.#state === EepromState.SendingData) {
      if (this.#sendPos < 4) {
        // First 4 bits are dummy (always 0)
        this.#sendPos++;
        return 0;
      }
      const bitIndex = 63 - (this.#sendPos - 4);
      const bit = Number((this.#sendBuffer >> BigInt(bitIndex)) & 1n);
      this.#sendPos++;
      if (this.#sendPos >= 68) {
        // Done sending — return to idle
        this.#state = EepromState.Idle;
      }
      return bit;
    }

    // When not in send mode, return 1 (ready)
    return 1;
  }

  /**
   * The game is reading back what it just clocked in, so its read request is whole and
   * its length is what says how wide this cartridge addresses: 9 bits of request for a
   * 4 Kbit chip, 17 for a 64 Kbit one, the last of them the stop bit. The cartridge has
   * the final word on the width, so this is where it is settled.
   *
   * A turnaround at any other count is not the end of a request at all — the line is
   * carrying something it lost the framing of — so the chip goes idle for the next start
   * bit to pick it up again, rather than staying in an address phase that then eats
   * every request after it.
   */
  #settleAddressWidth(): void {
    const width = this.#bitsReceived - 1;
    if (width !== 6 && width !== 14) {
      this.#idle();
      return;
    }
    this.#addrBits = width;
    this.#address = (this.#address >>> 1) & ((1 << width) - 1);
    this.#finishAddressPhase();
  }

  #finishAddressPhase(): void {
    if (this.#command === 1) {
      // Read command: prepare to send data
      this.#loadReadData();
      this.#state = EepromState.SendingData;
      this.#sendPos = 0;
    } else {
      // Write command: receive 64 data bits
      this.#state = EepromState.ReceivingData;
      this.#bitBuffer = 0n;
      this.#bitsReceived = 0;
    }
  }

  /**
   * The 64-bit word goes out most significant byte first and the GBA is little-endian,
   * so the byte the game sends first is the last of the eight in memory — which is
   * where a `.sav` file keeps it too, and why `#data` is one.
   */
  #loadReadData(): void {
    const byteAddr = this.#address * 8;
    this.#sendBuffer = 0n;
    for (let i = 7; i >= 0; i--) {
      const byte = this.#data[byteAddr + i] ?? 0xff;
      this.#sendBuffer = (this.#sendBuffer << 8n) | BigInt(byte);
    }
  }

  #executeWrite(): void {
    const byteAddr = this.#address * 8;
    if (byteAddr + 8 > this.#data.length) {
      this.#state = EepromState.WriteReady;
      return;
    }
    // the first byte the game clocked in is the last of the eight, the order
    // `#loadReadData` sends them back in and a `.sav` file keeps them
    for (let i = 0; i < 8; i++) {
      this.#data[byteAddr + i] = Number((this.#bitBuffer >> BigInt(i * 8)) & 0xffn);
    }
    this.#state = EepromState.WriteReady;
  }
}
