import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { Ppu } from '../ppu/ppu.js';
import { GbaSystemBus } from '../system-bus.js';
import { DISPCNT_LATCH_CYCLE, EventId, HBLANK_START_CYCLE } from '../types.js';

/** A 15-bit colour as the framebuffer shows it (each 5-bit channel shifted left by 3). */
function rgb(r: number, g: number, b: number): number {
  return (0xff000000 | (b << 19) | (g << 11) | (r << 3)) >>> 0;
}

const RED = 0x001f;
const GREEN = 0x03e0;
const BLUE = 0x7c00;
const WHITE = 0x7fff;

/**
 * A PPU over a bare bus, driven line by line the way the coordinator does: each line
 * starts (`beginScanline`) and latches DISPCNT (`latchDispcnt`), then `duringLine` may
 * change the machine, then the line renders. All 128 sprites start disabled.
 */
function setup() {
  const bus = new GbaSystemBus();
  const ppu = new Ppu();
  ppu.mmioRegisters = bus.mmioRegisters;
  bus.onBgRefPointWrite = (bg, isX) => ppu.reloadBgRefPoint(bg, isX);
  const io = (offset: number, value: number) => bus.write16(0x04000000 + offset, value);
  const io32 = (offset: number, value: number) => bus.write32(0x04000000 + offset, value);
  const pal = (index: number, color: number) => bus.write16(0x05000000 + index * 2, color);
  const vram16 = (offset: number, value: number) => bus.write16(0x06000000 + offset, value);
  const vram32 = (offset: number, value: number) => bus.write32(0x06000000 + offset, value);
  const oam = (index: number, attr0: number, attr1: number, attr2: number) => {
    bus.write16(0x07000000 + index * 8, attr0);
    bus.write16(0x07000000 + index * 8 + 2, attr1);
    bus.write16(0x07000000 + index * 8 + 4, attr2);
  };
  for (let i = 0; i < 128; i++) {
    oam(i, 1 << 9, 0, 0);
  }
  const frame = (duringLine?: (line: number) => void) => {
    for (let line = 0; line < 228; line++) {
      ppu.beginScanline(line, bus);
      ppu.latchDispcnt(line, bus);
      duringLine?.(line);
      if (line < 160) {
        ppu.renderScanline(line, bus);
      }
    }
  };
  const px = (x: number, y: number) => ppu.getFramebuffer()[y * 240 + x]!;
  return { bus, ppu, io, io32, pal, vram16, vram32, oam, frame, px };
}

type Machine = ReturnType<typeof setup>;

/** BG0: priority `priority`, every tile is tile 1 filled with colour 1, colour 1 = `color`. */
function solidBg0(t: Machine, color: number, priority = 0): void {
  t.io(0x08, priority | (31 << 8)); // char base 0, screen base 31 (0xF800)
  for (let i = 0; i < 32; i += 4) {
    t.vram32(0x20 + i, 0x11111111);
  }
  for (let i = 0; i < 0x800; i += 2) {
    t.vram16(0xf800 + i, 0x0001);
  }
  t.pal(1, color);
}

/** OBJ tile `tile` (4bpp) filled with colour index `index`. */
function solidObjTile(t: Machine, tile: number, index: number): void {
  for (let i = 0; i < 32; i += 4) {
    t.vram32(0x10000 + tile * 32 + i, index * 0x11111111);
  }
}

/** OBJ palette bank `bank`, colour 1. */
function objColor(t: Machine, bank: number, color: number): void {
  t.pal(256 + bank * 16 + 1, color);
}

const DISPCNT_OBJ = (1 << 12) | (1 << 6); // OBJ on, 1D mapping

