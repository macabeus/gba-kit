/**
 * ARMv4T instructions as the unwinder needs them: what each one does to sp, lr and
 * the provenance of a register, and where a branch goes.
 *
 * This is the one place in this package that knows an encoding. It reports effects
 * rather than prose — a disassembler's strings would have to be parsed back — and
 * anything it does not recognise that could still move sp or lr is a refusal, so a
 * measurement built on it is either derived or absent.
 *
 * Every instruction is decoded as the instruction set the ELF records at *its*
 * address, because mapping symbols are per-address and a function can change
 * instruction set in its middle: an interworking veneer switches with `bx pc`
 * halfway through itself, and a literal pool between two branches is not
 * instructions at all.
 */
import type { CodeIsa } from '../symbols.js';
import type { CodeReader } from './types.js';

export type Effect =
  | { kind: 'clobber'; size: number; regs: number[] }
  | { kind: 'push'; size: number; regs: number[] }
  | { kind: 'pop'; size: number; regs: number[]; toPc: boolean }
  | { kind: 'sp-add'; size: number; delta: number }
  | { kind: 'sp-add-reg'; size: number; reg: number }
  | { kind: 'move'; size: number; to: number; from: number }
  | { kind: 'literal'; size: number; to: number; from: number }
  /** a return, `conditional` when it may not have fired at all */
  | { kind: 'return'; size: number; via: 'lr' | { reg: number }; conditional: boolean }
  /** `target` where the encoding names it; absent for a call through a register */
  | { kind: 'call'; size: number; target?: number }
  | { kind: 'branch'; size: number; target?: number }
  /** the ELF marks this address as data, so nothing here executes */
  | { kind: 'data'; size: number }
  /** sp was set from a register whose value this scan does not track; lr is untouched */
  | { kind: 'sp-unknown'; size: number }
  | { kind: 'refuse'; size: number; reason: string };

/** What the instruction at `at` does, read in the ELF's instruction set for that address. */
export function decode(at: number, isa: CodeIsa, code: CodeReader): Effect {
  const stated = code.isaAt(at);
  if (stated === 'data') {
    return { kind: 'data', size: 4 };
  }
  const use = stated ?? isa;
  return use === 'thumb' ? decodeThumb(at, code) : decodeArm(at, code);
}

/** Registers of a `push`/`pop` bitmask, ascending — the order in which they occupy ascending addresses. */
function listOf(mask: number, extra: number | null): number[] {
  const regs: number[] = [];
  for (let r = 0; r < 8; r++) {
    if (mask & (1 << r)) {
      regs.push(r);
    }
  }
  if (extra !== null) {
    regs.push(extra);
  }
  return regs;
}

/** The halfword pair of a Thumb `bl`: its high half, then a low half that is the BL suffix. */
function thumbCallTarget(at: number, high: number, code: CodeReader): number | undefined {
  const low = code.read16((at + 2) >>> 0);
  return low === undefined || (low & 0xf800) !== 0xf800
    ? undefined
    : (at + 4 + ((signExtend(high & 0x7ff, 11) << 12) | ((low & 0x7ff) << 1))) >>> 0;
}

