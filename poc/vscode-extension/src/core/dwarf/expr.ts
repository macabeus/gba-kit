/**
 * DWARF expression evaluator — the subset GCC (2.95 through 15) emits for ARM
 * variable locations and frame bases. Anything else yields an 'optimized-out'
 * location with the reason, never a wrong value.
 */
import { Cursor } from './parse.js';

export type Location =
  | { kind: 'memory'; address: number }
  | { kind: 'register'; reg: number }
  | { kind: 'value'; value: number }
  | { kind: 'implicit'; bytes: Uint8Array }
  | { kind: 'composite'; pieces: Array<{ loc: Location; size: number }> }
  | { kind: 'optimized-out'; reason: string };

export interface EvalContext {
  /** Register value in this frame, or undefined when not recoverable. */
  reg(n: number): number | undefined;
  readMem(address: number, size: number): number | undefined;
  frameBase(): number | undefined;
  cfa(): number | undefined;
}

const OP = {
  addr: 0x03,
  deref: 0x06,
  const1u: 0x08,
  const1s: 0x09,
  const2u: 0x0a,
  const2s: 0x0b,
  const4u: 0x0c,
  const4s: 0x0d,
  const8u: 0x0e,
  const8s: 0x0f,
  constu: 0x10,
  consts: 0x11,
  dup: 0x12,
  drop: 0x13,
  over: 0x14,
  pick: 0x15,
  swap: 0x16,
  rot: 0x17,
  abs: 0x19,
  and: 0x1a,
  div: 0x1b,
  minus: 0x1c,
  mod: 0x1d,
  mul: 0x1e,
  neg: 0x1f,
  not: 0x20,
  or: 0x21,
  plus: 0x22,
  plus_uconst: 0x23,
  shl: 0x24,
  shr: 0x25,
  shra: 0x26,
  xor: 0x27,
  bra: 0x28,
  eq: 0x29,
  ge: 0x2a,
  gt: 0x2b,
  le: 0x2c,
  lt: 0x2d,
  ne: 0x2e,
  skip: 0x2f,
  lit0: 0x30,
  lit31: 0x4f,
  reg0: 0x50,
  reg31: 0x6f,
  breg0: 0x70,
  breg31: 0x8f,
  regx: 0x90,
  fbreg: 0x91,
  bregx: 0x92,
  piece: 0x93,
  deref_size: 0x94,
  nop: 0x96,
  call_frame_cfa: 0x9c,
  bit_piece: 0x9d,
  implicit_value: 0x9e,
  stack_value: 0x9f,
  implicit_pointer: 0xa0,
  addrx: 0xa1,
  constx: 0xa2,
  entry_value: 0xa3,
  GNU_push_tls_address: 0xe0,
  GNU_entry_value: 0xf3,
  GNU_implicit_pointer: 0xf2,
  GNU_parameter_ref: 0xfa,
} as const;