describe('PPU: OBJ layer', () => {
  it('an OBJ-window sprite only shapes the window: it never shows, and never hides a sprite under it', () => {
    const t = setup();
    solidObjTile(t, 0, 1);
    objColor(t, 0, BLUE); // the window sprite's colour, which must never appear
    objColor(t, 1, RED);
    t.oam(0, 2 << 10, 0, 0); // OAM 0: OBJ window, 8x8 at (0,0)
    t.oam(1, 0, 0, 1 << 12); // OAM 1: normal, same place, palette bank 1
    t.io(0x00, DISPCNT_OBJ);
    t.frame();
    t.frame();
    expect(t.px(2, 0)).toBe(rgb(31, 0, 0));

    // With the OBJ window on: OBJ shows inside it, nothing outside it.
    t.io(0x4a, 0x1000); // WINOUT: outside nothing, OBJ window OBJ only
    t.io(0x00, DISPCNT_OBJ | (1 << 15));
    t.frame();
    expect(t.px(2, 0)).toBe(rgb(31, 0, 0));
    t.oam(1, 0, 16, 1 << 12); // move the normal sprite outside the window
    t.frame();
    t.frame();
    expect(t.px(2, 0)).toBe(rgb(0, 0, 0)); // backdrop
    expect(t.px(18, 0)).toBe(rgb(0, 0, 0)); // outside: OBJ hidden
  });

  it('the opaque sprite with the lowest priority value wins; OAM order only breaks ties', () => {
    const t = setup();
    solidBg0(t, BLUE, 1);
    solidObjTile(t, 0, 1);
    objColor(t, 0, RED);
    objColor(t, 1, GREEN);
    t.oam(0, 0, 0, 2 << 10); // priority 2, red
    t.oam(1, 0, 0, (1 << 12) | (0 << 10)); // priority 0, green, later in OAM
    t.io(0x00, DISPCNT_OBJ | (1 << 8));
    t.frame();
    t.frame();
    expect(t.px(2, 0)).toBe(rgb(0, 31, 0)); // over BG0 (priority 1), which hides the red one

    t.oam(1, 0, 0, (1 << 12) | (2 << 10)); // equal priorities: OAM 0 wins
    t.frame();
    t.frame();
    expect(t.px(2, 0)).toBe(rgb(0, 0, 31)); // both behind BG0
    t.io(0x08, 3 | (31 << 8)); // BG0 to the back
    t.frame();
    expect(t.px(2, 0)).toBe(rgb(31, 0, 0));
  });

  it('a sprite reaching past line 255 wraps to the top of the screen', () => {
    const t = setup();
    objColor(t, 0, RED);
    for (let i = 0; i < 0x8000; i += 4) {
      t.vram32(0x10000 + i, 0x11111111);
    }
    // 64x64 affine, double size (a 128x128 box) at y=150, matrix 0 scales by 1/2 to fill it
    t.oam(0, 150 | (1 << 8) | (1 << 9), 3 << 14, 0);
    t.bus.write16(0x07000006, 0x80);
    t.bus.write16(0x0700001e, 0x80);
    t.io(0x00, DISPCNT_OBJ);
    t.frame();
    t.frame();
    expect(t.px(64, 10)).toBe(rgb(31, 0, 0));
    expect(t.px(64, 21)).toBe(rgb(31, 0, 0));
    expect(t.px(64, 22)).toBe(rgb(0, 0, 0));
    expect(t.px(64, 155)).toBe(rgb(0, 0, 0));
  });

  it('horizontal OBJ mosaic follows the screen grid, vertical OBJ mosaic the line counter', () => {
    const t = setup();
    for (let i = 1; i <= 8; i++) {
      t.pal(256 + i, i);
    }
    // 8x8 tile: texel (x, y) has colour x + 1 on row 0 and colour y + 1 in column 7
    for (let row = 0; row < 8; row++) {
      t.vram32(0x10000 + row * 4, (0x07654321 | ((row + 1) << 28)) >>> 0);
    }
    t.oam(0, 1 | (1 << 12), 1, 0); // mosaic sprite at (1, 1)
    t.io(0x4c, 0x3300); // OBJ mosaic 4x4
    t.io(0x00, DISPCNT_OBJ);
    t.frame();
    t.frame();
    // x: blocks start at screen x = 0, 4, 8; the block at 4 holds texel 3 (screen 4 - sprite 1)
    expect(t.px(2, 1)).toBe(rgb(1, 0, 0));
    expect(t.px(5, 1)).toBe(rgb(4, 0, 0));
    // y: lines 1-3 fetch the sprite's row 0, lines 4-7 its row 3 (screen 4 - sprite 1)
    expect(t.px(8, 3)).toBe(rgb(1, 0, 0));
    expect(t.px(8, 5)).toBe(rgb(4, 0, 0));
  });

  it('stops drawing sprites once the line runs out of OBJ cycles; DISPCNT bit 5 shortens the budget', () => {
    const t = setup();
    for (let i = 0; i < 0x400; i += 4) {
      t.vram32(0x10000 + i, 0x11111111);
    }
    objColor(t, 1, RED);
    // 64x32 sprites at x = 8 * i: each costs 64 cycles of 1210, so OAM 0-18 fit and 19 does not
    for (let i = 0; i < 20; i++) {
      t.oam(i, 1 << 14, (3 << 14) | (i * 8), 1 << 12);
    }
    t.io(0x00, DISPCNT_OBJ);
    t.frame();
    t.frame();
    expect(t.px(200, 0)).toBe(rgb(31, 0, 0)); // OAM 18 (144-207)
    expect(t.px(210, 0)).toBe(rgb(0, 0, 0)); // only OAM 19 reaches here
    t.io(0x00, DISPCNT_OBJ | (1 << 5)); // H-Blank Interval Free: 954 cycles, OAM 0-14
    t.frame();
    t.frame();
    expect(t.px(170, 0)).toBe(rgb(31, 0, 0)); // OAM 14 (112-175)
    expect(t.px(200, 0)).toBe(rgb(0, 0, 0));
  });

  it('builds a line of sprites a line ahead: OAM written during line N shows from line N + 2', () => {
    const t = setup();
    for (let i = 0; i < 0x800; i += 4) {
      t.vram32(0x10000 + i, 0x11111111);
    }
    objColor(t, 0, RED);
    t.oam(0, 0, 3 << 14, 0); // 64x64 at (0, 0)
    t.io(0x00, DISPCNT_OBJ);
    t.frame();
    t.frame((line) => {
      if (line === 20) {
        t.oam(0, 0, (3 << 14) | 100, 0); // move to x = 100
        objColor(t, 0, GREEN); // palette RAM is read when the line is drawn
      }
    });
    expect(t.px(0, 20)).toBe(rgb(0, 31, 0));
    expect(t.px(0, 21)).toBe(rgb(0, 31, 0));
    expect(t.px(100, 21)).toBe(rgb(0, 0, 0));
    expect(t.px(0, 22)).toBe(rgb(0, 0, 0));
    expect(t.px(100, 22)).toBe(rgb(0, 31, 0));
  });
});

