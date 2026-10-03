/**
 * GBA PPU — Layer Compositor
 *
 * Merges the BG line buffers, the OBJ line and the backdrop into one framebuffer line:
 * - windows (WIN0, WIN1, OBJ window, outside) select the layers and the colour effect per pixel;
 * - the top two visible layers are picked by priority (OBJ before BGs of equal priority,
 *   BGs by index);
 * - colour special effects (alpha blending, brightness increase/decrease, and the forced
 *   alpha blend of semi-transparent OBJs) run at the PPU's own channel precision.
 *
 * References: GBATEK "LCD I/O Window Feature", "LCD I/O Color Special Effects";
 * NanoBoyAdvance src/nba/src/hw/ppu/merge.cc (DrawMergeImpl, OBJ mosaic latch);
 * mGBA src/gba/renderers/video-software.c.
 */
import { SCREEN_WIDTH } from '../types.js';
import { color15to32, read16 } from './backgrounds.js';
import { OBJ_COLOR_MASK, OBJ_MOSAIC, OBJ_PRIORITY_SHIFT, OBJ_SEMI_TRANSPARENT, OBJ_WINDOW } from './sprites.js';

/** The green channel of a framebuffer colour (0xAABBGGRR). */
const GREEN_32 = 0x0000ff00;

// ─── Blend Mode ──────────────────────────────────────────────────────

const enum BlendMode {
  None = 0,
  Alpha = 1,
  BrightnessIncrease = 2,
  BrightnessDecrease = 3,
}

// ─── Layer IDs (BLDCNT and window control bit numbers) ──────────────

const LAYER_OBJ = 4;
const LAYER_BD = 5; // backdrop

/** Window control bit 4 enables OBJ, bit 5 the colour special effect. */
const WIN_OBJ = 1 << 4;
const WIN_SFX = 1 << 5;
/** Every layer and the colour effect: the control of a pixel when no window is enabled. */
const WIN_ALL = 0x3f;

// ─── Compositing Types ──────────────────────────────────────────────

export interface BgLayer {
  id: number; // 0-3
  priority: number; // 0-3
  lineBuffer: Uint32Array; // SCREEN_WIDTH, 0 = transparent, OPAQUE | colour otherwise
}

// ─── Windows ─────────────────────────────────────────────────────────

/** Which windows the current line uses. */
export interface WindowState {
  win0: boolean;
  win1: boolean;
  objWin: boolean;
  /** Per-pixel WIN0/WIN1 coverage (bit 0 WIN0, bit 1 WIN1), horizontal and vertical flip-flops combined. */
  inside: Uint8Array;
}

/**
 * Fill `out` with each pixel's window control (WININ/WINOUT bits 0-5). Priority: WIN0,
 * WIN1, OBJ window, outside. GBATEK, LCD I/O Window Feature.
 */
export function buildWindowMask(windows: WindowState, obj: Uint32Array, mmio: Uint8Array, out: Uint8Array): void {
  const win0Control = mmio[0x48]! & 0x3f;
  const win1Control = mmio[0x49]! & 0x3f;
  const outsideControl = mmio[0x4a]! & 0x3f;
  const objWinControl = mmio[0x4b]! & 0x3f;
  const { win0, win1, objWin, inside } = windows;
  for (let x = 0; x < SCREEN_WIDTH; x++) {
    const flags = inside[x]!;
    if (win0 && flags & 1) {
      out[x] = win0Control;
    } else if (win1 && flags & 2) {
      out[x] = win1Control;
    } else if (objWin && obj[x]! & OBJ_WINDOW) {
      out[x] = objWinControl;
    } else {
      out[x] = outsideControl;
    }
  }
}

// ─── OBJ Mosaic ──────────────────────────────────────────────────────

/**
 * Apply horizontal OBJ mosaic on the screen grid. A latch holds the OBJ pixel and reloads
 * at the start of each mosaic block, whenever the new or the latched pixel is non-mosaic,
 * and whenever the new one has a better priority (NBA merge.cc `sprite_pixel_latch`).
 * The OBJ-window bit passes through unlatched.
 */
export function applyObjMosaic(obj: Uint32Array, mosaicWidth: number, out: Uint32Array): void {
  let latch = 0;
  let counter = 0;
  for (let x = 0; x < SCREEN_WIDTH; x++) {
    const pixel = obj[x]!;
    if (
      counter === 0 ||
      !(pixel & OBJ_MOSAIC) ||
      !(latch & OBJ_MOSAIC) ||
      ((pixel >> OBJ_PRIORITY_SHIFT) & 3) < ((latch >> OBJ_PRIORITY_SHIFT) & 3)
    ) {
      latch = pixel;
    }
    out[x] = (latch & ~OBJ_WINDOW) | (pixel & OBJ_WINDOW);
    if (++counter === mosaicWidth) {
      counter = 0;
    }
  }
}

// ─── Colour Special Effects ──────────────────────────────────────────

// The effects work on 5-bit red and blue and a 6-bit green whose low bit is the colour's
// bit 15; each result rounds to nearest, halves up, and green drops its low bit again
// (NBA merge.cc Blend/Brighten/Darken). Coefficients are in 1/16 steps, capped at 16:
// GBATEK, LCD I/O Color Special Effects.

function green6(color: number): number {
  return ((color >> 4) & 0x3e) | ((color >> 15) & 1);
}

/** Alpha blending: I = MIN(max, I1st*EVA + I2nd*EVB). */
function blendAlpha(top: number, bot: number, eva: number, evb: number): number {
  const r = Math.min(31, ((top & 0x1f) * eva + (bot & 0x1f) * evb + 8) >> 4);
  const g = Math.min(63, (green6(top) * eva + green6(bot) * evb + 8) >> 4) >> 1;
  const b = Math.min(31, (((top >> 10) & 0x1f) * eva + ((bot >> 10) & 0x1f) * evb + 8) >> 4);
  return (b << 10) | (g << 5) | r;
}

