/**
 * Pixel helpers for the PPU views, pure so a test can check them without a canvas:
 * palette indices → RGBA for tiles, a tilemap, and a sprite.
 */
import type { SpriteInfo, TilemapEntry } from '@gba-kit/debug-core';

/** 0xRRGGBB → [r, g, b]. */
export function unpackRgb(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

/** 0xRRGGBB → CSS. */
export function cssColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Lay `count` tiles of 8×8 palette indices out in a grid `perRow` wide, painted
 * with `palette` (256 packed colors). A 4bpp tile uses the 16-color bank
 * `paletteBank`; index 0 is transparent unless `opaqueZero`.
 */
/** One opaque pixel of `0xRRGGBB` at byte offset `at`. */
function putPixel(rgba: Uint8ClampedArray, at: number, color: number): void {
  rgba[at] = (color >> 16) & 0xff;
  rgba[at + 1] = (color >> 8) & 0xff;
  rgba[at + 2] = color & 0xff;
  rgba[at + 3] = 255;
}

export function tilesToRgba(
  pixels: Uint8Array,
  count: number,
  perRow: number,
  bpp: 4 | 8,
  palette: number[],
  paletteBank = 0,
  opaqueZero = false,
): { width: number; height: number; rgba: Uint8ClampedArray } {
  const rows = Math.ceil(count / perRow);
  const width = perRow * 8;
  const height = rows * 8;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let t = 0; t < count; t++) {
    const tx = (t % perRow) * 8;
    const ty = Math.floor(t / perRow) * 8;
    for (let i = 0; i < 64; i++) {
      const index = pixels[t * 64 + i]!;
      if (index === 0 && !opaqueZero) {
        continue;
      }
      const color = palette[bpp === 4 ? paletteBank * 16 + index : index] ?? 0;
      const x = tx + (i & 7);
      const y = ty + (i >> 3);
      putPixel(rgba, (y * width + x) * 4, color);
    }
  }
  return { width, height, rgba };
}

/** Paint a text/affine background from its map entries and the tiles of its character base. */
export function tilemapToRgba(
  entries: TilemapEntry[],
  widthTiles: number,
  heightTiles: number,
  tiles: Uint8Array,
  tileCount: number,
  bpp: 4 | 8,
  palette: number[],
): { width: number; height: number; rgba: Uint8ClampedArray } {
  const width = widthTiles * 8;
  const height = heightTiles * 8;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let my = 0; my < heightTiles; my++) {
    for (let mx = 0; mx < widthTiles; mx++) {
      const e = entries[my * widthTiles + mx];
      if (!e || e.tile >= tileCount) {
        continue;
      }
      for (let i = 0; i < 64; i++) {
        const px = e.hFlip ? 7 - (i & 7) : i & 7;
        const py = e.vFlip ? 7 - (i >> 3) : i >> 3;
        const index = tiles[e.tile * 64 + py * 8 + px]!;
        if (index === 0) {
          continue;
        }
        const color = palette[bpp === 4 ? e.palette * 16 + index : index] ?? 0;
        const o = ((my * 8 + (i >> 3)) * width + mx * 8 + (i & 7)) * 4;
        rgba[o] = (color >> 16) & 0xff;
        rgba[o + 1] = (color >> 8) & 0xff;
        rgba[o + 2] = color & 0xff;
        rgba[o + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}

/**
 * Paint one sprite from the OBJ tiles (character base 0x10000, `objTiles` as 4bpp or
 * 8bpp indices per `sprite.bpp`) with the sprite palette. `oneDimensional` is
 * DISPCNT bit 6: how a multi-tile sprite's rows are addressed.
 */
export function spriteToRgba(
  sprite: SpriteInfo,
  objTiles: Uint8Array,
  objTileCount: number,
  objPalette: number[],
  oneDimensional: boolean,
): { width: number; height: number; rgba: Uint8ClampedArray } {
  const { width, height } = sprite;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const tilesWide = width / 8;
  const tilesHigh = height / 8;
  // 8bpp sprites count tiles in 4bpp units: each 8bpp tile is two 4bpp tile slots.
  const step = sprite.bpp === 8 ? 2 : 1;
  for (let ty = 0; ty < tilesHigh; ty++) {
    for (let tx = 0; tx < tilesWide; tx++) {
      const slot = oneDimensional ? sprite.tile + (ty * tilesWide + tx) * step : sprite.tile + ty * 32 + tx * step;
      const tileIndex = sprite.bpp === 8 ? slot >> 1 : slot;
      if (tileIndex >= objTileCount) {
        continue;
      }
      for (let i = 0; i < 64; i++) {
        const index = objTiles[tileIndex * 64 + i]!;
        if (index === 0) {
          continue;
        }
        const color = objPalette[sprite.bpp === 4 ? sprite.palette * 16 + index : index] ?? 0;
        let x = tx * 8 + (i & 7);
        let y = ty * 8 + (i >> 3);
        if (sprite.hFlip) {
          x = width - 1 - x;
        }
        if (sprite.vFlip) {
          y = height - 1 - y;
        }
        putPixel(rgba, (y * width + x) * 4, color);
      }
    }
  }
  return { width, height, rgba };
}

export function hex(value: number, digits = 8): string {
  return '0x' + (value >>> 0).toString(16).padStart(digits, '0');
}
