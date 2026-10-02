import { GbaMemory, LR, SENTINEL_ADDR } from '@gba-kit/arm-emulator';
import { ArmCpu, MODE_SYS } from '@gba-kit/arm-emulator/arm-cpu';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { handleSwi } from '../bios.js';

// ─── Helpers ────────────────────────────────────────────────────────

const AL = 0xe;

function armBx(rm: number): number {
  return ((AL << 28) | 0x012fff10 | (rm & 0xf)) >>> 0;
}

function armSwi(num: number): number {
  return ((AL << 28) | 0x0f000000 | ((num & 0xff) << 16)) >>> 0;
}

function loadArmInstructions(mem: GbaMemory, baseAddr: number, instructions: number[]): void {
  const buf = new Uint8Array(instructions.length * 4);
  const view = new DataView(buf.buffer);
  instructions.forEach((instr, i) => view.setUint32(i * 4, instr, true));
  mem.loadBytes(baseAddr, buf);
}

function loadThumbInstructions(mem: GbaMemory, baseAddr: number, instructions: number[]): void {
  const buf = new Uint8Array(instructions.length * 2);
  const view = new DataView(buf.buffer);
  instructions.forEach((instr, i) => view.setUint16(i * 2, instr, true));
  mem.loadBytes(baseAddr, buf);
}

function setupArmCpu(instructions: number[], startAddr: number = 0x08000000): { cpu: ArmCpu; mem: GbaMemory } {
  const mem = new GbaMemory();
  const cpu = new ArmCpu(mem, { swiHandler: handleSwi });
  loadArmInstructions(mem, startAddr, instructions);
  cpu.cpsr = MODE_SYS;
  cpu.registers[15] = startAddr;
  cpu.registers[LR] = SENTINEL_ADDR;
  return { cpu, mem };
}

