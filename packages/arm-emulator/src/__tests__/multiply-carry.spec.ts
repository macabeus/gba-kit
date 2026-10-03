import { describe, expect, it } from 'vitest';

import { multiplyCarry, multiplyLongCarry } from '../multiply-carry.js';

describe('multiply carry flag', () => {
  // C from zaydlang's reference implementation, which simulates the whole Booth array
  // (github.com/zaydlang/multiplication-algorithm impl.h: mul, mla, umull, smull, umlal, smlal).
  // The multipliers cover every cycle count of a signed multiply, with and without an accumulator.
  it.each([
    [0x31a61e54, 0x00009335, 0x2da18d6a, 0xffff4054, [true, false, true, true, false, false]],
    [0x0000d43a, 0x0000e78e, 0x341a76cb, 0xffffff76, [true, true, true, true, true, true]],
    [0x00bea091, 0x0000e7c0, 0x4b84b044, 0x2f91d4b2, [false, true, false, false, true, true]],
    [0x6b70ede5, 0xffffffef, 0x000000e7, 0x008c904f, [false, false, true, false, true, false]],
    [0xffffba63, 0xd6ed661c, 0x0000738d, 0xffffff1c, [false, false, true, false, true, false]],
    [0x0000acf4, 0xffffe98c, 0xd243856d, 0xffffff4e, [false, false, false, false, false, false]],
    [0x000000fb, 0xffbe4b37, 0x00000022, 0x49e32099, [true, true, false, true, false, true]],
    [0xffffff05, 0x5d954159, 0xfffabc4b, 0xffffff6e, [false, false, true, true, true, true]],
    [0x69279e09, 0xff4c9c42, 0x00000013, 0x48abcc7d, [true, true, true, true, true, true]],
    [0xffffffe8, 0xa10bf467, 0xdefb352c, 0xffffffed, [true, true, true, false, true, false]],
    [0x0019f5d7, 0xff5ea4da, 0x9006ec44, 0xbc46904d, [true, false, false, true, false, false]],
    [0xffff0b86, 0xff510eb6, 0xffffffa0, 0x0000ab80, [false, false, true, false, true, false]],
    [0xffffd189, 0xffffc78f, 0xe30f0f13, 0x201077a1, [false, false, true, false, false, false]],
  ])('Rm %s, Rs %s, accumulator %s:%s', (rm, rs, low, high, expected) => {
    expect([
      multiplyCarry(rm, rs, 0),
      multiplyCarry(rm, rs, low),
      multiplyLongCarry(rm, rs, 0, 0, false),
      multiplyLongCarry(rm, rs, 0, 0, true),
      multiplyLongCarry(rm, rs, low, high, false),
      multiplyLongCarry(rm, rs, low, high, true),
    ]).toEqual(expected);
  });
});
