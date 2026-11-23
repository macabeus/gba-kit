import { describe, expect, it } from 'vitest';

import { disassembleArm, disassembleArmAt, disassembleThumb, disassembleThumbAt } from '../disassembler.js';

/** A halfword reader over `words`, the halfwords laid out from `base`. */
function halfwords(base: number, words: number[]): (address: number) => number {
  return (address) => words[(address - base) >>> 1] ?? 0;
}

describe('disassembleThumbAt', () => {
  it('presents a bl prefix/suffix pair as one 4-byte call with its target', () => {
    // 0x08000100: bl 0x08000a20 → offset = 0x08000a20 - (0x08000100 + 4) = 0x91c
    //   prefix f000 | (0x91c >> 12) = 0xf000, suffix f800 | ((0x91c >> 1) & 0x7ff) = 0xfc8e
    const read = halfwords(0x08000100, [0xf000, 0xfc8e, 0x4770]);
    expect(disassembleThumbAt(read, 0x08000100)).toEqual({ text: 'bl 0x08000a20', size: 4, target: 0x08000a20 });
    expect(disassembleThumbAt(read, 0x08000104)).toEqual({ text: 'bx lr', size: 2 });
  });

  it('a lone prefix (no suffix after it) is still shown as the raw half', () => {
    const read = halfwords(0x08000000, [0xf000, 0x4770]);
    expect(disassembleThumbAt(read, 0x08000000)).toEqual({ text: disassembleThumb(0xf000, 0x08000000), size: 2 });
  });

  it('symbolizes branch targets and literal-pool words', () => {
    const symbolize = (a: number): string | null =>
      a === 0x08000a20 ? 'UpdatePlayer' : a === 0x03001234 ? 'gState' : null;
    const call = halfwords(0x08000100, [0xf000, 0xfc8e]);
    expect(disassembleThumbAt(call, 0x08000100, { symbolize }).text).toBe('bl 0x08000a20 <UpdatePlayer>');
    // ldr r0, [pc, #0x8] reads the word at ((0x08000000 + 4) & ~3) + 8 = 0x0800000c, which holds 0x03001234
    const ldr = halfwords(0x08000000, [0x4802, 0, 0, 0, 0, 0, 0x1234, 0x0300]);
    expect(disassembleThumbAt(ldr, 0x08000000, { symbolize })).toEqual({
      text: 'ldr r0, 0x0800000c @ =0x03001234 <gState>',
      size: 2,
      target: 0x0800000c,
    });
    expect(disassembleThumbAt(ldr, 0x08000000).text).toBe('ldr r0, 0x0800000c @ =0x03001234');
  });
});

describe('disassembleArmAt', () => {
  it('shows the word a literal-pool load reads, and its name', () => {
    // 0x08000000: ldr r0, [pc, #16] reads the word at 0x08000018
    const read32 = (address: number): number =>
      address === 0x08000000 ? 0xe59f0010 : address === 0x08000018 ? 0x03001234 : 0;
    expect(disassembleArmAt(read32, 0x08000000, { symbolize: (a) => (a === 0x03001234 ? 'gState' : null) })).toEqual({
      text: 'ldr r0, 0x08000018 @ =0x03001234 <gState>',
      size: 4,
      target: 0x08000018,
    });
  });

  it('reads a word and symbolizes an ARM branch', () => {
    // 0x08000000: b 0x08000010 → offset = (0x10 - 8) / 4 = 2 → 0xea000002
    const read32 = (address: number): number => (address === 0x08000000 ? 0xea000002 : 0);
    expect(disassembleArmAt(read32, 0x08000000, { symbolize: (a) => (a === 0x08000010 ? 'main' : null) })).toEqual({
      text: 'b 0x08000010 <main>',
      size: 4,
      target: 0x08000010,
    });
  });
});

// The instruction text itself is @match-kit/isa's and is tested there. These cover what this module decides.
describe('disassembleThumb and disassembleArm', () => {
  it('name an address by its number', () => {
    expect(disassembleThumb(0x4802, 0x08001000)).toBe('ldr r0, 0x0800100c');
    expect(disassembleArm(0xea000002, 0x08000000)).toBe('b 0x08000010');
  });

  it('show an encoding that is no instruction as its bytes and what it is', () => {
    expect(disassembleThumb(0xde00, 0x08000000)).toBe('.inst.n 0xDE00 @ undefined');
    expect(disassembleThumbAt(() => 0xde00, 0x08000000)).toEqual({ text: '.inst.n 0xDE00 @ undefined', size: 2 });
  });

  it('print an instruction GNU as would encode another way, since a listing is not reassembled', () => {
    // adds r0, r0, #1 in its 3-bit immediate form; as picks the 8-bit one for this text.
    expect(disassembleThumb(0x1c40, 0x08000000)).toBe('adds r0, r0, #1');
  });
});
