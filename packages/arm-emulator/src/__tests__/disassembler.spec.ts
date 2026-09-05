import { describe, expect, it } from 'vitest';

import { disassembleArmAt, disassembleThumb, disassembleThumbAt } from '../disassembler.js';

/** A halfword reader over a little-endian byte image based at `base`. */
function halfwords(base: number, words: number[]): (address: number) => number {
  return (address) => words[(address - base) >>> 1] ?? 0;
}

describe('disassembleThumbAt', () => {
  it('presents a bl prefix/suffix pair as one 4-byte call with its target', () => {
    // 0x08000100: bl 0x08000a20 → offset = 0x08000a20 - (0x08000100 + 4) = 0x91c
    //   prefix f000 | (0x91c >> 12) = 0xf000, suffix f800 | ((0x91c >> 1) & 0x7ff) = 0xf c8e
    const read = halfwords(0x08000100, [0xf000, 0xfc8e, 0x4770]);
    expect(disassembleThumbAt(read, 0x08000100)).toEqual({ text: 'bl 0x08000a20', size: 4, target: 0x08000a20 });
    expect(disassembleThumbAt(read, 0x08000104)).toEqual({ text: 'bx lr', size: 2 });
  });

  it('handles a backward bl', () => {
    // 0x08001000: bl 0x08000ffc → offset = -8 → high = -1 (0xfff), low = (-8 - (-4096)) >> 1
    const target = 0x08000ffc;
    const offset = target - (0x08001000 + 4);
    const high = (offset >> 12) & 0x7ff;
    const low = (offset >> 1) & 0x7ff;
    const read = halfwords(0x08001000, [0xf000 | high, 0xf800 | low]);
    expect(disassembleThumbAt(read, 0x08001000).target).toBe(target);
  });

  it('a lone prefix (no suffix after it) is still shown as the raw half', () => {
    const read = halfwords(0x08000000, [0xf000, 0x4770]);
    expect(disassembleThumbAt(read, 0x08000000)).toEqual({ text: disassembleThumb(0xf000, 0x08000000), size: 2 });
  });

  it('symbolizes branch targets and literal-pool words', () => {
    const symbolize = (a: number): string | null => (a === 0x08000a20 ? 'UpdatePlayer' : a === 0x03001234 ? 'gState' : null);
    const call = halfwords(0x08000100, [0xf000, 0xfc8e]);
    expect(disassembleThumbAt(call, 0x08000100, { symbolize }).text).toBe('bl 0x08000a20 <UpdatePlayer>');
    // ldr r0, [pc, #0x8]: target = (0x08000000 + 4 & ~3) + 8 = 0x0800000c
    const ldr = halfwords(0x08000000, [0x4802]);
    const named = (a: number): string | null => (a === 0x0800000c ? 'lit_gState' : null);
    const out = disassembleThumbAt(ldr, 0x08000000, { symbolize: named });
    expect(out.target).toBe(0x0800000c);
    expect(out.text.endsWith('<lit_gState>')).toBe(true);
  });
});

describe('disassembleArmAt', () => {
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