function decodeThumb(at: number, code: CodeReader): Effect {
  const h = code.read16(at);
  if (h === undefined) {
    return { kind: 'refuse', size: 2, reason: 'the code at this address is unreadable' };
  }
  if ((h & 0xfe00) === 0xb400) {
    return { kind: 'push', size: 2, regs: listOf(h & 0xff, h & 0x0100 ? 14 : null) };
  }
  if ((h & 0xfe00) === 0xbc00) {
    const toPc = (h & 0x0100) !== 0;
    return { kind: 'pop', size: 2, regs: listOf(h & 0xff, toPc ? 15 : null), toPc };
  }
  if ((h & 0xff80) === 0xb000) {
    return { kind: 'sp-add', size: 2, delta: (h & 0x7f) * 4 };
  }
  if ((h & 0xff80) === 0xb080) {
    return { kind: 'sp-add', size: 2, delta: -(h & 0x7f) * 4 };
  }
  // ldr rD, [pc, #imm8*4] — the literal a frame too large for `sub sp, #imm` is built from
  if ((h & 0xf800) === 0x4800) {
    return { kind: 'literal', size: 2, to: (h >> 8) & 7, from: (((at + 4) & ~3) + (h & 0xff) * 4) >>> 0 };
  }
  if ((h & 0xfc00) === 0x4400) {
    const op = (h >> 8) & 3;
    const rm = (((h >> 6) & 1) << 3) | ((h >> 3) & 7);
    const rd = (((h >> 7) & 1) << 3) | (h & 7);
    if (op === 3) {
      return (h & 0x0080) !== 0
        ? { kind: 'call', size: 2 }
        : { kind: 'return', size: 2, via: rm === 14 ? 'lr' : { reg: rm }, conditional: false };
    }
    if (op === 1) {
      return { kind: 'clobber', size: 2, regs: [] }; // cmp
    }
    if (rd === 15) {
      return { kind: 'branch', size: 2 };
    }
    if (rd === 13) {
      return op === 0 ? { kind: 'sp-add-reg', size: 2, reg: rm } : { kind: 'sp-unknown', size: 2 };
    }
    return op === 2 ? { kind: 'move', size: 2, to: rd, from: rm } : { kind: 'clobber', size: 2, regs: [rd] };
  }
  if ((h & 0xf000) === 0xd000) {
    // a conditional branch, or the swi in the 0xdf slot — both end the prologue
    return { kind: 'branch', size: 2 };
  }
  if ((h & 0xf800) === 0xe000) {
    return { kind: 'branch', size: 2, target: (at + 4 + (signExtend(h & 0x7ff, 11) << 1)) >>> 0 };
  }
  if ((h & 0xe000) === 0xe000) {
    // the bl halfword pair, and the blx suffix
    return (h & 0xf800) === 0xf000
      ? { kind: 'call', size: 4, target: thumbCallTarget(at, h, code) }
      : { kind: 'call', size: 2 };
  }
  if ((h & 0xf000) === 0xb000) {
    // The rest of the miscellaneous block is undefined on ARMv4T, and it is the one
    // place left where an encoding this scan does not know could move sp.
    return { kind: 'refuse', size: 2, reason: 'an unrecognised instruction that could move sp' };
  }
  // Everything left is Thumb-1 data processing or a load/store, which provably
  // cannot write sp, lr or pc, so the replay steps over it. Its destination is
  // over-approximated: losing provenance costs a saved slot, inventing one costs a
  // wrong value.
  return { kind: 'clobber', size: 2, regs: thumbDestinations(h) };
}

function thumbDestinations(h: number): number[] {
  return (h & 0xf000) === 0xc000
    ? listOf(h & 0xff, (h >> 8) & 7) // ldmia/stmia rN!, {list}
    : [h & 7, (h >> 8) & 7];
}

const ARM_COND_AL = 0xe;
const ARM_MOV = 0xd;
const ARM_SUB = 0x2;
const ARM_ADD = 0x4;