function setupThumbCpu(instructions: number[], startAddr: number = 0x08000000): { cpu: ArmCpu; mem: GbaMemory } {
  const mem = new GbaMemory();
  const cpu = new ArmCpu(mem, { swiHandler: handleSwi });
  loadThumbInstructions(mem, startAddr, instructions);
  cpu.cpsr = MODE_SYS | (1 << 5); // T bit set
  cpu.registers[15] = startAddr;
  cpu.registers[LR] = SENTINEL_ADDR;
  return { cpu, mem };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('GBA BIOS (HLE)', () => {
  it('SWI 0x06: Div', () => {
    const { cpu } = setupArmCpu([armSwi(0x06), armBx(LR)]);
    cpu.registers[0] = 42;
    cpu.registers[1] = 5;
    cpu.run(100);
    expect(cpu.registers[0]! | 0).toBe(8);
    expect(cpu.registers[1]! | 0).toBe(2);
    expect(cpu.registers[3]).toBe(8);
  });

  it('SWI 0x06: Div negative', () => {
    const { cpu } = setupArmCpu([armSwi(0x06), armBx(LR)]);
    cpu.registers[0] = -7 >>> 0;
    cpu.registers[1] = 2;
    cpu.run(100);
    expect(cpu.registers[0]! | 0).toBe(-3);
    expect(cpu.registers[1]! | 0).toBe(-1);
    expect(cpu.registers[3]).toBe(3);
  });

  it('SWI 0x07: DivArm (swapped args)', () => {
    const { cpu } = setupArmCpu([armSwi(0x07), armBx(LR)]);
    cpu.registers[0] = 5;
    cpu.registers[1] = 42;
    cpu.run(100);
    expect(cpu.registers[0]! | 0).toBe(8);
    expect(cpu.registers[1]! | 0).toBe(2);
  });

  it('SWI 0x08: Sqrt', () => {
    const { cpu } = setupArmCpu([armSwi(0x08), armBx(LR)]);
    cpu.registers[0] = 144;
    cpu.run(100);
    expect(cpu.registers[0]).toBe(12);
  });

  it('SWI 0x08: Sqrt non-perfect', () => {
    const { cpu } = setupArmCpu([armSwi(0x08), armBx(LR)]);
    cpu.registers[0] = 10;
    cpu.run(100);
    expect(cpu.registers[0]).toBe(3);
  });

  it('SWI 0x0B: CpuSet (copy, 32-bit)', () => {
    const { cpu, mem } = setupArmCpu([armSwi(0x0b), armBx(LR)]);
    mem.write32(0x02000000, 0x11111111);
    mem.write32(0x02000004, 0x22222222);
    mem.write32(0x02000008, 0x33333333);
    cpu.registers[0] = 0x02000000;
    cpu.registers[1] = 0x02000100;
    cpu.registers[2] = 3 | (1 << 26);
    cpu.run(100);
    expect(mem.read32(0x02000100)).toBe(0x11111111);
    expect(mem.read32(0x02000104)).toBe(0x22222222);
    expect(mem.read32(0x02000108)).toBe(0x33333333);
  });

  it('SWI 0x0B: CpuSet (fill, 32-bit)', () => {
    const { cpu, mem } = setupArmCpu([armSwi(0x0b), armBx(LR)]);
    mem.write32(0x02000000, 0xdeadbeef);
    cpu.registers[0] = 0x02000000;
    cpu.registers[1] = 0x02000100;
    cpu.registers[2] = 4 | (1 << 24) | (1 << 26);
    cpu.run(100);
    expect(mem.read32(0x02000100)).toBe(0xdeadbeef);
    expect(mem.read32(0x02000104)).toBe(0xdeadbeef);
    expect(mem.read32(0x02000108)).toBe(0xdeadbeef);
    expect(mem.read32(0x0200010c)).toBe(0xdeadbeef);
  });

  it('SWI 0x11: LZ77UnCompWram', () => {
    const { cpu, mem } = setupArmCpu([armSwi(0x11), armBx(LR)]);
    const srcAddr = 0x02000000;
    const dstAddr = 0x02000100;
    mem.write32(srcAddr, 0x00000810);
    mem.write8(srcAddr + 4, 0x00);
    mem.write8(srcAddr + 5, 0x41);
    mem.write8(srcAddr + 6, 0x42);
    mem.write8(srcAddr + 7, 0x43);
    mem.write8(srcAddr + 8, 0x44);
    mem.write8(srcAddr + 9, 0x45);
    mem.write8(srcAddr + 10, 0x46);
    mem.write8(srcAddr + 11, 0x47);
    mem.write8(srcAddr + 12, 0x48);
    cpu.registers[0] = srcAddr;
    cpu.registers[1] = dstAddr;
    cpu.run(100);
    expect(mem.read8(dstAddr)).toBe(0x41);
    expect(mem.read8(dstAddr + 1)).toBe(0x42);
    expect(mem.read8(dstAddr + 7)).toBe(0x48);
  });

  it('SWI 0x11: LZ77 with back-reference', () => {
    const { cpu, mem } = setupArmCpu([armSwi(0x11), armBx(LR)]);
    const srcAddr = 0x02000000;
    const dstAddr = 0x02000100;
    mem.write32(srcAddr, 0x00000710);
    mem.write8(srcAddr + 4, 0x08);
    mem.write8(srcAddr + 5, 0xaa);
    mem.write8(srcAddr + 6, 0xbb);
    mem.write8(srcAddr + 7, 0xcc);
    mem.write8(srcAddr + 8, 0xdd);
    mem.write8(srcAddr + 9, 0x00);
    mem.write8(srcAddr + 10, 0x03);
    cpu.registers[0] = srcAddr;
    cpu.registers[1] = dstAddr;
    cpu.run(100);
    expect(mem.read8(dstAddr)).toBe(0xaa);
    expect(mem.read8(dstAddr + 1)).toBe(0xbb);
    expect(mem.read8(dstAddr + 2)).toBe(0xcc);
    expect(mem.read8(dstAddr + 3)).toBe(0xdd);
    expect(mem.read8(dstAddr + 4)).toBe(0xaa);
    expect(mem.read8(dstAddr + 5)).toBe(0xbb);
    expect(mem.read8(dstAddr + 6)).toBe(0xcc);
  });

  it('a call costs the BIOS code it stands for: Div and Sqrt as the hardware measured them', () => {
    // mgba-suite Timing "BIOS Division" (338), "BIOS Division 2" (78) and "BIOS Sqrt" (104) in
    // IWRAM, less the 8, 8 and 5 one-cycle instructions around the swi: its fetch, the BIOS's
    // dispatch, the function, and the return's refill.
    const div = setupArmCpu([armSwi(0x06), armBx(LR)]);
    div.cpu.registers[0] = 0x12345678;
    div.cpu.registers[1] = 0xff;
    expect(div.cpu.step()).toBe(338 - 8);
    const div2 = setupArmCpu([armSwi(0x06), armBx(LR)]);
    div2.cpu.registers[0] = 0xff;
    div2.cpu.registers[1] = 0x12345678;
    expect(div2.cpu.step()).toBe(78 - 8);
    const sqrt = setupArmCpu([armSwi(0x08), armBx(LR)]);
    sqrt.cpu.registers[0] = 0;
    expect(sqrt.cpu.step()).toBe(104 - 5);
  });

  it('a decompression costs per byte it reads and writes', () => {
    // LZ77UnCompWram of 4 literal bytes, every access 1 cycle (mGBA _unLz77): 20 and the header
    // load (2); the flag byte (14 + 2); per byte 14 + 18, its load (2) and store (1).
    const { cpu, mem } = setupArmCpu([armSwi(0x11), armBx(LR)]);
    mem.write32(0x02000000, 0x00000410);
    mem.write32(0x02000004, 0x43424100);
    mem.write8(0x02000008, 0x44);
    cpu.registers[0] = 0x02000000;
    cpu.registers[1] = 0x02000100;
    const dispatch = 42 + 1;
    expect(cpu.step()).toBe(1 + dispatch + 20 + 2 + 14 + 2 + 4 * (14 + 18 + 2 + 1) + 2);
    expect(mem.read32(0x02000100)).toBe(0x44434241);
  });

  it('SWI 0x06: Div via Thumb SWI', () => {
    const { cpu } = setupThumbCpu([
      0xdf06, // swi #6
      0x4770, // bx lr
    ]);
    cpu.registers[0] = 100;
    cpu.registers[1] = 7;
    cpu.run(100);
    expect(cpu.registers[0]! | 0).toBe(14);
    expect(cpu.registers[1]! | 0).toBe(2);
  });
});

/** Run `swi n` from ROM with r0-r3 set; returns the CPU, the memory and the SWI's cycles. */
function call(
  n: number,
  regs: number[],
  setup: (mem: GbaMemory) => void = () => {},
): { cpu: ArmCpu; mem: GbaMemory; cycles: number } {
  const { cpu, mem } = setupArmCpu([armSwi(n), armBx(LR)]);
  setup(mem);
  regs.forEach((value, r) => (cpu.registers[r] = value >>> 0));
  const cycles = cpu.step();
  return { cpu, mem, cycles };
}

/** Results captured from the real BIOS, run instruction by instruction on this CPU. */
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/bios-golden.json', import.meta.url), 'utf8')) as {
  arcTan: Array<{ r0in: number; r0: number; r1: number; r3: number }>;
  arcTan2: Array<{ x: number; y: number; r0: number }>;
  objAffineSet: Array<{ sx: number; sy: number; angle: number; pa_pb_pc_pd: number[] }>;
  bgAffineSet: Array<{
    ox: number;
    oy: number;
    cx: number;
    cy: number;
    sx: number;
    sy: number;
    angle: number;
    pa_pb_pc_pd: number[];
    x: number;
    y: number;
  }>;
  midiKey2Freq: Array<{ freq: number; mk: number; fp: number; r0: number }>;
  getBiosChecksum: number[];
};

