/**
 * GBA System Bus
 *
 * Implements MemoryBus and dispatches reads/writes to the
 * appropriate subsystem based on address ranges.
 *
 * Memory map:
 *   0x00000000-0x00003FFF  BIOS (16 KB)
 *   0x02000000-0x0203FFFF  EWRAM (256 KB)
 *   0x03000000-0x03007FFF  IWRAM (32 KB)
 *   0x04000000-0x040003FE  I/O Registers (MMIO)
 *   0x05000000-0x050003FF  Palette RAM (1 KB)
 *   0x06000000-0x06017FFF  VRAM (96 KB)
 *   0x07000000-0x070003FF  OAM (1 KB)
 *   0x08000000-0x09FFFFFF  Game Pak ROM (up to 32 MB)
 *   0x0E000000-0x0E00FFFF  Game Pak SRAM (64 KB)
 */
import type { MemoryBus } from '@gba-kit/arm-emulator';

import type { Apu } from './apu/apu.js';
import type { DmaController } from './dma.js';
import type { InputController } from './input.js';
import type { InterruptController } from './interrupts.js';
import type { EepromSnapshot, SystemBusSnapshot } from './savestate.js';
import type { TimerController } from './timers.js';
import { MMIO } from './types.js';
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

  /** Game Pak SRAM (64 KB) */
  readonly sram = new Uint8Array(0x10000);

  /** Game Pak EEPROM */
  readonly #eeprom = new GbaEeprom();

  /** Whether SRAM is present (auto-detected from ROM save type string) */
  #hasSram = false;

  /** WAITCNT register */
  #waitcnt = 0;

  /** POSTFLG register */
  #postflg = 0;

  /** Last BIOS read value (for open-bus protection) */
  #lastBiosRead = 0;

  // Subsystem references (set during GBA construction)
  #interrupts!: InterruptController;
  #timers!: TimerController;
  #dma!: DmaController;
  #input!: InputController;
  #apu!: Apu;

  /** Display control registers (written via MMIO, read by PPU) */
  readonly mmioRegisters = new Uint8Array(0x400);

  /** Callback when BG2/BG3 reference point registers are written (for PPU ref point reload) */
  onBgRefPointWrite?: (bgIndex: 2 | 3, isX: boolean) => void;

  /**
   * Data watchpoints. Each fires its callback whenever a write *commits* to a
   * byte in the range [start, end). Used to discover *which code* writes a given
   * address (reverse-engineering / decomp assist). Kept empty by default so the
   * write fast-path pays nothing until a watchpoint is set.
   */
  readonly #watchpoints: Array<{
    start: number;
    end: number;
    onWrite: (info: WatchpointWrite) => void;
  }> = [];

  /** DMA channel (0-3) currently transferring, or -1 for CPU writes; attributes hits. */
  #dmaChannel = -1;
  #dmaOrigin: WriteOrigin | null = null;

  /** Attribute subsequent committed writes to a DMA channel (called by the DMA controller). */
  setDmaSource(channel: number, origin: WriteOrigin): void {
    this.#dmaChannel = channel;
    this.#dmaOrigin = origin;
  }

  /** Return write attribution to the CPU. */
  clearDmaSource(): void {
    this.#dmaChannel = -1;
    this.#dmaOrigin = null;
  }

  /**
   * Register a write watchpoint over [address, address+length). Returns a
   * disposer that removes it. A length < 1 is clamped to 1 so the start byte is
   * always watched (rather than silently matching nothing).
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

  /** Remove every registered watchpoint. */
  clearWriteWatchpoints(): void {
    this.#watchpoints.length = 0;
  }

  /** Whether any data watchpoint is currently registered (cheap hot-path gate). */
  hasWatchpoints(): boolean {
    return this.#watchpoints.length > 0;
  }

  /**
   * Notify any watchpoints overlapping a *committed* write of `value` (already
   * masked to `size` bytes) at the canonical aligned base `base`. Hot-path:
   * early-out when no watchpoints, and avoid allocating in the common
   * single-watchpoint case; only snapshot when several exist (so a callback may
   * dispose/clear mid-notify without corrupting iteration).
   */
  #notifyWrite(base: number, value: number, size: number): void {
    const wps = this.#watchpoints;
    const lo = base >>> 0;
    const hi = (lo + size) >>> 0;
    const dmaChannel = this.#dmaChannel;
    const dmaOrigin = this.#dmaOrigin;
    // Snapshot only when several watchpoints exist, so a callback may dispose/clear
    // mid-notify without corrupting iteration (the single-watchpoint case is alloc-free).
    const list = wps.length === 1 ? wps : wps.slice();
    for (const wp of list) {
      if (lo < wp.end && hi > wp.start) {
        // Report the specific watched byte within the access, not the access base.
        const address = (lo > wp.start ? lo : wp.start) >>> 0;
        wp.onWrite({ address, value, size, dmaChannel, dmaOrigin });
      }
    }
  }

  /** Wire up subsystem references */
  connect(parts: {
    interrupts: InterruptController;
    timers: TimerController;
    dma: DmaController;
    input: InputController;
    apu: Apu;
  }): void {
    this.#interrupts = parts.interrupts;
    this.#timers = parts.timers;
    this.#dma = parts.dma;
    this.#input = parts.input;
    this.#apu = parts.apu;
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

  /** Auto-detect save type from ROM SDK strings */
  #detectSaveType(rom: Uint8Array): void {
    // Search for save type identifier strings in ROM
    // Games built with the official SDK embed these strings
    const sramPattern = [0x53, 0x52, 0x41, 0x4d, 0x5f, 0x56]; // "SRAM_V"
    const flashPattern = [0x46, 0x4c, 0x41, 0x53, 0x48]; // "FLASH"

    this.#hasSram = false;
    for (let i = 0; i < rom.length - 6; i++) {
      if (
        rom[i] === sramPattern[0] &&
        rom[i + 1] === sramPattern[1] &&
        rom[i + 2] === sramPattern[2] &&
        rom[i + 3] === sramPattern[3] &&
        rom[i + 4] === sramPattern[4] &&
        rom[i + 5] === sramPattern[5]
      ) {
        this.#hasSram = true;
        return;
      }
      if (
        rom[i] === flashPattern[0] &&
        rom[i + 1] === flashPattern[1] &&
        rom[i + 2] === flashPattern[2] &&
        rom[i + 3] === flashPattern[3] &&
        rom[i + 4] === flashPattern[4]
      ) {
        // Flash-based save also uses SRAM region
        this.#hasSram = true;
        return;
      }
    }
  }

  // ─── MemoryBus Implementation ─────────────────────────────────────

  read8(address: number): number {
    const region = (address >>> 24) & 0xff;
    switch (region) {
      case 0x00:
        return this.#readBios8(address);
      case 0x02:
        return this.ewram[address & 0x3ffff]!;
      case 0x03:
        return this.iwram[address & 0x7fff]!;
      case 0x04:
        return this.#mmioRead8(address);
      case 0x05:
        return this.palette[address & 0x3ff]!;
      case 0x06:
        return this.vram[this.#mirrorVram(address)]!;
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
        return this.#hasSram ? this.sram[address & 0xffff]! : 0xff;
      default:
        return 0; // Open bus
    }
  }

  read16(address: number): number {
    const addr = address & ~1; // Force halfword alignment
    const region = (addr >>> 24) & 0xff;
    switch (region) {
      case 0x00:
        return this.#readBios8(addr) | (this.#readBios8(addr + 1) << 8);
      case 0x02:
        return this.#read16From(this.ewram, addr & 0x3ffff);
      case 0x03:
        return this.#read16From(this.iwram, addr & 0x7fff);
      case 0x04:
        return this.#mmioRead16(addr);
      case 0x05:
        return this.#read16From(this.palette, addr & 0x3ff);
      case 0x06:
        return this.#read16From(this.vram, this.#mirrorVram(addr));
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
        if (!this.#hasSram) {
          return 0xffff;
        }
        // SRAM has 8-bit bus: wider reads replicate the byte
        const byte = this.sram[address & 0xffff]!;
        return byte | (byte << 8);
      }
      default:
        return 0;
    }
  }

  read32(address: number): number {
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
      case 0x06:
        return this.#read32From(this.vram, this.#mirrorVram(addr));
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
        if (!this.#hasSram) {
          return 0xffffffff;
        }
        // SRAM has 8-bit bus: wider reads replicate the byte
        const byte = this.sram[address & 0xffff]!;
        return (byte | (byte << 8) | (byte << 16) | (byte << 24)) >>> 0;
      }
      default:
        return 0;
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
        // VRAM: 8-bit writes duplicate to halfword in BG area only.
        // 8-bit writes to OBJ VRAM area are ignored on real hardware.
        {
          const a = this.#mirrorVram(address);
          const dispcnt = this.mmioRegisters[0]! | (this.mmioRegisters[1]! << 8);
          const mode = dispcnt & 7;
          // OBJ boundary: 0x10000 in tile modes (0-2), 0x14000 in bitmap modes (3-5)
          const objBoundary = mode >= 3 ? 0x14000 : 0x10000;
          if (a >= objBoundary) {
            committed = false; // Ignore 8-bit writes to OBJ VRAM
            break;
          }
          const aligned = a & ~1;
          this.vram[aligned] = value;
          this.vram[aligned + 1] = value;
        }
        break;
      case 0x0e:
      case 0x0f:
        if (this.#hasSram) {
          this.sram[address & 0xffff] = value;
        } else {
          committed = false;
        }
        break;
      // OAM (0x07) ignores 8-bit writes; ROM/BIOS/unmapped regions are read-only.
      default:
        committed = false;
        break;
    }
    if (committed && this.#watchpoints.length > 0) {
      this.#notifyWrite(this.#canonicalWriteAddress(address), value & 0xff, 1);
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
        this.#mmioWrite16(addr, value);
        break;
      case 0x05:
        this.#write16To(this.palette, addr & 0x3ff, value);
        break;
      case 0x06:
        this.#write16To(this.vram, this.#mirrorVram(addr), value);
        break;
      case 0x07:
        this.#write16To(this.oam, addr & 0x3ff, value);
        break;
      case 0x0d:
        // EEPROM serial write — only bit 0 matters; a serial port, no addressable
        // byte, so it produces no watchpoint hit.
        this.#eeprom.write(value & 1);
        committed = false;
        break;
      case 0x0e:
      case 0x0f:
        if (this.#hasSram) {
          // SRAM has 8-bit bus: wider writes only write the low byte
          this.sram[address & 0xffff] = value & 0xff;
        } else {
          committed = false;
        }
        break;
      // ROM/BIOS/unmapped regions are read-only.
      default:
        committed = false;
        break;
    }
    if (committed && this.#watchpoints.length > 0) {
      this.#notifyWrite(this.#canonicalWriteAddress(addr), value & 0xffff, 2);
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
        this.#mmioWrite32(addr, value);
        break;
      case 0x05:
        this.#write32To(this.palette, addr & 0x3ff, value);
        break;
      case 0x06:
        this.#write32To(this.vram, this.#mirrorVram(addr), value);
        break;
      case 0x07:
        this.#write32To(this.oam, addr & 0x3ff, value);
        break;
      case 0x0d:
        // EEPROM serial write — a serial port, no addressable byte, so no hit.
        this.#eeprom.write(value & 1);
        committed = false;
        break;
      case 0x0e:
      case 0x0f:
        if (this.#hasSram) {
          // SRAM has 8-bit bus: wider writes only write the low byte
          this.sram[address & 0xffff] = value & 0xff;
        } else {
          committed = false;
        }
        break;
      // ROM/BIOS/unmapped regions are read-only.
      default:
        committed = false;
        break;
    }
    if (committed && this.#watchpoints.length > 0) {
      this.#notifyWrite(this.#canonicalWriteAddress(addr), value >>> 0, 4);
    }
  }

  // ─── BIOS Access ──────────────────────────────────────────────────

  #readBios8(address: number): number {
    // TODO: proper open-bus protection (only readable during BIOS execution)
    const value = this.#bios[address & 0x3fff]!;
    this.#lastBiosRead = value;
    return value;
  }

  #readBios32(address: number): number {
    const offset = address & 0x3fff;
    this.#lastBiosRead =
      this.#bios[offset]! |
      (this.#bios[offset + 1]! << 8) |
      (this.#bios[offset + 2]! << 16) |
      (this.#bios[offset + 3]! << 24);
    return this.#lastBiosRead;
  }

  // ─── ROM Access ───────────────────────────────────────────────────

  #readRom8(address: number): number {
    const offset = address & 0x01ffffff;
    return offset < this.#rom.length ? this.#rom[offset]! : 0;
  }

  #readRom16(address: number): number {
    const offset = address & 0x01fffffe;
    if (offset + 1 < this.#rom.length) {
      return this.#rom[offset]! | (this.#rom[offset + 1]! << 8);
    }
    return 0;
  }

  #readRom32(address: number): number {
    const offset = address & 0x01fffffc;
    if (offset + 3 < this.#rom.length) {
      return (
        this.#rom[offset]! |
        (this.#rom[offset + 1]! << 8) |
        (this.#rom[offset + 2]! << 16) |
        (this.#rom[offset + 3]! << 24)
      );
    }
    return 0;
  }

  // ─── VRAM Mirroring ───────────────────────────────────────────────

  /**
   * Map a write address to the canonical (un-mirrored) address of the physical
   * byte it stores to, mirroring the offset masks used by the storage paths.
   * Watchpoints are registered on canonical addresses, so writes that reach the
   * same byte through a region mirror still match.
   */
  #canonicalWriteAddress(address: number): number {
    switch ((address >>> 24) & 0xff) {
      case 0x02:
        return (0x02000000 | (address & 0x3ffff)) >>> 0;
      case 0x03:
        return (0x03000000 | (address & 0x7fff)) >>> 0;
      case 0x05:
        return (0x05000000 | (address & 0x3ff)) >>> 0;
      case 0x06:
        return (0x06000000 | this.#mirrorVram(address)) >>> 0;
      case 0x07:
        return (0x07000000 | (address & 0x3ff)) >>> 0;
      case 0x0e:
      case 0x0f:
        return (0x0e000000 | (address & 0xffff)) >>> 0;
      default:
        return address >>> 0;
    }
  }

  #mirrorVram(address: number): number {
    let offset = address & 0x1ffff;
    // VRAM is 96KB. Addresses 0x10000-0x17FFF mirror to 0x10000-0x17FFF.
    // Addresses 0x18000-0x1FFFF mirror back to 0x10000-0x17FFF.
    if (offset >= 0x18000) {
      offset -= 0x8000;
    }
    return offset;
  }

  // ─── MMIO Read ────────────────────────────────────────────────────

  #mmioRead8(address: number): number {
    // Special-case registers that need live computation
    const aligned = address & ~1;
    const shift = (address & 1) * 8;
    const value16 = this.#mmioRead16(aligned);
    return (value16 >> shift) & 0xff;
  }

  #mmioRead16(address: number): number {
    const reg = address & 0x3fe;

    switch (address & 0x04fffffe) {
      // Timers
      case MMIO.TM0CNT_L:
        return this.#timers.readCounter(0);
      case MMIO.TM0CNT_H:
        return this.#timers.readControl(0);
      case MMIO.TM1CNT_L:
        return this.#timers.readCounter(1);
      case MMIO.TM1CNT_H:
        return this.#timers.readControl(1);
      case MMIO.TM2CNT_L:
        return this.#timers.readCounter(2);
      case MMIO.TM2CNT_H:
        return this.#timers.readControl(2);
      case MMIO.TM3CNT_L:
        return this.#timers.readCounter(3);
      case MMIO.TM3CNT_H:
        return this.#timers.readControl(3);

      // Input
      case MMIO.KEYINPUT:
        return this.#input.readKeyInput();
      case MMIO.KEYCNT:
        return this.#input.readKeyCnt();

      // Interrupts
      case MMIO.IE:
        return this.#interrupts.readIe();
      case MMIO.IF:
        return this.#interrupts.readIf();
      case MMIO.IME:
        return this.#interrupts.readIme();
      case MMIO.WAITCNT:
        return this.#waitcnt;
      case MMIO.POSTFLG:
        return this.#postflg;

      // DMA control registers (read-only: only CNT_H is readable)
      case MMIO.DMA0CNT_H:
        return this.#dma.readControl(0);
      case MMIO.DMA1CNT_H:
        return this.#dma.readControl(1);
      case MMIO.DMA2CNT_H:
        return this.#dma.readControl(2);
      case MMIO.DMA3CNT_H:
        return this.#dma.readControl(3);

      default: {
        // Audio registers (0x60-0x9F, handled by APU)
        if (reg >= 0x60 && reg <= 0x9f) {
          return this.#apu.readRegister(reg);
        }
        // Display registers stored in mmioRegisters array
        return this.mmioRegisters[reg]! | (this.mmioRegisters[reg + 1]! << 8);
      }
    }
  }

  #mmioRead32(address: number): number {
    return this.#mmioRead16(address) | (this.#mmioRead16(address + 2) << 16);
  }

  // ─── MMIO Write ───────────────────────────────────────────────────

  #mmioWrite8(address: number, value: number): void {
    // Most MMIO registers are 16-bit; 8-bit writes need care.
    // Reconstruct a 16-bit value and dispatch through the 16-bit handler
    // for registers that need special handling (audio, timers, etc.).
    const reg = address & 0x3ff;

    if (address >= MMIO.HALTCNT && address <= MMIO.HALTCNT) {
      // HALTCNT — write triggers halt
      this.#interrupts.halted = true;
      return;
    }

    // For registers that require special dispatch, merge with the existing
    // byte and issue a 16-bit write so the subsystem handler sees the update.
    const aligned = address & ~1;
    const regAligned = aligned & 0x3fe;
    if (
      (regAligned >= 0x60 && regAligned <= 0x9e) || // Audio registers
      regAligned === 0xa0 ||
      regAligned === 0xa4 // FIFO
    ) {
      this.mmioRegisters[reg] = value & 0xff;
      const lo = this.mmioRegisters[regAligned]!;
      const hi = this.mmioRegisters[regAligned + 1]!;
      this.#mmioWrite16(aligned, lo | (hi << 8));
      return;
    }

    // Store in generic register array
    this.mmioRegisters[reg] = value & 0xff;
  }

  #mmioWrite16(address: number, value: number): void {
    const reg = address & 0x3fe;

    switch (address & 0x04fffffe) {
      // Timers
      case MMIO.TM0CNT_L:
        this.#timers.writeReload(0, value);
        return;
      case MMIO.TM0CNT_H:
        this.#timers.writeControl(0, value);
        return;
      case MMIO.TM1CNT_L:
        this.#timers.writeReload(1, value);
        return;
      case MMIO.TM1CNT_H:
        this.#timers.writeControl(1, value);
        return;
      case MMIO.TM2CNT_L:
        this.#timers.writeReload(2, value);
        return;
      case MMIO.TM2CNT_H:
        this.#timers.writeControl(2, value);
        return;
      case MMIO.TM3CNT_L:
        this.#timers.writeReload(3, value);
        return;
      case MMIO.TM3CNT_H:
        this.#timers.writeControl(3, value);
        return;

      // Input
      case MMIO.KEYCNT:
        this.#input.writeKeyCnt(value);
        return;

      // Interrupts
      case MMIO.IE:
        this.#interrupts.writeIe(value);
        return;
      case MMIO.IF:
        this.#interrupts.writeIf(value);
        return;
      case MMIO.IME:
        this.#interrupts.writeIme(value);
        return;
      case MMIO.WAITCNT:
        this.#waitcnt = value & 0x5fff;
        return;

      // DMA
      case MMIO.DMA0SAD:
        this.#dma.writeSrcAddr(0, value);
        return;
      case MMIO.DMA0DAD:
        this.#dma.writeDstAddr(0, value);
        return;
      case MMIO.DMA0CNT_L:
        this.#dma.writeWordCount(0, value);
        return;
      case MMIO.DMA0CNT_H:
        this.#dma.writeControl(0, value);
        return;
      case MMIO.DMA1SAD:
        this.#dma.writeSrcAddr(1, value);
        return;
      case MMIO.DMA1DAD:
        this.#dma.writeDstAddr(1, value);
        return;
      case MMIO.DMA1CNT_L:
        this.#dma.writeWordCount(1, value);
        return;
      case MMIO.DMA1CNT_H:
        this.#dma.writeControl(1, value);
        return;
      case MMIO.DMA2SAD:
        this.#dma.writeSrcAddr(2, value);
        return;
      case MMIO.DMA2DAD:
        this.#dma.writeDstAddr(2, value);
        return;
      case MMIO.DMA2CNT_L:
        this.#dma.writeWordCount(2, value);
        return;
      case MMIO.DMA2CNT_H:
        this.#dma.writeControl(2, value);
        return;
      case MMIO.DMA3SAD:
        this.#dma.writeSrcAddr(3, value);
        return;
      case MMIO.DMA3DAD:
        this.#dma.writeDstAddr(3, value);
        return;
      case MMIO.DMA3CNT_L:
        this.#dma.writeWordCount(3, value);
        return;
      case MMIO.DMA3CNT_H:
        this.#dma.writeControl(3, value);
        return;

      case MMIO.POSTFLG:
        this.#postflg |= value & 1;
        return;
      case MMIO.HALTCNT:
        this.#interrupts.halted = true;
        return;

      default: {
        // Audio registers (0x60-0x9F, handled by APU)
        if (reg >= 0x60 && reg <= 0x9f) {
          this.#apu.writeRegister(reg, value);
          // Also store in mmioRegisters for PPU/debug reads
          this.mmioRegisters[reg] = value & 0xff;
          this.mmioRegisters[reg + 1] = (value >> 8) & 0xff;
          return;
        }

        // FIFO writes (32-bit, but may arrive as two 16-bit writes)
        if (reg === 0xa0) {
          this.#apu.writeFifo(0, value);
          return;
        }
        if (reg === 0xa4) {
          this.#apu.writeFifo(1, value);
          return;
        }

        // Store in generic register array (display, etc.)
        this.mmioRegisters[reg] = value & 0xff;
        this.mmioRegisters[reg + 1] = (value >> 8) & 0xff;

        // Detect writes to BG2/BG3 reference point registers — PPU must
        // reload its internal accumulators (this is how per-scanline affine
        // effects like Mode 7 floors work).
        if (reg >= 0x28 && reg <= 0x2e) {
          this.onBgRefPointWrite?.(2, reg < 0x2c);
        } else if (reg >= 0x38 && reg <= 0x3e) {
          this.onBgRefPointWrite?.(3, reg < 0x3c);
        }
        return;
      }
    }
  }

  #mmioWrite32(address: number, value: number): void {
    // DMA source/dest addresses are 32-bit writes
    switch (address & 0x04fffffc) {
      case MMIO.DMA0SAD:
        this.#dma.writeSrcAddr(0, value);
        return;
      case MMIO.DMA0DAD:
        this.#dma.writeDstAddr(0, value);
        return;
      case MMIO.DMA1SAD:
        this.#dma.writeSrcAddr(1, value);
        return;
      case MMIO.DMA1DAD:
        this.#dma.writeDstAddr(1, value);
        return;
      case MMIO.DMA2SAD:
        this.#dma.writeSrcAddr(2, value);
        return;
      case MMIO.DMA2DAD:
        this.#dma.writeDstAddr(2, value);
        return;
      case MMIO.DMA3SAD:
        this.#dma.writeSrcAddr(3, value);
        return;
      case MMIO.DMA3DAD:
        this.#dma.writeDstAddr(3, value);
        return;
      // FIFO A/B: 32-bit writes go directly to APU
      case MMIO.FIFO_A:
        this.#apu.writeFifo(0, value);
        return;
      case MMIO.FIFO_B:
        this.#apu.writeFifo(1, value);
        return;
      default:
        // Split into two 16-bit writes
        this.#mmioWrite16(address, value & 0xffff);
        this.#mmioWrite16(address + 2, (value >>> 16) & 0xffff);
        return;
    }
  }

  // ─── Byte Array Helpers ───────────────────────────────────────────

  #read16From(arr: Uint8Array, offset: number): number {
    return arr[offset]! | (arr[offset + 1]! << 8);
  }

  #read32From(arr: Uint8Array, offset: number): number {
    return arr[offset]! | (arr[offset + 1]! << 8) | (arr[offset + 2]! << 16) | (arr[offset + 3]! << 24);
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
      hasSram: this.#hasSram,
      waitcnt: this.#waitcnt,
      postflg: this.#postflg,
      lastBiosRead: this.#lastBiosRead,
      eeprom: this.#eeprom.serialize(),
    };
  }

  /** Restore from a snapshot. BIOS and ROM must already be loaded. */
  deserialize(snap: SystemBusSnapshot): void {
    this.ewram.set(snap.ewram);
    this.iwram.set(snap.iwram);
    this.palette.set(snap.palette);
    this.vram.set(snap.vram);
    this.oam.set(snap.oam);
    this.sram.set(snap.sram);
    this.mmioRegisters.set(snap.mmioRegisters);
    this.#hasSram = snap.hasSram;
    this.#waitcnt = snap.waitcnt;
    this.#postflg = snap.postflg;
    this.#lastBiosRead = snap.lastBiosRead;
    this.#eeprom.deserialize(snap.eeprom);
  }

  /** Reset all memory and registers */
  reset(): void {
    this.ewram.fill(0);
    this.iwram.fill(0);
    this.palette.fill(0);
    this.vram.fill(0);
    this.oam.fill(0);
    this.sram.fill(0);
    this.#eeprom.reset();
    this.mmioRegisters.fill(0);
    this.#waitcnt = 0;
    this.#postflg = 0;
    this.#lastBiosRead = 0;
  }
}

