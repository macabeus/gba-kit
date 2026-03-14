/**
 * GBA PPU — Background Rendering
 *
 * Renders text (Mode 0/1) and affine (Mode 1/2) background layers.
 * Text BGs use 16-bit tile map entries; affine BGs use 8-bit entries.
 */
import type { GbaSystemBus } from '../system-bus.js';
import { SCREEN_WIDTH } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function read16(arr: Uint8Array, offset: number): number {
  return arr[offset]! | (arr[offset + 1]! << 8);
}

function color15to32(color15: number): number {
  const r = (color15 & 0x1f) << 3;
  const g = ((color15 >> 5) & 0x1f) << 3;
  const b = ((color15 >> 10) & 0x1f) << 3;
  return 0xff000000 | (b << 16) | (g << 8) | r;
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

// ─── Text BG Dimensions ──────────────────────────────────────────────

/** Returns [width, height] in tiles for text BG screen sizes */
function textBgDimensions(screenSize: number): [number, number] {
  switch (screenSize) {
    case 0:
      return [32, 32]; // 256x256
    case 1:
      return [64, 32]; // 512x256
    case 2:
      return [32, 64]; // 256x512
    case 3:
      return [64, 64]; // 512x512
    default:
      return [32, 32];
  }
}

// ─── Text Background Rendering ───────────────────────────────────────

/**
 * Render one scanline of a text background layer.
 *
 * @param line - scanline number (0-159)
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
  const hofsOffset = 0x10 + bgIndex * 4;
  const vofsOffset = 0x12 + bgIndex * 4;
  const hofs = read16(mmio, hofsOffset) & 0x1ff;
  const vofs = read16(mmio, vofsOffset) & 0x1ff;

  const [widthTiles, heightTiles] = textBgDimensions(ctrl.screenSize);
  const widthPixels = widthTiles * 8;
  const heightPixels = heightTiles * 8;

  const y = (line + vofs) % heightPixels;
  const tileRow = y >> 3;
  const fineY = y & 7;

  for (let px = 0; px < SCREEN_WIDTH; px++) {
    const x = (px + hofs) % widthPixels;
    const tileCol = x >> 3;
    const fineX = x & 7;

    // Determine which screen block this tile is in
    // For 64-wide: screens 0,1 are top row; 2,3 are bottom row
    // For 64-tall: screens 0,1 are left col top/bottom
    let screenBlock = 0;
    let localCol = tileCol;
    let localRow = tileRow;

    if (widthTiles === 64) {
      if (tileCol >= 32) {
        screenBlock += 1;
        localCol = tileCol - 32;
      }
    }
    if (heightTiles === 64) {
      if (tileRow >= 32) {
        screenBlock += widthTiles === 64 ? 2 : 1;
        localRow = tileRow - 32;
      }
    }

    const mapAddr = ctrl.mapBase + screenBlock * 0x800 + (localRow * 32 + localCol) * 2;
    const mapEntry = read16(bus.vram, mapAddr);

    const tileIndex = mapEntry & 0x3ff;
    const hflip = !!(mapEntry & (1 << 10));
    const vflip = !!(mapEntry & (1 << 11));
    const palNum = (mapEntry >> 12) & 0xf;

    const pixY = vflip ? 7 - fineY : fineY;
    const pixX = hflip ? 7 - fineX : fineX;

    let colorIndex: number;

    if (ctrl.colorMode === 1) {
      // 8bpp — 64 bytes per tile
      const tileAddr = ctrl.tileBase + tileIndex * 64 + pixY * 8 + pixX;
      colorIndex = bus.vram[tileAddr]!;
    } else {
      // 4bpp — 32 bytes per tile
      const tileAddr = ctrl.tileBase + tileIndex * 32 + pixY * 4 + (pixX >> 1);
      const byte = bus.vram[tileAddr]!;
      colorIndex = pixX & 1 ? byte >> 4 : byte & 0xf;
    }

    if (colorIndex === 0) {
      lineBuffer[px] = 0; // transparent
      continue;
    }

    let paletteOffset: number;
    if (ctrl.colorMode === 1) {
      paletteOffset = colorIndex * 2;
    } else {
      paletteOffset = (palNum * 16 + colorIndex) * 2;
    }

    const color15 = read16(bus.palette, paletteOffset);
    lineBuffer[px] = color15to32(color15);
  }
}

// ─── Affine Background Rendering ─────────────────────────────────────

/** Returns map size in tiles for affine BG screen sizes */
function affineBgSize(screenSize: number): number {
  switch (screenSize) {
    case 0:
      return 16; // 128x128
    case 1:
      return 32; // 256x256
    case 2:
      return 64; // 512x512
    case 3:
      return 128; // 1024x1024
    default:
      return 16;
  }
}

/**
 * Render one scanline of an affine background layer.
 *
 * @param line - scanline number
 * @param bgIndex - BG index (2 or 3)
 * @param ctrl - parsed BG control
 * @param refX - current reference point X (8.8 fixed point already accumulated)
 * @param refY - current reference point Y (8.8 fixed point already accumulated)
 * @param bus - system bus
 * @param lineBuffer - output buffer
 */
export function renderAffineBgScanline(
  _line: number,
  bgIndex: number,
  ctrl: BgControl,
  refX: number,
  refY: number,
  bus: GbaSystemBus,
  lineBuffer: Uint32Array,
): void {
  const mmio = bus.mmioRegisters;

  // Affine parameters — PA and PC are the per-pixel increments for X scanline
  const paramBase = bgIndex === 2 ? 0x20 : 0x30;
  const pa = toSignedS16(read16(mmio, paramBase)); // dx per pixel
  const pc = toSignedS16(read16(mmio, paramBase + 4)); // dy per pixel

  const sizeTiles = affineBgSize(ctrl.screenSize);
  const sizePixels = sizeTiles * 8;

  let texX = refX; // 8.8 fixed point
  let texY = refY;

  for (let px = 0; px < SCREEN_WIDTH; px++) {
    // Convert from 8.8 fixed point to integer pixel coords
    let ix = texX >> 8;
    let iy = texY >> 8;

    texX += pa;
    texY += pc;

    if (ctrl.overflow) {
      // Wrapping
      ix = ((ix % sizePixels) + sizePixels) % sizePixels;
      iy = ((iy % sizePixels) + sizePixels) % sizePixels;
    } else {
      // Clamp — out of bounds is transparent
      if (ix < 0 || ix >= sizePixels || iy < 0 || iy >= sizePixels) {
        lineBuffer[px] = 0;
        continue;
      }
    }

    const tileCol = ix >> 3;
    const tileRow = iy >> 3;
    const fineX = ix & 7;
    const fineY = iy & 7;

    // Affine map entries are 8-bit (tile index only)
    const mapAddr = ctrl.mapBase + tileRow * sizeTiles + tileCol;
    const tileIndex = bus.vram[mapAddr]!;

    // Always 8bpp for affine BGs
    const tileAddr = ctrl.tileBase + tileIndex * 64 + fineY * 8 + fineX;
    const colorIndex = bus.vram[tileAddr]!;

    if (colorIndex === 0) {
      lineBuffer[px] = 0;
      continue;
    }

    const color15 = read16(bus.palette, colorIndex * 2);
    lineBuffer[px] = color15to32(color15);
  }
}

// ─── Fixed-Point Helpers ─────────────────────────────────────────────

function toSignedS16(value: number): number {
  return (value << 16) >> 16;
}

export function readSigned28_8(mmio: Uint8Array, offset: number): number {
  const lo = read16(mmio, offset);
  const hi = read16(mmio, offset + 2);
  const raw = lo | (hi << 16);
  // Sign-extend from 28 bits (bit 27 is sign in the 28.8 format)
  return (raw << 4) >> 4;
}

export { color15to32, read16 };
