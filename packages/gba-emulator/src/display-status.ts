/**
 * GBA Display Status — DISPSTAT and VCOUNT
 *
 * The LCD controller owns the line counter and the three status flags; the CPU reads them and
 * writes only DISPSTAT's IRQ enables and V-count setting (LYC). The scanline state machine in
 * `Gba` reports each change of line and blanking period here, and this class keeps the
 * registers, compares VCOUNT with LYC, and raises the display interrupts.
 *
 * The registers live in bytes 4-7 of the I/O register file (`GbaSystemBus.mmioRegisters`), the
 * store the PPU, the debugger and snapshots read the display registers from. Outside reset and
 * snapshot restore, this class alone writes them.
 *
 * References: GBATEK "LCD I/O Display Status"; mGBA src/gba/video.c (GBAVideoWriteDISPSTAT,
 * _startHdraw); NanoBoyAdvance hw/ppu (DisplayStatus, UpdateVerticalCounterFlag).
 */
import type { InterruptController } from './interrupts.js';
import { IrqFlag } from './types.js';

const DISPSTAT = 0x04;
const VCOUNT = 0x06;

const VBLANK_FLAG = 1 << 0;
const HBLANK_FLAG = 1 << 1;
const VCOUNT_FLAG = 1 << 2;
const VBLANK_IRQ = 1 << 3;
const HBLANK_IRQ = 1 << 4;
const VCOUNT_IRQ = 1 << 5;

/** The bits a DISPSTAT write sets: the three IRQ enables and LYC. */
const DISPSTAT_WRITABLE = 0xff38;

/** Bits 6-7 are unused and read 0 (GBATEK: "Not used (0)"). */
const DISPSTAT_READABLE = 0xff3f;

/** The last line of the frame, where the VBlank flag already reads 0 (GBATEK: "set in line 160..226; not 227"). */
const LAST_SCANLINE = 227;

export class DisplayStatus {
  readonly #io: Uint8Array;
  readonly #interrupts: InterruptController;

  constructor(io: Uint8Array, interrupts: InterruptController) {
    this.#io = io;
    this.#interrupts = interrupts;
  }

  /** DISPSTAT as the CPU reads it. */
  readDispstat(): number {
    return (this.#io[DISPSTAT]! | (this.#io[DISPSTAT + 1]! << 8)) & DISPSTAT_READABLE;
  }

  /**
   * A CPU write to DISPSTAT: the flags in bits 0-2 keep their state, and the new LYC is compared
   * with the current line at once, so a match raises the V-count IRQ without waiting for the next
   * line (mGBA GBAVideoWriteDISPSTAT).
   */
  writeDispstat(value: number): void {
    const flags = this.#io[DISPSTAT]! & (VBLANK_FLAG | HBLANK_FLAG | VCOUNT_FLAG);
    this.#store((value & DISPSTAT_WRITABLE) | flags);
    this.#compareVcount();
  }

  /** VCOUNT: the line the LCD is on, 0-227. */
  readVcount(): number {
    return this.#io[VCOUNT]!;
  }

  /**
   * The LCD moved to `line` at the cycle `at`: VCOUNT follows, the VBlank flag clears on the last
   * line, and the V-count comparison runs for the new line, line 0 included.
   */
  setScanline(line: number, at?: number): void {
    this.#io[VCOUNT] = line;
    this.#io[VCOUNT + 1] = 0;
    if (line === LAST_SCANLINE) {
      this.#store(this.readDispstat() & ~VBLANK_FLAG);
    }
    this.#compareVcount(at);
  }

  /** Line 160 began at the cycle `at`: the VBlank flag sets and the VBlank IRQ is requested when enabled. */
  enterVBlank(at?: number): void {
    const stat = this.readDispstat() | VBLANK_FLAG;
    this.#store(stat);
    if (stat & VBLANK_IRQ) {
      this.#interrupts.requestInterrupt(IrqFlag.VBlank, at);
    }
  }

  /** HBlank began at the cycle `at`: the HBlank flag sets and the HBlank IRQ is requested when enabled. */
  enterHBlank(at?: number): void {
    const stat = this.readDispstat() | HBLANK_FLAG;
    this.#store(stat);
    if (stat & HBLANK_IRQ) {
      this.#interrupts.requestInterrupt(IrqFlag.HBlank, at);
    }
  }

  /** HBlank ended. */
  leaveHBlank(): void {
    this.#store(this.readDispstat() & ~HBLANK_FLAG);
  }

  /**
   * The V-count flag reads 1 while VCOUNT equals LYC. The IRQ is edge-triggered: it is requested
   * when the flag goes from 0 to 1 with the IRQ enabled (NanoBoyAdvance UpdateVerticalCounterFlag).
   */
  #compareVcount(at?: number): void {
    const stat = this.readDispstat();
    if (this.#io[VCOUNT] !== stat >>> 8) {
      this.#store(stat & ~VCOUNT_FLAG);
      return;
    }
    if (stat & VCOUNT_FLAG) {
      return;
    }
    this.#store(stat | VCOUNT_FLAG);
    if (stat & VCOUNT_IRQ) {
      this.#interrupts.requestInterrupt(IrqFlag.VCount, at);
    }
  }

  #store(stat: number): void {
    this.#io[DISPSTAT] = stat & 0xff;
    this.#io[DISPSTAT + 1] = (stat >>> 8) & 0xff;
  }
}