// ─── EEPROM ───────────────────────────────────────────────────────────

/**
 * GBA EEPROM — Serial EEPROM accessed via DMA at address region 0x0D.
 *
 * Supports both 4Kbit (512 bytes, 6-bit address) and 64Kbit (8KB, 14-bit address).
 * Auto-detects size based on address length in the first write command.
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
  readonly #data = new Uint8Array(0x2000);

  /** Address bit length: 6 for 4Kbit, 14 for 64Kbit. 0 = not yet detected. */
  #addrBits = 0;

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
    this.#state = snap.state as EepromState;
    this.#command = snap.command;
    this.#address = snap.address;
    this.#bitBuffer = BigInt(snap.bitBuffer);
    this.#bitsReceived = snap.bitsReceived;
    this.#sendBuffer = BigInt(snap.sendBuffer);
    this.#sendPos = snap.sendPos;
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

        // Auto-detect address size: if we've received 6 bits and this is followed
        // by a stop bit (for read) or data (for write), detect 6-bit addressing.
        // If more bits come, it's 14-bit addressing.
        // We detect based on the DMA transfer length:
        // - 4Kbit read request: 9 bits total (1 start + 1 cmd + 6 addr + 1 stop) = 9 × 16-bit DMA
        // - 64Kbit read request: 17 bits total (1 start + 1 cmd + 14 addr + 1 stop) = 17 × 16-bit DMA
        // For auto-detection: use 6-bit if total bits suggests small EEPROM
        if (this.#addrBits === 0) {
          // Can't detect yet — assume 6-bit initially, upgrade to 14-bit if we get more
          if (this.#bitsReceived === 6) {
            // Could be 6-bit. Will confirm when next state transition happens.
            // For now, tentatively accept 6 bits.
            this.#addrBits = 6;
            this.#finishAddressPhase();
          }
        } else if (this.#bitsReceived === this.#addrBits) {
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

  #loadReadData(): void {
    const byteAddr = this.#address * 8;
    this.#sendBuffer = 0n;
    for (let i = 0; i < 8; i++) {
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
    for (let i = 0; i < 8; i++) {
      const shift = BigInt((7 - i) * 8);
      this.#data[byteAddr + i] = Number((this.#bitBuffer >> shift) & 0xffn);
    }
    this.#state = EepromState.WriteReady;
  }
}