/** Brightness increase: I = I1st + (max-I1st)*EVY. */
function brightnessIncrease(color: number, evy: number): number {
  const r = color & 0x1f;
  const g = green6(color);
  const b = (color >> 10) & 0x1f;
  return (
    ((b + (((31 - b) * evy + 8) >> 4)) << 10) |
    (((g + (((63 - g) * evy + 8) >> 4)) >> 1) << 5) |
    (r + (((31 - r) * evy + 8) >> 4))
  );
}

/** Brightness decrease: I = I1st - I1st*EVY. */
function brightnessDecrease(color: number, evy: number): number {
  const r = color & 0x1f;
  const g = green6(color);
  const b = (color >> 10) & 0x1f;
  return ((b - ((b * evy + 7) >> 4)) << 10) | (((g - ((g * evy + 7) >> 4)) >> 1) << 5) | (r - ((r * evy + 7) >> 4));
}

// ─── Main Compositing Function ──────────────────────────────────────

/**
 * Compose one scanline into `framebuffer` at `offset`.
 *
 * @param layers - the enabled BGs, sorted by priority then index
 * @param obj - the OBJ line after mosaic, or null when the OBJ layer is off
 * @param windowMask - each pixel's window control, or null when no window is enabled
 */
export function compositeScanline(
  layers: BgLayer[],
  obj: Uint32Array | null,
  windowMask: Uint8Array | null,
  mmio: Uint8Array,
  palette: Uint8Array,
  framebuffer: Uint32Array,
  offset: number,
): void {
  const bldcnt = read16(mmio, 0x50);
  const blendMode = (bldcnt >> 6) & 0x3;
  const firstTargets = bldcnt & 0x3f;
  const secondTargets = (bldcnt >> 8) & 0x3f;
  const bldalpha = read16(mmio, 0x52);
  const eva = Math.min(16, bldalpha & 0x1f);
  const evb = Math.min(16, (bldalpha >> 8) & 0x1f);
  const evy = Math.min(16, read16(mmio, 0x54) & 0x1f);
  const backdrop = read16(palette, 0);
  const layerCount = layers.length;

  for (let x = 0; x < SCREEN_WIDTH; x++) {
    const control = windowMask ? windowMask[x]! : WIN_ALL;

    // The top two BG pixels; the backdrop sits below everything at priority 3.
    let topLayer = LAYER_BD;
    let topColor = backdrop;
    let topPriority = 3;
    let botLayer = LAYER_BD;
    let botColor = backdrop;
    let botPriority = 3;
    let found = 0;
    for (let i = 0; i < layerCount && found < 2; i++) {
      const bg = layers[i]!;
      if (!(control & (1 << bg.id))) {
        continue;
      }
      const pixel = bg.lineBuffer[x]!;
      if (pixel === 0) {
        continue;
      }
      if (found === 0) {
        topLayer = bg.id;
        topColor = pixel & 0xffff;
        topPriority = bg.priority;
      } else {
        botLayer = bg.id;
        botColor = pixel & 0xffff;
        botPriority = bg.priority;
      }
      found++;
    }

    // The OBJ pixel goes in front of a BG of equal or worse priority.
    let semiTransparent = false;
    if (obj && control & WIN_OBJ) {
      const pixel = obj[x]!;
      const index = pixel & OBJ_COLOR_MASK;
      if (index !== 0) {
        const priority = (pixel >> OBJ_PRIORITY_SHIFT) & 3;
        const color = read16(palette, 0x200 + index * 2);
        if (priority <= topPriority) {
          botLayer = topLayer;
          botColor = topColor;
          topLayer = LAYER_OBJ;
          topColor = color;
          semiTransparent = !!(pixel & OBJ_SEMI_TRANSPARENT);
        } else if (priority <= botPriority) {
          botLayer = LAYER_OBJ;
          botColor = color;
        }
      }
    }

    // A semi-transparent OBJ over a 2nd target always alpha-blends, whatever BLDCNT's mode and
    // the window's effect bit say; otherwise the window's effect bit gates BLDCNT's effect.
    let color = topColor;
    if (semiTransparent && secondTargets & (1 << botLayer)) {
      color = blendAlpha(topColor, botColor, eva, evb);
    } else if (control & WIN_SFX && firstTargets & (1 << topLayer)) {
      if (blendMode === BlendMode.Alpha) {
        if (secondTargets & (1 << botLayer)) {
          color = blendAlpha(topColor, botColor, eva, evb);
        }
      } else if (blendMode === BlendMode.BrightnessIncrease) {
        color = brightnessIncrease(topColor, evy);
      } else if (blendMode === BlendMode.BrightnessDecrease) {
        color = brightnessDecrease(topColor, evy);
      }
    }

    framebuffer[offset + x] = color15to32(color & 0x7fff);
  }

  // Green Swap (0x04000002 bit 0) exchanges the green of each even and odd pixel after merging
  // (GBATEK "Undocumented - Green Swap"; NBA merge.cc, mGBA video-software.c).
  if (mmio[0x02]! & 1) {
    for (let x = offset; x < offset + SCREEN_WIDTH; x += 2) {
      const left = framebuffer[x]!;
      const right = framebuffer[x + 1]!;
      framebuffer[x] = ((left & ~GREEN_32) | (right & GREEN_32)) >>> 0;
      framebuffer[x + 1] = ((right & ~GREEN_32) | (left & GREEN_32)) >>> 0;
    }
  }
}
