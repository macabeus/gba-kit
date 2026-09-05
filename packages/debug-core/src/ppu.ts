/**
 * What the PPU is showing, decoded from palette RAM, VRAM, OAM and the display
 * registers into plain data the viewers draw: palettes, tiles, tilemaps, sprites.
 */
import type { Machine } from './machine.js';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** BGR555 → 8-bit RGB. */
export function rgb555(value: number): RgbColor {
  return { r: (value & 0x1f) << 3, g: ((value >> 5) & 0x1f) << 3, b: ((value >> 10) & 0x1f) << 3 };
}

/** 256 background + 256 sprite colors as packed 0xRRGGBB. */
export function paletteSnapshot(machine: Machine): { bg: number[]; obj: number[] } {
  const raw = machine.peekPartial(0x05000000, 0x400).data;
  const colors = (offset: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 256; i++) {
      const v = raw[offset + i * 2]! | (raw[offset + i * 2 + 1]! << 8);
      const { r, g, b } = rgb555(v);
      out.push((r << 16) | (g << 8) | b);
    }
    return out;
  };
  return { bg: colors(0), obj: colors(0x200) };
}

export interface TilesSnapshot {
  charBase: number;
  bpp: 4 | 8;
  count: number;
  /** count × 64 palette indices, row-major 8×8 per tile */
  pixels: Uint8Array;
}

/** Decode `count` tiles from a character base (VRAM offset). 4bpp indices are 0–15, 8bpp 0–255. */
export function tilesSnapshot(machine: Machine, charBase: number, bpp: 4 | 8, count: number): TilesSnapshot {
  const bytesPerTile = bpp === 4 ? 32 : 64;
  const raw = machine.peekPartial(0x06000000 + charBase, bytesPerTile * count).data;
  const pixels = new Uint8Array(count * 64);
  for (let t = 0; t < count; t++) {
    for (let i = 0; i < 64; i++) {
      if (bpp === 8) {
        pixels[t * 64 + i] = raw[t * 64 + i]!;
      } else {
        const byte = raw[t * 32 + (i >> 1)]!;
        pixels[t * 64 + i] = i & 1 ? byte >> 4 : byte & 0xf;
      }
    }
  }
  return { charBase, bpp, count, pixels };
}

export interface BackgroundInfo {
  index: number;
  enabled: boolean;
  priority: number;
  charBase: number;
  screenBase: number;
  bpp: 4 | 8;
  mosaic: boolean;
  /** tile size of the map, in tiles */
  width: number;
  height: number;
  affine: boolean;
  scrollX: number;
  scrollY: number;
}

/** DISPCNT + BGxCNT decoded per layer. */
export function backgroundsSnapshot(machine: Machine): { mode: number; backgrounds: BackgroundInfo[] } {
  const io = machine.peekPartial(0x04000000, 0x60).data;
  const u16 = (off: number): number => io[off]! | (io[off + 1]! << 8);
  const dispcnt = u16(0);
  const mode = dispcnt & 7;
  const backgrounds: BackgroundInfo[] = [];
  for (let i = 0; i < 4; i++) {
    const cnt = u16(0x08 + i * 2);
    const affine = (mode === 1 && i === 2) || (mode === 2 && i >= 2);
    const size = (cnt >> 14) & 3;
    const width = affine ? [16, 32, 64, 128][size]! : size & 1 ? 64 : 32;
    const height = affine ? width : size & 2 ? 64 : 32;
    backgrounds.push({
      index: i,
      enabled: (dispcnt & (1 << (8 + i))) !== 0,
      priority: cnt & 3,
      charBase: ((cnt >> 2) & 3) * 0x4000,
      screenBase: ((cnt >> 8) & 0x1f) * 0x800,
      bpp: cnt & (1 << 7) || affine ? 8 : 4,
      mosaic: (cnt & (1 << 6)) !== 0,
      width,
      height,
      affine,
      scrollX: u16(0x10 + i * 4) & 0x1ff,
      scrollY: u16(0x12 + i * 4) & 0x1ff,
    });
  }
  return { mode, backgrounds };
}

export interface TilemapEntry {
  tile: number;
  hFlip: boolean;
  vFlip: boolean;
  palette: number;
}

