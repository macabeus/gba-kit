/**
 * ARM7TDMI Thumb Emulator - Memory System
 *
 * Implements the GBA memory map with region dispatch, dirty tracking,
 * and MMIO write recording. Uses ArrayBuffer + DataView for each region.
 */
import type { MemoryBus, MemoryWrite } from './types.js';

/** GBA memory region definitions */
const REGIONS = {
  EWRAM: { base: 0x02000000, size: 0x40000 }, // 256KB
  IWRAM: { base: 0x03000000, size: 0x8000 }, //  32KB
  MMIO: { base: 0x04000000, size: 0x400 }, //   1KB
  PALETTE: { base: 0x05000000, size: 0x400 }, //   1KB
  VRAM: { base: 0x06000000, size: 0x18000 }, //  96KB
  OAM: { base: 0x07000000, size: 0x400 }, //   1KB
  ROM: { base: 0x08000000, size: 0x2000000 }, //  32MB
} as const;

/**
 * GBA Memory Map implementation.
 *
 * Each region is backed by an ArrayBuffer. Reads and writes are dispatched
 * by the top byte of the address. All writes are logged for comparison.
 * MMIO writes are recorded separately (order-sensitive).
 */
export class GbaMemory implements MemoryBus {
  // Region backing stores
  readonly ewram: ArrayBuffer;
  readonly iwram: ArrayBuffer;
  readonly mmio: ArrayBuffer;
  readonly palette: ArrayBuffer;
  readonly vram: ArrayBuffer;
  readonly oam: ArrayBuffer;
  readonly rom: ArrayBuffer;

  // DataViews for typed access
  readonly #ewramView: DataView;
  readonly #iwramView: DataView;
  readonly #mmioView: DataView;
  readonly #paletteView: DataView;
  readonly #vramView: DataView;
  readonly #oamView: DataView;
  readonly #romView: DataView;

  // Write tracking
  #writeLog: MemoryWrite[] = [];
  #mmioWriteLog: MemoryWrite[] = [];

  constructor() {
    this.ewram = new ArrayBuffer(REGIONS.EWRAM.size);
    this.iwram = new ArrayBuffer(REGIONS.IWRAM.size);
    this.mmio = new ArrayBuffer(REGIONS.MMIO.size);
    this.palette = new ArrayBuffer(REGIONS.PALETTE.size);
    this.vram = new ArrayBuffer(REGIONS.VRAM.size);
    this.oam = new ArrayBuffer(REGIONS.OAM.size);
    this.rom = new ArrayBuffer(REGIONS.ROM.size);

    this.#ewramView = new DataView(this.ewram);
    this.#iwramView = new DataView(this.iwram);
    this.#mmioView = new DataView(this.mmio);
    this.#paletteView = new DataView(this.palette);
    this.#vramView = new DataView(this.vram);
    this.#oamView = new DataView(this.oam);
    this.#romView = new DataView(this.rom);
  }

