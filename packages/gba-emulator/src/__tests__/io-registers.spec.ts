/**
 * I/O register semantics at every access width. I/O sits on a 16-bit bus: a byte access drives
 * one byte lane of a register and a word access two registers, and each register answers with its
 * own readable bits (GBATEK "GBA I/O Map"; mGBA io.c GBAIOWrite8/GBAIORead; mgba-suite io-read.c).
 */
import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';

const IO = 0x04000000;
const IE = IO + 0x200;
const IF = IO + 0x202;
const IME = IO + 0x208;

function romOf(words: number[]): Uint8Array {
  const rom = new Uint8Array(words.length * 4);
  words.forEach((w, i) => {
    rom[i * 4] = w & 0xff;
    rom[i * 4 + 1] = (w >>> 8) & 0xff;
    rom[i * 4 + 2] = (w >>> 16) & 0xff;
    rom[i * 4 + 3] = w >>> 24;
  });
  return rom;
}

/** ARM, from 0x08000000; `b .` when no program is given. */
function boot(words: number[] = [0xeafffffe]): Gba {
  const gba = new Gba();
  gba.loadRom(romOf(words));
  gba.armCpu.cpsr = 0x1f;
  gba.armCpu.registers[15] = 0x08000000;
  return gba;
}

describe('I/O writes of every width reach the register that owns the address', () => {
  it('a byte write sets one byte of IE, IME, KEYCNT, WAITCNT and TM0CNT_H, as a halfword write would', () => {
    const cases: Array<[address: number, value: number]> = [
      [IE, 0x2005],
      [IO + 0x132, 0x4003], // KEYCNT
      [IO + 0x204, 0x4317], // WAITCNT
      [IO + 0x102, 0x00c3], // TM0CNT_H
      [IME, 0x0001],
    ];
    for (const [address, value] of cases) {
      const gba = boot();
      gba.bus.write8(address, value & 0xff);
      gba.bus.write8(address + 1, value >>> 8);
      expect(gba.bus.read16(address), address.toString(16)).toBe(value);
    }
  });

  it('a byte write leaves the register’s other byte as it was', () => {
    const gba = boot();
    gba.bus.write16(IE, 0x3fff);
    gba.bus.write8(IE, 0);
    expect(gba.bus.read16(IE)).toBe(0x3f00);
  });

  it('a byte write to TMxCNT_L sets that byte of the reload, keeping the reload’s other byte', () => {
    const gba = boot();
    gba.bus.write16(IO + 0x100, 0x1234);
    gba.bus.write8(IO + 0x101, 0xab);
    expect(gba.timers.readReload(0)).toBe(0xab34);
    gba.bus.write8(IO + 0x102, 0x80); // enable: the counter starts from the reload
    expect(gba.bus.read16(IO + 0x100)).toBe(0xab34);
  });

  it('IF acknowledges only bits of the byte written', () => {
    const gba = boot();
    gba.interrupts.requestInterrupt(0x0109); // VBlank, Timer0, DMA0
    gba.bus.write8(IF + 1, 0xff);
    expect(gba.bus.read16(IF)).toBe(0x0009);
    gba.bus.write8(IF, 0x01);
    expect(gba.bus.read16(IF)).toBe(0x0008);
  });

  it('a DMA programmed a halfword at a time copies, its address latches written in halves', () => {
    const gba = boot();
    gba.bus.write32(0x02000000, 0xdeadbeef);
    gba.bus.write32(0x02000004, 0xcafebabe);
    gba.bus.write16(IO + 0xd4, 0x0000); // DMA3SAD
    gba.bus.write16(IO + 0xd6, 0x0200);
    gba.bus.write16(IO + 0xd8, 0x0100); // DMA3DAD
    gba.bus.write16(IO + 0xda, 0x0300);
    gba.bus.write16(IO + 0xdc, 2); // two words
    gba.bus.write16(IO + 0xde, 0x8400); // enable, 32-bit, immediate
    gba.scheduler.tick(3); // a channel starts 3 cycles after the write that enables it
    expect(gba.bus.read32(0x03000100)).toBe(0xdeadbeef);
    expect(gba.bus.read32(0x03000104)).toBe(0xcafebabe);
  });

  it('a DMA programmed a byte at a time copies, and starts on the byte that sets the enable bit', () => {
    const gba = boot();
    gba.bus.write32(0x02000010, 0x11223344);
    const bytes: Array<[number, number]> = [
      [0xd4, 0x10],
      [0xd5, 0x00],
      [0xd6, 0x00],
      [0xd7, 0x02], // DMA3SAD = 0x02000010
      [0xd8, 0x20],
      [0xd9, 0x00],
      [0xda, 0x00],
      [0xdb, 0x03], // DMA3DAD = 0x03000020
      [0xdc, 0x01], // one word
      [0xde, 0x00],
    ];
    for (const [offset, value] of bytes) {
      gba.bus.write8(IO + offset, value);
    }
    gba.scheduler.tick(3);
    expect(gba.bus.read32(0x03000020)).toBe(0);
    gba.bus.write8(IO + 0xdf, 0x84);
    gba.scheduler.tick(3); // a channel starts 3 cycles after the write that enables it
    expect(gba.bus.read32(0x03000020)).toBe(0x11223344);
  });

  it('POSTFLG and HALTCNT are the two bytes of 0x04000300: a halfword write reaches both', () => {
    const gba = boot();
    gba.bus.write8(IO + 0x300, 1);
    expect(gba.bus.read8(IO + 0x300)).toBe(1);
    expect(gba.interrupts.halted).toBe(false);
    gba.bus.write16(IO + 0x300, 0x0001);
    expect(gba.interrupts.halted).toBe(true);
  });

  it('a write of any width to BG2X reloads the internal reference point', () => {
    const gba = boot();
    gba.bus.write8(IO + 0x29, 0x10);
    expect(gba.ppu.serialize().bg2RefX).toBe(0x1000);
    gba.bus.write8(IO + 0x3e, 0x02); // BG3Y, low byte of the high half
    expect(gba.ppu.serialize().bg3RefY).toBe(0x20000);
  });
});