export interface TilemapSnapshot {
  background: BackgroundInfo;
  entries: TilemapEntry[];
}

/** The map entries of a text or affine background, row-major, width × height. */
export function tilemapSnapshot(machine: Machine, index: number): TilemapSnapshot | null {
  const bg = backgroundsSnapshot(machine).backgrounds[index];
  if (!bg) {
    return null;
  }
  const entries: TilemapEntry[] = [];
  if (bg.affine) {
    const raw = machine.peekPartial(0x06000000 + bg.screenBase, bg.width * bg.height).data;
    for (let i = 0; i < bg.width * bg.height; i++) {
      entries.push({ tile: raw[i]!, hFlip: false, vFlip: false, palette: 0 });
    }
    return { background: bg, entries };
  }
  // Text backgrounds are made of 32×32 screen blocks laid out left-to-right, top-to-bottom.
  const blocksX = bg.width / 32;
  const bytes = machine.peekPartial(0x06000000 + bg.screenBase, blocksX * (bg.height / 32) * 0x800).data;
  for (let y = 0; y < bg.height; y++) {
    for (let x = 0; x < bg.width; x++) {
      const block = Math.floor(y / 32) * blocksX + Math.floor(x / 32);
      const offset = block * 0x800 + ((y % 32) * 32 + (x % 32)) * 2;
      const v = bytes[offset]! | (bytes[offset + 1]! << 8);
      entries.push({ tile: v & 0x3ff, hFlip: (v & 0x400) !== 0, vFlip: (v & 0x800) !== 0, palette: (v >> 12) & 0xf });
    }
  }
  return { background: bg, entries };
}

export interface SpriteInfo {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  tile: number;
  palette: number;
  priority: number;
  hFlip: boolean;
  vFlip: boolean;
  enabled: boolean;
  bpp: 4 | 8;
  /** 0 normal, 1 semi-transparent, 2 window */
  mode: number;
  affine: boolean;
  affineIndex: number;
  doubleSize: boolean;
  mosaic: boolean;
}

const SPRITE_SIZES: Record<number, Array<[number, number]>> = {
  0: [
    [8, 8],
    [16, 16],
    [32, 32],
    [64, 64],
  ],
  1: [
    [16, 8],
    [32, 8],
    [32, 16],
    [64, 32],
  ],
  2: [
    [8, 16],
    [8, 32],
    [16, 32],
    [32, 64],
  ],
};

/** The 128 OAM entries decoded. */
export function spritesSnapshot(machine: Machine): SpriteInfo[] {
  const oam = machine.peekPartial(0x07000000, 0x400).data;
  const out: SpriteInfo[] = [];
  for (let i = 0; i < 128; i++) {
    const o = i * 8;
    const a0 = oam[o]! | (oam[o + 1]! << 8);
    const a1 = oam[o + 2]! | (oam[o + 3]! << 8);
    const a2 = oam[o + 4]! | (oam[o + 5]! << 8);
    const shape = (a0 >> 14) & 3;
    const size = (a1 >> 14) & 3;
    const [width, height] = (SPRITE_SIZES[shape] ?? SPRITE_SIZES[0])![size]!;
    const affine = (a0 & 0x100) !== 0;
    const disabled = !affine && (a0 & 0x200) !== 0;
    let y = a0 & 0xff;
    if (y >= 160) {
      y -= 256;
    }
    let x = a1 & 0x1ff;
    if (x >= 240) {
      x -= 512;
    }
    out.push({
      index: i,
      x,
      y,
      width,
      height,
      tile: a2 & 0x3ff,
      palette: (a2 >> 12) & 0xf,
      priority: (a2 >> 10) & 3,
      hFlip: !affine && (a1 & 0x1000) !== 0,
      vFlip: !affine && (a1 & 0x2000) !== 0,
      enabled: !disabled,
      bpp: a0 & 0x2000 ? 8 : 4,
      mode: (a0 >> 10) & 3,
      affine,
      affineIndex: affine ? (a1 >> 9) & 0x1f : 0,
      doubleSize: affine && (a0 & 0x200) !== 0,
      mosaic: (a0 & 0x1000) !== 0,
    });
  }
  return out;
}
