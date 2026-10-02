/**
 * GBA PPU — Core
 *
 * Implements PpuInterface. The coordinator calls `beginScanline` at the start of every one
 * of the 228 lines, `latchDispcnt` 40 cycles into it, and `renderScanline` once per visible
 * line. This work holds the PPU's internal state, so it stays right wherever in the line the
 * image is drawn:
 * - the affine reference points step at the end of each visible line and reload from
 *   BGxX/BGxY at frame start and after a write;
 * - the BG mosaic counter steps with them;
 * - DISPCNT's layer enables pass through a three-line latch;
 * - the WIN0/WIN1 vertical flip-flops switch at their top and bottom lines, VBlank included;
 * - the OBJ engine builds the OBJ layer one line ahead, from OAM and VRAM as they are then.
 * `renderScanline` renders the BGs of the mode (text, affine or bitmap), and merges them with
 * the OBJ line and the backdrop through the windows and colour effects.
 *
 * References: GBATEK "LCD I/O Display Control", "LCD I/O BG Rotation/Scaling", "LCD I/O
 * Mosaic Function", "LCD I/O Window Feature"; NanoBoyAdvance src/nba/src/hw/ppu/ (ppu.cc,
 * background.cc, window.cc, sprite.cc, merge.cc).
 */
import type { PpuInterface } from '../gba.js';
import type { PpuSnapshot } from '../savestate.js';
import type { GbaSystemBus } from '../system-bus.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH, TOTAL_SCANLINES, VISIBLE_SCANLINES } from '../types.js';
import type { BgControl } from './backgrounds.js';
import {
  parseBgControl,
  read16,
  readSigned28_8,
  renderAffineBgScanline,
  renderBitmapBgScanline,
  renderTextBgScanline,
} from './backgrounds.js';
import type { BgLayer, WindowState } from './compositor.js';
import { applyObjMosaic, buildWindowMask, compositeScanline } from './compositor.js';
import { renderSpriteScanline } from './sprites.js';

/** DISPCNT bits 8-12: BG0-BG3 and OBJ enable. */
const DISPCNT_LAYERS = 0x1f00;
const DISPCNT_OBJ = 1 << 12;

/** `#refWritten` bits: BG2X, BG2Y, BG3X, BG3Y. */
const REF_BG2X = 1 << 0;
const REF_BG2Y = 1 << 1;
const REF_BG3X = 1 << 2;
const REF_BG3Y = 1 << 3;

/** `#windowFlags` bits: WIN0/WIN1 vertical flip-flops, then WIN0/WIN1 horizontal flip-flops. */
const WIN0_V = 1 << 0;
const WIN1_V = 1 << 1;
const WIN0_H = 1 << 2;
const WIN1_H = 1 << 3;

/** First BG and last BG of each mode (NBA merge.cc k_min_max_bg); modes 6 and 7 show none. */
const MODE_FIRST_BG = [0, 0, 2, 2, 2, 2, 0, 0];
const MODE_LAST_BG = [3, 2, 3, 2, 2, 2, -1, -1];

// ─── PPU Implementation ──────────────────────────────────────────────

export class Ppu implements PpuInterface {
  readonly #framebuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);

  // Internal affine reference point accumulators (signed 20.8 fixed point)
  #bg2RefX = 0;
  #bg2RefY = 0;
  #bg3RefX = 0;
  #bg3RefY = 0;
  /** Reference point registers written since the last line start (REF_* bits). */
  #refWritten = 0;

  /**
   * DISPCNT sampled at the last three latches, oldest first. A layer shows when it is
   * enabled both in the oldest sample and in DISPCNT now, so enabling takes effect two lines
   * later and disabling at once (NBA ppu.cc LatchDISPCNT, `dispcnt_latch[0] & dispcnt`).
   */
  readonly #dispcntLatch = [0, 0, 0];

  /** WIN0/WIN1 flip-flops (WIN*_V, WIN*_H bits). */
  #windowFlags = 0;

  /** Mosaic vertical counters: how many lines above the current one the BGs and OBJs fetch. */
  #bgMosaicY = 0;
  #objMosaicY = 0;

  /**
   * The OBJ line on display and the one the OBJ engine prepared for the next line, with the
   * scanline each was built for (-1: none).
   */
  #objFront = new Uint32Array(SCREEN_WIDTH);
  #objBack = new Uint32Array(SCREEN_WIDTH);
  #objFrontLine = -1;
  #objBackLine = -1;

