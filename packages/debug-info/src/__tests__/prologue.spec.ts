/**
 * The prologue decoder, on byte sequences taken from real toolchain output —
 * agbcc's multi-push prologue, newlib's park-r11-in-lr prologue, gcc's
 * literal-built frame — so the table is not a model of what a compiler might
 * emit but a record of what these ones do.
 */
import { describe, expect, it } from 'vitest';

import type { CodeIsa } from '../symbols.js';
import { measurePrologue } from '../unwind/prologue.js';
import type { CodeReader } from '../unwind/types.js';

const SPACE = 0x1000;

/** Code at address 0, as halfwords (Thumb) or words (ARM), plus literals placed by address. */
function code(units: number[], width: 2 | 4, literals: Record<number, number> = {}): CodeReader {
  const bytes = new Uint8Array(SPACE);
  const put = (at: number, value: number, size: number): void => {
    for (let i = 0; i < size; i++) {
      bytes[at + i] = (value >>> (i * 8)) & 0xff;
    }
  };
  units.forEach((u, i) => put(i * width, u, width));
  for (const [at, word] of Object.entries(literals)) {
    put(Number(at), word, 4);
  }
  const read = (at: number, size: number): number | undefined => {
    if (at < 0 || at + size > SPACE) {
      return undefined;
    }
    let v = 0;
    for (let i = size - 1; i >= 0; i--) {
      v = v * 256 + bytes[at + i]!;
    }
    return v >>> 0;
  };
  // The fixtures carry no mapping symbols, so every case states its own instruction
  // set and the decoder falls back to it, as it does on an agbcc ELF.
  return { read16: (at) => read(at, 2), read32: (at) => read(at, 4), isaAt: () => null };
}

interface Case {
  what: string;
  isa?: CodeIsa;
  units: number[];
  literals?: Record<number, number>;
  /** where to measure from; defaults to just past the last unit */
  pc?: number;
  /** how far the function extends; defaults to just past the last unit */
  end?: number;
  frameSize?: number;
  /** original register → offset from the CFA */
  saved?: Record<number, number>;
  /** the register holding the return address, or `'none'` when no live register does */
  raLive?: number | 'none';
  teardown?: boolean;
  refused?: RegExp;
}

