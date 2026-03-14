/**
 * ARM7TDMI Thumb Emulator - Bit manipulation and ALU utilities
 *
 * Key TypeScript/JS numeric patterns for 32-bit ARM emulation:
 * - `| 0` truncates to signed 32-bit (like C's int32_t)
 * - `>>> 0` reinterprets as unsigned 32-bit
 * - `Math.imul(a, b)` for correct 32-bit multiply (regular * loses precision above 2^53)
 * - `>>` is arithmetic right shift (sign-extending), `>>>` is logical right shift
 */
import type { AluResult } from './types.js';

/** Extract bits [hi:lo] from a value (inclusive) */
export function bits(value: number, hi: number, lo: number): number {
  return (value >>> lo) & ((1 << (hi - lo + 1)) - 1);
}

/** Extract a single bit */
export function bit(value: number, pos: number): number {
  return (value >>> pos) & 1;
}

/** Sign-extend a value from `bitWidth` bits to 32 bits */
export function signExtend(value: number, bitWidth: number): number {
  const shift = 32 - bitWidth;
  return (value << shift) >> shift;
}

/** Check if bit 31 is set (negative in signed interpretation) */
export function isNegative(value: number): boolean {
  return (value & 0x80000000) !== 0;
}

/**
 * Add two 32-bit values with full flag computation.
 * Returns the result and NZCV flags.
 */
export function addWithFlags(a: number, b: number, carryIn: number = 0): AluResult {
  // Use unsigned interpretation for carry detection
  const ua = a >>> 0;
  const ub = b >>> 0;
  const result = (ua + ub + carryIn) | 0;
  const uresult = result >>> 0;

  // Carry: unsigned overflow
  // We need to detect if ua + ub + carryIn > 0xFFFFFFFF
  // Since JS numbers have enough precision for this sum:
  const fullSum = ua + ub + carryIn;
  const c = fullSum > 0xffffffff;

  // Overflow: signed overflow
  // Positive + Positive = Negative, or Negative + Negative = Positive
  const v = ((a ^ result) & (b ^ result) & 0x80000000) !== 0;

  return {
    value: result,
    n: (uresult & 0x80000000) !== 0,
    z: uresult === 0,
    c,
    v,
  };
}

/**
 * Subtract two 32-bit values with full flag computation.
 * Computes a - b (with optional borrow).
 *
 * ARM subtraction uses inverted carry: C=1 means no borrow.
 * SUB is implemented as ADD(a, ~b, 1).
 */
export function subWithFlags(a: number, b: number, carryIn: number = 1): AluResult {
  // SUB a, b = ADD a, NOT(b), carry
  // For plain SUB: carry = 1 (no borrow)
  // For SBC: carry = CPSR.C (borrow flag)
  const notB = ~b;
  return addWithFlags(a, notB, carryIn);
}

/**
 * Logical shift left. Returns [result, carryOut].
 * If amount is 0, carry is unchanged (returns oldCarry).
 */
export function lsl(value: number, amount: number, oldCarry: boolean): [number, boolean] {
  if (amount === 0) {
    return [value, oldCarry];
  }
  if (amount >= 32) {
    return [0, amount === 32 ? (value & 1) !== 0 : false];
  }
  const carry = ((value >>> (32 - amount)) & 1) !== 0;
  return [(value << amount) | 0, carry];
}

/**
 * Logical shift right. Returns [result, carryOut].
 * amount=0 encodes LSR #32 in Thumb Format 1.
 */
export function lsr(
  value: number,
  amount: number,
  oldCarry: boolean,
  immZeroMeans32: boolean = false,
): [number, boolean] {
  if (amount === 0) {
    if (immZeroMeans32) {
      // LSR #0 in format 1 means LSR #32
      return [0, isNegative(value)];
    }
    return [value, oldCarry];
  }
  if (amount >= 32) {
    return [0, amount === 32 ? isNegative(value) : false];
  }
  const carry = ((value >>> (amount - 1)) & 1) !== 0;
  return [value >>> amount, carry];
}

/**
 * Arithmetic shift right. Returns [result, carryOut].
 * amount=0 encodes ASR #32 in Thumb Format 1.
 */
export function asr(
  value: number,
  amount: number,
  oldCarry: boolean,
  immZeroMeans32: boolean = false,
): [number, boolean] {
  if (amount === 0) {
    if (immZeroMeans32) {
      // ASR #0 in format 1 means ASR #32
      const carry = isNegative(value);
      return [carry ? 0xffffffff : 0, carry];
    }
    return [value, oldCarry];
  }
  if (amount >= 32) {
    const carry = isNegative(value);
    return [carry ? 0xffffffff : 0, carry];
  }
  const carry = ((value >> (amount - 1)) & 1) !== 0;
  return [value >> amount, carry];
}

/**
 * Rotate right. Returns [result, carryOut].
 */
export function ror(value: number, amount: number, oldCarry: boolean): [number, boolean] {
  if (amount === 0) {
    return [value, oldCarry];
  }
  const effectiveAmount = amount & 31;
  if (effectiveAmount === 0) {
    // Rotate by 32 = no-op, but carry = bit 31
    return [value, isNegative(value)];
  }
  const result = (value >>> effectiveAmount) | (value << (32 - effectiveAmount)) | 0;
  const carry = ((result >>> 31) & 1) !== 0;
  return [result, carry];
}
