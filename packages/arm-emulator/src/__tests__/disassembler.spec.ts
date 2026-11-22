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

  it('handles a backward bl', () => {
    // 0x08001000: bl 0x08000ffc → offset = -8 → high = 0x7ff (all sign bits), low = 0x7fc
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
    const symbolize = (a: number): string | null =>
      a === 0x08000a20 ? 'UpdatePlayer' : a === 0x03001234 ? 'gState' : null;
    const call = halfwords(0x08000100, [0xf000, 0xfc8e]);
    expect(disassembleThumbAt(call, 0x08000100, { symbolize }).text).toBe('bl 0x08000a20 <UpdatePlayer>');
    // ldr r0, [pc, #0x8]: target = ((0x08000000 + 4) & ~3) + 8 = 0x0800000c
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

describe('the text is from @match-kit/isa, which GNU as assembles back to the same bytes', () => {
  it('spells instructions in GNU as unified syntax', () => {
    expect(disassembleThumb(0xb5f0, 0x08000000)).toBe('push {r4, r5, r6, r7, lr}');
    expect(disassembleThumb(0x4802, 0x08001000)).toBe('ldr r0, 0x0800100c');
    expect(disassembleThumb(0x1c48, 0x08000000)).toBe('adds r0, r1, #1');
    expect(disassembleArm(0xe12fff1e, 0x08000000)).toBe('bx lr');
    expect(disassembleArm(0xe3a00301, 0x08000000)).toBe('mov r0, #0x4000000');
  });

  it('a Thumb ldmia whose base is in the list does not write the base back', () => {
    expect(disassembleThumb(0xc90e, 0x08000000)).toBe('ldmia r1, {r1, r2, r3}');
    expect(disassembleThumb(0xc90c, 0x08000000)).toBe('ldmia r1!, {r2, r3}');
  });

  it('a Thumb lsr or asr by 0 shifts by 32', () => {
    expect(disassembleThumb(0x0808, 0x08000000)).toBe('lsrs r0, r1, #0x20');
    expect(disassembleThumb(0x1008, 0x08000000)).toBe('asrs r0, r1, #0x20');
  });

  it('the undefined Thumb space 0xDExx is not a branch', () => {
    expect(disassembleThumb(0xde00, 0x08000000)).toBe('.inst.n 0xDE00 @ undefined');
    expect(disassembleThumbAt(() => 0xde00, 0x08000000)).toEqual({ text: '.inst.n 0xDE00 @ undefined', size: 2 });
  });

  it('an ARM post-indexed load or store with the W bit is the user-mode form', () => {
    expect(disassembleArm(0xe4b10004, 0x08000000)).toBe('ldrt r0, [r1], #4');
    expect(disassembleArm(0xe4e10004, 0x08000000)).toBe('strbt r0, [r1], #4');
  });

  it('prints an instruction GNU as would encode another way, since a listing is not reassembled', () => {
    // adds r0, r0, #1 in its 3-bit immediate form; as picks the 8-bit one for this text.
    expect(disassembleThumb(0x1c40, 0x08000000)).toBe('adds r0, r0, #1');
  });
});