const CASES: Case[] = [
  {
    what: 'the smallest Thumb frame: push {r4, lr}',
    units: [0xb510],
    frameSize: 8,
    saved: { 4: -8, 14: -4 },
  },
  {
    what: 'a high register copied into a low one and pushed is attributed to the high one',
    units: [0xb5f0, 0x4647, 0xb480, 0xb081], // push {r4-r7,lr}; mov r7,r8; push {r7}; sub sp,#4
    frameSize: 28,
    saved: { 4: -20, 5: -16, 6: -12, 7: -8, 8: -24, 14: -4 },
  },
  {
    what: "agbcc's three-register high-half save lands r8-r10 in the order the movs put them",
    units: [0xb5f0, 0x4657, 0x464e, 0x4645, 0xb4e0, 0xb08c],
    frameSize: 80,
    saved: { 4: -20, 5: -16, 6: -12, 7: -8, 8: -32, 9: -28, 10: -24, 14: -4 },
  },
  {
    what: 'r11 parked in lr and pushed does not displace the return address the first push wrote down',
    units: [0xb5f0, 0x46de, 0xb5e0], // push {r4-r7,lr}; mov lr,fp; push {r5,r6,r7,lr}
    frameSize: 36,
    saved: { 4: -20, 5: -16, 6: -12, 7: -8, 11: -24, 14: -4 },
    raLive: 'none',
  },
  {
    what: 'a frame too large for an immediate is measured through the literal it is built from',
    units: [0x4ca8, 0x44a5], // ldr r4,[pc,#672]; add sp,r4
    literals: { 676: 0xfffffd28 },
    frameSize: 728,
    saved: {},
  },
  {
    what: 'a varargs prologue pushes the argument registers below the saved ones',
    units: [0xb40f, 0xb530, 0xb083], // push {r0-r3}; push {r4,r5,lr}; sub sp,#12
    frameSize: 40,
    saved: { 0: -16, 1: -12, 2: -8, 3: -4, 4: -28, 5: -24, 14: -20 },
  },
  {
    what: 'an instruction the scheduler hoisted above the push is stepped over, not treated as the end',
    units: [0x2200, 0xb510], // movs r2,#0; push {r4,lr}
    frameSize: 8,
    saved: { 4: -8, 14: -4 },
  },
  {
    what: 'at the entry nothing is pushed yet and lr is the return address',
    units: [0xb510, 0x4770],
    pc: 0,
    frameSize: 0,
    saved: {},
    raLive: 14,
  },
  {
    what: 'mid-prologue the frame is as far along as the instructions that ran',
    units: [0xb5f0, 0x4647, 0xb480, 0xb081],
    pc: 2,
    frameSize: 20,
    saved: { 4: -20, 5: -16, 6: -12, 7: -8, 14: -4 },
    raLive: 14,
  },
  {
    // mmInitDefault's shape: the frame the call returns into is 32 bytes larger than
    // the one the prologue built, and a replay that stopped at the `bl` would hand
    // the caller a stack pointer 32 bytes low and read its return address from the
    // wrong word. Control comes back from a call, so the replay goes through it.
    what: 'stack arguments pushed after a call are part of the frame the call returns into',
    units: [0xb510, 0xf000, 0xf800, 0xb40f, 0xb083, 0x2000], // push {r4,lr}; bl; push {r0-r3}; sub sp,#12; movs
    pc: 10,
    frameSize: 36,
    // The call wrote the registers it passes arguments in, so the words pushed from
    // them afterwards hold nothing this can attribute to a caller's register — the
    // saved r4 and the saved lr, written before the call, still do.
    saved: { 4: -8, 14: -4 },
    raLive: 'none',
  },
  {
    // What the replay cannot follow, it does not measure around: past the branch the
    // instructions that ran are no longer the ones written down, and libgba's
    // memcpy32 pushes seven registers two instructions after its first one.
    what: 'a frame is not measured when sp moves between the last followable instruction and the pc',
    units: [0x2800, 0xd001, 0xb4f0, 0x2000], // cmp r0,#0; beq; push {r4-r7}; movs
    pc: 6,
    refused: /sp is moved between the last instruction that could be followed and the pc/,
  },
  {
    // m4a and hand-written agbcc assembly park the return address in ip and leave
    // through it. Both registers hold it while lr is intact, so the one the function
    // returns through is the one to report: only that copy survives the call.
    what: 'a return address parked in ip is read from ip once a call has overwritten lr',
    units: [0x46f4, 0xf000, 0xf800, 0x2000, 0x4760], // mov ip,lr; bl; movs r0,#0; bx ip
    pc: 8,
    frameSize: 0,
    saved: {},
    raLive: 12,
  },
  {
    what: 'a copy of lr the function never returns through leaves lr itself the return address',
    units: [0x46f4, 0x2000, 0x4770], // mov ip,lr; movs r0,#0; bx lr
    pc: 2,
    frameSize: 0,
    saved: {},
    raLive: 14,
  },
  {
    what: 'a leaf that never calls keeps lr at every address, including past a branch',
    units: [0xb082, 0x2800, 0xd001, 0x2000, 0xb002, 0x4770], // sub sp,#8; cmp; beq; movs; add sp,#8; bx lr
    pc: 6,
    frameSize: 8,
    saved: {},
    raLive: 14,
  },
  {
    what: 'the agbcc epilogue is measured from what is left to pop',
    units: [0xb003, 0xbcf0, 0xbc02, 0x4708], // add sp,#12; pop {r4-r7}; pop {r1}; bx r1
    pc: 0,
    frameSize: 32,
    saved: { 1: -4, 4: -20, 5: -16, 6: -12, 7: -8, 14: -4 },
    teardown: true,
  },
  {
    what: 'the same epilogue one instruction further in has released 12 bytes fewer',
    units: [0xb003, 0xbcf0, 0xbc02, 0x4708],
    pc: 2,
    frameSize: 20,
    saved: { 1: -4, 4: -20, 5: -16, 6: -12, 7: -8, 14: -4 },
    teardown: true,
  },
  {
    what: 'a pop straight into pc puts the return address in the slot it reads',
    units: [0xb003, 0xbdf0], // add sp,#12; pop {r4-r7,pc}
    pc: 0,
    frameSize: 32,
    saved: { 4: -20, 5: -16, 6: -12, 7: -8, 14: -4 },
    teardown: true,
  },
  {
    what: 'at the last instruction of that epilogue the frame is gone and r1 is the return address',
    // The pops that loaded r1 are behind the pc, so nothing is left to undo: the
    // CFA is sp itself, and replaying the prologue here would measure a frame the
    // machine has already taken apart.
    units: [0xb003, 0xbcf0, 0xbc02, 0x4708],
    pc: 6,
    frameSize: 0,
    saved: {},
    raLive: 1,
    teardown: true,
  },
  {
    what: 'an ARM epilogue still to pop lr reads the return address from that slot, not from the live lr',
    // `pop {fp, lr}; bx lr` — at the pop, the lr the machine holds is the return of
    // a call this function already made, and the slot two words up is the caller.
    isa: 'arm',
    units: [0xe8bd4800, 0xe12fff1e],
    pc: 0,
    frameSize: 8,
    saved: { 11: -8, 14: -4 },
    raLive: 'none',
    teardown: true,
  },
  {
    what: 'the same epilogue at its `bx lr`, where the pop has run and lr is the return address',
    isa: 'arm',
    units: [0xe8bd4800, 0xe12fff1e],
    pc: 4,
    frameSize: 0,
    saved: {},
    raLive: 14,
    teardown: true,
  },
  {
    what: 'a conditional return is walked through rather than taken as the end of the prologue',
    // libgba's dispatcher opens `cmp r0,#0; bxeq lr` and pushes four instructions
    // later; stopping at the conditional return measures no frame at all.
    isa: 'arm',
    units: [0xe3500000, 0x012fff1e, 0xe92d500f], // cmp r0,#0; bxeq lr; push {r0-r3,r12,lr}
    frameSize: 24,
    saved: { 0: -24, 1: -20, 2: -16, 3: -12, 12: -8, 14: -4 },
  },
  {
    what: 'the ARM interrupt-stub push of r0-r3, r12 and lr',
    isa: 'arm',
    units: [0xe92d500f],
    frameSize: 24,
    saved: { 0: -24, 1: -20, 2: -16, 3: -12, 12: -8, 14: -4 },
  },
  {
    what: 'an ARM frame built with an immediate',
    isa: 'arm',
    units: [0xe92d4010, 0xe24dd010], // stmdb sp!,{r4,lr}; sub sp,sp,#16
    frameSize: 24,
    saved: { 4: -8, 14: -4 },
  },
  {
    what: 'a conditional ARM push may or may not have run, so nothing is measured',
    isa: 'arm',
    units: [0x092d500f],
    refused: /conditional/,
  },
  {
    what: 'a frame pointer copied out of sp is not a reason to refuse: it is how a local is addressed',
    units: [0xb590, 0x466f, 0xb083], // push {r4,r7,lr}; mov r7,sp; sub sp,#12
    frameSize: 24,
    saved: { 4: -12, 7: -8, 14: -4 },
  },
  {
    what: 'sp set from a register is, because where sp went is then unknowable',
    units: [0xb500, 0x46bd], // push {lr}; mov sp,r7
    refused: /sp was set from a register/,
  },
  {
    what: 'the same in ARM, where a frame is torn down through the frame pointer',
    isa: 'arm',
    units: [0xe92d4810, 0xe28bd000], // stmdb sp!,{r4,r11,lr}; add sp,fp,#0
    refused: /sp was set from a register/,
  },
  {
    what: 'a stack allocated from a register that holds no literal is refused',
    units: [0xb500, 0x44ad], // push {lr}; add sp,r5
    refused: /r5, which holds no literal/,
  },
];

