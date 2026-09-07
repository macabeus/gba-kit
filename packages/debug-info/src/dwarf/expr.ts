/**
 * DWARF expression evaluator — the subset GCC (2.95 through 15) emits for ARM
 * variable locations and frame bases. Anything else yields an 'optimized-out'
 * location with the reason, never a wrong value.
 */
import { Cursor } from '../reader.js';
import { DW_OP } from './constants.js';

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
  /** Little-endian unsigned read of `size` bytes, or undefined when unmapped. */
  readMem(address: number, size: number): number | undefined;
  frameBase(): number | undefined;
  cfa(): number | undefined;
}

export function evaluate(expr: Uint8Array, ctx: EvalContext): Location {
  const c = new Cursor(expr, 0, true);
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
      if (op >= DW_OP.lit0 && op <= DW_OP.lit31) {
        stack.push(op - DW_OP.lit0);
        continue;
      }
      if (op >= DW_OP.reg0 && op <= DW_OP.reg31) {
        current = { kind: 'register', reg: op - DW_OP.reg0 };
        continue;
      }
      if (op >= DW_OP.breg0 && op <= DW_OP.breg31) {
        const off = c.sleb();
        const r = ctx.reg(op - DW_OP.breg0);
        if (r === undefined) {
          return optOut(`r${op - DW_OP.breg0} not recoverable`);
        }
        stack.push((r + off) >>> 0);
        continue;
      }
      switch (op) {
        case DW_OP.addr:
          stack.push(c.u32());
          break;
        case DW_OP.deref: {
          const v = ctx.readMem(pop(), 4);
          if (v === undefined) {
            return optOut('deref of unmapped address');
          }
          stack.push(v >>> 0);
          break;
        }
        case DW_OP.deref_size: {
          const size = c.u8();
          const v = ctx.readMem(pop(), size);
          if (v === undefined) {
            return optOut('deref of unmapped address');
          }
          stack.push(v >>> 0);
          break;
        }
        case DW_OP.const1u:
          stack.push(c.u8());
          break;
        case DW_OP.const1s:
          stack.push(c.s8());
          break;
        case DW_OP.const2u:
          stack.push(c.u16());
          break;
        case DW_OP.const2s:
          stack.push(c.s16());
          break;
        case DW_OP.const4u:
          stack.push(c.u32());
          break;
        case DW_OP.const4s:
          stack.push(c.s32());
          break;
        case DW_OP.const8u:
        case DW_OP.const8s:
          stack.push(c.u64());
          break;
        case DW_OP.constu:
          stack.push(c.uleb());
          break;
        case DW_OP.consts:
          stack.push(c.sleb());
          break;
        case DW_OP.dup:
          stack.push(stack[stack.length - 1] ?? pop());
          break;
        case DW_OP.drop:
          pop();
          break;
        case DW_OP.over: {
          const v = stack[stack.length - 2];
          if (v === undefined) {
            throw new Error('DWARF stack underflow');
          }
          stack.push(v);
          break;
        }
        case DW_OP.pick: {
          const v = stack[stack.length - 1 - c.u8()];
          if (v === undefined) {
            throw new Error('DWARF stack underflow');
          }
          stack.push(v);
          break;
        }
        case DW_OP.swap: {
          const a = pop();
          const b = pop();
          stack.push(a, b);
          break;
        }
        case DW_OP.rot: {
          const a = pop();
          const b = pop();
          const d = pop();
          stack.push(a, d, b);
          break;
        }
        case DW_OP.abs:
          stack.push(Math.abs(pop() | 0));
          break;
        case DW_OP.neg:
          stack.push(-(pop() | 0) >>> 0);
          break;
        case DW_OP.not:
          stack.push(~pop() >>> 0);
          break;
        case DW_OP.plus_uconst:
          stack.push((pop() + c.uleb()) >>> 0);
          break;
        case DW_OP.and:
        case DW_OP.div:
        case DW_OP.minus:
        case DW_OP.mod:
        case DW_OP.mul:
        case DW_OP.or:
        case DW_OP.plus:
        case DW_OP.shl:
        case DW_OP.shr:
        case DW_OP.shra:
        case DW_OP.xor:
        case DW_OP.eq:
        case DW_OP.ge:
        case DW_OP.gt:
        case DW_OP.le:
        case DW_OP.lt:
        case DW_OP.ne: {
          const b = pop();
          const a = pop();
          stack.push(binary(op, a, b));
          break;
        }
        case DW_OP.skip: {
          const off = c.s16();
          c.offset += off;
          break;
        }
        case DW_OP.bra: {
          const off = c.s16();
          if (pop() !== 0) {
            c.offset += off;
          }
          break;
        }
        case DW_OP.regx:
          current = { kind: 'register', reg: c.uleb() };
          break;
        case DW_OP.fbreg: {
          const off = c.sleb();
          const fb = ctx.frameBase();
          if (fb === undefined) {
            return optOut('frame base not recoverable');
          }
          stack.push((fb + off) >>> 0);
          break;
        }
        case DW_OP.bregx: {
          const reg = c.uleb();
          const off = c.sleb();
          const r = ctx.reg(reg);
          if (r === undefined) {
            return optOut(`r${reg} not recoverable`);
          }
          stack.push((r + off) >>> 0);
          break;
        }
        case DW_OP.call_frame_cfa: {
          const cfa = ctx.cfa();
          if (cfa === undefined) {
            return optOut('no call frame information for this pc');
          }
          stack.push(cfa);
          break;
        }
        case DW_OP.stack_value:
          current = { kind: 'value', value: pop() >>> 0 };
          break;
        case DW_OP.implicit_value:
          current = { kind: 'implicit', bytes: c.take(c.uleb()) };
          break;
        case DW_OP.piece: {
          const size = c.uleb();
          const loc: Location =
            current ?? (stack.length > 0 ? { kind: 'memory', address: pop() } : optOut('empty piece'));
          pieces.push({ loc, size });
          current = null;
          break;
        }
        case DW_OP.bit_piece:
          return optOut('bit pieces');
        case DW_OP.nop:
          break;
        case DW_OP.entry_value:
        case DW_OP.GNU_entry_value:
          return optOut('value only known at function entry');
        case DW_OP.implicit_pointer:
        case DW_OP.GNU_implicit_pointer:
          return optOut('implicit pointer');
        case DW_OP.addrx:
        case DW_OP.constx:
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
    case DW_OP.and:
      return (a & b) >>> 0;
    case DW_OP.div:
      return b === 0 ? 0 : ((a | 0) / (b | 0)) | 0;
    case DW_OP.minus:
      return (a - b) >>> 0;
    case DW_OP.mod:
      return b === 0 ? 0 : (a % b) >>> 0;
    case DW_OP.mul:
      return Math.imul(a, b) >>> 0;
    case DW_OP.or:
      return (a | b) >>> 0;
    case DW_OP.plus:
      return (a + b) >>> 0;
    case DW_OP.shl:
      return (a << b) >>> 0;
    case DW_OP.shr:
      return a >>> b;
    case DW_OP.shra:
      return ((a | 0) >> b) >>> 0;
    case DW_OP.xor:
      return (a ^ b) >>> 0;
    case DW_OP.eq:
      return a === b ? 1 : 0;
    case DW_OP.ge:
      return (a | 0) >= (b | 0) ? 1 : 0;
    case DW_OP.gt:
      return (a | 0) > (b | 0) ? 1 : 0;
    case DW_OP.le:
      return (a | 0) <= (b | 0) ? 1 : 0;
    case DW_OP.lt:
      return (a | 0) < (b | 0) ? 1 : 0;
    case DW_OP.ne:
      return a !== b ? 1 : 0;
    default:
      return 0;
  }
}