describe('PPU: bitmap modes go through BG2 and the compositor', () => {
  it('mode 4: index 0 is transparent and DISPCNT bit 4 selects the frame', () => {
    const t = setup();
    t.pal(0, WHITE);
    t.pal(1, 0);
    t.bus.vram[5] = 1;
    t.bus.vram[0xa000 + 7] = 1;
    t.io(0x00, 4 | (1 << 10));
    t.frame();
    t.frame();
    expect(t.px(0, 0)).toBe(rgb(31, 31, 31)); // backdrop through index 0
    expect(t.px(5, 0)).toBe(rgb(0, 0, 0));
    t.io(0x00, 4 | (1 << 10) | (1 << 4));
    t.frame();
    expect(t.px(5, 0)).toBe(rgb(31, 31, 31));
    expect(t.px(7, 0)).toBe(rgb(0, 0, 0));
  });

  it('mode 3: sprites from tile 512 up draw over the bitmap, lower tiles read as transparent', () => {
    const t = setup();
    for (let x = 0; x < 240; x++) {
      t.vram16(x * 2, GREEN);
    }
    solidObjTile(t, 512, 1);
    objColor(t, 0, RED);
    t.oam(0, 0, 0, 512);
    t.oam(1, 0, 16, 0);
    t.io(0x00, 3 | (1 << 10) | DISPCNT_OBJ);
    t.frame();
    t.frame();
    expect(t.px(2, 0)).toBe(rgb(31, 0, 0));
    expect(t.px(18, 0)).toBe(rgb(0, 31, 0));
  });

  it('mode 3 samples through BG2PA-PD and the reference point, and takes colour effects', () => {
    const t = setup();
    for (let x = 0; x < 240; x++) {
      t.vram16(x * 2, x & 0x1f);
    }
    t.io(0x20, 0x200); // PA = 2: twice as many bitmap pixels per screen pixel
    t.io(0x00, 3 | (1 << 10));
    t.frame();
    t.frame();
    expect(t.px(10, 0)).toBe(rgb(20, 0, 0));

    t.io(0x50, (1 << 2) | (3 << 6)); // BG2 first target, brightness decrease
    t.io(0x54, 16);
    t.frame();
    expect(t.px(10, 0)).toBe(rgb(0, 0, 0));
  });

  it('mode 5 is 160x128: outside it the backdrop shows', () => {
    const t = setup();
    t.pal(0, BLUE);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 160; x++) {
        t.vram16((y * 160 + x) * 2, RED);
      }
    }
    t.io(0x00, 5 | (1 << 10));
    t.frame();
    t.frame();
    expect(t.px(159, 127)).toBe(rgb(31, 0, 0));
    expect(t.px(160, 0)).toBe(rgb(0, 0, 31));
    expect(t.px(0, 128)).toBe(rgb(0, 0, 31));
  });

  it('BG2 off in a bitmap mode leaves the backdrop', () => {
    const t = setup();
    t.pal(0, GREEN);
    t.vram16(0, RED);
    t.io(0x00, 3);
    t.frame();
    expect(t.px(0, 0)).toBe(rgb(0, 31, 0));
  });
});

