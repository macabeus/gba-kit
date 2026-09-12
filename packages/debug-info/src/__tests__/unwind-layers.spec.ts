/**
 * The layer sequence, against a machine made of nothing but the facts the walker
 * is allowed to ask for. Every frame here is produced by a layer whose inputs are
 * written down in the test, so what is asserted is which layer answered, what it
 * established, and — where it declined — that it said so instead of guessing.
 */
import { describe, expect, it } from 'vitest';

import { FrameTable } from '../dwarf/frame.js';
import type { CodeIsa, IsaMode } from '../symbols.js';
import { type MachineFacts, frameConfidence } from '../unwind/types.js';
import { unwindStack } from '../unwind/walker.js';

const NO_CFI = new FrameTable(undefined);
const IRQ = 0x12;
const SYS = 0x1f;
const STACK_TOP = 0x03008000;

/** A machine assembled from the facts the walker asks about, and nothing else. */
class World implements MachineFacts {
  readonly #bytes = new Map<number, number>();
  readonly #words = new Map<number, number>();
  readonly #functions: Array<{ lo: number; hi: number; isa: CodeIsa; named: boolean }> = [];
  readonly #mappings: Array<{ lo: number; hi: number; mode: IsaMode }> = [];
  readonly #executable: Array<[number, number]> = [];
  readonly #spsrs = new Map<number, number>();
  readonly #sps = new Map<number, number>();
  readonly #lrs = new Map<number, number>();
  mode = SYS;
  readonly codeFloor = 0x4000;
  readonly exceptionStub = { mode: IRQ, lrOffset: 20 };

  /** A function whose body is `units`, laid out at `lo` and named by the ELF. */
  fn(lo: number, units: number[], isa: CodeIsa = 'thumb'): this {
    const width = isa === 'arm' ? 4 : 2;
    units.forEach((u, i) => this.#unit(lo + i * width, u, width));
    this.#functions.push({ lo, hi: lo + units.length * width, isa, named: true });
    return this;
  }

  /** Rewrite one instruction of a function already laid down. */
  patch(at: number, unit: number, isa: CodeIsa = 'thumb'): this {
    this.#unit(at, unit, isa === 'arm' ? 4 : 2);
    return this;
  }

  #unit(at: number, value: number, width: number): void {
    for (let b = 0; b < width; b++) {
      this.#bytes.set(at + b, (value >>> (b * 8)) & 0xff);
    }
  }

  /**
   * A range the ELF's mapping symbols describe as `mode`, whatever the function
   * holding it is written in. The last range added wins, so a literal pool can be
   * laid inside the instruction-set region around it.
   */
  mapping(lo: number, hi: number, mode: IsaMode): this {
    this.#mappings.push({ lo, hi, mode });
    return this;
  }

  /** Code the ELF places in an executable section but names nothing in. */
  unnamedCode(lo: number, hi: number): this {
    this.#executable.push([lo, hi]);
    return this;
  }