function decodeArm(at: number, code: CodeReader): Effect {
  const w = code.read32(at);
  if (w === undefined) {
    return { kind: 'refuse', size: 4, reason: 'the code at this address is unreadable' };
  }
  const conditional = w >>> 28 !== ARM_COND_AL;
  const rn = (w >>> 16) & 0xf;
  const rd = (w >>> 12) & 0xf;
  const rm = w & 0xf;
  /** A conditional instruction that could matter may or may not have run: nothing can be measured through it. */
  const unlessConditional = (effect: Effect): Effect =>
    conditional ? { kind: 'refuse', size: 4, reason: 'a conditional instruction may or may not have run' } : effect;

  if ((w & 0x0f000000) === 0x0f000000) {
    return { kind: 'branch', size: 4 }; // swi: its return address banks in svc mode, not here
  }
  switch ((w >>> 25) & 0x7) {
    case 0x5: {
      const target = (at + 8 + (signExtend(w & 0x00ffffff, 24) << 2)) >>> 0;
      return { kind: (w & 0x01000000) !== 0 ? 'call' : 'branch', size: 4, target };
    }
    case 0x6:
    case 0x7:
      return { kind: 'refuse', size: 4, reason: 'a coprocessor instruction, which this scan does not model' };
    case 0x4: {
      const list = w & 0xffff;
      const load = (w & 0x00100000) !== 0;
      if (rn !== 13 && (list & 0x8000) === 0) {
        return { kind: 'clobber', size: 4, regs: load ? registersIn(list) : [] };
      }
      const regs = registersIn(list);
      const writeback = (w & 0x00200000) !== 0;
      const increasing = (w & 0x00800000) !== 0;
      if (load && writeback && increasing) {
        return unlessConditional({ kind: 'pop', size: 4, regs, toPc: (list & 0x8000) !== 0 });
      }
      if (!load && writeback && !increasing) {
        return unlessConditional({ kind: 'push', size: 4, regs });
      }
      return { kind: 'refuse', size: 4, reason: 'an unrecognised block transfer touching sp or pc' };
    }
    case 0x2:
    case 0x3: {
      const load = (w & 0x00100000) !== 0;
      const preIndexed = (w & 0x01000000) !== 0;
      const writeback = (w & 0x00200000) !== 0 || !preIndexed;
      if (load && rn === 15 && preIndexed && (w & 0x02000000) === 0 && rd < 13) {
        const offset = w & 0xfff;
        return {
          kind: 'literal',
          size: 4,
          to: rd,
          from: (at + 8 + ((w & 0x00800000) !== 0 ? offset : -offset)) >>> 0,
        };
      }
      if (rd < 13 && !(rn === 13 && writeback)) {
        return { kind: 'clobber', size: 4, regs: load ? [rd] : [] };
      }
      const oneWord = rn === 13 && writeback && (w & 0x02400fff) === 0x00000004;
      if (oneWord && !load && preIndexed && (w & 0x00800000) === 0) {
        return unlessConditional({ kind: 'push', size: 4, regs: [rd] }); // str rD, [sp, #-4]!
      }
      if (oneWord && load && !preIndexed && (w & 0x00800000) !== 0) {
        return unlessConditional({ kind: 'pop', size: 4, regs: [rd], toPc: rd === 15 }); // ldr rD, [sp], #4
      }
      return { kind: 'refuse', size: 4, reason: 'an unrecognised transfer that could move sp, lr or pc' };
    }
    default: {
      if ((w & 0x0ffffff0) === 0x012fff10) {
        return { kind: 'return', size: 4, via: rm === 14 ? 'lr' : { reg: rm }, conditional };
      }
      if ((w & 0x0ffffff0) === 0x012fff30) {
        return { kind: 'call', size: 4 };
      }
      // multiply and swap: the destination register sits in the rn field
      if ((w & 0x0c0000f0) === 0x00000090) {
        return rn >= 13 || rd >= 13
          ? { kind: 'refuse', size: 4, reason: 'a multiply or swap writing sp, lr or pc' }
          : { kind: 'clobber', size: 4, regs: [rn, rd] };
      }
      const opcode = (w >>> 21) & 0xf;
      const registerForm = (w & 0x02000000) === 0 && (w & 0xff0) === 0;
      if (opcode >= 0x8 && opcode <= 0xb && (w & 0x00100000) !== 0) {
        // tst, teq, cmp and cmn set flags and write nothing, whatever sits in the
        // destination field — so a compare before the push costs no provenance.
        return { kind: 'clobber', size: 4, regs: [] };
      }
      if (rd < 13) {
        return { kind: 'clobber', size: 4, regs: [rd] };
      }
      const immediate = (w & 0x02000000) !== 0 ? rotatedImmediate(w) : null;
      if (rd === 13 && rn === 13 && immediate !== null && (opcode === ARM_ADD || opcode === ARM_SUB)) {
        return unlessConditional({ kind: 'sp-add', size: 4, delta: opcode === ARM_ADD ? immediate : -immediate });
      }
      if (rd === 13 && rn === 13 && opcode === ARM_ADD && registerForm) {
        return unlessConditional({ kind: 'sp-add-reg', size: 4, reg: rm });
      }
      if (opcode === ARM_MOV && registerForm) {
        if (rd === 14) {
          return unlessConditional({ kind: 'move', size: 4, to: 14, from: rm });
        }
        if (rd === 15) {
          return { kind: 'return', size: 4, via: rm === 14 ? 'lr' : { reg: rm }, conditional };
        }
      }
      if (rd === 13) {
        // sp set from a register: restored from a frame pointer (`add sp, fp, #0`),
        // or moved by an amount this scan cannot know. Copying sp *out* into a
        // register is the opposite case and harmless — it is how both compilers take
        // the address of a local, and refusing on it costs real frames.
        return { kind: 'sp-unknown', size: 4 };
      }
      return { kind: 'refuse', size: 4, reason: 'an unrecognised instruction that could move sp, lr or pc' };
    }
  }
}

function registersIn(list: number): number[] {
  const regs: number[] = [];
  for (let r = 0; r < 16; r++) {
    if (list & (1 << r)) {
      regs.push(r);
    }
  }
  return regs;
}

function rotatedImmediate(w: number): number {
  const rotate = ((w >>> 8) & 0xf) * 2;
  const value = w & 0xff;
  return rotate === 0 ? value : ((value >>> rotate) | (value << (32 - rotate))) >>> 0;
}

function signExtend(value: number, bits: number): number {
  const sign = 1 << (bits - 1);
  return (value & sign) !== 0 ? value - (sign << 1) : value;
}