describe('PPU: affine reference points', () => {
  /** Mode 3 with bitmap row y filled with colour y + 1 (red channel), PD = 1 row per line. */
  function rows(): Machine {
    const t = setup();
    for (let y = 0; y < 160; y++) {
      t.vram16(y * 480, (y + 1) & 0x1f);
    }
    t.io(0x00, 3 | (1 << 10));
    return t;
  }
  const row = (y: number) => rgb((y + 1) & 0x1f, 0, 0);

  it('both axes reload at frame start, even when only one was written during VBlank', () => {
    const t = rows();
    t.frame((line) => {
      if (line === 170) {
        t.io32(0x28, 0); // BG2X only
      }
    });
    t.frame();
    expect(t.px(0, 0)).toBe(row(0));
    expect(t.px(0, 5)).toBe(row(5));
  });

  it('a write during a line reloads the point from the next line', () => {
    const t = rows();
    t.frame();
    t.frame((line) => {
      if (line === 20) {
        t.io32(0x2c, 50 << 8); // BG2Y = row 50
      }
    });
    expect(t.px(0, 20)).toBe(row(20));
    expect(t.px(0, 21)).toBe(row(50));
    expect(t.px(0, 22)).toBe(row(51));
  });

  it('with BG mosaic the point steps mosaic-height rows at a time', () => {
    const t = rows();
    t.io(0x0c, 1 << 6); // BG2 mosaic
    t.io(0x4c, 0x0030); // BG mosaic 1 wide, 4 tall
    t.frame();
    t.frame();
    expect(t.px(0, 3)).toBe(row(0));
    expect(t.px(0, 4)).toBe(row(4));
    expect(t.px(0, 7)).toBe(row(4));
    expect(t.px(0, 8)).toBe(row(8));
  });

  it('holds while the BG is off, and keeps stepping through forced blank', () => {
    const t = rows();
    t.frame();
    t.frame((line) => {
      if (line === 10) {
        t.io(0x00, 3); // BG2 off
      } else if (line === 20) {
        t.io(0x00, 3 | (1 << 10));
      } else if (line === 40) {
        t.io(0x00, 3 | (1 << 10) | (1 << 7)); // forced blank
      } else if (line === 50) {
        t.io(0x00, 3 | (1 << 10));
      }
    });
    // Lines 10-22 neither draw nor step BG2 (the enable shows three lines after it is set).
    expect(t.px(0, 22)).toBe(rgb(0, 0, 0));
    expect(t.px(0, 23)).toBe(row(10));
    expect(t.px(0, 45)).toBe(0xffffffff);
    expect(t.px(0, 50)).toBe(row(37));
  });
});

