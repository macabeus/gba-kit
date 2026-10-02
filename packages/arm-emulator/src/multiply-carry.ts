/**
 * ARM7TDMI multiply carry flag.
 *
 * A flag-setting multiply (MULS, MLAS, UMULLS, SMULLS, UMLALS, SMLALS and Thumb MUL) leaves in C
 * a bit of the multiplier's internal state. The ARM7TDMI multiplies with a radix-4 Booth array
 * that retires 8 multiplier bits per cycle into a carry-save adder, stops early once the remaining
 * multiplier bits are all zero (or, for a signed multiply, all ones), and adds the final sum and
 * carry vectors with the ALU. C is the barrel shifter's carry-out from that last addition, which
 * reads one bit of the carry vector.
 *
 * Research and algorithm: zaydlang and calc84maniac, "Solving the Mystery of ARM7TDMI Multiply
 * Carry Flag" (2024, https://bmchtech.github.io/post/multiply/), as implemented in NanoBoyAdvance
 * (src/nba/src/arm/handlers/arithmetic.inl: MultiplyCarrySimple, MultiplyCarryLo,
 * MultiplyCarryHi). The expected flags are hardware results from mgba-suite's multiply-long test.
 *
 * The functions below are a TypeScript port of that algorithm, altered from its original form:
 * translated to 32-bit JavaScript integer arithmetic. Its license follows.
 *
 *   Copyright (C) 2024 zaydlang, calc84maniac
 *
 *   This software is provided 'as-is', without any express or implied warranty. In no event will
 *   the authors be held liable for any damages arising from the use of this software.
 *
 *   Permission is granted to anyone to use this software for any purpose, including commercial
 *   applications, and to alter it and redistribute it freely, subject to the following
 *   restrictions:
 *
 *     1. The origin of this software must not be misrepresented; you must not claim that you
 *        wrote the original software. If you use this software in a product, an acknowledgment
 *        in the product documentation would be appreciated but is not required.
 *     2. Altered source versions must be plainly marked as such, and must not be misrepresented
 *        as being the original software.
 *     3. This notice may not be removed or altered from any source distribution.
 */

/**
 * Whether the multiplier runs all four 8-bit cycles. It stops after the cycle whose remaining
 * multiplier bits are all zero, or all ones for a signed multiply (MUL and MLA count as signed).
 */
function runsAllCycles(multiplier: number, signed: boolean): boolean {
  for (let shift = 8; shift < 32; shift += 8) {
    const rest = multiplier >> shift;
    if (rest === 0 || (signed && rest === -1)) {
      return false;
    }
  }
  return true;
}

/** Sign-extend the low `32 - shift` bits of `value`. */
function lowBitsSigned(value: number, shift: number): number {
  return (value << shift) >> shift;
}

/**
 * C after an early-terminated multiply: bit 31 of the carry-save carry vector. Each Booth step
 * adds one addend with a carry-save add; the sum vector is the XOR of the operands and the carry
 * vector is what the true total exceeds it by. Bit 0 of the multiplicand is forced on so that a
 * negated addend equals the bitwise inversion the hardware uses everywhere that can reach bit 31.
 */
function carryFromLowWord(multiplicand: number, multiplier: number, accumulator: number): boolean {
  const m = multiplicand | 1;
  let booth = lowBitsSigned(multiplier, 31);
  let carry = Math.imul(m, booth);
  let sum = (carry + accumulator) | 0;
  let partial = accumulator | 0;
  let shift = 29;
  do {
    for (let i = 0; i < 4; i++, shift -= 2) {
      const nextBooth = lowBitsSigned(multiplier, shift);
      const addend = Math.imul(m, (nextBooth - booth) | 0);
      booth = nextBooth;
      partial ^= carry ^ addend;
      sum = (sum + addend) | 0;
      carry = (sum - partial) | 0;
    }
  } while (booth !== (multiplier | 0));
  return carry >>> 31 === 1;
}

/**
 * C after a long multiply that ran all four cycles: bit 63 of the carry vector. Only the last
 * three Booth steps reach it, so the inputs are scaled down to keep bits 63..60 of the 64-bit
 * addends in bits 31..28, with constants standing in for the sign-extension the array performs.
 */
function carryFromHighWord(
  multiplicand: number,
  multiplier: number,
  accumulatorHigh: number,
  signed: boolean,
): boolean {
  let m = signed ? multiplicand >> 6 : multiplicand >>> 6;
  const r = signed ? multiplier >> 26 : multiplier >>> 26;
  m |= 1;
  const carry = ~accumulatorHigh & 0x20000000;
  let partial = (accumulatorHigh - 0x08000000) | 0;
  const booth0 = lowBitsSigned(r, 27);
  const booth1 = lowBitsSigned(r, 29);
  const booth2 = lowBitsSigned(r, 31);
  let addend = Math.imul(m, (booth1 - booth2) | 0);
  partial = (partial - (addend & 0x10000000)) | 0;
  addend = Math.imul(m, (booth0 - booth1) | 0);
  partial = (partial - (addend & 0x40000000)) | 0;
  let sum = (partial + (addend & 0x20000000)) | 0;
  partial = (partial - carry) | 0;
  addend = Math.imul(m, (r - booth0) | 0);
  sum = (sum + (addend & 0x40000000)) | 0;
  return (sum ^ partial) >>> 31 === 1;
}

/** C after MULS/MLAS (and Thumb MUL, which is MULS Rd, Rs, Rd): `multiplier` is Rs. */
export function multiplyCarry(multiplicand: number, multiplier: number, accumulator: number): boolean {
  if (runsAllCycles(multiplier, true)) {
    // The final Booth addend comes from multiplier bits 31..30 and is negative only for 0b10.
    return multiplier >>> 30 === 2;
  }
  return carryFromLowWord(multiplicand, multiplier, accumulator);
}

/** C after UMULLS/SMULLS/UMLALS/SMLALS: `multiplier` is Rs, the accumulator is RdHi:RdLo (0 for MULL). */
export function multiplyLongCarry(
  multiplicand: number,
  multiplier: number,
  accumulatorLow: number,
  accumulatorHigh: number,
  signed: boolean,
): boolean {
  if (runsAllCycles(multiplier, signed)) {
    return carryFromHighWord(multiplicand, multiplier, accumulatorHigh, signed);
  }
  return carryFromLowWord(multiplicand, multiplier, accumulatorLow);
}
