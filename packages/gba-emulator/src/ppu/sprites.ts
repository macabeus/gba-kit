/**
 * GBA PPU — Sprite (OBJ) Rendering
 *
 * Builds one line of the OBJ layer from OAM and OBJ VRAM. The layer holds two separate
 * outputs per pixel, the way the hardware does: the OBJ colour (an OBJ palette index with
 * its priority, semi-transparency and mosaic flags) and the OBJ-window mask. An OBJ-window
 * sprite only sets the mask, so it never hides a normal sprite.
 *
 * Supports all OAM sizes, 4bpp/8bpp, flips, 1D/2D mapping, affine sprites (32 parameter
 * groups) with double size, OBJ window, mosaic, the bitmap-mode OBJ VRAM limit and the
 * per-line OBJ rendering cycle budget.
 *
 * References: GBATEK "LCD OBJ - OAM Attributes", "LCD OBJ - Overview" (OBJ rendering
 * cycles); NanoBoyAdvance src/nba/src/hw/ppu/sprite.cc (Plot, tile numbering);
 * mGBA src/gba/renderers/common.c GBAVideoRendererCleanOAM (cycle costs, Y wrap).
 */
import { SCREEN_WIDTH } from '../types.js';
import { read16 } from './backgrounds.js';

// ─── OBJ Line Layout ─────────────────────────────────────────────────

/** Bits 0-7: OBJ palette index (palette RAM 0x200 + 2 * index); 0 is transparent. */
export const OBJ_COLOR_MASK = 0xff;
/** Bits 8-9: priority relative to BGs. */
export const OBJ_PRIORITY_SHIFT = 8;
/** Bit 10: semi-transparent OBJ (forces alpha blending over a 2nd target). */
export const OBJ_SEMI_TRANSPARENT = 1 << 10;
/** Bit 11: the pixel came from a mosaic OBJ. */
export const OBJ_MOSAIC = 1 << 11;
/** Bit 12: inside the OBJ window. */
export const OBJ_WINDOW = 1 << 12;

/** OBJ rendering cycles per line, and with DISPCNT bit 5 (H-Blank Interval Free) set. GBATEK, LCD OBJ - Overview. */
const OBJ_CYCLES = 1210;
const OBJ_CYCLES_HBLANK_FREE = 954;

/** OAM attribute 0 bits 10-11. Mode 3 is prohibited and draws as a normal OBJ, as in mGBA. */
const enum ObjMode {
  Normal = 0,
  SemiTransparent = 1,
  Window = 2,
}

// ─── OAM Size Lookup ─────────────────────────────────────────────────

/** Width and height for each shape (0 square, 1 horizontal, 2 vertical) and size. */
const OBJ_WIDTH = [8, 16, 32, 64, 16, 32, 32, 64, 8, 8, 16, 32];
const OBJ_HEIGHT = [8, 16, 32, 64, 8, 8, 16, 32, 16, 32, 32, 64];

// ─── Sprite Scanline Rendering ───────────────────────────────────────

export interface ObjLineParams {
  /** DISPCNT: BG mode (bitmap modes hide OBJ tiles below 512), bit 5 (cycle budget), bit 6 (1D mapping). */
  dispcnt: number;
  /** The OBJ mosaic vertical counter for this line: a mosaic sprite fetches `mosaicY` rows higher. */
  mosaicY: number;
}

/**
 * Render the OBJ layer of `line` into `out` (SCREEN_WIDTH packed pixels, see OBJ_* above).
 * OAM is walked from entry 0. A pixel takes an opaque sprite whose priority is better than
 * the one already there, or any sprite while the pixel is still transparent; so the lowest
 * priority value wins and OAM order breaks ties. A transparent pixel of a normal sprite
 * still updates the priority and mosaic flag (NBA sprite.cc Plot), which the OBJ mosaic
 * latch in the compositor observes.
 */
