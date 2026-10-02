/**
 * Who aligns a misaligned access. The CPU and DMA drive the address they mean and the bus aligns
 * it the way the addressed memory does (MemoryBus in arm-emulator). The 8-bit SRAM bus is the one
 * memory that sees address bits 0-1, so it is where a layer that aligns too early shows.
 */
import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { GbaSystemBus } from '../system-bus.js';

const SRAM = 0x0e000000;
const EWRAM = 0x02000100;

/** A ROM holding `words` at its start and declaring SRAM the way a build does. */
function sramRom(words: number[] = []): Uint8Array {
  const rom = new Uint8Array(0x1000);
  words.forEach((w, i) => {
    rom[i * 4] = w & 0xff;
    rom[i * 4 + 1] = (w >>> 8) & 0xff;
    rom[i * 4 + 2] = (w >>> 16) & 0xff;
    rom[i * 4 + 3] = w >>> 24;
  });
  const id = 'SRAM_V113';
  for (let i = 0; i < id.length; i++) {
    rom[0x400 + i] = id.charCodeAt(i);
  }
  return rom;
}

function sramBus(): GbaSystemBus {
  const bus = new GbaSystemBus();
  bus.loadRom(sramRom());
  return bus;
}

describe('SRAM on its 8-bit bus', () => {
  // mGBA GBAStore16 (`if (address & 1) value >>= 8`) and STORE_SRAM (`value >> (8 * (address & 3))`);
  // jsmolka save/sram tests 6 and 8.
  it('a halfword store writes the byte lane address bit 0 selects', () => {
    const bus = sramBus();
    bus.write16(SRAM, 0xaabb);
    bus.write16(SRAM + 1, 0xaabb);
    expect([bus.sram[0], bus.sram[1]]).toEqual([0xbb, 0xaa]);
  });

  it('a word store writes the byte lane address bits 0-1 select', () => {
    const bus = sramBus();
    for (let i = 0; i < 4; i++) {
      bus.write32(SRAM + 4 + i, 0xaabbccdd);
    }
    expect(Array.from(bus.sram.subarray(4, 8))).toEqual([0xdd, 0xcc, 0xbb, 0xaa]);
  });

  it('a wide read returns the addressed byte on every lane', () => {
    const bus = sramBus();
    bus.sram[3] = 0x61;
    expect(bus.read16(SRAM + 3)).toBe(0x6161);
    expect(bus.read32(SRAM + 3)).toBe(0x61616161);
  });

  it('the CPU hands SRAM the misaligned address and rotates what comes back', () => {
    // mgba-suite Memory "SRAM load": U16 (unaligned) reads 0x61000061 with 0x61 at +1.
    const gba = new Gba();
    gba.loadRom(
      sramRom([
        0xe1d010b0, // ldrh r1, [r0]
        0xe5902000, // ldr  r2, [r0]
        0xe1c030b0, // strh r3, [r0]
        0xe5803000, // str  r3, [r0]
      ]),
    );
    gba.armCpu.cpsr = 0x1f;
    gba.armCpu.registers[15] = 0x08000000;
    gba.bus.sram[0] = 0x47;
    gba.bus.sram[1] = 0x61;
    gba.armCpu.registers[0] = SRAM + 1;
    gba.armCpu.registers[3] = 0xaabbccdd;
    gba.armCpu.step();
    gba.armCpu.step();
    expect(gba.armCpu.registers[1]).toBe(0x61000061);
    expect(gba.armCpu.registers[2]).toBe(0x61616161);
    gba.armCpu.step();
    expect(gba.bus.sram[1]).toBe(0xcc);
    gba.armCpu.registers[0] = SRAM + 2;
    gba.armCpu.step();
    expect(gba.bus.sram[2]).toBe(0xbb);
  });
});

describe('DMA addresses', () => {
  // mGBA GBADMAWriteCNT_HI: `nextSource &= -width; nextDest &= -width` when the channel starts.
  function dma3(gba: Gba, src: number, dst: number, control: number): void {
    gba.bus.write32(0x040000d4, src);
    gba.bus.write32(0x040000d8, dst);
    gba.bus.write16(0x040000dc, 1);
    gba.bus.write16(0x040000de, control);
  }

  it('a halfword DMA drops address bit 0, so it reads the even SRAM byte', () => {
    // mgba-suite Memory "DMA1 16 (unaligned)": 0x4747 with 0x47 at +0 and 0x61 at +1.
    const gba = new Gba();
    gba.loadRom(sramRom());
    gba.bus.sram[0] = 0x47;
    gba.bus.sram[1] = 0x61;
    dma3(gba, SRAM + 1, EWRAM + 1, 0x8000); // enable, immediate, 16-bit
    expect(gba.bus.read16(EWRAM)).toBe(0x4747);
  });

  it('a word DMA drops address bits 0-1 on both ends', () => {
    const gba = new Gba();
    gba.loadRom(sramRom());
    gba.bus.write32(EWRAM, 0x11223344);
    dma3(gba, EWRAM + 2, EWRAM + 0x13, 0x8400); // enable, immediate, 32-bit
    expect(gba.bus.read32(EWRAM + 0x10)).toBe(0x11223344);
  });
});
