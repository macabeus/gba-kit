/**
 * GBA PPU — Background Rendering
 *
 * Renders one line of a text (modes 0/1), affine (modes 1/2) or bitmap (modes 3/4/5)
 * background into a line buffer of colours. A buffer entry is 0 for a transparent pixel and
 * `OPAQUE | colour` otherwise, where the colour is the whole halfword read from palette RAM
 * or VRAM (bit 15 included: the colour effects use it as green's sixth bit).
 * Text BGs use 16-bit tile map entries; affine BGs use 8-bit entries; bitmap BGs read
 * VRAM directly. Affine and bitmap BGs are sampled through BG2/BG3's internal reference
 * point, stepped by PA/PC per pixel.
 *
 * References: GBATEK "LCD VRAM BG Screen Data Format", "LCD VRAM Bitmap BG Modes";
 * NanoBoyAdvance src/nba/src/hw/ppu/background.inl (RenderMode2BG, RenderMode3BG-5BG).
 */
import type { GbaSystemBus } from '../system-bus.js';
import { SCREEN_WIDTH } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────

/** Marks an opaque pixel in a BG line buffer, above the 16-bit colour. */
export const OPAQUE = 0x10000;

/** The BG area of VRAM in the tile modes; the OBJ tiles sit above it (GBATEK "LCD VRAM Overview"). */
const BG_VRAM_SIZE = 0x10000;

function read16(arr: Uint8Array, offset: number): number {
  return arr[offset]! | (arr[offset + 1]! << 8);
}