export function renderSpriteScanline(
  line: number,
  oam: Uint8Array,
  vram: Uint8Array,
  params: ObjLineParams,
  out: Uint32Array,
): void {
  out.fill(0);

  const { dispcnt, mosaicY } = params;
  const mapping1D = !!(dispcnt & (1 << 6));
  // In bitmap modes the BG owns VRAM up to 0x14000; OBJ fetches below it read as transparent.
  const vramBoundary = (dispcnt & 7) >= 3 ? 0x14000 : 0x10000;
  const budget = dispcnt & (1 << 5) ? OBJ_CYCLES_HBLANK_FREE : OBJ_CYCLES;
  let spent = 0;

  for (let i = 0; i < 128; i++) {
    const base = i * 8;
    const attr0 = read16(oam, base);
    const affine = !!(attr0 & (1 << 8));
    if (!affine && attr0 & (1 << 9)) {
      continue; // disabled
    }
    const mode = (attr0 >> 10) & 3;
    const shape = attr0 >> 14;
    if (shape === 3) {
      continue; // prohibited shape: no size
    }

    // Walking OAM costs 2 cycles per entry; the line's sprites cost theirs on top. Sprites
    // past the budget are not drawn (mGBA video-software.c GBAVideoSoftwareRendererPreprocessSpriteLayer).
    if (budget - 2 * i - spent <= 0) {
      break;
    }

    const attr1 = read16(oam, base + 2);
    const sizeIndex = shape * 4 + (attr1 >> 14);
    const width = OBJ_WIDTH[sizeIndex]!;
    const height = OBJ_HEIGHT[sizeIndex]!;
    const doubleSize = affine && !!(attr0 & (1 << 9));
    const boundW = doubleSize ? width * 2 : width;
    const boundH = doubleSize ? height * 2 : height;

    // Y is 8 bits; a sprite reaching past line 255 wraps to the top of the screen.
    let y = attr0 & 0xff;
    if (y + boundH > 256) {
      y -= 256;
    }
    if (line < y || line >= y + boundH) {
      continue;
    }

    let x = attr1 & 0x1ff;
    if (x >= 256) {
      x -= 512;
    }
    // A box with no pixel on screen is not fetched and takes no cycles past its OAM walk (NBA
    // sprite.cc DrawSpriteFetchOAM, `remaining_pixels <= 0`).
    if (x >= SCREEN_WIDTH || x + boundW <= 0) {
      continue;
    }
    // GBATEK: normal OBJs take width cycles, affine ones 10 + 2 * width (here 2 of each go to the OAM walk).
    spent += affine ? 8 + 2 * boundW + (x < 0 ? x : 0) : width - 2 + (x < 0 ? x >> 1 : 0);

    const isWindow = mode === ObjMode.Window;
    const mosaic = !!(attr0 & (1 << 12)) && !isWindow;
    let localY = line - y;
    if (mosaic) {
      localY = Math.max(0, localY - mosaicY);
    }

    const attr2 = read16(oam, base + 4);
    const is256 = !!(attr0 & (1 << 13));
    const baseTile = attr2 & 0x3ff;
    const priority = (attr2 >> 10) & 3;
    const paletteBank = (attr2 >> 12) << 4;
    // Everything a plot writes besides the colour index.
    const attributes =
      (priority << OBJ_PRIORITY_SHIFT) |
      (mode === ObjMode.SemiTransparent ? OBJ_SEMI_TRANSPARENT : 0) |
      (mosaic ? OBJ_MOSAIC : 0);

    // Affine sprites step PA/PC per pixel from the box's first column; normal ones read rows directly.
    let pa = 0;
    let pc = 0;
    let texX0 = 0;
    let texY0 = localY;
    if (affine) {
      // The parameter group's PA-PD sit in the fourth halfword of four consecutive OAM entries.
      const paramBase = ((attr1 >> 9) & 0x1f) * 32;
      pa = (read16(oam, paramBase + 6) << 16) >> 16;
      const pb = (read16(oam, paramBase + 14) << 16) >> 16;
      pc = (read16(oam, paramBase + 22) << 16) >> 16;
      const pd = (read16(oam, paramBase + 30) << 16) >> 16;
      const dy = localY - (boundH >> 1);
      // Texture coordinates of the bounding box's first column, 8.8 fixed point around the sprite centre.
      texX0 = pa * -(boundW >> 1) + pb * dy + (width << 7);
      texY0 = pc * -(boundW >> 1) + pd * dy + (height << 7);
    } else if (attr1 & (1 << 13)) {
      texY0 = height - 1 - localY; // vertical flip
    }
    const hflip = !affine && !!(attr1 & (1 << 12));

    for (let bx = 0; bx < boundW; bx++) {
      const screenX = x + bx;
      if (screenX < 0) {
        continue;
      }
      if (screenX >= SCREEN_WIDTH) {
        break;
      }

      let texX: number;
      let texY: number;
      if (affine) {
        texX = (texX0 + pa * bx) >> 8;
        texY = (texY0 + pc * bx) >> 8;
        if (texX < 0 || texX >= width || texY < 0 || texY >= height) {
          continue;
        }
      } else {
        texX = hflip ? width - 1 - bx : bx;
        texY = texY0;
      }

      // Tile numbering, NBA sprite.cc CalculateTileNumber4BPP/8BPP: 1D counts tiles linearly,
      // 2D lays them out 32 per row and wraps the column within the row.
      const blockX = texX >> 3;
      const blockY = texY >> 3;
      let address: number;
      let colorIndex: number;
      if (is256) {
        const tile = mapping1D
          ? (baseTile + blockY * (width >> 2) + (blockX << 1)) & 0x3ff
          : ((baseTile + (blockY << 5)) & 0x3e0) | (((baseTile & ~1) + (blockX << 1)) & 0x1f);
        address = 0x10000 | ((tile * 32 + (texY & 7) * 8 + (texX & 7)) & 0x7fff);
        colorIndex = address < vramBoundary ? 0 : vram[address]!;
      } else {
        const tile = mapping1D
          ? (baseTile + blockY * (width >> 3) + blockX) & 0x3ff
          : ((baseTile + (blockY << 5)) & 0x3e0) | ((baseTile + blockX) & 0x1f);
        address = 0x10000 | ((tile * 32 + (texY & 7) * 4 + ((texX & 7) >> 1)) & 0x7fff);
        const byte = address < vramBoundary ? 0 : vram[address]!;
        const nibble = texX & 1 ? byte >> 4 : byte & 0xf;
        colorIndex = nibble === 0 ? 0 : paletteBank | nibble;
      }

      const pixel = out[screenX]!;
      if (isWindow && colorIndex !== 0) {
        out[screenX] = pixel | OBJ_WINDOW;
      } else if (priority < ((pixel >> OBJ_PRIORITY_SHIFT) & 3) || (pixel & OBJ_COLOR_MASK) === 0) {
        out[screenX] =
          colorIndex !== 0
            ? (pixel & OBJ_WINDOW) | attributes | colorIndex
            : (pixel & (OBJ_WINDOW | OBJ_SEMI_TRANSPARENT | OBJ_COLOR_MASK)) | (attributes & ~OBJ_SEMI_TRANSPARENT);
      }
    }
  }
}