const SRC = 0x02000000;
const DST = 0x02010000;
const s16 = (v: number): number => (v << 16) >> 16;

describe('BIOS math matches the real BIOS bit for bit', () => {
  it('ArcTan: the fixed-point polynomial, with r1 and r3 as the BIOS leaves them', () => {
    for (const { r0in, r0, r1, r3 } of GOLDEN.arcTan) {
      const { cpu } = call(0x09, [r0in]);
      expect([cpu.registers[0]! | 0, cpu.registers[1]! | 0, cpu.registers[3]! | 0]).toEqual([r0, r1, r3]);
    }
  });

  it('ArcTan keeps the sign of a negative angle and the polynomial past 1.0', () => {
    // mgba-suite "BIOS math": ArcTan 0000C000 -> FFFFC360, r1 0001C000, r3 00010480.
    const { cpu } = call(0x09, [0xc000]);
    expect([cpu.registers[0], cpu.registers[1], cpu.registers[3]]).toEqual([0xffffc360, 0x0001c000, 0x00010480]);
  });

  it('ArcTan2: every octant and both axes, r3 left at 0x170', () => {
    for (const { x, y, r0 } of GOLDEN.arcTan2) {
      const { cpu } = call(0x0a, [x, y]);
      expect(cpu.registers[0]).toBe(r0);
      expect(cpu.registers[3]).toBe(0x170);
    }
  });

  it('ArcTan2 takes 32-bit coordinates: x = 0x8000 is positive', () => {
    // mgba-suite "BIOS math": ArcTan2 00008000,00000000 -> 0.
    expect(call(0x0a, [0x8000, 0]).cpu.registers[0]).toBe(0);
    expect(call(0x0a, [1, 1]).cpu.registers[1]).toBe(0xffffc000);
  });

  it('Div by zero returns the numerator’s sign, the numerator and 1', () => {
    // mgba-suite "BIOS math" Div 00000001/00000000 and FFFFFFFF/00000000.
    expect(Array.from(call(0x06, [1, 0]).cpu.registers.slice(0, 4))).toEqual([1, 1, 0, 1]);
    expect(Array.from(call(0x06, [-1, 0]).cpu.registers.slice(0, 4))).toEqual([0xffffffff, 0xffffffff, 0, 1]);
    expect(Array.from(call(0x06, [0, 0]).cpu.registers.slice(0, 4))).toEqual([1, 0, 0, 1]);
  });

  it('Div counts its loop from the magnitudes: a negative numerator costs what its positive does', () => {
    expect(call(0x06, [-100, 7]).cycles).toBe(call(0x06, [100, 7]).cycles);
  });

  it('Sqrt leaves the search’s last bound in r1 and its quotient in r3', () => {
    // Checked against the real BIOS: Sqrt(0xFF) leaves r1 0x10 and r3 0x11; Sqrt(0) leaves r3 1.
    expect(Array.from(call(0x08, [0xff]).cpu.registers.slice(0, 4))).toEqual([0xf, 0x10, 0, 0x11]);
    expect(Array.from(call(0x08, [0, 0x55, 0, 0x66]).cpu.registers.slice(0, 4))).toEqual([0, 0, 0, 1]);
  });

  it('GetBiosChecksum returns the GBA BIOS’s checksum, 1 and its size', () => {
    const { cpu } = call(0x0d, [5, 6, 7, 8]);
    expect(Array.from(cpu.registers.slice(0, 4))).toEqual([0xbaae187f, 1, 7, 0x4000]);
    expect(GOLDEN.getBiosChecksum[0]).toBe(0xbaae187f);
  });
});