describe('PPU: windows', () => {
  it('each window holds a vertical flip-flop; a bottom edge the counter never reaches never closes it', () => {
    // mgba-suite video.c "Window offscreen reset"
    const t = setup();
    solidBg0(t, 0x3def);
    t.pal(0, WHITE);
    t.io(0x4a, 0x0010); // outside: OBJ only
    t.io(0x48, 0x3f3f);
    t.io(0x40, 0x0078); // WIN0: x 0-120
    t.io(0x44, 0x50e3); // y 80-227
    t.io(0x42, 0x78f0); // WIN1: x 120-240
    t.io(0x46, 0x50e4); // y from 80 to 228, which no line reaches
    t.io(0x00, (1 << 8) | (1 << 13) | (1 << 14));
    t.frame();
    t.frame();
    const grey = rgb(15, 15, 15);
    const backdrop = rgb(31, 31, 31);
    expect(t.px(10, 10)).toBe(backdrop); // WIN0 closed at 227
    expect(t.px(10, 100)).toBe(grey);
    expect(t.px(200, 10)).toBe(grey); // WIN1 still open from line 80 of the previous frame
    expect(t.px(200, 100)).toBe(grey);
  });

  it('a window whose left edge is past its right edge wraps around the line', () => {
    const t = setup();
    solidBg0(t, RED);
    t.io(0x48, 0x0001); // WIN0: BG0
    t.io(0x4a, 0x0000);
    t.io(0x40, 0xc820); // x from 200 to 32
    t.io(0x44, 0x00a0);
    t.io(0x00, (1 << 8) | (1 << 13));
    t.frame();
    t.frame();
    expect(t.px(10, 50)).toBe(rgb(31, 0, 0));
    expect(t.px(100, 50)).toBe(rgb(0, 0, 0));
    expect(t.px(220, 50)).toBe(rgb(31, 0, 0));
  });

  it('the OBJ window exists only while the OBJ layer is on', () => {
    const t = setup();
    solidBg0(t, RED);
    t.io(0x4a, 0x0000); // outside and OBJ window: nothing
    t.io(0x00, (1 << 8) | (1 << 15));
    t.frame();
    t.frame();
    expect(t.px(10, 10)).toBe(rgb(31, 0, 0));
  });
});

describe('PPU: colour effects', () => {
  it('a semi-transparent sprite blends over a 2nd target even where the window turns effects off', () => {
    const t = setup();
    solidBg0(t, BLUE);
    solidObjTile(t, 0, 1);
    objColor(t, 0, RED);
    t.oam(0, 1 << 10, 0, 0); // semi-transparent at x 0
    t.oam(1, 0, 16, 0); // normal at x 16
    t.io(0x50, 1 << 8); // BG0 2nd target, no effect
    t.io(0x52, 0x0808);
    t.io(0x40, 0x00f0);
    t.io(0x44, 0x00a0);
    t.io(0x48, 0x0011); // WIN0: BG0 + OBJ, effects off
    t.io(0x00, DISPCNT_OBJ | (1 << 8) | (1 << 13));
    t.frame();
    t.frame();
    expect(t.px(2, 0)).toBe(rgb(16, 0, 16));
    expect(t.px(18, 0)).toBe(rgb(31, 0, 0));
  });

  it('works on 5-bit channels with a 6-bit green, rounding to nearest', () => {
    const t = setup();
    // Brightness increase of black by 8/16: 0 + 31 * 8/16 = 15.5 -> 16
    t.io(0x50, (1 << 5) | (2 << 6)); // backdrop first target
    t.io(0x54, 8);
    t.frame();
    expect(t.px(0, 0)).toBe(rgb(16, 16, 16));

    // Brightness decrease of white by 8/16: 31 - 15.5 -> 16; green is 62 in 6 bits (bit 15 clear),
    // 62 - 31 = 31, which drops to 15
    t.pal(0, WHITE);
    t.io(0x50, (1 << 5) | (3 << 6));
    t.frame();
    expect(t.px(0, 0)).toBe(rgb(16, 15, 16));

    // Alpha: red 31 * 8/16 over black -> 16
    solidBg0(t, RED);
    t.pal(0, 0);
    t.io(0x50, 1 | (1 << 13) | (1 << 6)); // BG0 over backdrop
    t.io(0x52, 0x0808);
    t.io(0x00, 1 << 8);
    t.frame();
    t.frame();
    expect(t.px(0, 0)).toBe(rgb(16, 0, 0));

    // Bit 15 of a colour is green's sixth bit: green 10 with it set brightens by 1/16 to 12, without it
    // to 11 (red and blue: 0 + 31/16 -> 2)
    t.io(0x00, 0);
    t.io(0x50, (1 << 5) | (2 << 6));
    t.io(0x54, 1);
    t.pal(0, 0x8000 | (10 << 5));
    t.frame();
    expect(t.px(0, 0)).toBe(rgb(2, 12, 2));
    t.pal(0, 10 << 5);
    t.frame();
    expect(t.px(0, 0)).toBe(rgb(2, 11, 2));
  });
});