describe('I/O reads return each register’s readable bits', () => {
  it('readable registers mask their unimplemented bits (mgba-suite io-read.c)', () => {
    const cases: Array<[offset: number, readback: number]> = [
      [0x008, 0xdfff], // BG0CNT: bit 13 exists on BG2 and BG3 only
      [0x00a, 0xdfff],
      [0x00c, 0xffff],
      [0x048, 0x3f3f], // WININ
      [0x04a, 0x3f3f], // WINOUT
      [0x050, 0x3fff], // BLDCNT
      [0x052, 0x1f1f], // BLDALPHA
      [0x0b8, 0x0000], // DMA0CNT_L: write-only, reads 0
      [0x0de, 0x0800 | 0x7fe0], // DMA3CNT_H, enable bit left clear: bit 11 (Game Pak DRQ) reads back on DMA3
      [0x0ba, 0x7fe0 & ~0x0800], // DMA0CNT_H has no bit 11
      [0x136, 0x0000], // unused halfwords that read 0
      [0x206, 0x0000],
      [0x20a, 0x0000],
      [0x302, 0x0000],
    ];
    for (const [offset, readback] of cases) {
      const gba = boot();
      gba.bus.write16(IO + offset, offset >= 0xb0 && offset < 0xe0 ? 0x7fff : 0xffff);
      expect(gba.bus.read16(IO + offset), offset.toString(16)).toBe(readback);
    }
  });

  it('a write-only or unused register reads open bus: the opcode the CPU fetched last', () => {
    const gba = boot([
      0xe3a00301, // mov  r0, #0x04000000
      0xe1d011b0, // ldrh r1, [r0, #0x10]   BG0HOFS: low half of [$+8]
      0xea000000, // b    over the data
      0xcafef00d,
      0xe1d034be, // ldrh r3, [r0, #0x4e]   unused, address bit 1 set: high half of [$+8]
      0xea000000,
      0xbeef1234,
      0xe5902410, // ldr  r2, [r0, #0x410]  past the register file
      0xea000000,
      0x600dd00d,
      0xeafffffe, // b .
    ]);
    gba.bus.write16(IO + 0x10, 0x0123);
    gba.bus.write16(IO + 0x410, 0x4567); // reaches nothing
    gba.runScanline();
    expect(gba.armCpu.registers[1]).toBe(0xf00d);
    expect(gba.armCpu.registers[3]).toBe(0xbeef);
    expect(gba.armCpu.registers[2]).toBe(0x600dd00d);
  });

  it('a debugger’s peek shows what was written to a write-only register', () => {
    const gba = boot();
    gba.bus.write16(IO + 0x10, 0x0123); // BG0HOFS
    gba.bus.write32(IO + 0xb0, 0x02000004); // DMA0SAD
    gba.bus.write16(IO + 0xb8, 0x0010); // DMA0CNT_L
    expect(Array.from(gba.bus.peek(IO + 0x10, 2).data)).toEqual([0x23, 0x01]);
    expect(Array.from(gba.bus.peek(IO + 0xb0, 4).data)).toEqual([0x04, 0x00, 0x00, 0x02]);
    expect(Array.from(gba.bus.peek(IO + 0xb8, 2).data)).toEqual([0x10, 0x00]);
    expect(Array.from(gba.bus.peek(IO + 0x4e, 2).data)).toEqual([0, 0]); // unused
  });
});

describe('I/O above the register file', () => {
  it('does not alias the registers below it', () => {
    const gba = boot();
    gba.bus.write16(IO + 0x10, 0x0123);
    gba.bus.write16(IO + 0x400, 0x1234);
    gba.bus.write16(IO + 0x410, 0x4567);
    gba.bus.write32(IO + 0x800, 0x0d000020);
    expect(gba.bus.read16(IO)).toBe(0);
    expect(gba.bus.peek(IO + 0x10, 2).data).toEqual(new Uint8Array([0x23, 0x01]));
    expect(gba.bus.describeAddress(IO + 0x400)).toBeNull();
    expect(gba.bus.peek(IO + 0x400, 1).readable).toBe(0);
  });

  it('holds the memory-control register at 0x04000800, mirrored every 64 KB', () => {
    // GBATEK "Memory Control - 4000800h": 0D000020h after boot; bits 0-3, 5 and 24-31 read back.
    const gba = boot();
    expect(gba.bus.read32(IO + 0x800)).toBe(0x0d000020);
    gba.bus.write32(IO + 0x800, 0xffffffff);
    expect(gba.bus.read32(IO + 0x800)).toBe(0xff00002f);
    gba.bus.write8(IO + 0x10803, 0x0e); // a byte through a mirror
    expect(gba.bus.read32(IO + 0x20800)).toBe(0x0e00002f);
    expect(gba.bus.describeAddress(IO + 0x800)).toEqual({ region: 'MMIO' });
    expect(Array.from(gba.bus.peek(IO + 0x800, 4).data)).toEqual([0x2f, 0x00, 0x00, 0x0e]);
  });
});