describe('BIOS affine parameters', () => {
  it('ObjAffineSet uses the BIOS sine table and 1.14 fixed point', () => {
    for (const { sx, sy, angle, pa_pb_pc_pd } of GOLDEN.objAffineSet) {
      const { mem } = call(0x0f, [SRC, DST, 1, 2], (m) => {
        m.write16(SRC, sx & 0xffff);
        m.write16(SRC + 2, sy & 0xffff);
        m.write16(SRC + 4, angle);
      });
      expect([0, 2, 4, 6].map((o) => s16(mem.read16(DST + o)))).toEqual(pa_pb_pc_pd);
    }
  });

  it('ObjAffineSet takes r3 as the byte offset between parameters: 8 lands in OAM’s attribute 3 slots', () => {
    const { cpu, mem } = call(0x0f, [SRC, 0x07000006, 1, 8], (m) => {
      m.write16(SRC, 0x100); // scale 1.0
      m.write16(SRC + 2, 0x100);
      m.write16(SRC + 4, 0x4000); // 90 degrees
      for (let i = 0; i < 0x40; i += 2) {
        m.write16(0x07000000 + i, 0xcccc);
      }
    });
    expect([6, 14, 22, 30].map((o) => mem.read16(0x07000000 + o))).toEqual([0, 0xff00, 0x100, 0]);
    expect(mem.read16(0x07000008)).toBe(0xcccc); // the next OBJ's attribute 0 is untouched
    expect([cpu.registers[0], cpu.registers[1]]).toEqual([SRC + 8, 0x07000006 + 32]);
  });

  it('BgAffineSet computes the start point in 32-bit integers from the truncated matrix', () => {
    for (const { ox, oy, cx, cy, sx, sy, angle, pa_pb_pc_pd, x, y } of GOLDEN.bgAffineSet) {
      const { mem } = call(0x0e, [SRC, DST, 1], (m) => {
        m.write32(SRC, ox);
        m.write32(SRC + 4, oy);
        [cx, cy, sx, sy, angle].forEach((v, i) => m.write16(SRC + 8 + i * 2, v & 0xffff));
      });
      expect([0, 2, 4, 6].map((o) => s16(mem.read16(DST + o)))).toEqual(pa_pb_pc_pd);
      expect([mem.read32(DST + 8) | 0, mem.read32(DST + 12) | 0]).toEqual([x, y]);
    }
  });
});

