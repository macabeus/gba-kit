/**
 * DISPSTAT and VCOUNT: the LCD owns the line counter and the three status flags, the CPU writes
 * the IRQ enables and LYC (GBATEK "LCD I/O Display Status"; mGBA video.c GBAVideoWriteDISPSTAT;
 * NanoBoyAdvance PPU::UpdateVerticalCounterFlag).
 */
import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';

const DISPSTAT = 0x04000004;
const VCOUNT = 0x04000006;
const IF = 0x04000202;
const VCOUNT_IRQ_FLAG = 1 << 2;

/** A machine spinning on `b .` in ROM. */
function spinning(): Gba {
  const gba = new Gba();
  gba.loadRom(new Uint8Array([0xfe, 0xff, 0xff, 0xea]));
  gba.armCpu.cpsr = 0x1f;
  gba.armCpu.registers[15] = 0x08000000;
  return gba;
}

function runToLine(gba: Gba, line: number): void {
  do {
    gba.runScanline();
  } while (gba.scanline !== line);
}

describe('DISPSTAT and VCOUNT', () => {
  it('LYC=0 matches line 0: the flag sets and the V-count IRQ is requested there', () => {
    const gba = spinning();
    gba.bus.write16(DISPSTAT, 0x0020); // LYC 0, V-count IRQ enabled
    runToLine(gba, 1);
    expect(gba.bus.read16(DISPSTAT) & 4).toBe(0);
    gba.bus.write16(IF, 0xffff);
    runToLine(gba, 0);
    expect(gba.bus.read16(VCOUNT)).toBe(0);
    expect(gba.bus.read16(DISPSTAT) & 4).toBe(4);
    expect(gba.bus.read16(IF) & VCOUNT_IRQ_FLAG).toBe(VCOUNT_IRQ_FLAG);
  });

  it('a write sets the IRQ enables and LYC, and leaves the status flags to the LCD', () => {
    const gba = spinning();
    runToLine(gba, 170);
    expect(gba.bus.read16(DISPSTAT)).toBe(0x0001); // VBlank
    gba.bus.write16(DISPSTAT, 0x0008);
    expect(gba.bus.read16(DISPSTAT)).toBe(0x0009);
    gba.bus.write16(DISPSTAT, 0x00c6); // the flags, and the unused bits 6-7
    expect(gba.bus.read16(DISPSTAT)).toBe(0x0001);
  });

  it('VCOUNT is read-only: a word write to DISPSTAT leaves it counting', () => {
    const gba = spinning();
    runToLine(gba, 170);
    gba.bus.write32(DISPSTAT, 0xab000000);
    expect(gba.bus.read16(VCOUNT)).toBe(170);
    gba.runScanline();
    gba.runScanline();
    expect(gba.bus.read16(VCOUNT)).toBe(172);
    gba.bus.write8(VCOUNT, 5);
    expect(gba.bus.read16(VCOUNT)).toBe(172);
  });

  it('a write of LYC equal to the current line sets the flag and requests the IRQ at once, on the edge only', () => {
    const gba = spinning();
    runToLine(gba, 50);
    gba.bus.write8(DISPSTAT, 0x20);
    gba.bus.write8(DISPSTAT + 1, 50);
    expect(gba.bus.read16(DISPSTAT) & 4).toBe(4);
    expect(gba.bus.read16(IF) & VCOUNT_IRQ_FLAG).toBe(VCOUNT_IRQ_FLAG);
    gba.bus.write16(IF, VCOUNT_IRQ_FLAG);
    gba.bus.write16(DISPSTAT, (50 << 8) | 0x20); // still matching: no new edge
    expect(gba.bus.read16(IF) & VCOUNT_IRQ_FLAG).toBe(0);
    gba.bus.write16(DISPSTAT, (51 << 8) | 0x20);
    expect(gba.bus.read16(DISPSTAT) & 4).toBe(0);
  });

  it('the VBlank flag is set on lines 160-226, not on 227', () => {
    const gba = spinning();
    runToLine(gba, 159);
    expect(gba.bus.read16(DISPSTAT) & 1).toBe(0);
    runToLine(gba, 160);
    expect(gba.bus.read16(DISPSTAT) & 1).toBe(1);
    runToLine(gba, 226);
    expect(gba.bus.read16(DISPSTAT) & 1).toBe(1);
    runToLine(gba, 227);
    expect(gba.bus.read16(DISPSTAT) & 1).toBe(0);
  });

  it('the HBlank flag is set from cycle 1006 of the line to its end', () => {
    // GBATEK: "Although the drawing time is only 960 cycles (240*4), the H-Blank flag is "0" for a
    // total of 1006 cycles." The CPU sees it at the end of the `b .` (20 cycles) running then.
    const gba = spinning();
    runToLine(gba, 10);
    expect(gba.bus.read16(DISPSTAT) & 2).toBe(0);
    gba.runFrame(() => (gba.bus.read16(DISPSTAT) & 2) !== 0);
    expect(gba.scanline).toBe(10);
    expect(gba.scheduler.currentCycle % 1232).toBeGreaterThanOrEqual(1006);
    expect(gba.scheduler.currentCycle % 1232).toBeLessThan(1006 + 20);
    gba.runFrame(() => (gba.bus.read16(DISPSTAT) & 2) === 0);
    expect(gba.scanline).toBe(11);
  });
});
