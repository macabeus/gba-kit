/**
 * GBA PPU — Core
 *
 * Implements PpuInterface. Dispatches rendering by BG mode (0, 1, 2)
 * and composites BG layers + sprites per scanline.
 *
 * Modes 3, 4, 5 (bitmap modes) are also supported for completeness.
 */
import type { PpuInterface } from '../gba.js';
import type { PpuSnapshot } from '../savestate.js';
import type { GbaSystemBus } from '../system-bus.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../types.js';
import {
  color15to32,
  parseBgControl,
  read16,
  readSigned28_8,
  renderAffineBgScanline,
  renderTextBgScanline,
} from './backgrounds.js';
import type { BgLayer } from './compositor.js';
import { compositeScanline } from './compositor.js';
import { renderSpriteScanline } from './sprites.js';
import type { SpritePixel } from './sprites.js';

// ─── PPU Implementation ──────────────────────────────────────────────

export class Ppu implements PpuInterface {
  readonly #framebuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);

  // Internal affine reference point accumulators (20.8 fixed point)
  #bg2RefX = 0;
  #bg2RefY = 0;
  #bg3RefX = 0;
  #bg3RefY = 0;
  #bg2RefLatched = false;
  #bg3RefLatched = false;

  // OAM buffer: snapshot taken at scanline start to prevent mid-frame corruption
  readonly #oamBuffer = new Uint8Array(0x400);

