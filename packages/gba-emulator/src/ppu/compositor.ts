/**
 * GBA PPU — Layer Compositor
 *
 * Handles:
 * - Priority-based layer sorting (BG + sprites)
 * - Windowing (WIN0, WIN1, OBJ window, outside)
 * - Alpha blending (BLDCNT, BLDALPHA, BLDY)
 * - Brightness increase/decrease
 */
import type { GbaSystemBus } from '../system-bus.js';
import { SCREEN_WIDTH } from '../types.js';
import { read16 } from './backgrounds.js';
import type { SpritePixel } from './sprites.js';

// ─── Blend Mode ──────────────────────────────────────────────────────

const enum BlendMode {
  None = 0,
  Alpha = 1,
  BrightnessIncrease = 2,
  BrightnessDecrease = 3,
}

// ─── Layer IDs for BLDCNT ────────────────────────────────────────────

const LAYER_OBJ = 4;
const LAYER_BD = 5; // backdrop

// ─── Window Flags ────────────────────────────────────────────────────

const WIN_BG0 = 1 << 0;
const WIN_BG1 = 1 << 1;
const WIN_BG2 = 1 << 2;
const WIN_BG3 = 1 << 3;
const WIN_OBJ = 1 << 4;
const WIN_SFX = 1 << 5;

// ─── Compositing Types ──────────────────────────────────────────────

export interface BgLayer {
  id: number; // 0-3
  priority: number; // 0-3
  lineBuffer: Uint32Array; // SCREEN_WIDTH, 0 = transparent
}

// ─── Window Region Evaluation ────────────────────────────────────────

function evaluateWindows(x: number, line: number, dispcnt: number, sprites: SpritePixel[], bus: GbaSystemBus): number {
  const mmio = bus.mmioRegisters;
  const win0Enabled = !!(dispcnt & (1 << 13));
  const win1Enabled = !!(dispcnt & (1 << 14));
  const objWinEnabled = !!(dispcnt & (1 << 15));

  // If no windows are enabled, everything is visible with effects
  if (!win0Enabled && !win1Enabled && !objWinEnabled) {
    return WIN_BG0 | WIN_BG1 | WIN_BG2 | WIN_BG3 | WIN_OBJ | WIN_SFX;
  }

  // Check WIN0
  if (win0Enabled && isInWindow(x, line, mmio, 0x40, 0x44)) {
    return mmio[0x48]! & 0x3f;
  }

  // Check WIN1
  if (win1Enabled && isInWindow(x, line, mmio, 0x42, 0x46)) {
    return mmio[0x49]! & 0x3f;
  }

  // Check OBJ window
  if (objWinEnabled && sprites[x]!.isObjWindow) {
    return mmio[0x4b]! & 0x3f;
  }

  // Outside all windows
  return mmio[0x4a]! & 0x3f;
}

function isInWindow(x: number, line: number, mmio: Uint8Array, hOffset: number, vOffset: number): boolean {
  const winH = read16(mmio, hOffset);
  const winV = read16(mmio, vOffset);

  const x1 = (winH >> 8) & 0xff;
  const x2 = winH & 0xff;
  const y1 = (winV >> 8) & 0xff;
  const y2 = winV & 0xff;

  // Vertical check
  let inY: boolean;
  if (y1 <= y2) {
    inY = line >= y1 && line < y2;
  } else {
    // Wrapping
    inY = line >= y1 || line < y2;
  }
  if (!inY) {
    return false;
  }

  // Horizontal check
  if (x1 <= x2) {
    return x >= x1 && x < x2;
  } else {
    return x >= x1 || x < x2;
  }
}

// ─── Color Blending ──────────────────────────────────────────────────

function blendAlpha(top: number, bot: number, eva: number, evb: number): number {
  const r1 = top & 0xff;
  const g1 = (top >> 8) & 0xff;
  const b1 = (top >> 16) & 0xff;
  const r2 = bot & 0xff;
  const g2 = (bot >> 8) & 0xff;
  const b2 = (bot >> 16) & 0xff;

  const r = Math.min(255, (r1 * eva + r2 * evb) >> 4);
  const g = Math.min(255, (g1 * eva + g2 * evb) >> 4);
  const b = Math.min(255, (b1 * eva + b2 * evb) >> 4);

  return 0xff000000 | (b << 16) | (g << 8) | r;
}

function blendBrightnessIncrease(color: number, evy: number): number {
  const r = color & 0xff;
  const g = (color >> 8) & 0xff;
  const b = (color >> 16) & 0xff;

  const rr = r + (((255 - r) * evy) >> 4);
  const gg = g + (((255 - g) * evy) >> 4);
  const bb = b + (((255 - b) * evy) >> 4);

  return 0xff000000 | (Math.min(255, bb) << 16) | (Math.min(255, gg) << 8) | Math.min(255, rr);
}

function blendBrightnessDecrease(color: number, evy: number): number {
  const r = color & 0xff;
  const g = (color >> 8) & 0xff;
  const b = (color >> 16) & 0xff;

  const rr = r - ((r * evy) >> 4);
  const gg = g - ((g * evy) >> 4);
  const bb = b - ((b * evy) >> 4);

  return 0xff000000 | (Math.max(0, bb) << 16) | (Math.max(0, gg) << 8) | Math.max(0, rr);
}