describe('BIOS sound helpers', () => {
  it('MidiKey2Freq is SWI 0x1F and interpolates the m4a tables', () => {
    for (const { freq, mk, fp, r0 } of GOLDEN.midiKey2Freq) {
      const { cpu } = call(0x1f, [SRC, mk, fp], (m) => m.write32(SRC + 4, freq));
      expect(cpu.registers[0]).toBe(r0);
    }
  });

  it('SoundBias is SWI 0x19: it ramps the bias level by 2 per step and keeps r0', () => {
    const down = call(0x19, [0, 0x11, 0x22, 0x33], (m) => m.write16(0x04000088, 0xc200));
    expect(down.mem.read16(0x04000088)).toBe(0xc000); // the resolution bits stay
    expect(Array.from(down.cpu.registers.slice(0, 4))).toEqual([0, 0, 0x22, 0x04000088]);
    // The fetch, the dispatch and the return refill (46 on this bus), then 256 steps down.
    expect(down.cycles).toBe(46 + 27 + 256 * 61);
    const up = call(0x19, [1], (m) => m.write16(0x04000088, 0x100));
    expect(up.mem.read16(0x04000088)).toBe(0x200);
    expect(up.cycles).toBe(46 + 25 + 128 * 62);
    const above = call(0x19, [1], (m) => m.write16(0x04000088, 0x3fe));
    expect(above.mem.read16(0x04000088)).toBe(0x3fe); // a level above 0x200 stays
  });
});

describe('BIOS copies', () => {
  const pattern = (m: GbaMemory): void => {
    for (let i = 0; i < 64; i += 4) {
      m.write32(SRC + i, (0x11223344 + i * 0x01010101) >>> 0);
      m.write32(DST + i, 0xcccccccc);
    }
  };

  it('CpuSet refuses a source in the BIOS region and leaves r3 at 0x170 on every path', () => {
    // mgba-suite Memory "swi B 16" from the BIOS: the destination keeps its contents.
    for (const src of [0x100, 0x01fffff0, 0x10000100]) {
      const { cpu, mem } = call(0x0b, [src, DST, 4 | (1 << 26)], pattern);
      expect(mem.read32(DST)).toBe(0xcccccccc);
      expect(cpu.registers[3]).toBe(0x170);
    }
    expect(call(0x0b, [SRC, DST, 0], pattern).cpu.registers[3]).toBe(0x170);
  });

  it('a 16-bit CpuSet from an odd address copies the addressed byte, as LDRH rotates it', () => {
    // mgba-suite Memory "swi B 16 (unaligned)": DEADBEEF at the source copies as 00DE00BE.
    const { mem } = call(0x0b, [SRC + 1, DST, 2], (m) => m.write32(SRC, 0xdeadbeef));
    expect(mem.read32(DST)).toBe(0x00de00be);
    const fill = call(0x0b, [SRC + 1, DST, 2 | (1 << 24)], (m) => m.write32(SRC, 0xdeadbeef));
    expect(fill.mem.read32(DST)).toBe(0x00be00be);
  });

  it('a 32-bit CpuSet leaves r0 and r1 past the data, as LDMIA and STMIA write them back', () => {
    const { cpu } = call(0x0b, [SRC, DST, 3 | (1 << 26)], pattern);
    expect([cpu.registers[0], cpu.registers[1]]).toEqual([SRC + 12, DST + 12]);
  });

  it('CpuFastSet loads each block of 8 words before storing it', () => {
    // An overlapping copy one word up moves each block as it was, not a smear of its first word.
    const { cpu, mem } = call(0x0c, [SRC, SRC + 4, 8], pattern);
    expect(mem.read32(SRC + 4)).toBe(0x11223344);
    expect(mem.read32(SRC + 32)).toBe((0x11223344 + 28 * 0x01010101) >>> 0);
    expect(cpu.registers[3]).toBe((0x11223344 + 4 * 0x01010101) >>> 0); // the block's second word
    expect(call(0x0c, [0x100, DST, 8], pattern).mem.read32(DST)).toBe(0xcccccccc);
  });
});