  // Temporary line buffers (reused per scanline to avoid allocation)
  readonly #bgBuffers: Uint32Array[] = [
    new Uint32Array(SCREEN_WIDTH),
    new Uint32Array(SCREEN_WIDTH),
    new Uint32Array(SCREEN_WIDTH),
    new Uint32Array(SCREEN_WIDTH),
  ];

  /** Reference to MMIO registers — set by the GBA coordinator */
  mmioRegisters?: Uint8Array;

  reset(): void {
    this.#framebuffer.fill(0);
    this.#bg2RefX = 0;
    this.#bg2RefY = 0;
    this.#bg3RefX = 0;
    this.#bg3RefY = 0;
    this.#bg2RefLatched = false;
    this.#bg3RefLatched = false;
    this.#oamBuffer.fill(0);
  }

  /** Serialize to a plain snapshot. */
  serialize(): PpuSnapshot {
    return {
      framebuffer: new Uint32Array(this.#framebuffer),
      bg2RefX: this.#bg2RefX,
      bg2RefY: this.#bg2RefY,
      bg3RefX: this.#bg3RefX,
      bg3RefY: this.#bg3RefY,
      bg2RefLatched: this.#bg2RefLatched,
      bg3RefLatched: this.#bg3RefLatched,
    };
  }

  /** Restore from a snapshot. */
  deserialize(snap: PpuSnapshot): void {
    this.#framebuffer.set(snap.framebuffer);
    this.#bg2RefX = snap.bg2RefX;
    this.#bg2RefY = snap.bg2RefY;
    this.#bg3RefX = snap.bg3RefX;
    this.#bg3RefY = snap.bg3RefY;
    this.#bg2RefLatched = snap.bg2RefLatched;
    this.#bg3RefLatched = snap.bg3RefLatched;
  }

  /**
   * Reload a BG reference point from MMIO registers.
   * On real GBA hardware, writing to BG2X/BG2Y/BG3X/BG3Y immediately
   * reloads the PPU's internal accumulator. This is how per-scanline
   * affine effects (pseudo-3D floors) work.
   */
  reloadBgRefPoint(bgIndex: 2 | 3, isX: boolean): void {
    const mmio = this.mmioRegisters;
    if (!mmio) {
      return;
    }
    if (bgIndex === 2) {
      if (isX) {
        this.#bg2RefX = readSigned28_8(mmio, 0x28);
      } else {
        this.#bg2RefY = readSigned28_8(mmio, 0x2c);
      }
      this.#bg2RefLatched = true;
    } else {
      if (isX) {
        this.#bg3RefX = readSigned28_8(mmio, 0x38);
      } else {
        this.#bg3RefY = readSigned28_8(mmio, 0x3c);
      }
      this.#bg3RefLatched = true;
    }
  }

  getFramebuffer(): Uint32Array {
    return this.#framebuffer;
  }

  onVBlank(): void {
    // Reset affine reference points at VBlank so they reload at frame start
    this.#bg2RefLatched = false;
    this.#bg3RefLatched = false;
  }

  renderScanline(line: number, bus: GbaSystemBus): void {
    if (line < 0 || line >= SCREEN_HEIGHT) {
      return;
    }

    const mmio = bus.mmioRegisters;
    const dispcnt = read16(mmio, 0x00);
    const mode = dispcnt & 0x7;

    // Forced blank — white scanline
    if (dispcnt & (1 << 7)) {
      const offset = line * SCREEN_WIDTH;
      this.#framebuffer.fill(0xffffffff, offset, offset + SCREEN_WIDTH);
      return;
    }

    // Determine which BGs are enabled
    const bg0On = !!(dispcnt & (1 << 8));
    const bg1On = !!(dispcnt & (1 << 9));
    const bg2On = !!(dispcnt & (1 << 10));
    const bg3On = !!(dispcnt & (1 << 11));
    const objOn = !!(dispcnt & (1 << 12));

    // OBJ 1D mapping mode
    const objMapping1D = !!(dispcnt & (1 << 6));

    // Mosaic register
    const mosaicReg = read16(mmio, 0x4c);
    const bgMosaicH = (mosaicReg & 0xf) + 1;
    const bgMosaicV = ((mosaicReg >> 4) & 0xf) + 1;
    const objMosaicH = ((mosaicReg >> 8) & 0xf) + 1;
    const objMosaicV = ((mosaicReg >> 12) & 0xf) + 1;

    // Clear line buffers
    for (const buf of this.#bgBuffers) {
      buf.fill(0);
    }

    // Latch affine reference points at scanline 0
    if (!this.#bg2RefLatched) {
      this.#bg2RefX = readSigned28_8(mmio, 0x28);
      this.#bg2RefY = readSigned28_8(mmio, 0x2c);
      this.#bg2RefLatched = true;
    }
    if (!this.#bg3RefLatched) {
      this.#bg3RefX = readSigned28_8(mmio, 0x38);
      this.#bg3RefY = readSigned28_8(mmio, 0x3c);
      this.#bg3RefLatched = true;
    }

    // Render BGs based on mode
    const bgLayers: BgLayer[] = [];

    switch (mode) {
      case 0:
        this.#renderMode0(line, bg0On, bg1On, bg2On, bg3On, bus, bgLayers, bgMosaicH, bgMosaicV);
        break;
      case 1:
        this.#renderMode1(line, bg0On, bg1On, bg2On, bus, bgLayers, bgMosaicH, bgMosaicV);
        break;
      case 2:
        this.#renderMode2(line, bg2On, bg3On, bus, bgLayers, bgMosaicH, bgMosaicV);
        break;
      case 3:
        this.#renderMode3(line, bg2On, bus);
        this.#advanceAffineRefs(mmio);
        // Mode 3 writes directly to framebuffer, skip compositing
        return;
      case 4:
        this.#renderMode4(line, bg2On, bus);
        this.#advanceAffineRefs(mmio);
        return;
      case 5:
        this.#renderMode5(line, bg2On, bus);
        this.#advanceAffineRefs(mmio);
        return;
      default:
        break;
    }

    // Snapshot OAM at scanline start to prevent mid-frame DMA corruption
    this.#oamBuffer.set(bus.oam);

    // Render sprites
    let sprites: SpritePixel[];
    if (objOn) {
      sprites = renderSpriteScanline(line, bus, objMapping1D, objMosaicH, objMosaicV, this.#oamBuffer);
    } else {
      sprites = emptySprites();
    }

    // Composite
    compositeScanline(line, bgLayers, sprites, bus, this.#framebuffer);

    // Advance affine reference points for next scanline
    this.#advanceAffineRefs(mmio);
  }

  // ─── Mode 0: 4 Text BGs ─────────────────────────────────────────

  #renderMode0(
    line: number,
    bg0On: boolean,
    bg1On: boolean,
    bg2On: boolean,
    bg3On: boolean,
    bus: GbaSystemBus,
    bgLayers: BgLayer[],
    mosaicH: number,
    mosaicV: number,
  ): void {
    const bgs: [boolean, number][] = [
      [bg0On, 0],
      [bg1On, 1],
      [bg2On, 2],
      [bg3On, 3],
    ];

    for (const [enabled, idx] of bgs) {
      if (!enabled) {
        continue;
      }
      const cnt = read16(bus.mmioRegisters, 0x08 + idx * 2);
      const ctrl = parseBgControl(cnt);
      const buf = this.#bgBuffers[idx]!;

      const effectiveLine = ctrl.mosaic ? line - (line % mosaicV) : line;

      renderTextBgScanline(effectiveLine, idx, ctrl, bus, buf);

      if (ctrl.mosaic && mosaicH > 1) {
        applyHorizontalMosaic(buf, mosaicH);
      }

      bgLayers.push({ id: idx, priority: ctrl.priority, lineBuffer: buf });
    }
  }

  // ─── Mode 1: 2 Text + 1 Affine ──────────────────────────────────

  #renderMode1(
    line: number,
    bg0On: boolean,
    bg1On: boolean,
    bg2On: boolean,
    bus: GbaSystemBus,
    bgLayers: BgLayer[],
    mosaicH: number,
    mosaicV: number,
  ): void {
    // BG0, BG1 are text
    const textBgs: [boolean, number][] = [
      [bg0On, 0],
      [bg1On, 1],
    ];

    for (const [enabled, idx] of textBgs) {
      if (!enabled) {
        continue;
      }
      const cnt = read16(bus.mmioRegisters, 0x08 + idx * 2);
      const ctrl = parseBgControl(cnt);
      const buf = this.#bgBuffers[idx]!;

      const effectiveLine = ctrl.mosaic ? line - (line % mosaicV) : line;
      renderTextBgScanline(effectiveLine, idx, ctrl, bus, buf);

      if (ctrl.mosaic && mosaicH > 1) {
        applyHorizontalMosaic(buf, mosaicH);
      }

      bgLayers.push({ id: idx, priority: ctrl.priority, lineBuffer: buf });
    }

    // BG2 is affine
    if (bg2On) {
      const cnt = read16(bus.mmioRegisters, 0x0c);
      const ctrl = parseBgControl(cnt);
      const buf = this.#bgBuffers[2]!;

      renderAffineBgScanline(line, 2, ctrl, this.#bg2RefX, this.#bg2RefY, bus, buf);

      if (ctrl.mosaic && mosaicH > 1) {
        applyHorizontalMosaic(buf, mosaicH);
      }

      bgLayers.push({ id: 2, priority: ctrl.priority, lineBuffer: buf });
    }
  }

  // ─── Mode 2: 2 Affine BGs ───────────────────────────────────────

  #renderMode2(
    line: number,
    bg2On: boolean,
    bg3On: boolean,
    bus: GbaSystemBus,
    bgLayers: BgLayer[],
    mosaicH: number,
    _mosaicV: number,
  ): void {
    if (bg2On) {
      const cnt = read16(bus.mmioRegisters, 0x0c);
      const ctrl = parseBgControl(cnt);
      const buf = this.#bgBuffers[2]!;

      renderAffineBgScanline(line, 2, ctrl, this.#bg2RefX, this.#bg2RefY, bus, buf);

      if (ctrl.mosaic && mosaicH > 1) {
        applyHorizontalMosaic(buf, mosaicH);
      }

      bgLayers.push({ id: 2, priority: ctrl.priority, lineBuffer: buf });
    }

    if (bg3On) {
      const cnt = read16(bus.mmioRegisters, 0x0e);
      const ctrl = parseBgControl(cnt);
      const buf = this.#bgBuffers[3]!;

      renderAffineBgScanline(line, 3, ctrl, this.#bg3RefX, this.#bg3RefY, bus, buf);

      if (ctrl.mosaic && mosaicH > 1) {
        applyHorizontalMosaic(buf, mosaicH);
      }

      bgLayers.push({ id: 3, priority: ctrl.priority, lineBuffer: buf });
    }
  }

  // ─── Mode 3: 16-bit Bitmap ──────────────────────────────────────

  #renderMode3(line: number, bg2On: boolean, bus: GbaSystemBus): void {
    const offset = line * SCREEN_WIDTH;
    if (!bg2On) {
      this.#framebuffer.fill(0xff000000, offset, offset + SCREEN_WIDTH);
      return;
    }

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const addr = (line * SCREEN_WIDTH + x) * 2;
      const color15 = read16(bus.vram, addr);
      this.#framebuffer[offset + x] = color15to32(color15);
    }
  }

  // ─── Mode 4: 8-bit Indexed Bitmap ───────────────────────────────

  #renderMode4(line: number, bg2On: boolean, bus: GbaSystemBus): void {
    const offset = line * SCREEN_WIDTH;
    if (!bg2On) {
      this.#framebuffer.fill(0xff000000, offset, offset + SCREEN_WIDTH);
      return;
    }

    const dispcnt = read16(bus.mmioRegisters, 0x00);
    const frame = dispcnt & (1 << 4) ? 0xa000 : 0;

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const idx = bus.vram[frame + line * SCREEN_WIDTH + x]!;
      if (idx === 0) {
        this.#framebuffer[offset + x] = 0xff000000;
      } else {
        const color15 = read16(bus.palette, idx * 2);
        this.#framebuffer[offset + x] = color15to32(color15);
      }
    }
  }

  // ─── Mode 5: 16-bit Bitmap (smaller) ────────────────────────────

  #renderMode5(line: number, bg2On: boolean, bus: GbaSystemBus): void {
    const offset = line * SCREEN_WIDTH;
    if (!bg2On || line >= 128) {
      this.#framebuffer.fill(0xff000000, offset, offset + SCREEN_WIDTH);
      return;
    }

    const dispcnt = read16(bus.mmioRegisters, 0x00);
    const frame = dispcnt & (1 << 4) ? 0xa000 : 0;

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      if (x >= 160) {
        this.#framebuffer[offset + x] = 0xff000000;
      } else {
        const addr = frame + (line * 160 + x) * 2;
        const color15 = read16(bus.vram, addr);
        this.#framebuffer[offset + x] = color15to32(color15);
      }
    }
  }

  // ─── Affine Reference Point Advancement ──────────────────────────

  #advanceAffineRefs(mmio: Uint8Array): void {
    // After each scanline, add PB/PD to reference points
    const bg2pb = toSignedS16(read16(mmio, 0x22));
    const bg2pd = toSignedS16(read16(mmio, 0x26));
    this.#bg2RefX += bg2pb;
    this.#bg2RefY += bg2pd;

    const bg3pb = toSignedS16(read16(mmio, 0x32));
    const bg3pd = toSignedS16(read16(mmio, 0x36));
    this.#bg3RefX += bg3pb;
    this.#bg3RefY += bg3pd;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function toSignedS16(value: number): number {
  return (value << 16) >> 16;
}

function applyHorizontalMosaic(buf: Uint32Array, mosaicH: number): void {
  for (let x = 0; x < SCREEN_WIDTH; x++) {
    const blockStart = x - (x % mosaicH);
    buf[x] = buf[blockStart]!;
  }
}

/** Create an empty sprite pixel array (no sprites visible) */
function emptySprites(): SpritePixel[] {
  const arr: SpritePixel[] = new Array(SCREEN_WIDTH);
  for (let i = 0; i < SCREEN_WIDTH; i++) {
    arr[i] = { color: 0, priority: 4, semiTransparent: false, isObjWindow: false };
  }
  return arr;
}
