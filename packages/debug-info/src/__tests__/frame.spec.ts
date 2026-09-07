/**
 * Call-frame information on a hand-built `.debug_frame`: an unwind reports the
 * return address the rules establish, and nothing when they say there is none.
 */
import { describe, expect, it } from 'vitest';

import { FrameTable } from '../dwarf/frame.js';

const DW_CFA_undefined = 0x07;
const DW_CFA_def_cfa = 0x0c;
const DW_CFA_def_cfa_offset = 0x0e;
const DW_CFA_expression = 0x10;
const DW_CFA_offset = 0x80;
const DW_OP_reg0 = 0x50;

const LR = 14;
const SP = 13;
const FN_START = 0x08000000;
const FN_END = 0x08000100;
const LIVE_LR = 0x08001235;

/** A CIE (version 1, no augmentation, r14 returns, CFA = sp) and one FDE with `ops`. */
function section(ops: number[]): Uint8Array {
  const cieBody = [1, 0, 2, 0x7c, LR, DW_CFA_def_cfa, SP, 0]; // version, "", code_align 2, data_align -4, r14
  const cie = [...u32(cieBody.length + 4), ...u32(0xffffffff), ...cieBody];
  const fdeBody = [...u32(0), ...u32(FN_START), ...u32(FN_END - FN_START), ...ops];
  const fde = [...u32(fdeBody.length), ...fdeBody];
  return new Uint8Array([...cie, ...fde]);
}

function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

function unwind(ops: number[], readWord: (a: number) => number | undefined = () => undefined) {
  const regs = new Array<number | undefined>(16).fill(0);
  regs[SP] = 0x03007f00;
  regs[LR] = LIVE_LR;
  return new FrameTable(section(ops)).unwind(FN_START + 4, regs, readWord);
}

describe('FrameTable.unwind', () => {
  it('a leaf with no rule for lr returns through the live lr', () => {
    expect(unwind([])?.returnAddress).toBe(LIVE_LR);
  });

  it('lr marked undefined means there is no caller: nothing is invented from the live lr', () => {
    expect(unwind([DW_CFA_undefined, LR])).toBeNull();
  });

  it('an expression rule for lr is unsupported: no caller rather than a guessed one', () => {
    expect(unwind([DW_CFA_expression, LR, 1, DW_OP_reg0])).toBeNull();
  });

  it('a saved lr is read from the stack, and an unreadable slot yields no caller', () => {
    const ops = [DW_CFA_def_cfa_offset, 4, DW_CFA_offset | LR, 1]; // lr at cfa - 4
    expect(unwind(ops, (a) => (a === 0x03007f04 - 4 ? 0x08005679 : undefined))?.returnAddress).toBe(0x08005679);
    expect(unwind(ops, () => undefined)).toBeNull();
  });
});