describe('PPU: DISPCNT layer latch', () => {
  it('a BG enabled during a line shows three lines later; disabling is immediate', () => {
    const t = setup();
    solidBg0(t, RED);
    t.frame();
    t.frame((line) => {
      if (line === 50) {
        t.io(0x00, 1 << 8);
      } else if (line === 80) {
        t.io(0x00, 0);
      } else if (line === 81) {
        t.io(0x00, 1 << 8); // back on while the latch still holds it
      }
    });
    expect(t.px(0, 52)).toBe(rgb(0, 0, 0));
    expect(t.px(0, 53)).toBe(rgb(31, 0, 0));
    expect(t.px(0, 80)).toBe(rgb(0, 0, 0));
    expect(t.px(0, 81)).toBe(rgb(31, 0, 0));
  });

  it('a BG enabled during VBlank shows from line 0', () => {
    const t = setup();
    solidBg0(t, RED);
    t.frame((line) => {
      if (line === 200) {
        t.io(0x00, 1 << 8);
      }
    });
    t.frame();
    expect(t.px(0, 0)).toBe(rgb(31, 0, 0));
  });
});

describe('PPU: machine wiring', () => {
  it('DISPCNT is latched 40 cycles into the line: a write before then makes that line’s latch', () => {
    const start = () => {
      const gba = new Gba();
      gba.loadRom(new Uint8Array([0xfe, 0xff, 0xff, 0xea])); // b .
      gba.runScanline(); // the first cycle of line 1
      const lineStart = gba.scheduler.dueCycle(EventId.HBlank) - HBLANK_START_CYCLE;
      expect(gba.scheduler.dueCycle(EventId.DispcntLatch)).toBe(lineStart + DISPCNT_LATCH_CYCLE);
      return { gba, lineStart };
    };

    const early = start().gba;
    early.bus.write16(0x04000000, 1 << 8);
    early.runScanline();
    expect(early.ppu.serialize().dispcntLatch![2]).toBe(1 << 8);

    const { gba: late, lineStart } = start();
    expect(late.runFrame(() => late.scheduler.currentCycle >= lineStart + DISPCNT_LATCH_CYCLE)).toBe('stopped');
    late.bus.write16(0x04000000, 1 << 8);
    late.runScanline();
    expect(late.ppu.serialize().dispcntLatch![2]).toBe(0x0080); // the boot value: forced blank
  });

  it('BG2PA and BG2PD power on as 1.0, so a bitmap shows one to one', () => {
    const gba = new Gba();
    gba.loadRom(new Uint8Array([0xfe, 0xff, 0xff, 0xea])); // b .
    gba.armCpu.cpsr = 0x1f;
    gba.armCpu.registers[15] = 0x08000000;
    gba.bus.write16(0x06000000 + (3 * 240 + 5) * 2, RED);
    gba.bus.write16(0x04000000, 3 | (1 << 10));
    gba.runFrame();
    gba.runFrame();
    expect(gba.ppu.getFramebuffer()[3 * 240 + 5]).toBe(rgb(31, 0, 0));
    expect(gba.ppu.getFramebuffer()[3 * 240 + 6]).toBe(rgb(0, 0, 0));
  });
});