/** A 15-bit colour as the framebuffer's 0xAABBGGRR, each 5-bit channel shifted left by 3. */
function color15to32(color15: number): number {
  const r = (color15 & 0x1f) << 3;
  const g = ((color15 >> 5) & 0x1f) << 3;
  const b = ((color15 >> 10) & 0x1f) << 3;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

// ─── BG Control Parsing ──────────────────────────────────────────────

export interface BgControl {
  priority: number;
  tileBase: number; // character base block (in bytes, offset into VRAM)
  mosaic: boolean;
  colorMode: number; // 0 = 4bpp (16 palettes), 1 = 8bpp (single palette)
  mapBase: number; // screen base block (in bytes, offset into VRAM)
  overflow: boolean; // affine wrapping
  screenSize: number; // 0-3
}

export function parseBgControl(cnt: number): BgControl {
  return {
    priority: cnt & 0x3,
    tileBase: ((cnt >> 2) & 0x3) * 0x4000,
    mosaic: !!(cnt & (1 << 6)),
    colorMode: (cnt >> 7) & 1,
    mapBase: ((cnt >> 8) & 0x1f) * 0x800,
    overflow: !!(cnt & (1 << 13)),
    screenSize: (cnt >> 14) & 0x3,
  };
}

// ─── Text Background Rendering ───────────────────────────────────────

/**
 * Render one scanline of a text background layer.
 *
 * @param line - the BG line to fetch: the scanline minus the BG mosaic counter
 * @param bgIndex - BG layer index (0-3)
 * @param ctrl - parsed BG control register
 * @param bus - system bus for memory access
 * @param lineBuffer - output buffer (SCREEN_WIDTH entries, 0 = transparent)
 */
export function renderTextBgScanline(
  line: number,
  bgIndex: number,
  ctrl: BgControl,
  bus: GbaSystemBus,
  lineBuffer: Uint32Array,
): void {
  const mmio = bus.mmioRegisters;
  const vram = bus.vram;
  const palette = bus.palette;
  const hofs = read16(mmio, 0x10 + bgIndex * 4) & 0x1ff;
  const vofs = read16(mmio, 0x12 + bgIndex * 4) & 0x1ff;

  // Screen sizes 1 and 3 are 64 tiles wide, 2 and 3 are 64 tiles tall; each 32x32 block is 0x800 bytes.
  const wide = ctrl.screenSize & 1;
  const tall = ctrl.screenSize >> 1;
  const widthMask = (256 << wide) - 1;
  const heightMask = (256 << tall) - 1;

  const y = (line + vofs) & heightMask;
  const tileRow = y >> 3;
  const fineY = y & 7;
  const rowBase = ctrl.mapBase + (tileRow >> 5) * (wide ? 0x1000 : 0x800) + (tileRow & 31) * 64;

  for (let px = 0; px < SCREEN_WIDTH; px++) {
    const x = (px + hofs) & widthMask;
    const tileCol = x >> 3;
    const mapEntry = read16(vram, rowBase + (tileCol >> 5) * 0x800 + (tileCol & 31) * 2);

    const tileIndex = mapEntry & 0x3ff;
    const pixX = mapEntry & (1 << 10) ? 7 - (x & 7) : x & 7;
    const pixY = mapEntry & (1 << 11) ? 7 - fineY : fineY;

    // The BG unit fetches from the 64 KB BG area only: tile data past it draws transparent (mGBA
    // software-mode0.c `charBase >= 0x10000`; NBA ppu.hh FetchVRAM_BG reads no OBJ VRAM either).
    let paletteIndex = 0;
    if (ctrl.colorMode === 1) {
      // 8bpp — 64 bytes per tile
      const address = ctrl.tileBase + tileIndex * 64 + pixY * 8 + pixX;
      if (address < BG_VRAM_SIZE) {
        paletteIndex = vram[address]!;
      }
    } else {
      // 4bpp — 32 bytes per tile
      const address = ctrl.tileBase + tileIndex * 32 + pixY * 4 + (pixX >> 1);
      if (address < BG_VRAM_SIZE) {
        const byte = vram[address]!;
        const colorIndex = pixX & 1 ? byte >> 4 : byte & 0xf;
        paletteIndex = colorIndex === 0 ? 0 : ((mapEntry >> 12) << 4) | colorIndex;
      }
    }

    lineBuffer[px] = paletteIndex === 0 ? 0 : OPAQUE | read16(palette, paletteIndex * 2);
  }
}

// ─── Affine Background Rendering ─────────────────────────────────────

/**
 * Render one scanline of an affine background layer.
 *
 * @param ctrl - parsed BG control
 * @param refX - internal reference point X (signed 20.8 fixed point)
 * @param refY - internal reference point Y (signed 20.8 fixed point)
 * @param pa - X step per pixel (BGxPA, signed 8.8)
 * @param pc - Y step per pixel (BGxPC, signed 8.8)
 * @param bus - system bus
 * @param lineBuffer - output buffer
 */
export function renderAffineBgScanline(
  ctrl: BgControl,
  refX: number,
  refY: number,
  pa: number,
  pc: number,
  bus: GbaSystemBus,
  lineBuffer: Uint32Array,
): void {
  const vram = bus.vram;
  const palette = bus.palette;
  const logSize = ctrl.screenSize;
  const sizePixels = 128 << logSize;
  const mask = sizePixels - 1;

  let texX = refX;
  let texY = refY;

  for (let px = 0; px < SCREEN_WIDTH; px++) {
    let ix = texX >> 8;
    let iy = texY >> 8;
    texX += pa;
    texY += pc;

    if (ctrl.overflow) {
      ix &= mask;
      iy &= mask;
    } else if ((ix | iy) & -sizePixels) {
      // Outside the map without wraparound: transparent.
      lineBuffer[px] = 0;
      continue;
    }

    // Affine map entries are 8-bit tile numbers; tiles are always 8bpp.
    const tileIndex = vram[(ctrl.mapBase + ((iy >> 3) << (4 + logSize)) + (ix >> 3)) & 0xffff]!;
    const colorIndex = vram[ctrl.tileBase + tileIndex * 64 + (iy & 7) * 8 + (ix & 7)]!;

    lineBuffer[px] = colorIndex === 0 ? 0 : OPAQUE | read16(palette, colorIndex * 2);
  }
}

// ─── Bitmap Background Rendering ─────────────────────────────────────

/**
 * Render one scanline of BG2 in a bitmap mode, sampled through the affine reference point
 * like any rotation/scaling BG. Pixels outside the bitmap (240x160 in modes 3 and 4, 160x128
 * in mode 5) and palette index 0 in mode 4 are transparent, so the layers behind and the
 * backdrop show through. GBATEK, "LCD VRAM Bitmap BG Modes".
 *
 * @param mode - BG mode (3, 4 or 5)
 * @param frameBase - VRAM offset of the displayed frame (DISPCNT bit 4 selects 0xA000 in modes 4 and 5)
 */
export function renderBitmapBgScanline(
  mode: number,
  frameBase: number,
  refX: number,
  refY: number,
  pa: number,
  pc: number,
  bus: GbaSystemBus,
  lineBuffer: Uint32Array,
): void {
  const vram = bus.vram;
  const palette = bus.palette;
  const width = mode === 5 ? 160 : SCREEN_WIDTH;
  const height = mode === 5 ? 128 : 160;

  let texX = refX;
  let texY = refY;

  for (let px = 0; px < SCREEN_WIDTH; px++) {
    const ix = texX >> 8;
    const iy = texY >> 8;
    texX += pa;
    texY += pc;

    if (ix < 0 || ix >= width || iy < 0 || iy >= height) {
      lineBuffer[px] = 0;
      continue;
    }

    if (mode === 4) {
      const index = vram[frameBase + iy * SCREEN_WIDTH + ix]!;
      lineBuffer[px] = index === 0 ? 0 : OPAQUE | read16(palette, index * 2);
    } else {
      lineBuffer[px] = OPAQUE | read16(vram, frameBase + (iy * width + ix) * 2);
    }
  }
}

// ─── Fixed-Point Helpers ─────────────────────────────────────────────

export function readSigned28_8(mmio: Uint8Array, offset: number): number {
  const lo = read16(mmio, offset);
  const hi = read16(mmio, offset + 2);
  const raw = lo | (hi << 16);
  // Sign-extend from 28 bits (bit 27 is sign in the 28.8 format)
  return (raw << 4) >> 4;
}

export { color15to32, read16 };