  /** Words on the stack, from `at` upward. */
  stack(at: number, ...words: number[]): this {
    words.forEach((w, i) => this.#words.set(at + i * 4, w >>> 0));
    return this;
  }

  /** Every word in `[lo, hi)` reads as `word` — for driving the walk into a bound. */
  fill(lo: number, hi: number, word: number): this {
    for (let at = lo; at < hi; at += 4) {
      this.#words.set(at, word >>> 0);
    }
    return this;
  }

  /**
   * A real Thumb `bl` to `target` whose last byte ends just before
   * `returnAddress` — the instructions the chain test decodes, rather than an
   * answer handed to it.
   */
  call(returnAddress: number, target: number): this {
    const at = returnAddress - 4;
    const offset = target - (at + 4);
    this.#unit(at, 0xf000 | ((offset >> 12) & 0x7ff), 2);
    this.#unit(at + 2, 0xf800 | ((offset >> 1) & 0x7ff), 2);
    return this;
  }

  banked(mode: number, sp: number, lr = 0): this {
    this.#sps.set(mode, sp);
    this.#lrs.set(mode, lr);
    return this;
  }

  interruptedFrom(mode: number): this {
    this.mode = IRQ;
    this.#spsrs.set(IRQ, mode);
    return this;
  }

  read16(address: number): number | undefined {
    const lo = this.#bytes.get(address);
    const hi = this.#bytes.get(address + 1);
    return lo === undefined || hi === undefined ? undefined : lo | (hi << 8);
  }

  read32(address: number): number | undefined {
    const written = this.#words.get(address);
    if (written !== undefined) {
      return written;
    }
    const lo = this.read16(address);
    const hi = this.read16(address + 2);
    return lo === undefined || hi === undefined ? undefined : (lo | (hi << 16)) >>> 0;
  }

  isCodeRegion(address: number): boolean {
    return address >= 0x4000;
  }

  isExecutable(address: number): boolean {
    return (
      this.#executable.some(([lo, hi]) => address >= lo && address < hi) ||
      this.#functions.some((f) => address >= f.lo && address < f.hi)
    );
  }

  nameable(address: number): boolean {
    return this.#functions.some((f) => f.named && address >= f.lo && address < f.hi);
  }

  isaAt(address: number): IsaMode | null {
    const mapped = this.#mappings.filter((m) => address >= m.lo && address < m.hi).at(-1);
    return mapped?.mode ?? this.#functions.find((f) => address >= f.lo && address < f.hi)?.isa ?? null;
  }

  functionBounds(pc: number): { lo: number; hi: number } | null {
    const f = this.#functions.find((fn) => pc >= fn.lo && pc < fn.hi);
    return f ? { lo: f.lo, hi: f.hi } : null;
  }

  bankedSp(mode: number): number | undefined {
    return this.#sps.get(mode);
  }

  bankedLr(mode: number): number | undefined {
    return this.#lrs.get(mode);
  }

  spsr(mode: number): number | undefined {
    return this.#spsrs.get(mode);
  }

  stackBoundFor(): number {
    return STACK_TOP;
  }

  exceptionReturnBias(mode: number): number {
    return mode === IRQ ? -4 : 0;
  }
}

function registers(overrides: Record<number, number>): number[] {
  const r = new Array<number>(16).fill(0);
  for (const [k, v] of Object.entries(overrides)) {
    r[Number(k)] = v;
  }
  return r;
}

const PUSH_R4_LR = 0xb510;
const PUSH_LR = 0xb500;
const PUSH_R4_R6_LR = 0xb570;
const SUB_SP_12 = 0xb083;
const MOVS_R0_0 = 0x2000;
const BX_LR = 0x4770;
const MOV_SP_R7 = 0x46bd;
const BL_LO = 0xf000;
const BL_HI = 0xf800;
const POP_R4 = 0xbc10;
const POP_R0 = 0xbc01;
const BX_R0 = 0x4700;
const BX_R3 = 0x4718;
const BX_PC = 0x4778;
const THUMB_NOP = 0x46c0;
const POP_R4_PC = 0xbd10;
/** beq to the next instruction: a branch the replay cannot follow past */
const BEQ_NEXT = 0xd000;
/** ldr r3, [pc, #0] — a veneer loading the destination it branches through */
const LDR_R3_PC = 0x4b00;
/** ARM: stmdb sp!,{fp,lr} / ldmia sp!,{fp,lr} / bx lr / nop / stmdb sp!,{lr} / bl */
const ARM_PUSH_FP_LR = 0xe92d4800;
const ARM_POP_FP_LR = 0xe8bd4800;
const ARM_BX_LR = 0xe12fff1e;
const ARM_NOP = 0xe1a00000;
const ARM_PUSH_LR = 0xe92d4000;
const ARM_BL = 0xebfffffe;

describe('the layer sequence', () => {
  it('measures a three-deep chain from prologues where there is no call-frame information', () => {
    const w = new World()
      .fn(0x08000100, [PUSH_LR, BL_LO, BL_HI, MOVS_R0_0])
      .fn(0x08000200, [PUSH_R4_R6_LR, SUB_SP_12, BL_LO, BL_HI, MOVS_R0_0])
      .fn(0x08000300, [PUSH_R4_LR, MOVS_R0_0, MOVS_R0_0])
      .stack(0x03007e00, 0x00001234, 0x08000209) // the innermost frame: saved r4, then the return into 0x0800200
      .stack(0x03007e14, 0x00005678) // the middle frame's saved r4
      .stack(0x03007e20, 0x08000107) // the middle frame's saved lr: the return into 0x08000100
      .stack(0x03007e24, 0); // the outermost frame returns to 0

    const walk = unwindStack(0x08000304, registers({ 13: 0x03007e00, 14: 0x0badf00d }), w, NO_CFI);

    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'prologue', 'prologue']);
    expect(walk.frames.map((f) => f.pc)).toEqual([0x08000304, 0x08000208, 0x08000106]);
    // Each frame's own CFA, and each caller's sp being the callee's CFA.
    expect(walk.frames.map((f) => f.cfa)).toEqual([0x03007e08, 0x03007e24, 0x03007e28]);
    expect(walk.frames.map((f) => f.regs[13])).toEqual([0x03007e00, 0x03007e08, 0x03007e24]);
    expect(walk.end).toMatch(/saved return address reads 0/);
  });