export function evaluate(expr: Uint8Array, ctx: EvalContext): Location {
  const c = new Cursor(expr);
  const stack: number[] = [];
  const pieces: Array<{ loc: Location; size: number }> = [];
  let current: Location | null = null; // register/implicit location awaiting a piece or the end
  const optOut = (reason: string): Location => ({ kind: 'optimized-out', reason });
  const pop = (): number => {
    const v = stack.pop();
    if (v === undefined) {
      throw new Error('DWARF stack underflow');
    }
    return v;
  };
  try {
    while (!c.eof) {
      const op = c.u8();
      if (op >= OP.lit0 && op <= OP.lit31) {
        stack.push(op - OP.lit0);
        continue;
      }
      if (op >= OP.reg0 && op <= OP.reg31) {
        current = { kind: 'register', reg: op - OP.reg0 };
        continue;
      }
      if (op >= OP.breg0 && op <= OP.breg31) {
        const off = c.sleb();
        const r = ctx.reg(op - OP.breg0);
        if (r === undefined) {
          return optOut(`r${op - OP.breg0} not recoverable`);
        }
        stack.push((r + off) >>> 0);
        continue;
      }
      switch (op) {
        case OP.addr:
          stack.push(c.u32());
          break;
        case OP.deref: {
          const v = ctx.readMem(pop(), 4);
          if (v === undefined) {
            return optOut('deref of unmapped address');
          }
          stack.push(v >>> 0);
          break;
        }
        case OP.deref_size: {
          const size = c.u8();
          const v = ctx.readMem(pop(), size);
          if (v === undefined) {
            return optOut('deref of unmapped address');
          }
          stack.push(v >>> 0);
          break;
        }
        case OP.const1u:
          stack.push(c.u8());
          break;
        case OP.const1s:
          stack.push(c.s8());
          break;
        case OP.const2u:
          stack.push(c.u16());
          break;
        case OP.const2s:
          stack.push(c.s16());
          break;
        case OP.const4u:
          stack.push(c.u32());
          break;
        case OP.const4s:
          stack.push(c.s32());
          break;
        case OP.const8u:
        case OP.const8s:
          stack.push(c.u64());
          break;
        case OP.constu:
          stack.push(c.uleb());
          break;
        case OP.consts:
          stack.push(c.sleb());
          break;
        case OP.dup:
          stack.push(stack[stack.length - 1]!);
          break;
        case OP.drop:
          pop();
          break;
        case OP.over:
          stack.push(stack[stack.length - 2]!);
          break;
        case OP.pick:
          stack.push(stack[stack.length - 1 - c.u8()]!);
          break;
        case OP.swap: {
          const a = pop();
          const b = pop();
          stack.push(a, b);
          break;
        }
        case OP.rot: {
          const a = pop();
          const b = pop();
          const d = pop();
          stack.push(a, d, b);
          break;
        }
        case OP.abs:
          stack.push(Math.abs(pop() | 0));
          break;
        case OP.neg:
          stack.push(-(pop() | 0) >>> 0);
          break;
        case OP.not:
          stack.push(~pop() >>> 0);
          break;
        case OP.plus_uconst:
          stack.push((pop() + c.uleb()) >>> 0);
          break;
        case OP.and:
        case OP.div:
        case OP.minus:
        case OP.mod:
        case OP.mul:
        case OP.or:
        case OP.plus:
        case OP.shl:
        case OP.shr:
        case OP.shra:
        case OP.xor:
        case OP.eq:
        case OP.ge:
        case OP.gt:
        case OP.le:
        case OP.lt:
        case OP.ne: {
          const b = pop();
          const a = pop();
          stack.push(binary(op, a, b));
          break;
        }
        case OP.skip: {
          const off = c.s16();
          c.offset += off;
          break;
        }
        case OP.bra: {
          const off = c.s16();
          if (pop() !== 0) {
            c.offset += off;
          }
          break;
        }
        case OP.regx:
          current = { kind: 'register', reg: c.uleb() };
          break;
        case OP.fbreg: {
          const off = c.sleb();
          const fb = ctx.frameBase();
          if (fb === undefined) {
            return optOut('frame base not recoverable');
          }
          stack.push((fb + off) >>> 0);
          break;
        }
        case OP.bregx: {
          const reg = c.uleb();
          const off = c.sleb();
          const r = ctx.reg(reg);
          if (r === undefined) {
            return optOut(`r${reg} not recoverable`);
          }
          stack.push((r + off) >>> 0);
          break;
        }
        case OP.call_frame_cfa: {
          const cfa = ctx.cfa();
          if (cfa === undefined) {
            return optOut('no call frame information for this pc');
          }
          stack.push(cfa);
          break;
        }
        case OP.stack_value:
          current = { kind: 'value', value: pop() >>> 0 };
          break;
        case OP.implicit_value: {
          const len = c.uleb();
          current = { kind: 'implicit', bytes: c.take(len) };
          break;
        }
        case OP.piece: {
          const size = c.uleb();
          const loc: Location =
            current ?? (stack.length > 0 ? { kind: 'memory', address: pop() } : optOut('empty piece'));
          pieces.push({ loc, size });
          current = null;
          break;
        }
        case OP.bit_piece:
          return optOut('bit pieces');
        case OP.nop:
          break;
        case OP.entry_value:
        case OP.GNU_entry_value:
          return optOut('value only known at function entry');
        case OP.implicit_pointer:
        case OP.GNU_implicit_pointer:
          return optOut('implicit pointer');
        case OP.addrx:
        case OP.constx:
          return optOut('addrx/constx');
        default:
          return optOut(`DW_OP 0x${op.toString(16)}`);
      }
    }
  } catch (err) {
    return optOut((err as Error).message);
  }
  if (pieces.length > 0) {
    if (current) {
      pieces.push({ loc: current, size: 0 });
    }
    return { kind: 'composite', pieces };
  }
  if (current) {
    return current;
  }
  if (stack.length > 0) {
    return { kind: 'memory', address: stack[stack.length - 1]! >>> 0 };
  }
  return optOut('empty expression');
}

function binary(op: number, a: number, b: number): number {
  switch (op) {
    case OP.and:
      return (a & b) >>> 0;
    case OP.div:
      return b === 0 ? 0 : ((a | 0) / (b | 0)) | 0;
    case OP.minus:
      return (a - b) >>> 0;
    case OP.mod:
      return b === 0 ? 0 : (a % b) >>> 0;
    case OP.mul:
      return Math.imul(a, b) >>> 0;
    case OP.or:
      return (a | b) >>> 0;
    case OP.plus:
      return (a + b) >>> 0;
    case OP.shl:
      return (a << b) >>> 0;
    case OP.shr:
      return a >>> b;
    case OP.shra:
      return ((a | 0) >> b) >>> 0;
    case OP.xor:
      return (a ^ b) >>> 0;
    case OP.eq:
      return a === b ? 1 : 0;
    case OP.ge:
      return (a | 0) >= (b | 0) ? 1 : 0;
    case OP.gt:
      return (a | 0) > (b | 0) ? 1 : 0;
    case OP.le:
      return (a | 0) <= (b | 0) ? 1 : 0;
    case OP.lt:
      return (a | 0) < (b | 0) ? 1 : 0;
    case OP.ne:
      return a !== b ? 1 : 0;
    default:
      return 0;
  }
}