  // Scratch buffers, reused per scanline
  readonly #bgBuffers = [
    new Uint32Array(SCREEN_WIDTH),
    new Uint32Array(SCREEN_WIDTH),
    new Uint32Array(SCREEN_WIDTH),
    new Uint32Array(SCREEN_WIDTH),
  ];
  readonly #objMosaicLine = new Uint32Array(SCREEN_WIDTH);
  readonly #windowMask = new Uint8Array(SCREEN_WIDTH);
  readonly #windowInside = new Uint8Array(SCREEN_WIDTH);

  /** Reference to MMIO registers — set by the GBA coordinator */
  mmioRegisters?: Uint8Array;

  reset(): void {
    this.#framebuffer.fill(0);
    this.#bg2RefX = 0;
    this.#bg2RefY = 0;
    this.#bg3RefX = 0;
    this.#bg3RefY = 0;
    this.#refWritten = 0;
    this.#dispcntLatch.fill(0);
    this.#windowFlags = 0;
    this.#bgMosaicY = 0;
    this.#objMosaicY = 0;
    this.#objFront.fill(0);
    this.#objBack.fill(0);
    this.#objFrontLine = -1;
    this.#objBackLine = -1;
  }

  /** Serialize to a plain snapshot. */
  serialize(): PpuSnapshot {
    const objLines = new Uint32Array(SCREEN_WIDTH * 2);
    objLines.set(this.#objFront, 0);
    objLines.set(this.#objBack, SCREEN_WIDTH);
    return {
      framebuffer: new Uint32Array(this.#framebuffer),
      bg2RefX: this.#bg2RefX,
      bg2RefY: this.#bg2RefY,
      bg3RefX: this.#bg3RefX,
      bg3RefY: this.#bg3RefY,
      refWritten: this.#refWritten,
      dispcntLatch: [...this.#dispcntLatch],
      windowFlags: this.#windowFlags,
      bgMosaicY: this.#bgMosaicY,
      objMosaicY: this.#objMosaicY,
      objLines,
      objLineNumbers: [this.#objFrontLine, this.#objBackLine],
    };
  }

  /**
   * Restore from a snapshot. A snapshot from before the line-start state existed restores
   * DISPCNT's latch as three copies of DISPCNT, the windows and mosaic counters cleared, and
   * no OBJ line prepared (the next visible line builds its own).
   */
  deserialize(snap: PpuSnapshot): void {
    this.#framebuffer.set(snap.framebuffer);
    this.#bg2RefX = snap.bg2RefX;
    this.#bg2RefY = snap.bg2RefY;
    this.#bg3RefX = snap.bg3RefX;
    this.#bg3RefY = snap.bg3RefY;
    this.#refWritten = snap.refWritten ?? 0;
    const dispcnt = this.mmioRegisters ? read16(this.mmioRegisters, 0x00) : 0;
    const latch = snap.dispcntLatch ?? [dispcnt, dispcnt, dispcnt];
    for (let i = 0; i < 3; i++) {
      this.#dispcntLatch[i] = latch[i] ?? dispcnt;
    }
    this.#windowFlags = snap.windowFlags ?? 0;
    this.#bgMosaicY = snap.bgMosaicY ?? 0;
    this.#objMosaicY = snap.objMosaicY ?? 0;
    if (snap.objLines && snap.objLineNumbers) {
      this.#objFront.set(snap.objLines.subarray(0, SCREEN_WIDTH));
      this.#objBack.set(snap.objLines.subarray(SCREEN_WIDTH, SCREEN_WIDTH * 2));
      this.#objFrontLine = snap.objLineNumbers[0] ?? -1;
      this.#objBackLine = snap.objLineNumbers[1] ?? -1;
    } else {
      this.#objFrontLine = -1;
      this.#objBackLine = -1;
    }
  }

  /**
   * A write to BG2X/BG2Y/BG3X/BG3Y: the internal reference point reloads that axis from the
   * register at the next line start, so a write during a line takes effect on the next one.
   * GBATEK, LCD I/O BG Rotation/Scaling; NBA background.cc InitBackground (`bgx.written`).
   */
  reloadBgRefPoint(bgIndex: 2 | 3, isX: boolean): void {
    if (bgIndex === 2) {
      this.#refWritten |= isX ? REF_BG2X : REF_BG2Y;
    } else {
      this.#refWritten |= isX ? REF_BG3X : REF_BG3Y;
    }
  }

  getFramebuffer(): Uint32Array {
    return this.#framebuffer;
  }

  /**
   * DISPCNT's layer enables pass through a three-line latch, shifted 40 cycles into the line on
   * visible lines (and the line after them) and on the last three VBlank lines, so a change made
   * earlier in VBlank is complete by line 0 (NanoBoyAdvance ppu.cc LatchDISPCNT).
   */
  latchDispcnt(line: number, bus: GbaSystemBus): void {
    if (line <= VISIBLE_SCANLINES || line >= TOTAL_SCANLINES - 3) {
      this.#dispcntLatch[0] = this.#dispcntLatch[1]!;
      this.#dispcntLatch[1] = this.#dispcntLatch[2]!;
      this.#dispcntLatch[2] = read16(bus.mmioRegisters, 0x00);
    }
  }

  /** Line-start work for `line` (0-227); runs before that line renders. */
  beginScanline(line: number, bus: GbaSystemBus): void {
    const mmio = bus.mmioRegisters;
    const dispcnt = read16(mmio, 0x00);

    // The end of the previous visible line steps the BG mosaic counter and the affine points.
    if (line >= 1 && line <= VISIBLE_SCANLINES) {
      this.#finishVisibleLine(line - 1, mmio, dispcnt);
    }

    // Each window's vertical flip-flop turns on at its top line and off at its bottom line,
    // on every line including VBlank, so a bottom edge past 227 never turns it off.
    // GBATEK, LCD I/O Window Feature; NBA window.cc InitWindow.
    for (let i = 0; i < 2; i++) {
      const winV = read16(mmio, 0x44 + i * 2);
      const flag = i === 0 ? WIN0_V : WIN1_V;
      if (line === winV >> 8) {
        this.#windowFlags |= flag;
      }
      if (line === (winV & 0xff)) {
        this.#windowFlags &= ~flag;
      }
    }

    if (line < VISIBLE_SCANLINES) {
      this.#reloadAffineRefs(mmio, line === 0 ? REF_BG2X | REF_BG2Y | REF_BG3X | REF_BG3Y : this.#refWritten);
    } else {
      // No image is drawn, but the horizontal flip-flops still sweep the line.
      this.#sweepWindowsHorizontal(mmio, null);
    }

    // The OBJ engine works one line ahead: the line prepared last time is now on display.
    if (line < VISIBLE_SCANLINES) {
      const front = this.#objFront;
      this.#objFront = this.#objBack;
      this.#objBack = front;
      this.#objFrontLine = this.#objBackLine;
      this.#objBackLine = -1;
    }
    const next = line === TOTAL_SCANLINES - 1 ? 0 : line + 1;
    if (next < VISIBLE_SCANLINES) {
      this.#renderObjLine(next, bus, this.#objBack);
      this.#objBackLine = next;
      // The OBJ mosaic counter steps once per OBJ line and restarts after the last visible one.
      const sizeY = ((read16(mmio, 0x4c) >> 12) & 0xf) + 1;
      this.#objMosaicY = next < VISIBLE_SCANLINES - 1 ? stepMosaicCounter(this.#objMosaicY, sizeY) : 0;
    }
  }

  renderScanline(line: number, bus: GbaSystemBus): void {
    if (line < 0 || line >= SCREEN_HEIGHT) {
      return;
    }

    const mmio = bus.mmioRegisters;
    const dispcnt = read16(mmio, 0x00);
    const fbOffset = line * SCREEN_WIDTH;

    this.#sweepWindowsHorizontal(mmio, this.#windowInside);

    // Forced blank — white scanline
    if (dispcnt & (1 << 7)) {
      this.#framebuffer.fill(0xffffffff, fbOffset, fbOffset + SCREEN_WIDTH);
      return;
    }

    if (this.#objFrontLine !== line) {
      // No line start prepared this OBJ line (first line after a reset or an older snapshot).
      this.#renderObjLine(line, bus, this.#objFront);
      this.#objFrontLine = line;
    }

    const enabled = this.#dispcntLatch[0]! & dispcnt & DISPCNT_LAYERS;
    const mode = dispcnt & 0x7;

    // Enabled BGs of this mode, sorted by priority then index.
    const layers: BgLayer[] = [];
    const firstBg = MODE_FIRST_BG[mode]!;
    const lastBg = MODE_LAST_BG[mode]!;
    for (let id = firstBg; id <= lastBg; id++) {
      if (enabled & (0x100 << id)) {
        const ctrl = parseBgControl(read16(mmio, 0x08 + id * 2));
        const buf = this.#bgBuffers[id]!;
        this.#renderBg(id, mode, ctrl, line, dispcnt, bus, buf);
        layers.push({ id, priority: ctrl.priority, lineBuffer: buf });
      }
    }
    layers.sort((a, b) => a.priority - b.priority || a.id - b.id);

    const objEnabled = !!(enabled & DISPCNT_OBJ);
    let obj: Uint32Array | null = null;
    if (objEnabled) {
      const mosaicWidth = ((read16(mmio, 0x4c) >> 8) & 0xf) + 1;
      if (mosaicWidth > 1) {
        applyObjMosaic(this.#objFront, mosaicWidth, this.#objMosaicLine);
        obj = this.#objMosaicLine;
      } else {
        obj = this.#objFront;
      }
    }

    // The OBJ window exists only while the OBJ layer is on (NBA merge.cc `enable_objwin`).
    const windows: WindowState = {
      win0: !!(dispcnt & (1 << 13)),
      win1: !!(dispcnt & (1 << 14)),
      objWin: !!(dispcnt & (1 << 15)) && objEnabled,
      inside: this.#windowInside,
    };
    let windowMask: Uint8Array | null = null;
    if (windows.win0 || windows.win1 || windows.objWin) {
      buildWindowMask(windows, this.#objFront, mmio, this.#windowMask);
      windowMask = this.#windowMask;
    }

    compositeScanline(layers, obj, windowMask, mmio, bus.palette, this.#framebuffer, fbOffset);
  }

  // ─── Backgrounds ─────────────────────────────────────────────────

  #renderBg(
    id: number,
    mode: number,
    ctrl: BgControl,
    line: number,
    dispcnt: number,
    bus: GbaSystemBus,
    buf: Uint32Array,
  ): void {
    const mmio = bus.mmioRegisters;
    if (mode === 0 || (mode === 1 && id < 2)) {
      renderTextBgScanline(ctrl.mosaic ? line - this.#bgMosaicY : line, id, ctrl, bus, buf);
    } else {
      const paramBase = id === 2 ? 0x20 : 0x30;
      const pa = (read16(mmio, paramBase) << 16) >> 16;
      const pc = (read16(mmio, paramBase + 4) << 16) >> 16;
      const refX = id === 2 ? this.#bg2RefX : this.#bg3RefX;
      const refY = id === 2 ? this.#bg2RefY : this.#bg3RefY;
      if (mode <= 2) {
        renderAffineBgScanline(ctrl, refX, refY, pa, pc, bus, buf);
      } else {
        // Mode 3 has a single frame; modes 4 and 5 show the frame DISPCNT bit 4 selects.
        const frameBase = mode !== 3 && dispcnt & (1 << 4) ? 0xa000 : 0;
        renderBitmapBgScanline(mode, frameBase, refX, refY, pa, pc, bus, buf);
      }
    }
    if (ctrl.mosaic) {
      const mosaicWidth = (read16(mmio, 0x4c) & 0xf) + 1;
      if (mosaicWidth > 1) {
        applyHorizontalMosaic(buf, mosaicWidth);
      }
    }
  }

  // ─── Line-start State ────────────────────────────────────────────

  /**
   * The end of visible line `line`: step the BG mosaic counter, then the affine reference
   * points of the BGs this mode draws through them — by PB/PD per line, or with mosaic by
   * size*PB/PD each time the counter wraps. A BG whose latched enable is off holds its point.
   * NBA background.cc DrawBackgroundImpl (cycle 1232, AdvanceBGXY).
   */
  #finishVisibleLine(line: number, mmio: Uint8Array, dispcnt: number): void {
    const sizeY = ((read16(mmio, 0x4c) >> 4) & 0xf) + 1;
    this.#bgMosaicY = line < VISIBLE_SCANLINES - 1 ? stepMosaicCounter(this.#bgMosaicY, sizeY) : 0;

    const mode = dispcnt & 0x7;
    const enabled = this.#dispcntLatch[0]! & dispcnt;
    if (mode >= 1 && mode <= 5 && enabled & (1 << 10)) {
      const step = this.#affineStep(mmio, 0x0c, sizeY);
      if (step) {
        this.#bg2RefX += step * ((read16(mmio, 0x22) << 16) >> 16);
        this.#bg2RefY += step * ((read16(mmio, 0x26) << 16) >> 16);
      }
    }
    if (mode === 2 && enabled & (1 << 11)) {
      const step = this.#affineStep(mmio, 0x0e, sizeY);
      if (step) {
        this.#bg3RefX += step * ((read16(mmio, 0x32) << 16) >> 16);
        this.#bg3RefY += step * ((read16(mmio, 0x36) << 16) >> 16);
      }
    }
  }

  /** How many lines of PB/PD an affine BG advances by at the end of this line. */
  #affineStep(mmio: Uint8Array, bgcntOffset: number, mosaicSizeY: number): number {
    if (!(read16(mmio, bgcntOffset) & (1 << 6))) {
      return 1;
    }
    return this.#bgMosaicY === 0 ? mosaicSizeY : 0;
  }

  /** Reload the axes in `which` (REF_* bits) from BGxX/BGxY and clear their written flags. */
  #reloadAffineRefs(mmio: Uint8Array, which: number): void {
    if (which & REF_BG2X) {
      this.#bg2RefX = readSigned28_8(mmio, 0x28);
    }
    if (which & REF_BG2Y) {
      this.#bg2RefY = readSigned28_8(mmio, 0x2c);
    }
    if (which & REF_BG3X) {
      this.#bg3RefX = readSigned28_8(mmio, 0x38);
    }
    if (which & REF_BG3Y) {
      this.#bg3RefY = readSigned28_8(mmio, 0x3c);
    }
    this.#refWritten = 0;
  }

  /**
   * Sweep both windows' horizontal flip-flops over x = 0..255: on at the left edge, off at
   * the right edge, carried over to the next line. Writes each visible pixel's coverage
   * (bit 0 WIN0, bit 1 WIN1, combined with the vertical flip-flops) into `inside` when given.
   * NBA window.cc DrawWindow.
   */
  #sweepWindowsHorizontal(mmio: Uint8Array, inside: Uint8Array | null): void {
    const win0H = read16(mmio, 0x40);
    const win1H = read16(mmio, 0x42);
    const left0 = win0H >> 8;
    const right0 = win0H & 0xff;
    const left1 = win1H >> 8;
    const right1 = win1H & 0xff;
    let flags = this.#windowFlags;
    if (inside) {
      const v0 = flags & WIN0_V ? 1 : 0;
      const v1 = flags & WIN1_V ? 2 : 0;
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        if (x === left0) {
          flags |= WIN0_H;
        }
        if (x === right0) {
          flags &= ~WIN0_H;
        }
        if (x === left1) {
          flags |= WIN1_H;
        }
        if (x === right1) {
          flags &= ~WIN1_H;
        }
        inside[x] = (flags & WIN0_H ? v0 : 0) | (flags & WIN1_H ? v1 : 0);
      }
    }
    // Every edge between 0 and 255 is reached, so the flip-flop ends the line on when its left
    // edge comes after its right edge, and off otherwise.
    flags &= ~(WIN0_H | WIN1_H);
    if (left0 > right0) {
      flags |= WIN0_H;
    }
    if (left1 > right1) {
      flags |= WIN1_H;
    }
    this.#windowFlags = flags;
  }

  // ─── OBJ ─────────────────────────────────────────────────────────

  #renderObjLine(line: number, bus: GbaSystemBus, out: Uint32Array): void {
    const dispcnt = read16(bus.mmioRegisters, 0x00);
    if (!(dispcnt & DISPCNT_OBJ)) {
      out.fill(0);
      return;
    }
    renderSpriteScanline(line, bus.oam, bus.vram, { dispcnt, mosaicY: this.#objMosaicY }, out);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Advance a mosaic vertical counter: wrap to 0 after `size` lines (NBA `_counter_y`). */
function stepMosaicCounter(counter: number, size: number): number {
  const next = counter + 1;
  return next === size ? 0 : next & 15;
}

function applyHorizontalMosaic(buf: Uint32Array, mosaicH: number): void {
  for (let x = 0; x < SCREEN_WIDTH; x++) {
    buf[x] = buf[x - (x % mosaicH)]!;
  }
}