  it('hands a caller the registers it saved, and nothing about the scratch ones', () => {
    const w = new World()
      .fn(0x08000200, [PUSH_R4_R6_LR, SUB_SP_12, BL_LO, BL_HI, MOVS_R0_0])
      .fn(0x08000300, [PUSH_R4_LR, MOVS_R0_0, MOVS_R0_0])
      .stack(0x03007e00, 0x00001234, 0x08000209)
      .stack(0x03007e20, 0);

    const walk = unwindStack(0x08000304, registers({ 1: 0xdead, 4: 0x99, 7: 0x77, 13: 0x03007e00 }), w, NO_CFI);

    const caller = walk.frames[1]!;
    // r4 came out of the slot the callee put it in, not out of the live register.
    expect(caller.regs[4]).toBe(0x00001234);
    // r7 was never saved, so the callee never clobbered it and the live value is the caller's.
    expect(caller.regs[7]).toBe(0x77);
    // AAPCS scratch: the callee's values are not the caller's, and are not offered as such.
    expect(caller.regs.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
    expect(caller.regs[12]).toBeUndefined();
  });

  it('trusts lr in a function that contains no call, at any address in it', () => {
    const w = new World().fn(0x08000400, [MOVS_R0_0, BX_LR]).fn(0x08000200, [PUSH_LR, MOVS_R0_0]).stack(0x03007e00, 0);
    const walk = unwindStack(0x08000400, registers({ 13: 0x03007e00, 14: 0x08000201 }), w, NO_CFI);
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'lr']);
    expect(walk.frames[1]!.pc).toBe(0x08000200);
  });

  it('refuses lr once the function has made a call, rather than naming what it already returned from', () => {
    // The klonoa shape: no saved return address, and lr holding the return of a
    // call this function made — a frame that names a function that has come back.
    const w = new World()
      .fn(0x08000500, [0xb082, BL_LO, BL_HI, MOVS_R0_0, 0xb002, BX_LR])
      .fn(0x08005cf4, [PUSH_LR, MOVS_R0_0]);
    const walk = unwindStack(0x08000506, registers({ 13: 0x03007e00, 14: 0x08005d05 }), w, NO_CFI);
    expect(walk.frames).toHaveLength(1);
    expect(walk.end).toMatch(/saves no return address and lr has been overwritten/);
  });

  it('ends the walk when a saved return address does not point at code the ELF accounts for', () => {
    const w = new World().fn(0x08000300, [PUSH_R4_LR, MOVS_R0_0]).stack(0x03007e04, 0x03000104);
    const walk = unwindStack(0x08000302, registers({ 13: 0x03007e00 }), w, NO_CFI);
    expect(walk.frames).toHaveLength(1);
    expect(walk.end).toMatch(/0x03000104.*no executable section, is named by nothing/);
  });

  it('keeps a frame whose code the ELF places but does not name, and says what is missing', () => {
    // crt0's `bl main` returns into a NOTYPE symbol of size 0; dropping that frame
    // loses the bottom of every stack, so the missing name is a caveat, not a veto.
    const w = new World()
      .fn(0x08000300, [PUSH_R4_LR, MOVS_R0_0])
      .unnamedCode(0x08000180, 0x080001c0)
      .stack(0x03007e04, 0x08000187);
    const walk = unwindStack(0x08000302, registers({ 13: 0x03007e00 }), w, NO_CFI);
    expect(walk.frames).toHaveLength(2);
    expect(walk.frames[1]!.pc).toBe(0x08000186);
    expect(walk.frames[1]!.doubt).toMatch(/no sized symbol or DWARF entry covers the code at 0x08000186/);
  });

  it('measures the frame as gone at the last instruction of an agbcc return, and takes the caller from r0', () => {
    // `pop {r4}; pop {r0}; bx r0` is how an agbcc function exits, and at the `bx`
    // the pops are behind the pc: nothing is left to undo, so the CFA is sp itself
    // and r0 is the return address. Replaying the prologue here would report the
    // frame the function entered with, which is a frame that no longer exists.
    const w = new World()
      .fn(0x08000600, [PUSH_R4_LR, MOVS_R0_0, POP_R4, POP_R0, BX_R0])
      .fn(0x08000700, [PUSH_LR, BL_LO, BL_HI, MOVS_R0_0])
      .call(0x08000706, 0x08000600)
      .stack(0x03007e00, 0);
    const walk = unwindStack(0x08000608, registers({ 0: 0x08000707, 13: 0x03007e00, 14: 0x08000603 }), w, NO_CFI);
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'prologue']);
    expect(walk.frames.map((f) => f.pc)).toEqual([0x08000608, 0x08000706]);
    expect(walk.frames[0]!.cfa).toBe(0x03007e00);
    expect(walk.frames[1]!.doubt).toMatch(/measured in the function epilogue/);
  });

  it("takes a veneer's caller from lr, not from the register its `bx` branches through", () => {
    // The same instruction with no pop behind it is not a return at all: r3 is
    // where the call is going, and a veneer's own caller is the bl that reached it.
    const w = new World()
      .fn(0x08000640, [BX_R3])
      .fn(0x08000700, [PUSH_LR, BL_LO, BL_HI, MOVS_R0_0])
      .call(0x08000706, 0x08000640)
      .stack(0x03007e00, 0);
    const walk = unwindStack(0x08000640, registers({ 3: 0x08000701, 13: 0x03007e00, 14: 0x08000707 }), w, NO_CFI);
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'lr']);
    expect(walk.frames[1]!.pc).toBe(0x08000706);
  });

  it("reads an ARM epilogue's return address from the slot still to be popped, not from the lr it holds", () => {
    // `pop {fp, lr}; bx lr` is the devkitARM ARM exit. At the pop, the lr the
    // machine holds is the return of a call this function already made — a frame
    // that has come back — while the caller is in the slot two words up.
    const w = new World()
      .fn(0x08000800, [ARM_PUSH_FP_LR, ARM_NOP, ARM_POP_FP_LR, ARM_BX_LR], 'arm')
      .fn(0x08000900, [ARM_PUSH_LR, ARM_BL, ARM_NOP], 'arm')
      .stack(0x03007e00, 0x0000dada, 0x08000908)
      .stack(0x03007e08, 0);
    const walk = unwindStack(0x08000808, registers({ 13: 0x03007e00, 14: 0x08000804 }), w, NO_CFI);
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'prologue']);
    expect(walk.frames.map((f) => f.pc)).toEqual([0x08000808, 0x08000908]);
    expect(walk.frames[1]!.regs[11]).toBe(0x0000dada);
  });

  it("measures a caller's frame at the return address, not between the halves of the call", () => {
    // A caller's lines and scopes are looked up at ra - 2, inside the call — but that
    // is the second halfword of a 4-byte `bl`, and half an instruction measures
    // nothing: the teardown the return address stands on reads as a call there, and
    // the replay that would answer instead cannot get past `mov sp, r7`.
    const w = new World()
      .fn(0x08000300, [PUSH_R4_LR, MOVS_R0_0, MOVS_R0_0])
      .fn(0x08000200, [PUSH_R4_LR, MOV_SP_R7, BL_LO, BL_HI, POP_R4_PC])
      .fn(0x08000100, [PUSH_LR, BL_LO, BL_HI, MOVS_R0_0])
      .stack(0x03007e00, 0x00001234, 0x08000209) // the callee's frame: saved r4, then the return into the caller
      .stack(0x03007e08, 0x00005678, 0x08000107); // the caller's frame: saved r4, then the return above it
    const walk = unwindStack(0x08000302, registers({ 13: 0x03007e00, 14: 0x0badf00d }), w, NO_CFI);
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'prologue', 'prologue']);
    expect(walk.frames.map((f) => f.pc)).toEqual([0x08000302, 0x08000208, 0x08000106]);
    // Said of the frame the teardown measurement produced, which is how the caller's
    // own frame is known to have been measured at the pop and not at the `bl`.
    expect(walk.frames[2]!.doubt).toMatch(/measured in the function epilogue/);
    expect(walk.frames[1]!.cfa).toBe(0x03007e10);
  });

  it('offers lr, flagged, where a call into this function ends at it', () => {
    // Nothing proves lr here: the pc is past a branch the replay could not follow,
    // and the function contains a call, so lr could be that call's return. What
    // corroborates it is a `bl` into this very function ending exactly at it — the
    // same test a stack word has to pass, and the frame says lr was not proved.
    const w = new World()
      .fn(0x08000400, [BEQ_NEXT, BL_LO, BL_HI, MOVS_R0_0])
      .fn(0x08000500, [PUSH_LR, BL_LO, BL_HI, MOVS_R0_0])
      .call(0x08000506, 0x08000400);
    const walk = unwindStack(0x08000402, registers({ 13: 0x03007e00, 14: 0x08000507 }), w, NO_CFI);
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'lr-corroborated']);
    expect(walk.frames[1]!.pc).toBe(0x08000506);
    expect(frameConfidence(walk.frames[1]!.method)).toBe('inferred');
    expect(walk.frames[1]!.doubt).toMatch(/lr was not proved intact/);
  });

  it('reads a veneer in the instruction set each half of it is written in', () => {
    // A Thumb→ARM veneer switches instruction set in its middle with `bx pc`, so
    // reading the whole function as its entry's encoding decodes the ARM half as
    // Thumb halfwords — and the garbage that comes out refuses the measurement. A
    // trampoline builds no frame and never touches lr, which is visible in it.
    const w = new World()
      .fn(0x08006000, [BX_PC, THUMB_NOP, 0, 0, 0, 0, 0, 0])
      .patch(0x08006004, 0xe59fc000, 'arm') // ldr ip, [pc, #0]
      .patch(0x08006008, 0xe12fff1c, 'arm') // bx ip
      .mapping(0x08006004, 0x08006010, 'arm')
      .mapping(0x0800600c, 0x08006010, 'data') // the literal the veneer branches through
      .fn(0x08000100, [PUSH_LR, BL_LO, BL_HI, MOVS_R0_0])
      .call(0x08000106, 0x08006000);
    const walk = unwindStack(0x08006004, registers({ 13: 0x03007e00, 14: 0x08000107 }), w, NO_CFI);
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'lr']);
    expect(walk.frames[1]!.pc).toBe(0x08000106);
    expect(walk.frames[1]!.regs[13]).toBe(0x03007e00);
  });

  it('stops rather than reporting a frame inside its own function over an unmoved stack pointer', () => {
    // What a loop of the function's own making does to lr: the `bl` in the loop body
    // leaves lr pointing a few halfwords ahead, in this very function, and a leaf's
    // frame size of zero means the "caller" would stand on the same stack pointer.
    const w = new World().fn(0x08000900, [MOVS_R0_0, MOVS_R0_0, MOVS_R0_0, BX_LR]);
    const walk = unwindStack(0x08000902, registers({ 13: 0x03007e00, 14: 0x08000905 }), w, NO_CFI);
    expect(walk.frames.map((f) => f.pc)).toEqual([0x08000902]);
    expect(walk.end).toMatch(/inside this frame's own function/);
  });

  it('reports a truncation rather than walking a corrupted stack forever', () => {
    const w = new World()
      .fn(0x08000800, [PUSH_LR, MOVS_R0_0, MOVS_R0_0, MOVS_R0_0, BX_LR])
      .fill(0x03007000, STACK_TOP, 0x08000807);
    const walk = unwindStack(0x08000804, registers({ 13: 0x03007000 }), w, NO_CFI);
    expect(walk.frames).toHaveLength(256);
    expect(walk.end).toMatch(/truncated at 256 frames/);
  });

  it('stops at a frame whose stack pointer is the top of the stack, rather than asking what called it', () => {
    // The entry point of a program is such a frame, and what the layers would report
    // there is whatever they could not decode about hand-written assembly.
    const w = new World()
      .fn(0x08000800, [PUSH_LR, MOVS_R0_0, MOVS_R0_0, MOVS_R0_0, BX_LR])
      .fill(0x03007fc0, 0x03008040, 0x08000807);
    const walk = unwindStack(0x08000804, registers({ 13: 0x03007ff0 }), w, NO_CFI);
    expect(walk.end).toMatch(/stack pointer is at the top of its stack/);
    expect(walk.frames).toHaveLength(5);
  });

  it('stops when a frame address steps over the top of the stack instead of landing on it', () => {
    const w = new World()
      .fn(0x08000800, [PUSH_R4_LR, MOVS_R0_0, MOVS_R0_0, BX_LR])
      .fill(0x03007fc0, 0x03008040, 0x08000807);
    const walk = unwindStack(0x08000804, registers({ 13: 0x03007ffc }), w, NO_CFI);
    expect(walk.end).toMatch(/top of its region/);
    expect(walk.frames).toHaveLength(1);
  });
});

