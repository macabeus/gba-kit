import { describe, expect, it } from 'vitest';

import { addWithFlags, asr, bit, bits, lsl, lsr, ror, signExtend, subWithFlags } from '../utils.js';

describe('bits()', () => {
  it('extracts single-bit fields', () => {
    expect(bits(0b11010, 4, 4)).toBe(1);
    expect(bits(0b11010, 0, 0)).toBe(0);
  });

  it('extracts multi-bit fields', () => {
    expect(bits(0b11010110, 7, 4)).toBe(0b1101);
    expect(bits(0b11010110, 3, 0)).toBe(0b0110);
  });

  it('extracts from high bits', () => {
    expect(bits(0xf800, 15, 11)).toBe(0x1f);
  });
});

describe('bit()', () => {
  it('returns individual bits', () => {
    expect(bit(0b1010, 3)).toBe(1);
    expect(bit(0b1010, 2)).toBe(0);
    expect(bit(0b1010, 1)).toBe(1);
    expect(bit(0b1010, 0)).toBe(0);
  });

  it('works on bit 31', () => {
    expect(bit(0x80000000, 31)).toBe(1);
    expect(bit(0x7fffffff, 31)).toBe(0);
  });
});

describe('signExtend()', () => {
  it('extends positive values (no sign bit)', () => {
    expect(signExtend(0x7f, 8)).toBe(127);
    expect(signExtend(0x3ff, 11)).toBe(1023);
  });

  it('extends negative values (sign bit set)', () => {
    expect(signExtend(0x80, 8)).toBe(-128);
    expect(signExtend(0xff, 8)).toBe(-1);
    expect(signExtend(0x400, 11)).toBe(-1024);
  });

  it('extends single-bit widths', () => {
    expect(signExtend(0, 1)).toBe(0);
    expect(signExtend(1, 1)).toBe(-1);
  });
});

describe('addWithFlags()', () => {
  it('adds positive numbers', () => {
    const r = addWithFlags(5, 3);
    expect(r.value).toBe(8);
    expect(r.n).toBe(false);
    expect(r.z).toBe(false);
    expect(r.c).toBe(false);
    expect(r.v).toBe(false);
  });

  it('sets Z flag on zero result', () => {
    const r = addWithFlags(0, 0);
    expect(r.value).toBe(0);
    expect(r.z).toBe(true);
  });

  it('sets N flag on negative result', () => {
    const r = addWithFlags(-1, 0);
    expect(r.value | 0).toBe(-1);
    expect(r.n).toBe(true);
  });

  it('sets C flag on unsigned overflow', () => {
    const r = addWithFlags(0xffffffff, 1);
    expect(r.value >>> 0).toBe(0);
    expect(r.c).toBe(true);
    expect(r.z).toBe(true);
  });

  it('sets V flag on signed overflow (positive)', () => {
    const r = addWithFlags(0x7fffffff, 1);
    expect(r.v).toBe(true);
    expect(r.n).toBe(true);
  });

  it('sets V flag on signed overflow (negative)', () => {
    // -2147483648 + (-1) = overflow
    const r = addWithFlags(0x80000000 | 0, -1);
    expect(r.v).toBe(true);
  });

  it('handles carry-in', () => {
    const r = addWithFlags(0xffffffff, 0, 1);
    expect(r.value >>> 0).toBe(0);
    expect(r.c).toBe(true);
  });
});

describe('subWithFlags()', () => {
  it('subtracts smaller from larger', () => {
    const r = subWithFlags(10, 3);
    expect(r.value).toBe(7);
    expect(r.c).toBe(true); // No borrow
    expect(r.v).toBe(false);
  });

  it('subtracts equal values', () => {
    const r = subWithFlags(5, 5);
    expect(r.value).toBe(0);
    expect(r.z).toBe(true);
    expect(r.c).toBe(true); // No borrow
  });

  it('sets C=0 when borrow occurs', () => {
    const r = subWithFlags(3, 10);
    expect(r.c).toBe(false); // Borrow happened
    expect(r.n).toBe(true);
  });

  it('NEG: 0 - value', () => {
    const r = subWithFlags(0, 1);
    expect(r.value | 0).toBe(-1);
    expect(r.n).toBe(true);
    expect(r.c).toBe(false);
  });

  it('handles V flag on signed overflow', () => {
    // 0x80000000 - 1 overflows in signed
    const r = subWithFlags(0x80000000 | 0, 1);
    expect(r.v).toBe(true);
    expect(r.n).toBe(false); // 0x7fffffff is positive
  });
});