describe('BIOS unpacking and decompression', () => {
  it('BitUnPack fills 32-bit units, and leaves a last partial word unwritten', () => {
    const wide = call(0x10, [SRC, DST, 0x02020000], (m) => {
      m.write32(SRC, 0x04030201);
      m.write16(0x02020000, 2); // 2 source bytes
      m.write8(0x02020002, 8);
      m.write8(0x02020003, 32);
      m.write32(0x02020004, 0x80000001); // add 1, zeros included
      m.write32(DST + 8, 0xcccccccc);
    });
    expect([wide.mem.read32(DST), wide.mem.read32(DST + 4), wide.mem.read32(DST + 8)]).toEqual([2, 3, 0xcccccccc]);
    const partial = call(0x10, [SRC, DST, 0x02020000], (m) => {
      m.write32(SRC, 0x00ffffff);
      m.write16(0x02020000, 3); // 3 bytes of 1-bit units: 48 bits of 2-bit units
      m.write8(0x02020002, 1);
      m.write8(0x02020003, 2);
      m.write32(0x02020004, 0);
      m.write32(DST + 4, 0xcccccccc);
    });
    expect(partial.mem.read32(DST)).toBe(0x55555555);
    expect(partial.mem.read32(DST + 4)).toBe(0xcccccccc);
    expect(partial.cpu.registers[3]).toBe(16); // the bits of the word it held back
  });

  it('a VRAM decompression stores whole halfwords: an odd last byte stays unwritten', () => {
    // RLUnCompVram of 3 bytes 'aaa' to DST, which holds cc: the third byte waits for a partner.
    const { cpu, mem } = call(0x15, [SRC, DST], (m) => {
      m.write32(SRC, 0x00000330);
      m.write16(SRC + 4, 0x6180); // a run of 3 'a'
      m.write32(DST, 0xcccccccc);
    });
    expect(mem.read32(DST)).toBe(0xcccc6161);
    expect([cpu.registers[0], cpu.registers[1]]).toEqual([SRC + 6, DST + 2]);
  });

  it('LZ77UnCompVram reads a reference from VRAM itself: displacement 1 reads the byte not yet stored', () => {
    // Literal 5, then a reference of 3 at displacement 1. The real BIOS holds the 5 until its odd
    // partner arrives, so the reference reads the old contents (cc) for the byte at offset 1.
    const { mem } = call(0x12, [SRC, DST], (m) => {
      m.write32(SRC, 0x00000410);
      m.write32(SRC + 4, 0x00000540); // flags 0x40: a literal, then a reference; literal 5; 00 00
      m.write32(SRC + 8, 0);
      m.write32(DST, 0xcccccccc);
    });
    expect(mem.read32(DST)).toBe(0xcccccc05);
  });

  it('a reference runs to its end, past the size the header gives', () => {
    // Size 6: literals 1, 2, 3 and a reference of 18 at displacement 3; the BIOS writes all 21.
    const { cpu, mem } = call(0x11, [SRC, DST], (m) => {
      m.write32(SRC, 0x00000610);
      m.write32(SRC + 4, 0x03020110);
      m.write32(SRC + 8, 0x000002f0);
    });
    expect(mem.read8(DST + 20)).toBe(3);
    expect(cpu.registers[1]).toBe(DST + 21);
  });

  it('the decompressors refuse a source in the BIOS region', () => {
    for (const n of [0x11, 0x13, 0x14, 0x16]) {
      const { mem } = call(n, [0x100, DST], (m) => m.write32(DST, 0xcccccccc));
      expect(mem.read32(DST)).toBe(0xcccccccc);
    }
  });

  it('Diff8bitUnFilterWram, Diff8bitUnFilterVram and Diff16bitUnFilter add up the differences', () => {
    const wram = call(0x16, [SRC, DST], (m) => {
      m.write32(SRC, 0x00000481);
      m.write32(SRC + 4, 0x01010101);
    });
    expect(wram.mem.read32(DST)).toBe(0x04030201);
    const vram = call(0x17, [SRC, DST], (m) => {
      m.write32(SRC, 0x00000381);
      m.write32(SRC + 4, 0x00010101);
      m.write32(DST, 0xcccccccc);
    });
    expect(vram.mem.read32(DST)).toBe(0xcccc0201); // 3 bytes: the third waits for a partner
    const wide = call(0x18, [SRC, DST], (m) => {
      m.write32(SRC, 0x00000682);
      m.write32(SRC + 4, 0x00020001);
      m.write16(SRC + 8, 0xfffd);
    });
    expect([wide.mem.read16(DST), wide.mem.read16(DST + 2), wide.mem.read16(DST + 4)]).toEqual([1, 3, 0]);
    expect(wide.cpu.registers[3]).toBe(0xfffd); // the last difference
  });
});