describe('the exception boundary', () => {
  /**
   * A handler reached through the BIOS stub: it returns to 0x90, the stub's own
   * return path, and what it interrupted is in the pushed block, the SPSR and the
   * interrupted mode's banked stack pointer.
   */
  function interruptedWorld(): World {
    return new World()
      .fn(0x08001000, [PUSH_LR, MOVS_R0_0, MOVS_R0_0])
      .fn(0x08002080, [PUSH_R4_LR, ...new Array<number>(15).fill(MOVS_R0_0)])
      .fn(0x08002100, [PUSH_LR, BL_LO, BL_HI, MOVS_R0_0])
      .stack(0x03007f80, 0x00000090) // the handler's saved lr: the stub's return path
      .stack(0x03007f88, 0xa0, 0xa1, 0xa2, 0xa3, 0xac, 0x080020a2) // the stub's pushed r0-r3, r12, lr
      .stack(0x03007ef0, 0x00004444, 0x08002105, 0) // the interrupted frame: saved r4, its caller, then the root
      .banked(IRQ, 0x03007f88)
      .banked(SYS, 0x03007ef0, 0x08002105)
      .interruptedFrom(SYS);
  }

  it('crosses from the handler into the code it interrupted, through the stub it returns to', () => {
    const walk = unwindStack(0x08001004, registers({ 13: 0x03007f80 }), interruptedWorld(), NO_CFI);
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'exception', 'exception', 'prologue']);
    expect(walk.frames.map((f) => f.pc)).toEqual([0x08001004, 0x90, 0x0800209e, 0x08002104]);
    // The interrupted pc is the next instruction, not a return address, so it is
    // looked up as itself: backing it into a call would report the previous line.
    expect(walk.frames[2]!.lookupPc).toBe(0x0800209e);
    // The interrupted code's own stack, not the handler's.
    expect(walk.frames[2]!.regs[13]).toBe(0x03007ef0);
    expect(walk.frames[2]!.regs[0]).toBe(0xa0);
    expect(walk.frames[2]!.regs[12]).toBe(0xac);
    expect(walk.frames[2]!.regs[4]).toBeUndefined();
    expect(walk.frames[2]!.doubt).toMatch(/r4–r11 were not recovered across the interrupt/);
    // And the frame above it reads its saved registers off that stack.
    expect(walk.frames[3]!.regs[4]).toBe(0x00004444);
  });

  it('crosses from inside the stub before it has pushed, through the lr that holds the interrupted address', () => {
    // At the vector the stub has pushed nothing, so there is no block to read and
    // its own lr is the only record of what the interrupt struck. Once it has
    // called the handler that lr is its own return path, a BIOS address, which is
    // why following it can land nowhere but in the interrupted code.
    const w = interruptedWorld().banked(IRQ, 0x03007fa0, 0x080020a2);
    const walk = unwindStack(0x18, registers({ 13: 0x03007fa0 }), w, NO_CFI);
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'exception', 'prologue']);
    expect(walk.frames[1]!.pc).toBe(0x0800209e);
    expect(walk.frames[1]!.regs[13]).toBe(0x03007ef0);
    expect(walk.frames[1]!.doubt).toMatch(/had not pushed its block yet/);
    expect(walk.frames[2]!.pc).toBe(0x08002104);
  });

  it('stops rather than crossing the same boundary twice, which is a loop and not a nesting', () => {
    // The interrupted frame's own saved return address is a BIOS address too, so
    // following it reads the one pushed block again and arrives where it already is.
    const w = interruptedWorld().stack(0x03007ef4, 0x00000090);
    const walk = unwindStack(0x08001004, registers({ 13: 0x03007f80 }), w, NO_CFI);
    expect(walk.frames.map((f) => f.pc)).toEqual([0x08001004, 0x90, 0x0800209e]);
    expect(walk.end).toMatch(/the same interrupt boundary was crossed twice/);
  });

  it('emits no stub frame when the boundary it would cross cannot be read', () => {
    // A word below the program looks exactly like a stub address whether it is one
    // or is stale, so nothing is reported until the crossing itself reads.
    const w = new World()
      .fn(0x08001000, [PUSH_LR, MOVS_R0_0, MOVS_R0_0])
      .stack(0x03007f80, 0x00000090)
      .banked(IRQ, 0x03007f88)
      .interruptedFrom(SYS);
    const walk = unwindStack(0x08001004, registers({ 13: 0x03007f80 }), w, NO_CFI);
    expect(walk.frames.map((f) => f.method)).toEqual(['live']);
    expect(walk.end).toMatch(/0x00000090.*is below the program.*no pushed stub frame matched/);
  });
});