  /** Resolve an address to a [DataView, offset] pair */
  #resolve(address: number): [DataView, number] | null {
    const region = (address >>> 24) & 0xff;
    switch (region) {
      case 0x02:
        return [this.#ewramView, (address & 0x3ffff) % REGIONS.EWRAM.size];
      case 0x03:
        return [this.#iwramView, (address & 0x7fff) % REGIONS.IWRAM.size];
      case 0x04:
        return [this.#mmioView, address & 0x3ff];
      case 0x05:
        return [this.#paletteView, address & 0x3ff];
      case 0x06: {
        let offset = address & 0x1ffff;
        // VRAM mirror: 0x10000-0x17FFF mirrors to 0x10000-0x17FFF, above mirrors back
        if (offset >= REGIONS.VRAM.size) {
          offset -= 0x8000;
        }
        return [this.#vramView, offset];
      }
      case 0x07:
        return [this.#oamView, address & 0x3ff];
      case 0x08:
      case 0x09:
        return [this.#romView, address - REGIONS.ROM.base];
      default:
        return null;
    }
  }

  read8(address: number): number {
    const resolved = this.#resolve(address);
    if (!resolved) {
      return 0; // Open bus
    }
    const [view, offset] = resolved;
    if (offset >= view.byteLength) {
      return 0;
    }
    return view.getUint8(offset);
  }

  read16(address: number): number {
    // ARM7TDMI: halfword reads are aligned, unaligned rotates
    const aligned = address & ~1;
    const resolved = this.#resolve(aligned);
    if (!resolved) {
      return 0;
    }
    const [view, offset] = resolved;
    if (offset + 1 >= view.byteLength) {
      return 0;
    }
    const value = view.getUint16(offset, true); // little-endian
    // Rotate for unaligned access on ARMv4T
    if (address & 1) {
      return ((value >>> 8) | (value << 24)) >>> 0;
    }
    return value;
  }

  read32(address: number): number {
    // ARM7TDMI: word reads are force-aligned, unaligned rotates
    const aligned = address & ~3;
    const resolved = this.#resolve(aligned);
    if (!resolved) {
      return 0;
    }
    const [view, offset] = resolved;
    if (offset + 3 >= view.byteLength) {
      return 0;
    }
    const value = view.getUint32(offset, true); // little-endian
    // Rotate for unaligned access
    const rot = (address & 3) * 8;
    if (rot !== 0) {
      return ((value >>> rot) | (value << (32 - rot))) >>> 0;
    }
    return value;
  }

  write8(address: number, value: number): void {
    const resolved = this.#resolve(address);
    if (!resolved) {
      return;
    }
    const [view, offset] = resolved;
    if (offset >= view.byteLength) {
      return;
    }
    value = value & 0xff;
    view.setUint8(offset, value);
    this.#recordWrite(address, 1, value);
  }

  write16(address: number, value: number): void {
    const aligned = address & ~1;
    const resolved = this.#resolve(aligned);
    if (!resolved) {
      return;
    }
    const [view, offset] = resolved;
    if (offset + 1 >= view.byteLength) {
      return;
    }
    value = value & 0xffff;
    view.setUint16(offset, value, true);
    this.#recordWrite(aligned, 2, value);
  }

  write32(address: number, value: number): void {
    const aligned = address & ~3;
    const resolved = this.#resolve(aligned);
    if (!resolved) {
      return;
    }
    const [view, offset] = resolved;
    if (offset + 3 >= view.byteLength) {
      return;
    }
    value = value >>> 0;
    view.setUint32(offset, value, true);
    this.#recordWrite(aligned, 4, value);
  }

  #recordWrite(address: number, size: 1 | 2 | 4, value: number): void {
    const entry: MemoryWrite = { address, size, value };
    this.#writeLog.push(entry);
    // Also record MMIO writes separately (order-sensitive)
    if (((address >>> 24) & 0xff) === 0x04) {
      this.#mmioWriteLog.push(entry);
    }
  }

  /** Load a block of bytes into memory at a given address */
  loadBytes(baseAddress: number, data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      const resolved = this.#resolve(baseAddress + i);
      if (resolved) {
        const [view, offset] = resolved;
        if (offset < view.byteLength) {
          view.setUint8(offset, data[i]!);
        }
      }
    }
  }

  /** Get all memory writes since last reset */
  getWriteLog(): MemoryWrite[] {
    return this.#writeLog;
  }

  /** Get MMIO writes only (order-sensitive) */
  getMmioWriteLog(): MemoryWrite[] {
    return this.#mmioWriteLog;
  }

  /** Reset write logs (but keep memory contents) */
  resetWriteLog(): void {
    this.#writeLog = [];
    this.#mmioWriteLog = [];
  }

  /** Zero all writable memory regions and reset logs */
  reset(): void {
    new Uint8Array(this.ewram).fill(0);
    new Uint8Array(this.iwram).fill(0);
    new Uint8Array(this.mmio).fill(0);
    new Uint8Array(this.palette).fill(0);
    new Uint8Array(this.vram).fill(0);
    new Uint8Array(this.oam).fill(0);
    // ROM is not zeroed — it's loaded once
    this.#writeLog = [];
    this.#mmioWriteLog = [];
  }
}