describe('measurePrologue', () => {
  it.each(CASES)('$what', (c) => {
    const isa = c.isa ?? 'thumb';
    const width = isa === 'arm' ? 4 : 2;
    const span = c.units.length * width;
    const result = measurePrologue(0, c.pc ?? span, c.end ?? span, isa, code(c.units, width, c.literals));
    if (c.refused) {
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toMatch(c.refused);
      return;
    }
    expect(result.ok ? null : result.reason).toBeNull();
    const frame = result.ok ? result.frame : null;
    expect(frame!.frameSize).toBe(c.frameSize);
    if (c.saved) {
      expect(Object.fromEntries(frame!.saved)).toEqual(c.saved);
    }
    if (c.raLive !== undefined) {
      expect(frame!.raLive).toBe(c.raLive === 'none' ? undefined : c.raLive);
    }
    expect(frame!.teardown).toBe(c.teardown === true);
  });

  it('refuses a pc outside the function it was looked up in', () => {
    expect(measurePrologue(0x100, 0x80, 0x200, 'thumb', code([0xb510], 2))).toEqual({
      ok: false,
      reason: 'the pc is outside the function it was looked up in',
    });
  });

  it('refuses when the code cannot be read', () => {
    const unreadable: CodeReader = { read16: () => undefined, read32: () => undefined, isaAt: () => null };
    expect(measurePrologue(0, 4, 8, 'thumb', unreadable)).toMatchObject({ ok: false });
  });
});