describe('the scan layer', () => {
  /** A frame the prologue decoder refuses (sp is set from a register), with a stack to search. */
  function scannable(): World {
    return new World()
      .fn(0x08003000, [PUSH_LR, MOV_SP_R7, MOVS_R0_0])
      .fn(0x08004000, new Array<number>(16).fill(MOVS_R0_0))
      .fn(0x08005000, new Array<number>(16).fill(MOVS_R0_0));
  }

  it('is not reached while a derived layer can answer', () => {
    const w = scannable().fn(0x08003100, [PUSH_R4_LR, MOVS_R0_0]).stack(0x03006004, 0x08003001);
    const walk = unwindStack(0x08003102, registers({ 13: 0x03006000 }), w, NO_CFI, { scan: true });
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'prologue']);
  });

  it('skips a word no call precedes and one whose instruction set disagrees', () => {
    const w = scannable().stack(0x03006000, 0, 0x08004000, 0x08004010, 0x08004011).call(0x08004010, 0x08003000); // a real call, to the function being unwound
    const walk = unwindStack(0x08003004, registers({ 13: 0x03006000 }), w, NO_CFI, { scan: true });
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'scan']);
    // 0x08004000 has no call before it; 0x08004010 is even where the ELF says Thumb,
    // so it is a word that happens to look like the right address rather than one.
    expect(walk.frames[1]!.pc).toBe(0x08004010);
    expect(walk.frames[1]!.regs[13]).toBe(0x03006010);
    expect(walk.frames[1]!.doubt).toMatch(/inferred from a stack word/);
  });

  it('reports a return address whose call went elsewhere as an ancestor, saying frames are missing', () => {
    // A real call ends at the word and the ELF gives the code a sized name, so the
    // frame is on this stack — but the call went into another function, so whatever
    // called the frame below is one of the frames no layer could recover.
    const w = scannable().stack(0x03006000, 0, 0x08004009).call(0x08004008, 0x08005000); // a real call, but not to the function being unwound
    const walk = unwindStack(0x08003004, registers({ 13: 0x03006000 }), w, NO_CFI, { scan: true });
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'scan']);
    expect(walk.frames[1]!.pc).toBe(0x08004008);
    expect(walk.frames[1]!.doubt).toMatch(
      /nothing shows it called the frame below, so frames between the two are missing/,
    );
  });

  it('follows a veneer to see whether the call behind a word reaches the frame below', () => {
    // On a Thumb ROM calling into ARM code most calls go through a trampoline, so a
    // chain test that gave up at one would be doing nothing at all. The veneer holds
    // its destination in a literal, which is readable.
    const w = scannable()
      .fn(0x08004600, [LDR_R3_PC, BX_R3])
      .stack(0x08004604, 0x08003001) // the veneer's literal: the function being unwound
      .stack(0x03006000, 0, 0x08004011)
      .call(0x08004010, 0x08004600);
    const walk = unwindStack(0x08003004, registers({ 13: 0x03006000 }), w, NO_CFI, { scan: true });
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'scan']);
    expect(walk.frames[1]!.pc).toBe(0x08004010);
    expect(walk.frames[1]!.doubt).toMatch(/reaches the frame below through an interworking veneer/);
  });

  it('skips a word that repeats the frame below rather than counting one activation twice', () => {
    // The word the frame below was itself found at would otherwise be accepted a
    // second time, one frame further out, as that activation counted twice.
    const w = new World()
      .fn(0x08003000, [PUSH_LR, MOV_SP_R7, BL_LO, BL_HI, MOVS_R0_0])
      .fn(0x08004000, new Array<number>(16).fill(MOVS_R0_0))
      .call(0x08004010, 0x08003000)
      .stack(0x03006000, 0x08003009, 0x08004011);
    const walk = unwindStack(0x08003008, registers({ 13: 0x03006000 }), w, NO_CFI, { scan: true });
    expect(walk.frames.map((f) => f.method)).toEqual(['live', 'scan']);
    expect(walk.frames[1]!.pc).toBe(0x08004010);
  });

  it('invents nothing from a word in code no sized symbol covers, and says the stack was searched', () => {
    // The weakest evidence there is — a real call ends at the word, and nothing else
    // ties it to this stack — is not enough on code the ELF only places in an
    // executable section. A discarded symbol will happily name such an address, and
    // crt0's own `bl main` returns into one.
    const w = scannable()
      .unnamedCode(0x08006000, 0x08006040)
      .stack(0x03007f00, 0, 0x08006009, 0x08006009)
      .call(0x08006008, 0x08005000);
    const walk = unwindStack(0x08003004, registers({ 13: 0x03007f00 }), w, NO_CFI, { scan: true });
    expect(walk.frames).toHaveLength(1);
    expect(walk.end).toMatch(/no stack word was credible as a return address/);
  });

  it('stops searching short of a stack region it cannot see the end of, and says how far it looked', () => {
    // A stack in EWRAM is a quarter of a megabyte of candidate words, every one of
    // them a bus read and three lookups; a frame that deep into a search is not
    // going to name its caller, and the walk says where it gave up instead.
    const w = scannable().stack(0x03006000, 0);
    const walk = unwindStack(0x08003004, registers({ 13: 0x03006000 }), w, NO_CFI, { scan: true });
    expect(walk.frames).toHaveLength(1);
    expect(walk.end).toMatch(/no stack word in the 512 above this frame was credible/);
  });

  it('refuses in place of the scan layer when scanning is off', () => {
    const w = scannable().stack(0x03006000, 0, 0x08004011).call(0x08004010, 0x08003000);
    const walk = unwindStack(0x08003004, registers({ 13: 0x03006000 }), w, NO_CFI, { scan: false });
    expect(walk.frames).toHaveLength(1);
    expect(walk.end).toMatch(/the stack was not searched/);
  });
});