describe('lsl()', () => {
  it('shifts by 0 preserves value and carry', () => {
    const [result, carry] = lsl(0xff, 0, true);
    expect(result).toBe(0xff);
    expect(carry).toBe(true);
  });

  it('shifts by small amount', () => {
    const [result, carry] = lsl(1, 4, false);
    expect(result).toBe(16);
    expect(carry).toBe(false);
  });

  it('carry out is the last bit shifted out', () => {
    const [result, carry] = lsl(0x80000000 | 0, 1, false);
    expect(result).toBe(0);
    expect(carry).toBe(true);
  });

  it('shift by 32 gives 0, carry = bit 0', () => {
    const [result, carry] = lsl(1, 32, false);
    expect(result).toBe(0);
    expect(carry).toBe(true);
  });

  it('shift by >32 gives 0 and carry=false', () => {
    const [result, carry] = lsl(0xffffffff, 33, true);
    expect(result).toBe(0);
    expect(carry).toBe(false);
  });
});

describe('lsr()', () => {
  it('shifts by 0 preserves value when not immZeroMeans32', () => {
    const [result, carry] = lsr(0xff, 0, true);
    expect(result).toBe(0xff);
    expect(carry).toBe(true);
  });

  it('shift by 0 with immZeroMeans32 encodes LSR #32', () => {
    const [result, carry] = lsr(0x80000000, 0, false, true);
    expect(result).toBe(0);
    expect(carry).toBe(true); // bit 31 was set
  });

  it('shifts normally', () => {
    const [result, carry] = lsr(0x100, 4, false);
    expect(result).toBe(0x10);
    expect(carry).toBe(false);
  });

  it('carry out is the last bit shifted out', () => {
    // 3 (binary 11) >> 1: bit 0 = 1, so carry = true
    const [result, carry] = lsr(3, 1, false);
    expect(result).toBe(1);
    expect(carry).toBe(true);
  });

  it('shift by 32 gives 0, carry = bit 31', () => {
    const [result, carry] = lsr(0x80000000, 32, false);
    expect(result).toBe(0);
    expect(carry).toBe(true);
  });
});

describe('asr()', () => {
  it('shifts positive value', () => {
    const [result, carry] = asr(0x40, 2, false);
    expect(result).toBe(0x10);
    expect(carry).toBe(false);
  });

  it('sign-extends negative value', () => {
    // -8 = ...11111000. ASR by 2: result = ...11111110 = -2
    // carry = bit 1 of -8 = 0
    const [result, carry] = asr(-8, 2, false);
    expect(result).toBe(-2);
    expect(carry).toBe(false);
  });

  it('shift by 0 with immZeroMeans32 encodes ASR #32', () => {
    const [result, carry] = asr(-1, 0, false, true);
    expect(result | 0).toBe(-1);
    expect(carry).toBe(true);

    const [result2, carry2] = asr(1, 0, false, true);
    expect(result2).toBe(0);
    expect(carry2).toBe(false);
  });

  it('shift by >=32 fills with sign bit', () => {
    const [result, carry] = asr(-1, 32, false);
    expect(result | 0).toBe(-1);
    expect(carry).toBe(true);

    const [result2, carry2] = asr(1, 32, false);
    expect(result2).toBe(0);
    expect(carry2).toBe(false);
  });
});

describe('ror()', () => {
  it('shift by 0 preserves value', () => {
    const [result, carry] = ror(0xab, 0, true);
    expect(result).toBe(0xab);
    expect(carry).toBe(true);
  });

  it('rotates right', () => {
    const [result] = ror(0x01, 1, false);
    expect(result >>> 0).toBe(0x80000000);
  });

  it('full rotation (32) returns same value', () => {
    const [result, carry] = ror(0xdeadbeef, 32, false);
    expect(result | 0).toBe(0xdeadbeef | 0);
    expect(carry).toBe(true); // bit 31 of 0xdeadbeef
  });

  it('carry is bit 31 of result', () => {
    const [result, carry] = ror(1, 2, false);
    // 1 rotated right by 2 = 0x40000000
    expect(result >>> 0).toBe(0x40000000);
    expect(carry).toBe(false); // bit 31 is 0
  });
});