// ─── Main Compositing Function ──────────────────────────────────────

/**
 * Compose all layers for one scanline into the framebuffer.
 */
export function compositeScanline(
  line: number,
  bgLayers: BgLayer[],
  sprites: SpritePixel[],
  bus: GbaSystemBus,
  framebuffer: Uint32Array,
): void {
  const mmio = bus.mmioRegisters;
  const dispcnt = read16(mmio, 0x00);

  // Read blend control
  const bldcnt = read16(mmio, 0x50);
  const blendMode = (bldcnt >> 6) & 0x3;
  const topTargets = bldcnt & 0x3f; // first target layers
  const botTargets = (bldcnt >> 8) & 0x3f; // second target layers

  // Alpha coefficients
  const bldalpha = read16(mmio, 0x52);
  const eva = Math.min(16, bldalpha & 0x1f);
  const evb = Math.min(16, (bldalpha >> 8) & 0x1f);

  // Brightness coefficient
  const bldy = Math.min(16, read16(mmio, 0x54) & 0x1f);

  // Backdrop color (palette entry 0)
  const backdrop = read16(bus.palette, 0);
  const backdropColor =
    backdrop === 0
      ? 0xff000000
      : 0xff000000 | (((backdrop >> 10) & 0x1f) << 19) | (((backdrop >> 5) & 0x1f) << 11) | ((backdrop & 0x1f) << 3);

  // Sort BG layers by priority, then by BG index (lower wins)
  const sortedBgs = [...bgLayers].sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.id - b.id;
  });

  const fbOffset = line * SCREEN_WIDTH;

  for (let x = 0; x < SCREEN_WIDTH; x++) {
    const winFlags = evaluateWindows(x, line, dispcnt, sprites, bus);

    // Build sorted list of visible, non-transparent pixels at this column
    // Each entry: { color, layerId, isSemiTransparent }
    let topColor = 0;
    let topLayer = LAYER_BD;
    let botColor = 0;
    let botLayer = LAYER_BD;
    let topFound = false;
    let botFound = false;
    let isSemiTransparent = false;

    // Interleave BGs and sprites by priority
    // We iterate through priority levels 0-3, and within each:
    //   1. Sprites at this priority (OBJ always checked if visible)
    //   2. BGs at this priority (in BG index order)

    for (let pri = 0; pri <= 3 && !botFound; pri++) {
      // Check sprites at this priority
      if (!topFound || !botFound) {
        const sp = sprites[x]!;
        if (sp.color !== 0 && sp.priority === pri && !sp.isObjWindow && winFlags & WIN_OBJ) {
          if (!topFound) {
            topColor = sp.color;
            topLayer = LAYER_OBJ;
            topFound = true;
            isSemiTransparent = sp.semiTransparent;
          } else if (!botFound) {
            botColor = sp.color;
            botLayer = LAYER_OBJ;
            botFound = true;
          }
        }
      }

      // Check BGs at this priority
      for (const bg of sortedBgs) {
        if (bg.priority !== pri) {
          continue;
        }
        const winBit = 1 << bg.id;
        if (!(winFlags & winBit)) {
          continue;
        }
        const pixel = bg.lineBuffer[x]!;
        if (pixel === 0) {
          continue;
        }

        if (!topFound) {
          topColor = pixel;
          topLayer = bg.id;
          topFound = true;
        } else if (!botFound) {
          botColor = pixel;
          botLayer = bg.id;
          botFound = true;
        }
        // Once we have top and bottom, we can stop for this pixel
        if (topFound && botFound) {
          break;
        }
      }
    }

    // If nothing was found on top, use backdrop
    if (!topFound) {
      topColor = backdropColor;
      topLayer = LAYER_BD;
    }
    if (!botFound) {
      botColor = backdropColor;
      botLayer = LAYER_BD;
    }

    // Apply blending
    let finalColor = topColor;

    const canBlend = !!(winFlags & WIN_SFX);

    if (canBlend) {
      // Semi-transparent sprites always use alpha blending if second target exists
      if (isSemiTransparent && botTargets & (1 << botLayer)) {
        finalColor = blendAlpha(topColor, botColor, eva, evb);
      } else if (blendMode === BlendMode.Alpha) {
        if (topTargets & (1 << topLayer) && botTargets & (1 << botLayer)) {
          finalColor = blendAlpha(topColor, botColor, eva, evb);
        }
      } else if (blendMode === BlendMode.BrightnessIncrease) {
        if (topTargets & (1 << topLayer)) {
          finalColor = blendBrightnessIncrease(topColor, bldy);
        }
      } else if (blendMode === BlendMode.BrightnessDecrease) {
        if (topTargets & (1 << topLayer)) {
          finalColor = blendBrightnessDecrease(topColor, bldy);
        }
      }
    }

    framebuffer[fbOffset + x] = finalColor;
  }
}
