/**
 * ARM7TDMI HLE BIOS — High-Level Emulation of GBA BIOS calls
 *
 * The emulator ships no BIOS dump: most SWIs run here in TypeScript, at the SWI instruction. The
 * calls that steer the CPU itself (Halt, Stop, IntrWait, VBlankIntrWait, CustomHalt, SoftReset) run
 * as ARM code from the BIOS image (bios-image.ts), entered through the SWI exception.
 *
 * Each call reports the cycles the real BIOS code takes, so a call costs the time it does on
 * hardware: the dispatch and return every SWI goes through, plus the function's own code. Div,
 * Sqrt, ArcTan and CpuFastSet take mGBA's counts, which match hardware (src/gba/bios.c GBASwi16
 * and its stall counts; mgba-suite Timing). The other functions follow the real BIOS's own code:
 * their loops' instructions and memory accesses, and fixed costs measured from the real BIOS run
 * on this emulator's CPU.
 *
 * The functions follow the real BIOS's algorithms, fixed-point arithmetic and edge cases included,
 * and leave r0, r1 and r3 as it does wherever those hold a result or a pointer the call advanced.
 * They were checked against the real BIOS run instruction by instruction on this emulator's CPU,
 * and against mgba-suite "BIOS math".
 *
 * Reference: GBATEK - GBA BIOS Functions
 * http://problemkaputt.de/gbatek-gba-bios-functions.htm
 */
import type { MemoryBus } from '@gba-kit/arm-emulator';

import { runsInBiosCode } from './bios-image.js';
import { MMIO } from './types.js';

/**
 * Interface for the CPU that BIOS calls need access to.
 * Uses duck typing to avoid circular imports with ArmCpu.
 */
interface BiosCpu {
  readonly registers: Uint32Array;
  readonly memory: MemoryBus;
}

/**
 * Handle a Software Interrupt (SWI) call.
 *
 * On GBA, the SWI number is the comment field of the SWI instruction:
 * - Thumb: bits 7-0 of the instruction
 * - ARM: bits 23-16 of the instruction
 *
 * The caller is responsible for extracting the correct SWI number
 * before calling this function.
 *
 * @param cpu - The CPU instance
 * @param swiNumber - The SWI function number (0x00-0xFF)
 * @returns the cycles the BIOS spends from the SWI vector to its return branch, or null for a call
 *   the BIOS image runs as ARM code, which the CPU enters through the SWI exception: the calls that
 *   steer the CPU itself, and the inputs on which the real BIOS loops forever
 */
export function handleSwi(cpu: BiosCpu, swiNumber: number): number | null {
  if (runsInBiosCode(swiNumber)) {
    return null;
  }
  // Read before the call, which may change the registers.
  const dispatch = swiDispatchCycles(cpu);
  let cycles: number | null = 0;
  switch (swiNumber) {
    case 0x01:
      cycles = swiRegisterRamReset(cpu);
      break;
    case 0x06:
      cycles = swiDiv(cpu);
      break;
    case 0x07:
      cycles = swiDivArm(cpu);
      break;
    case 0x08:
      cycles = swiSqrt(cpu);
      break;
    case 0x09:
      cycles = swiArcTan(cpu);
      break;
    case 0x0a:
      cycles = swiArcTan2(cpu);
      break;
    case 0x0b:
      cycles = swiCpuSet(cpu);
      break;
    case 0x0c:
      cycles = swiCpuFastSet(cpu);
      break;
    case 0x0d:
      cycles = swiGetBiosChecksum(cpu);
      break;
    case 0x0e:
      cycles = swiBgAffineSet(cpu);
      break;
    case 0x0f:
      cycles = swiObjAffineSet(cpu);
      break;
    case 0x10:
      cycles = swiBitUnPack(cpu);
      break;
    case 0x11:
      cycles = lz77Decompress(cpu, false);
      break;
    case 0x12:
      cycles = lz77Decompress(cpu, true);
      break;
    case 0x13:
      cycles = swiHuffUnComp(cpu);
      break;
    case 0x14:
      cycles = rlDecompress(cpu, false);
      break;
    case 0x15:
      cycles = rlDecompress(cpu, true);
      break;
    case 0x16:
      cycles = swiDiffUnFilter(cpu, 1, false);
      break;
    case 0x17:
      cycles = swiDiffUnFilter(cpu, 1, true);
      break;
    case 0x18:
      cycles = swiDiffUnFilter(cpu, 2, false);
      break;
    case 0x19:
      cycles = swiSoundBias(cpu);
      break;
    case 0x1f:
      cycles = swiMidiKey2Freq(cpu);
      break;
    default:
      // The BIOS's own sound driver (0x1A-0x1E, 0x20-0x24, 0x28-0x2A), MultiBoot (0x25) and
      // HardReset (0x26) return at once here; m4a games carry their own copy of the driver.
      break;
  }
  return cycles === null ? null : dispatch + cycles;
}

/**
 * Whether the BIOS reads from `source`. Every function that reads a source refuses one whose
 * address bits 25-27 are all clear — the BIOS itself, and its mirrors — and returns at once,
 * writing no memory, which keeps the BIOS from being read out through it (mGBA bios.c "Cannot
 * CpuSet from BIOS"; checked on the real BIOS for 0x00000100, 0x01FFFFF0 and 0x10000100).
 */
function readableSource(source: number): boolean {
  return (source & 0x0e000000) !== 0;
}

/**
 * The BIOS's source check at 0xBA4: a non-zero length, and a source whose first byte and
 * the byte `length` (bits 0-24) later both pass `readableSource`. CpuSet and CpuFastSet pass the
 * bytes r2 counts, BitUnPack its source length, and the decompressors the size in their header,
 * from past the header.
 */
function readableRange(source: number, length: number): boolean {
  return length !== 0 && readableSource(source) && readableSource((source + (length & 0x01ffffff)) >>> 0);
}

/** The bytes CpuSet's and CpuFastSet's check covers: r2's count (bits 0-20) times 4, in either CpuSet width. */
function copyCheckLength(control: number): number {
  return (control << 11) >>> 9;
}

// ─── Cycle costs ──────────────────────────────────────────────────

/**
 * The cycles every call spends in the BIOS's SWI dispatch and return code, which runs from the
 * zero-wait BIOS ROM, besides the `ldrb r12, [lr, #-2]` that reads the SWI number from the
 * caller's code. mGBA counts 45 cycles plus that load's wait states (GBASwi16): these 42, the
 * load's 1-cycle access, and the 2-cycle refill of the caller's pipeline on return, which the CPU
 * charges as the SWI instruction's own branch back.
 */
const SWI_DISPATCH_CYCLES = 42;

function swiDispatchCycles(cpu: BiosCpu): number {
  // While the SWI executes, registers[15] is the return address, the BIOS's lr.
  const numberAddress = (cpu.registers[15]! - 2) >>> 0;
  return SWI_DISPATCH_CYCLES + cpu.memory.accessCycles(numberAddress, 1, false);
}

/**
 * The real BIOS's code runs from its own ROM, which fetches an opcode in 1 cycle, so each of its
 * instructions costs 1 cycle, plus: for a load, its access and an internal cycle; for a store, its
 * access; for a taken branch, 2 fetches to refill the pipeline; for a register-specified shift, an
 * internal cycle; for a multiply, its internal cycles (GBATEK "ARM CPU Instruction Cycle Times").
 * The loops below are counted that way from the BIOS's code, at the addresses given. The stacks
 * sit in IWRAM, where an access takes 1 cycle. Each function's fixed cost (its prologue, the source
 * check, its return) is the real BIOS's code run on this emulator's cycle model.
 */
/** The refill after a taken branch. */
const TAKEN = 2;
/** A load from and a store to the stack, past their instructions' cycle. */
const STACK_LOAD = 2;
const STACK_STORE = 1;
/** A load from the BIOS ROM's own tables, past its instruction's cycle. */
const BIOS_LOAD = 2;

/** A load's cycles past its instruction's: the access, and the internal cycle that writes the register. */
function loadCycles(memory: MemoryBus, address: number, width: 1 | 2 | 4): number {
  return memory.accessCycles(address, width, false) + 1;
}

/** A store's cycles past its instruction's: the access. */
function storeCycles(memory: MemoryBus, address: number, width: 1 | 2 | 4): number {
  return memory.accessCycles(address, width, false);
}

/** The source check (BIOS 0xBA4) returns after its first test for a zero length, and takes 2 cycles more for any other. */
function sourceCheckCycles(length: number): number {
  return length === 0 ? 0 : 2;
}

/**
 * The internal cycles of a multiply whose operand is `value`: 1 to 4, by how many of its top bytes
 * are sign bits (GBATEK "ARM CPU Instruction Cycle Times"; mGBA bios.c _mulWait, which ArcTan's
 * counts apply to each product).
 */
function multiplyWait(value: number): number {
  const v = value | 0;
  if (v >> 8 === 0 || v >> 8 === -1) {
    return 1;
  }
  if (v >> 16 === 0 || v >> 16 === -1) {
    return 2;
  }
  return v >> 24 === 0 || v >> 24 === -1 ? 3 : 4;
}

/**
 * Div's loop runs once per quotient bit it can produce: 13 cycles each, 4 before and 7 after (mGBA
 * _Div). The BIOS divides the magnitudes, so the count comes from those: -100/7 loops as often as
 * 100/7 (checked against the real BIOS; mGBA counts the sign bits of a negative operand as digits).
 */
function divCycles(numerator: number, denominator: number): number {
  const loops = Math.max(1, Math.clz32(Math.abs(denominator | 0)) - Math.clz32(Math.abs(numerator | 0)));
  return 4 + 13 * loops + 7;
}

/**
 * The BIOS's square root: Newton's iteration on a bound, each step's quotient found bit by bit,
 * until the bound stops shrinking (mGBA bios.c _Sqrt, whose cycle counts this keeps step for
 * step). r1 and r3 end as the last step's new bound and quotient, as the real BIOS leaves them.
 */
function bitwiseSqrt(value: number): { root: number; r1: number; r3: number; cycles: number } {
  const x = value >>> 0;
  if (x === 0) {
    return { root: 0, r1: 0, r3: 1, cycles: 53 };
  }
  let cycles = 15;
  let upper = x;
  let bound = 1;
  while (bound < upper) {
    upper >>>= 1;
    bound = (bound << 1) >>> 0;
    cycles += 6;
  }
  for (;;) {
    cycles += 6;
    upper = x;
    let accum = 0;
    let lower = bound;
    for (;;) {
      cycles += 5;
      const oldLower = lower;
      if (lower <= upper >>> 1) {
        lower = (lower << 1) >>> 0;
      }
      if (oldLower >= upper >>> 1) {
        break;
      }
    }
    for (;;) {
      cycles += 8;
      accum = (accum << 1) >>> 0;
      if (upper >= lower) {
        accum++;
        upper = (upper - lower) >>> 0;
      }
      if (lower === bound) {
        break;
      }
      lower >>>= 1;
    }
    const oldBound = bound;
    bound = ((bound + accum) >>> 0) >>> 1;
    if (bound >= oldBound) {
      return { root: oldBound, r1: bound, r3: accum, cycles };
    }
  }
}

/**
 * ArcTan evaluates a polynomial in Horner form; each multiply's cost depends on its product
 * (mGBA _ArcTan: 37 cycles plus the multiplies').
 */
function arcTanCycles(tan: number): number {
  const i = tan | 0;
  let cycles = 37 + multiplyWait(Math.imul(i, i));
  const a = -(Math.imul(i, i) >> 14);
  cycles += multiplyWait(Math.imul(0xa9, a));
  let b = (Math.imul(0xa9, a) >> 14) + 0x390;
  for (const term of ARCTAN_TERMS) {
    cycles += multiplyWait(Math.imul(b, a));
    b = (Math.imul(b, a) >> 14) + term;
  }
  return cycles;
}

/**
 * ArcTan2 (BIOS 0x4FC) tests y and then x for zero, and returns at once on an axis. Otherwise it
 * picks the octant with up to three more compares, runs Div on the smaller coordinate shifted left
 * by 14 over the larger, and ArcTan on that ratio.
 */
const ARCTAN2_AXIS_CYCLES = 28;
const ARCTAN2_CYCLES = 60;

/**
 * CpuSet (BIOS 0xB4C) moves one unit per pass of a Thumb loop: a word copy runs 5 instructions
 * (compare, branch out, LDMIA, STMIA, branch back), a halfword copy one more to step its offset. A
 * fill loads its unit once before the loop and runs one instruction fewer per unit. Reaching the
 * 16-bit loops takes one more branch, and reaching a copy loop one more than a fill's.
 */
const CPUSET_CYCLES = 47;
const CPUSET_REFUSED_CYCLES = 37;

function cpuSetCycles(memory: MemoryBus, src: number, dst: number, count: number, width: 2 | 4, fill: boolean): number {
  const halfword = width === 2 ? 1 : 0;
  const store = storeCycles(memory, dst, width);
  const path = CPUSET_CYCLES + halfword * TAKEN;
  if (fill) {
    return path + 1 + loadCycles(memory, src, width) + count * (4 + halfword + TAKEN + store);
  }
  return path + TAKEN + count * (5 + halfword + TAKEN + loadCycles(memory, src, width) + store);
}

/**
 * CpuFastSet moves 8 words per LDM/STM pair, with 5 more instructions per block for a fill and 7
 * for a copy (mGBA hle-bios.s). Around the loop it spends 48 cycles, as measured on hardware
 * (mgba-suite Timing "CpuSet": 256 words EWRAM to EWRAM).
 */
const CPUFASTSET_FIXED_CYCLES = 48;
const CPUFASTSET_REFUSED_CYCLES = 39;

function cpuFastSetCycles(cpu: BiosCpu, src: number, dst: number, words: number, fill: boolean): number {
  const blocks = words >>> 3;
  if (fill) {
    // The word goes into 8 registers: a load and 7 moves.
    return (
      CPUFASTSET_FIXED_CYCLES +
      cpu.memory.accessCycles(src, 4, false) +
      1 +
      7 +
      blocks * (5 + fastSetBlockCycles(cpu, dst))
    );
  }
  return CPUFASTSET_FIXED_CYCLES + blocks * (7 + fastSetBlockCycles(cpu, src) + fastSetBlockCycles(cpu, dst));
}

/** One LDMIA or STMIA of 8 words at `address`: an N access, then 7 S accesses. */
function fastSetBlockCycles(cpu: BiosCpu, address: number): number {
  return cpu.memory.accessCycles(address, 4, false) + 7 * cpu.memory.accessCycles(address, 4, true);
}

// ─── SWI 0x06: Div ─────────────────────────────────────────────────

/**
 * SWI 0x06 — Div: Signed division
 *
 * Input:
 *   r0 = numerator (signed)
 *   r1 = denominator (signed)
 *
 * Output:
 *   r0 = numerator / denominator (signed)
 *   r1 = numerator % denominator (signed)
 *   r3 = abs(numerator / denominator)
 *
 * The BIOS divides by zero without trapping: a numerator of 0, 1 or -1 gives r0 = 1 or -1 (the
 * numerator's sign), r1 = the numerator and r3 = 1 (mgba-suite "BIOS math" Div n/0; mGBA _Div).
 * On hardware a larger numerator loops forever in the BIOS; here it returns the same values.
 */
function swiDiv(cpu: BiosCpu): number {
  const numerator = cpu.registers[0]! | 0;
  const denominator = cpu.registers[1]! | 0;
  const cycles = divCycles(numerator, denominator);

  if (denominator === 0) {
    cpu.registers[0] = numerator < 0 ? 0xffffffff : 1;
    cpu.registers[1] = numerator >>> 0;
    cpu.registers[3] = 1;
    return cycles;
  }

  // JavaScript integer division truncates toward zero (like C99)
  const quotient = (numerator / denominator) | 0;
  const remainder = (numerator % denominator) | 0;

  cpu.registers[0] = quotient >>> 0;
  cpu.registers[1] = remainder >>> 0;
  cpu.registers[3] = Math.abs(quotient) >>> 0;
  return cycles;
}

// ─── SWI 0x07: DivArm ──────────────────────────────────────────────

/**
 * SWI 0x07 — DivArm: Same as Div but r0 and r1 are swapped.
 *
 * Input:
 *   r0 = denominator (signed)
 *   r1 = numerator (signed)
 *
 * Output:
 *   r0 = numerator / denominator (signed)
 *   r1 = numerator % denominator (signed)
 *   r3 = abs(numerator / denominator)
 */
function swiDivArm(cpu: BiosCpu): number {
  // Swap r0 and r1, then call Div
  const temp = cpu.registers[0]!;
  cpu.registers[0] = cpu.registers[1]!;
  cpu.registers[1] = temp;
  return swiDiv(cpu);
}

// ─── SWI 0x08: Sqrt ────────────────────────────────────────────────

/**
 * SWI 0x08 — Sqrt: Integer square root.
 *
 * Input:
 *   r0 = value (unsigned 32-bit)
 *
 * Output:
 *   r0 = floor(sqrt(r0)) (unsigned 16-bit)
 *   r1, r3 = the search's last bound and quotient
 */
function swiSqrt(cpu: BiosCpu): number {
  const { root, r1, r3, cycles } = bitwiseSqrt(cpu.registers[0]!);
  cpu.registers[0] = root;
  cpu.registers[1] = r1;
  cpu.registers[3] = r3;
  return cycles;
}

// ─── SWI 0x09: ArcTan ──────────────────────────────────────────────

/**
 * The BIOS's arctangent: a fixed-point polynomial in Horner form over a = -(t*t)/0x4000, each
 * product a 32-bit multiply shifted right by 14 (mGBA bios.c _ArcTan, which matches the real BIOS
 * on every input tried, r1 and r3 included). The result is (t*b) >> 16 in the BIOS's 0x10000 =
 * 2*pi scale, so tan 1.0 (0x4000) gives 0x2000; inputs beyond +-1.0 run through the same
 * polynomial and wrap like the BIOS's 32-bit arithmetic does.
 */
function arcTan(tan: number): { angle: number; a: number; b: number } {
  const i = tan | 0;
  const a = -(Math.imul(i, i) >> 14);
  let b = (Math.imul(0xa9, a) >> 14) + 0x390;
  for (const term of ARCTAN_TERMS) {
    b = (Math.imul(b, a) >> 14) + term;
  }
  return { angle: Math.imul(i, b) >> 16, a, b };
}

const ARCTAN_TERMS = [0x91c, 0xfb6, 0x16aa, 0x2081, 0x3651, 0xa2f9];

/**
 * SWI 0x09 — ArcTan: Arctangent.
 *
 * Input:
 *   r0 = tan (signed, 1.14 fixed point)
 *
 * Output:
 *   r0 = arctan(r0), signed, 0x4000 = pi/2 (so -0x2000..0x2000 for -1.0..1.0)
 *   r1, r3 = the polynomial's a and b, as the BIOS leaves them
 */
function swiArcTan(cpu: BiosCpu): number {
  const cycles = arcTanCycles(cpu.registers[0]!);
  const { angle, a, b } = arcTan(cpu.registers[0]!);
  cpu.registers[0] = angle >>> 0;
  cpu.registers[1] = a >>> 0;
  cpu.registers[3] = b >>> 0;
  return cycles;
}

// ─── SWI 0x0A: ArcTan2 ─────────────────────────────────────────────

/**
 * SWI 0x0A — ArcTan2: Four-quadrant arctangent.
 *
 * Input:
 *   r0 = x (signed 32-bit)
 *   r1 = y (signed 32-bit)
 *
 * Output:
 *   r0 = the angle of (x, y), 0x0000..0x10000 for 0..2*pi
 *   r1 = ArcTan's a for the ratio it took, unchanged on an axis
 *   r3 = 0x170, which the BIOS leaves there
 *
 * The BIOS reduces the angle to an octant and runs ArcTan on (smaller << 14) / larger, a 32-bit
 * signed division truncated toward zero (mGBA bios.c _ArcTan2). It adds the octant's base angle
 * without wrapping it, so a ratio of 0 just below the positive x axis gives 0x10000.
 */
function swiArcTan2(cpu: BiosCpu): number {
  const x = cpu.registers[0]! | 0;
  const y = cpu.registers[1]! | 0;
  cpu.registers[3] = 0x170;
  // On an axis: y = 0 with x < 0 adds a taken branch and one instruction; x = 0 adds the first
  // test's taken branch, two instructions and its own test, and y < 0 that test's taken branch.
  if (y === 0) {
    cpu.registers[0] = x >= 0 ? 0 : 0x8000;
    return ARCTAN2_AXIS_CYCLES + (x >= 0 ? 0 : 3);
  }
  if (x === 0) {
    cpu.registers[0] = y >= 0 ? 0x4000 : 0xc000;
    return ARCTAN2_AXIS_CYCLES + (y >= 0 ? 5 : 7);
  }
  // Each octant: the ratio's operands, the base angle, whether ArcTan's angle is subtracted from
  // it, and the cycles its compares and result code take past those of x >= y >= 0's.
  let octant: [numerator: number, denominator: number, base: number, subtract: boolean, extra: number];
  if (y >= 0) {
    if (x >= 0 && x >= y) {
      octant = [y, x, 0, false, 0];
    } else if (x < 0 && -x >= y) {
      octant = [y, x, 0x8000, false, 3];
    } else {
      octant = [x, y, 0x4000, true, x >= 0 ? 2 : 4];
    }
  } else if (x <= 0 && -x > -y) {
    octant = [y, x, 0x8000, false, 5];
  } else if (x > 0 && x >= -y) {
    octant = [y, x, 0x10000, false, 3];
  } else {
    octant = [x, y, 0xc000, true, x > 0 ? 7 : 3];
  }
  const [numerator, denominator, base, subtract, extra] = octant;
  const ratio = ((numerator << 14) / denominator) | 0;
  const { angle, a } = arcTan(ratio);
  cpu.registers[0] = (subtract ? base - angle : base + angle) >>> 0;
  cpu.registers[1] = a >>> 0;
  return ARCTAN2_CYCLES + extra + divCycles(numerator << 14, denominator) + arcTanCycles(ratio);
}

// ─── SWI 0x0B: CpuSet ──────────────────────────────────────────────

/**
 * SWI 0x0B — CpuSet: Memory copy or fill.
 *
 * Input:
 *   r0 = source address
 *   r1 = destination address
 *   r2 = length/mode:
 *     bits 20-0:  word count (number of transfers)
 *     bit 24:     0=copy, 1=fill (use first source word/halfword for all)
 *     bit 26:     0=16-bit (halfword), 1=32-bit (word)
 */
function swiCpuSet(cpu: BiosCpu): number {
  const src = cpu.registers[0]! >>> 0;
  const dst = cpu.registers[1]! >>> 0;
  const control = cpu.registers[2]! >>> 0;

  const count = control & 0x1fffff;
  const fill = (control & (1 << 24)) !== 0;
  const word32 = (control & (1 << 26)) !== 0;
  // r3 ends as the BIOS's return address, which its exit pops through it: 0x170 on every path.
  cpu.registers[3] = 0x170;
  const length = copyCheckLength(control);
  if (!readableRange(src, length)) {
    return CPUSET_REFUSED_CYCLES + sourceCheckCycles(length);
  }
  const cycles = cpuSetCycles(cpu.memory, src, dst, count, word32 ? 4 : 2, fill);

  if (word32) {
    // LDMIA and STMIA, which ignore the addresses' bits 0-1 and write the pointers back to r0
    // and r1; a fill loads its word once.
    const fillValue = cpu.memory.read32(src);
    for (let i = 0; i < count; i++) {
      cpu.memory.write32((dst + i * 4) >>> 0, fill ? fillValue : cpu.memory.read32((src + i * 4) >>> 0));
    }
    cpu.registers[0] = (src + (fill ? 4 : count * 4)) >>> 0;
    cpu.registers[1] = (dst + count * 4) >>> 0;
  } else {
    // LDRH and STRH on pointers of the BIOS's own. LDRH from an odd address returns the aligned
    // halfword rotated right by 8, so its low half — what STRH stores — is the addressed byte
    // (mgba-suite Memory "swi B 16 (unaligned)"), for the fill's one load as for the copy's.
    const load = (address: number): number => cpu.memory.read16(address) >>> ((address & 1) * 8);
    const fillValue = load(src);
    for (let i = 0; i < count; i++) {
      cpu.memory.write16((dst + i * 2) >>> 0, fill ? fillValue : load((src + i * 2) >>> 0));
    }
  }
  return cycles;
}

// ─── SWI 0x0C: CpuFastSet ──────────────────────────────────────────

/**
 * SWI 0x0C — CpuFastSet: Fast memory copy or fill (32-bit only, 32-byte blocks).
 *
 * Input:
 *   r0 = source address (LDM ignores bits 0-1)
 *   r1 = destination address (STM ignores bits 0-1)
 *   r2 = length/mode:
 *     bits 20-0:  word count (rounded up to multiple of 8)
 *     bit 24:     0=copy, 1=fill
 *
 * Always operates in 32-bit mode, in blocks of 8 words (32 bytes), with LDMIA r0!, {r2-r9} and
 * STMIA r1!, {r2-r9}: r0 (for a copy) and r1 end past the data, and r3 holds the last block's
 * second word, or the fill word.
 */
function swiCpuFastSet(cpu: BiosCpu): number {
  const src = cpu.registers[0]! >>> 0;
  const dst = cpu.registers[1]! >>> 0;
  const control = cpu.registers[2]! >>> 0;

  // Round up to multiple of 8
  const count = ((control & 0x1fffff) + 7) & ~7;
  const fill = (control & (1 << 24)) !== 0;
  const length = copyCheckLength(control);
  if (!readableRange(src, length)) {
    return CPUFASTSET_REFUSED_CYCLES + sourceCheckCycles(length);
  }
  const cycles = cpuFastSetCycles(cpu, src, dst, count, fill);

  // Each block is loaded whole before it is stored, which decides what an overlapping copy moves.
  const block = new Uint32Array(8);
  block.fill(cpu.memory.read32(src));
  for (let offset = 0; offset < count * 4; offset += 32) {
    if (!fill) {
      for (let i = 0; i < 8; i++) {
        block[i] = cpu.memory.read32((src + offset + i * 4) >>> 0);
      }
    }
    for (let i = 0; i < 8; i++) {
      cpu.memory.write32((dst + offset + i * 4) >>> 0, block[i]!);
    }
  }
  if (!fill) {
    cpu.registers[0] = (src + count * 4) >>> 0;
  }
  cpu.registers[1] = (dst + count * 4) >>> 0;
  cpu.registers[3] = block[1]!;
  return cycles;
}

// ─── SWI 0x0E/0x0F: Affine parameters ────────────────────────────

/**
 * The BIOS's sine table: 256 steps over a full turn in 1.14 fixed point, sin(k * 2pi / 256) * 0x4000
 * truncated toward zero, which is the table the BIOS holds, entry for entry. Cosine is the entry a
 * quarter turn (64) later.
 */
const SINE_TABLE = Int16Array.from({ length: 256 }, (_, k) => Math.trunc(Math.sin((k * 2 * Math.PI) / 256) * 0x4000));

/**
 * The rotation-scaling matrix the affine SWIs compute: the angle's top byte indexes the sine table,
 * and each 8.8 scale times a 1.14 sine or cosine is shifted right by 14, an arithmetic shift that
 * rounds toward minus infinity (pb negates the shifted product).
 */
function affineMatrix(sx: number, sy: number, angle: number): [pa: number, pb: number, pc: number, pd: number] {
  const step = (angle >>> 8) & 0xff;
  const sin = SINE_TABLE[step]!;
  const cos = SINE_TABLE[(step + 64) & 0xff]!;
  return [Math.imul(sx, cos) >> 14, -(Math.imul(sx, sin) >> 14), Math.imul(sy, sin) >> 14, Math.imul(sy, cos) >> 14];
}

/**
 * SWI 0x0E — BgAffineSet: Compute background affine transformation parameters.
 *
 * Input:
 *   r0 = source address (BgAffineSource struct array)
 *   r1 = destination address (BgAffineDest struct array)
 *   r2 = number of calculations
 *
 * BgAffineSource (20 bytes):
 *   s32 srcX  (+0, 8.8 fixed: original data center X)
 *   s32 srcY  (+4, 8.8 fixed: original data center Y)
 *   s16 dstX  (+8, integer: display center X)
 *   s16 dstY  (+10, integer: display center Y)
 *   s16 scaleX (+12, 8.8 fixed)
 *   s16 scaleY (+14, 8.8 fixed)
 *   u16 angle  (+16, upper 8 bits used: 0-255 → 0-360°)
 *
 * BgAffineDest (16 bytes):
 *   s16 pa, pb, pc, pd (+0..+6, 8.8 fixed)
 *   s32 startX, startY (+8, +12, 8.8 fixed)
 *
 * startX = srcX - (pa * dstX + pb * dstY) and startY = srcY - (pc * dstX + pd * dstY), in 32-bit
 * integers from the truncated pa..pd (GBATEK "BgAffineSet"; checked against the real BIOS).
 */
const BG_AFFINE_SET_CYCLES = 28;

function swiBgAffineSet(cpu: BiosCpu): number {
  const memory = cpu.memory;
  let src = cpu.registers[0]! >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  let cycles = BG_AFFINE_SET_CYCLES;

  // The BIOS counts r2 down as a signed number, so a count below 1 computes nothing.
  for (let count = cpu.registers[2]! | 0; count > 0; count--) {
    const ox = memory.read32(src) | 0;
    const oy = memory.read32((src + 4) >>> 0) | 0;
    const cx = toS16(memory.read16((src + 8) >>> 0));
    const cy = toS16(memory.read16((src + 10) >>> 0));
    const sx = toS16(memory.read16((src + 12) >>> 0));
    const sy = toS16(memory.read16((src + 14) >>> 0));
    const angle = memory.read16((src + 16) >>> 0);

    const [pa, pb, pc, pd] = affineMatrix(sx, sy, angle);
    memory.write16(dst, pa & 0xffff);
    memory.write16((dst + 2) >>> 0, pb & 0xffff);
    memory.write16((dst + 4) >>> 0, pc & 0xffff);
    memory.write16((dst + 6) >>> 0, pd & 0xffff);
    memory.write32((dst + 8) >>> 0, (ox - Math.imul(pa, cx) - Math.imul(pb, cy)) >>> 0);
    memory.write32((dst + 12) >>> 0, (oy - Math.imul(pc, cx) - Math.imul(pd, cy)) >>> 0);
    cpu.registers[3] = pa >>> 0;

    // BIOS 0xC30: 42 instructions and the branch back; three halfword loads, an LDM of the three
    // words and two sine-table loads; four multiplies by the scales and four multiply-accumulates
    // by -cx, cy, -cx and -cy, each 1 internal cycle longer; two word and four halfword stores.
    cycles +=
      42 +
      TAKEN +
      loadCycles(memory, (src + 16) >>> 0, 2) +
      loadCycles(memory, (src + 12) >>> 0, 2) +
      loadCycles(memory, (src + 14) >>> 0, 2) +
      memory.accessCycles(src, 4, false) +
      2 * memory.accessCycles((src + 4) >>> 0, 4, true) +
      1 +
      2 * BIOS_LOAD +
      2 * multiplyWait(sx) +
      2 * multiplyWait(sy) +
      2 * multiplyWait(-cx) +
      multiplyWait(cy) +
      multiplyWait(-cy) +
      4 +
      2 * storeCycles(memory, (dst + 8) >>> 0, 4) +
      4 * storeCycles(memory, dst, 2);
    src = (src + 20) >>> 0;
    dst = (dst + 16) >>> 0;
  }
  cpu.registers[0] = src;
  cpu.registers[1] = dst;
  return cycles;
}

/** Interpret a u16 read as signed 16-bit */
function toS16(v: number): number {
  return (v << 16) >> 16;
}

/**
 * SWI 0x0F — ObjAffineSet: Compute affine transformation parameters.
 *
 * Input:
 *   r0 = source address (ObjAffineSource struct array)
 *   r1 = destination address (ObjAffineDest struct or OAM)
 *   r2 = number of calculations
 *   r3 = bytes between the destination's parameters: 2 for a packed struct, 8 for OAM
 *
 * ObjAffineSource (8 bytes):
 *   s16 sx  (scale X, 8.8 fixed point)
 *   s16 sy  (scale Y, 8.8 fixed point)
 *   u16 theta (angle, upper 8 bits used: 0-255 → 0-360°)
 *
 * Output: pa, pb, pc, pd at dest + 0, r3, 2*r3 and 3*r3; the next set starts 4*r3 later
 * (GBATEK "ObjAffineSet"; mGBA bios.c _ObjAffineSet).
 */
const OBJ_AFFINE_SET_CYCLES = 20;

function swiObjAffineSet(cpu: BiosCpu): number {
  const memory = cpu.memory;
  let src = cpu.registers[0]! >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  const stride = cpu.registers[3]! >>> 0;
  let cycles = OBJ_AFFINE_SET_CYCLES;

  // The BIOS counts r2 down as a signed number, so a count below 1 computes nothing.
  for (let count = cpu.registers[2]! | 0; count > 0; count--) {
    const sx = toS16(memory.read16(src));
    const sy = toS16(memory.read16((src + 2) >>> 0));
    const angle = memory.read16((src + 4) >>> 0);

    // BIOS 0xCE4: 28 instructions and the branch back; three halfword loads and two sine-table
    // loads; two multiplies by each scale; four halfword stores.
    cycles +=
      28 +
      TAKEN +
      loadCycles(memory, (src + 4) >>> 0, 2) +
      loadCycles(memory, src, 2) +
      loadCycles(memory, (src + 2) >>> 0, 2) +
      2 * BIOS_LOAD +
      2 * multiplyWait(sx) +
      2 * multiplyWait(sy);
    affineMatrix(sx, sy, angle).forEach((value, k) => {
      const address = (dst + k * stride) >>> 0;
      memory.write16(address, value & 0xffff);
      cycles += storeCycles(memory, address, 2);
    });

    src = (src + 8) >>> 0;
    dst = (dst + stride * 4) >>> 0;
  }
  cpu.registers[0] = src;
  cpu.registers[1] = dst;
  return cycles;
}

// ─── SWI 0x10: BitUnPack ───────────────────────────────────────────

/**
 * SWI 0x10 — BitUnPack: Unpack data from smaller bit widths to larger.
 *
 * Input:
 *   r0 = source address
 *   r1 = destination address
 *   r2 = pointer to UnPackInfo struct:
 *     u16 srcLength    (source data length in bytes)
 *     u8  srcBitWidth  (source bit width: 1, 2, 4, 8)
 *     u8  dstBitWidth  (destination bit width: 1, 2, 4, 8, 16, 32)
 *     u32 dataOffset   (value added to all non-zero source values;
 *                        bit 31: also add offset to zero values)
 *
 * Units fill 32-bit words from the low bits up, and the BIOS stores a word once its units reach 32
 * bits: a unit that ends past bit 31 loses its top bits, a last partial word stays unwritten, and
 * r3 ends as the count of its bits. A unit the offset carries past its width spills into the next
 * unit's bits. A source unit wider than 8 bits reads as 0 (mGBA bios.c _unBitPack; checked against
 * the real BIOS).
 *
 * With a source width of 0 the BIOS's unit loop stays on the first byte and stores words of zero
 * units (or of offsets) past the destination forever; such a call runs on in the BIOS image.
 */
const BIT_UNPACK_CYCLES = 59;
const BIT_UNPACK_REFUSED_CYCLES = 43;

function swiBitUnPack(cpu: BiosCpu): number | null {
  const memory = cpu.memory;
  let src = cpu.registers[0]! >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  const infoPtr = cpu.registers[2]! >>> 0;

  const srcLength = memory.read16(infoPtr);
  if (!readableRange(src, srcLength)) {
    return BIT_UNPACK_REFUSED_CYCLES + loadCycles(memory, infoPtr, 2) + sourceCheckCycles(srcLength);
  }
  const srcBitWidth = memory.read8((infoPtr + 2) >>> 0);
  if (srcBitWidth === 0) {
    return null;
  }
  const dstBitWidth = memory.read8((infoPtr + 3) >>> 0);
  const dataOffset = memory.read32((infoPtr + 4) >>> 0);

  const addToZero = (dataOffset & 0x80000000) !== 0;
  const offsetValue = dataOffset & 0x7fffffff;
  const srcMask = srcBitWidth <= 8 ? 0xff >> (8 - srcBitWidth) : 0;
  let word = 0;
  let bitsUsed = 0;
  let cycles =
    BIT_UNPACK_CYCLES +
    loadCycles(memory, infoPtr, 2) +
    loadCycles(memory, (infoPtr + 2) >>> 0, 1) +
    2 * loadCycles(memory, (infoPtr + 4) >>> 0, 4) +
    loadCycles(memory, (infoPtr + 3) >>> 0, 1);

  for (let byteIdx = 0; byteIdx < srcLength; byteIdx++) {
    // BIOS 0xFA4: 6 instructions, one a register shift, and the load; after the byte's units, a
    // compare and the branch back.
    cycles += 7 + loadCycles(memory, src, 1) + 2 + TAKEN;
    const srcByte = memory.read8(src);
    src = (src + 1) >>> 0;
    for (let bitPos = 0; bitPos < 8; bitPos += srcBitWidth) {
      // BIOS 0xFBC: 13 instructions, three of them register shifts, and the branch back; the offset
      // costs a stack load and an add, and a full word its store and two moves, each else a branch
      // past them.
      cycles += 16 + TAKEN;
      let value = (srcByte >>> bitPos) & srcMask;
      if (value !== 0 || addToZero) {
        value = (value + offsetValue) >>> 0;
        cycles += 2 + STACK_LOAD;
      } else {
        cycles += TAKEN;
      }
      word = (word | (value << bitsUsed)) >>> 0;
      bitsUsed += dstBitWidth;
      if (bitsUsed >= 32) {
        memory.write32(dst, word);
        cycles += 3 + storeCycles(memory, dst, 4);
        dst = (dst + 4) >>> 0;
        word = 0;
        bitsUsed = 0;
      } else {
        cycles += TAKEN;
      }
    }
  }
  cpu.registers[0] = src;
  cpu.registers[1] = dst;
  cpu.registers[3] = bitsUsed;
  return cycles;
}

// ─── Decompressor output ────────────────────────────────────────────

/**
 * Where a decompressor's bytes go, as the BIOS stores them: WRAM takes each byte with a byte store.
 * VRAM takes halfwords only, so the BIOS holds an even byte until the odd byte after it arrives and
 * stores the pair. A last odd byte stays unwritten, and a back-reference to the byte still held
 * reads what VRAM had there before (GBATEK "LZ77UnCompReadNormalWrite16bit"; mGBA bios.c _unLz77;
 * checked against the real BIOS).
 */
class DecompressorOutput {
  readonly #memory: MemoryBus;
  readonly #vram: boolean;
  #address: number;
  #held = 0;

  constructor(memory: MemoryBus, start: number, vram: boolean) {
    this.#memory = memory;
    this.#address = start;
    this.#vram = vram;
  }

  /** Store the next byte; returns the cycles of the store it makes, if any. */
  put(byte: number): number {
    const address = this.#address;
    this.#address = (address + 1) >>> 0;
    if (!this.#vram) {
      this.#memory.write8(address, byte);
      return storeCycles(this.#memory, address, 1);
    }
    if ((address & 1) === 0) {
      this.#held = byte;
      return 0;
    }
    const halfword = (address & ~1) >>> 0;
    this.#memory.write16(halfword, this.#held | (byte << 8));
    return storeCycles(this.#memory, halfword, 2);
  }

  /** Whether the next byte completes a store: every byte in WRAM, every odd one in VRAM. */
  get storesNext(): boolean {
    return !this.#vram || (this.#address & 1) === 1;
  }

  /** The byte at `address` as a back-reference reads it: VRAM through its aligned halfword. */
  read(address: number): number {
    if (!this.#vram) {
      return this.#memory.read8(address);
    }
    return (this.#memory.read16((address & ~1) >>> 0) >>> ((address & 1) * 8)) & 0xff;
  }

  /** The next byte's address. */
  get address(): number {
    return this.#address;
  }

  /** Past the last byte stored: in VRAM, past the last whole halfword (the BIOS's final r1). */
  get end(): number {
    return this.#vram ? (this.#address & ~1) >>> 0 : this.#address;
  }

  /** The byte VRAM still holds back when the count is odd, which the BIOS leaves in r3. */
  get heldByte(): number {
    return this.#vram && this.#address & 1 ? this.#held : 0;
  }
}

// ─── SWI 0x11/0x12: LZ77 Decompress ────────────────────────────────

/**
 * SWI 0x11 — LZ77UnCompWram: LZ77 decompress to WRAM (byte writes).
 * SWI 0x12 — LZ77UnCompVram: LZ77 decompress to VRAM (halfword writes).
 *
 * Input:
 *   r0 = source address
 *   r1 = destination address
 *
 * Source data format:
 *   u32 header: bits 7-4 = 1 (LZ77), bits 31-8 = decompressed size
 *   Then compressed data stream:
 *     Each block starts with a flag byte (8 bits, MSB first):
 *       bit=0: copy 1 byte literally from source
 *       bit=1: reference: 2 bytes (4-bit length + 12-bit offset)
 *              displacement = offset + 1 (back from current dst)
 *              length = length + 3
 *
 * A reference is copied whole even past the size, as the BIOS does. r0 and r1 end past the data
 * read and written.
 */
const LZ77_CYCLES = 35;
const LZ77_REFUSED_CYCLES = 32;
const LZ77_VRAM_CYCLES = 45;
const LZ77_VRAM_REFUSED_CYCLES = 42;

function lz77Decompress(cpu: BiosCpu, vram: boolean): number {
  const memory = cpu.memory;
  const header = cpu.registers[0]! >>> 0;
  let src = (header + 4) >>> 0;
  let remaining = memory.read32(header) >>> 8;
  let cycles = loadCycles(memory, header, 4) + sourceCheckCycles(remaining);
  if (vram) {
    cpu.registers[3] = 0;
  }
  if (!readableRange(src, remaining)) {
    cpu.registers[0] = src;
    return cycles + (vram ? LZ77_VRAM_REFUSED_CYCLES : LZ77_REFUSED_CYCLES);
  }
  cycles += vram ? LZ77_VRAM_CYCLES : LZ77_CYCLES;
  const output = new DecompressorOutput(memory, cpu.registers[1]! >>> 0, vram);

  // BIOS 0x1114 (WRAM, ARM) and 0x11B4 (VRAM): 4 instructions and the load per flag byte; per flag,
  // 4 instructions to test it, then the literal or the reference, then 3 instructions and a taken
  // branch, the last flag's included; after the eighth flag, while data remains, 2 instructions and
  // the branch back.
  while (remaining > 0) {
    cycles += 4 + loadCycles(memory, src, 1);
    const flags = memory.read8(src);
    src = (src + 1) >>> 0;

    for (let i = 7; i >= 0 && remaining > 0; i--) {
      cycles += 4 + 3 + TAKEN;
      if ((flags >> i) & 1) {
        // The reference: its branch, 10 instructions (13 for VRAM) and its two bytes, the first
        // loaded twice; per byte, 4 instructions (VRAM: 15, three of them register shifts, and a
        // halfword load), the load, the store, and the branch back but for the last byte.
        cycles +=
          TAKEN + (vram ? 13 : 10) + 2 * loadCycles(memory, src, 1) + loadCycles(memory, (src + 1) >>> 0, 1) - TAKEN;
        const byte1 = memory.read8(src);
        const byte2 = memory.read8((src + 1) >>> 0);
        src = (src + 2) >>> 0;

        const length = ((byte1 >> 4) & 0xf) + 3;
        let from = (output.address - (((byte1 & 0xf) << 8) | byte2) - 1) >>> 0;
        for (let j = 0; j < length; j++) {
          cycles += vram
            ? 18 + TAKEN + loadCycles(memory, (from & ~1) >>> 0, 2)
            : 4 + TAKEN + loadCycles(memory, from, 1);
          cycles += output.put(output.read(from));
          from = (from + 1) >>> 0;
        }
        remaining -= length;
      } else {
        // The literal: 4 instructions (VRAM: 7, one a register shift), its load, the store and the
        // branch past the reference.
        cycles += (vram ? 8 : 4) + TAKEN + loadCycles(memory, src, 1);
        cycles += output.put(memory.read8(src));
        src = (src + 1) >>> 0;
        remaining--;
      }
    }
    if (remaining > 0) {
      cycles += 2 + TAKEN;
    }
  }
  cpu.registers[0] = src;
  cpu.registers[1] = output.end;
  if (vram) {
    cpu.registers[3] = output.heldByte;
  }
  return cycles;
}

// ─── SWI 0x14/0x15: Run-Length Decompress ───────────────────────────

/**
 * SWI 0x14 — RLUnCompWram: Run-length decompress to WRAM (byte writes).
 * SWI 0x15 — RLUnCompVram: Run-length decompress to VRAM (halfword writes).
 *
 * Input:
 *   r0 = source address
 *   r1 = destination address
 *
 * Source data format:
 *   u32 header: bits 7-4 = 3 (RLE), bits 31-8 = decompressed size
 *   Then compressed data stream:
 *     Flag byte:
 *       bit 7 = 0: uncompressed, bits 6-0 = length - 1 (1-128 bytes), followed by that many bytes
 *       bit 7 = 1: compressed, bits 6-0 = length - 3 (3-130 bytes), followed by 1 repeated byte
 *
 * A run is written whole even past the size, as the BIOS does. r0 and r1 end past the data read
 * and written, and r3 holds the BIOS's return address, 0x170.
 */
const RL_CYCLES = 44;
const RL_REFUSED_CYCLES = 42;
const RL_VRAM_CYCLES = 48;
const RL_VRAM_REFUSED_CYCLES = 45;

function rlDecompress(cpu: BiosCpu, vram: boolean): number {
  const memory = cpu.memory;
  const header = cpu.registers[0]! >>> 0;
  let src = (header + 4) >>> 0;
  let remaining = memory.read32(header) >>> 8;
  let cycles = loadCycles(memory, header, 4) + sourceCheckCycles(remaining);
  cpu.registers[3] = 0x170;
  if (!readableRange(src, remaining)) {
    cpu.registers[0] = src;
    return cycles + (vram ? RL_VRAM_REFUSED_CYCLES : RL_REFUSED_CYCLES);
  }
  cycles += vram ? RL_VRAM_CYCLES : RL_CYCLES;
  const output = new DecompressorOutput(memory, cpu.registers[1]! >>> 0, vram);

  // A byte's store: in WRAM, part of the byte's instructions; in VRAM, 3 instructions and the store
  // when it completes a halfword, or else the branch past them.
  const put = (byte: number): number => {
    if (!vram) {
      return output.put(byte);
    }
    const stores = output.storesNext;
    const store = output.put(byte);
    return stores ? 3 + store : TAKEN;
  };

  // BIOS 0x1286 (WRAM, Thumb) and 0x12D4 (VRAM): 8 instructions and the flag byte's load per block
  // (VRAM: 11, with the flag parked on the stack and read back twice), then the run or the literal
  // bytes, each byte's branch back but the last, and the branch to the next block.
  while (remaining > 0) {
    cycles += (vram ? 11 + STACK_STORE + 2 * STACK_LOAD : 8) + loadCycles(memory, src, 1) + 1;
    const flag = memory.read8(src);
    src = (src + 1) >>> 0;
    if (flag & 0x80) {
      // The run: its branch, 4 instructions (VRAM: 5, the byte parked on the stack) and the byte's
      // load; per byte 4 instructions (VRAM: 8, a stack load and a register shift).
      const length = (flag & 0x7f) + 3;
      cycles += TAKEN + (vram ? 5 + STACK_STORE : 4) + loadCycles(memory, src, 1);
      const data = memory.read8(src);
      src = (src + 1) >>> 0;
      for (let i = 0; i < length; i++) {
        cycles += (vram ? 9 + STACK_LOAD : 4) + TAKEN + put(data);
      }
      remaining -= length;
    } else {
      // The literal bytes: 2 instructions; per byte 6 instructions (VRAM: 9 and a register shift)
      // and its load.
      const length = (flag & 0x7f) + 1;
      cycles += 2;
      for (let i = 0; i < length; i++) {
        cycles += (vram ? 10 : 6) + TAKEN + loadCycles(memory, src, 1) + put(memory.read8(src));
        src = (src + 1) >>> 0;
      }
      remaining -= length;
    }
  }
  cpu.registers[0] = src;
  cpu.registers[1] = output.end;
  return cycles;
}

// ─── SWI 0x13: HuffUnComp ───────────────────────────────────────

/**
 * SWI 0x13 — HuffUnCompReadNormal: Huffman decompress.
 *
 * Input:
 *   r0 = source address
 *   r1 = destination address
 *
 * Source data format:
 *   u32 header: bits 3-0 = data size in bits (4 or 8)
 *               bits 7-4 = type (0x2 for Huffman)
 *               bits 31-8 = decompressed size in bytes
 *   u8  treeSize: (tree table size / 2) - 1
 *   u8[] tree: tree table (treeSize*2 + 1 bytes)
 *     Each node byte: bits 5-0 = offset to children
 *                     bit 6 = right child is leaf
 *                     bit 7 = left child is leaf
 *   u32[] data: bitstream (MSB first within each 32-bit word)
 *
 * The BIOS shifts each leaf in from the top of a word, `(word >> size) | (leaf << (32 - size))`,
 * and stores the word after (size & 7) + 4 leaves: 8 for 4-bit data, 4 for 8-bit data, and 4 for
 * a size of 0, whose words stay 0. r0 ends past the last bitstream word read, r1 past the data,
 * and r3 holds the last word.
 *
 * The walk moves forward through memory, at least a byte per bit, until a node's flag marks a
 * leaf, so a walk of more nodes than the largest tree table holds (512 bytes) has left its table.
 * On hardware it reads on through the memory after it until a byte there marks a leaf, which may
 * never happen; this HLE hands such a call to the BIOS image's endless loop instead.
 */
const HUFF_CYCLES = 61;
const HUFF_REFUSED_CYCLES = 44;
const HUFF_WALK_LIMIT = 512;

function swiHuffUnComp(cpu: BiosCpu): number | null {
  const memory = cpu.memory;
  const src = cpu.registers[0]! >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  // The check covers the first byte only.
  if (!readableSource(src)) {
    return HUFF_REFUSED_CYCLES;
  }

  const header = memory.read32(src);
  const bits = header & 0xf;
  const leavesPerWord = (bits & 7) + 4;
  let remaining = header >>> 8;
  const root = (src + 5) >>> 0;
  let stream = (src + 4 + (memory.read8((src + 4) >>> 0) + 1) * 2) >>> 0;
  let cycles =
    HUFF_CYCLES +
    loadCycles(memory, src, 1) +
    STACK_STORE +
    loadCycles(memory, src, 4) +
    loadCycles(memory, (src + 4) >>> 0, 1);

  let node = root;
  let word = 0;
  let leaves = 0;
  let walk = 0;
  // BIOS 0x1064 (ARM): 4 instructions and the load per bitstream word, which LDR rotates when the
  // tree leaves it unaligned; after its 32 bits, 2 instructions and the branch back.
  while (remaining > 0) {
    cycles += 4 + loadCycles(memory, stream, 4);
    const rotate = (stream & 3) * 8;
    const aligned = memory.read32((stream & ~3) >>> 0);
    let bitstream = ((aligned >>> rotate) | (aligned << (32 - rotate))) >>> 0;
    stream = (stream + 4) >>> 0;
    let bit = 0;
    for (; bit < 32; bit++) {
      // BIOS 0x1074: 15 instructions, one a register shift, and the node's two loads; the branch
      // past the leaf code when the bit leads to another node.
      cycles += 16 + 2 * loadCycles(memory, node, 1);
      const right = bitstream >>> 31;
      bitstream = (bitstream << 1) >>> 0;
      const flags = memory.read8(node);
      const child = ((node & ~1) + ((flags & 0x3f) + 1) * 2 + right) >>> 0;
      if (((flags << right) & 0x80) === 0) {
        cycles += TAKEN;
        node = child;
        if (++walk === HUFF_WALK_LIMIT) {
          cpu.registers[0] = stream;
          cpu.registers[1] = dst;
          return null;
        }
      } else {
        // The leaf: 11 instructions, two of them register shifts, its load and a stack load; the
        // word's store after its last leaf.
        cycles += 13 + loadCycles(memory, child, 1) + STACK_LOAD;
        const leaf = memory.read8(child);
        word = ((word >>> bits) | (bits === 0 ? 0 : leaf << (32 - bits))) >>> 0;
        node = root;
        walk = 0;
        if (++leaves === leavesPerWord) {
          memory.write32(dst, word);
          cycles += storeCycles(memory, dst, 4);
          dst = (dst + 4) >>> 0;
          remaining -= 4;
          leaves = 0;
        }
      }
      // 3 instructions and the branch back while data remains, or the branch out.
      cycles += 3 + TAKEN;
      if (remaining <= 0) {
        cycles += 1;
        break;
      }
    }
    if (bit === 32) {
      cycles += 2 + TAKEN;
    }
  }
  cpu.registers[0] = stream;
  cpu.registers[1] = dst;
  cpu.registers[3] = word;
  return cycles;
}

// ─── SWI 0x16-0x18: Differential unfilters ─────────────────────────

/**
 * SWI 0x16 — Diff8bitUnFilterWram, 0x17 — Diff8bitUnFilterVram, 0x18 — Diff16bitUnFilter.
 *
 * Input:
 *   r0 = source address: a header word (bits 31-8 = size in bytes), then the differences
 *   r1 = destination address
 *
 * Each unit of `unitBytes` is the previous unit plus the difference, wrapping at its width. The
 * VRAM variant of the 8-bit filter stores halfwords, so it stores each pair of bytes once the
 * second is known, and an odd last byte stays unwritten (GBATEK "Decompression Functions"; checked
 * against the real BIOS). The 16-bit filter leaves its last difference in r3, or the source
 * check's 0xBA4 when it ran one unit; the 8-bit ones leave their return address, 0x170.
 */
const DIFF_CYCLES = 37;
const DIFF_REFUSED_CYCLES = 35;
const DIFF8_VRAM_CYCLES = 44;
const DIFF8_VRAM_REFUSED_CYCLES = 42;

function swiDiffUnFilter(cpu: BiosCpu, unitBytes: 1 | 2, vram: boolean): number {
  const memory = cpu.memory;
  const header = cpu.registers[0]! >>> 0;
  let src = (header + 4) >>> 0;
  const size = memory.read32(header) >>> 8;
  let cycles = loadCycles(memory, header, 4) + sourceCheckCycles(size);
  cpu.registers[3] = unitBytes === 1 ? 0x170 : 0xba4;
  if (!readableRange(src, size)) {
    cpu.registers[0] = src;
    return cycles + (vram ? DIFF8_VRAM_REFUSED_CYCLES : DIFF_REFUSED_CYCLES);
  }
  cycles += vram ? DIFF8_VRAM_CYCLES : DIFF_CYCLES;
  let dst = cpu.registers[1]! >>> 0;
  const output = new DecompressorOutput(memory, dst, vram);
  let unit = 0;
  for (let remaining = size; remaining > 0; remaining -= unitBytes) {
    const first = remaining === size;
    // BIOS 0x133E, 0x136C and 0x13A4 (Thumb): the first unit takes 4 instructions, its load and
    // its store; each next one 8 instructions, its load, its store and the branch back. The VRAM
    // loop's next unit takes 13 cycles and its load; then 4 instructions, the store and a taken
    // branch when the byte completes a halfword, or else a taken branch past them.
    cycles += loadCycles(memory, src, unitBytes) + (first ? 4 : vram ? 13 : 10);
    if (unitBytes === 1) {
      unit = (unit + memory.read8(src)) & 0xff;
      const stores = output.storesNext;
      const store = output.put(unit);
      cycles += !vram || first ? store : stores ? 4 + store + TAKEN : TAKEN;
    } else {
      const difference = memory.read16(src);
      unit = (unit + difference) & 0xffff;
      memory.write16(dst, unit);
      cycles += storeCycles(memory, dst, 2);
      dst = (dst + 2) >>> 0;
      if (!first) {
        cpu.registers[3] = difference;
      }
    }
    src = (src + unitBytes) >>> 0;
  }
  cpu.registers[0] = src;
  cpu.registers[1] = unitBytes === 1 ? output.end : dst;
  return cycles;
}

// ─── SWI 0x01: RegisterRamReset ───────────────────────────────────

/**
 * The BIOS clears memory 8 words per STMIA, with 5 cycles of loop around each, and spends 64 cycles
 * setting up each area; the call itself takes 140 cycles with nothing to clear. These are the
 * real BIOS's code run on this emulator's cycle model (as are the I/O groups' costs below), and they
 * make clearing EWRAM take about 1.5 frames.
 */
const REGISTER_RAM_RESET_FIXED_CYCLES = 140;
const CLEAR_AREA_SETUP_CYCLES = 64;
const RESET_SERIAL_CYCLES = 154;
const RESET_SOUND_CYCLES = 203;
const RESET_OTHER_REGISTERS_CYCLES = 410;

/** r0 bit, first byte, and length of each memory area RegisterRamReset clears. */
const RESET_AREAS: ReadonlyArray<readonly [bit: number, start: number, bytes: number]> = [
  [0x01, 0x02000000, 0x40000], // EWRAM
  [0x02, 0x03000000, 0x7e00], // IWRAM, short of the top 0x200 bytes: the stacks and BIOS vectors
  [0x04, 0x05000000, 0x400], // palette
  [0x08, 0x06000000, 0x18000], // VRAM
  [0x10, 0x07000000, 0x400], // OAM
];

/**
 * SWI 0x01 — RegisterRamReset: clear the memory areas and reset the I/O register groups r0 picks.
 *
 * Input:
 *   r0 = bit 0 EWRAM, 1 IWRAM (all but its top 0x200 bytes), 2 palette, 3 VRAM, 4 OAM,
 *        5 serial registers, 6 sound registers, 7 every other register
 *
 * DISPCNT becomes 0x0080, forced blank, whatever r0 holds. The I/O writes are the real BIOS's, in
 * its order: the sound group goes through the master enable, which clears the PSG registers,
 * keeps the SOUNDBIAS level with the resolution bits cleared, and zeroes both wave RAM banks and
 * the FIFOs after them. With bit 5 clear the BIOS still writes 0x8000 to 0x04000114 and 7 to the
 * low byte of SIODATA32 (GBATEK "BIOS Reset Functions": "LSBs of SIODATA32 are always
 * destroyed").
 */
function swiRegisterRamReset(cpu: BiosCpu): number {
  const flags = cpu.registers[0]!;
  const memory = cpu.memory;
  const zeroWords = (first: number, last: number): void => {
    for (let address = first; address <= last; address += 4) {
      memory.write32(address, 0);
    }
  };
  let cycles = REGISTER_RAM_RESET_FIXED_CYCLES;

  memory.write16(MMIO.DISPCNT, 0x0080);
  for (const [bit, start, bytes] of RESET_AREAS) {
    if (flags & bit) {
      zeroWords(start, start + bytes - 4);
      cycles += CLEAR_AREA_SETUP_CYCLES + (bytes / 32) * (5 + fastSetBlockCycles(cpu, start));
    }
  }
  if (flags & 0x80) {
    zeroWords(MMIO.IE, MMIO.IE + 0x1c); // IE, IF, WAITCNT, IME
    memory.write16(MMIO.IF, 0xffff); // acknowledge every request
    memory.write8(0x04000410, 0xff); // an address with no register behind it
    zeroWords(MMIO.DISPSTAT, MMIO.BLDY + 0x8); // the display registers past DISPCNT
    zeroWords(MMIO.DMA0SAD, MMIO.DMA3CNT_L + 0x20); // the DMA channels
    zeroWords(MMIO.TM0CNT_L, MMIO.TM3CNT_L); // the timers
    memory.write32(MMIO.KEYINPUT, 0); // KEYCNT
    for (const identity of [MMIO.BG2PA, MMIO.BG3PA, MMIO.BG2PD, MMIO.BG3PD]) {
      memory.write16(identity, 0x0100);
    }
    cycles += RESET_OTHER_REGISTERS_CYCLES;
  }
  if (flags & 0x20) {
    zeroWords(MMIO.SIODATA32 - 0x10, MMIO.SIODATA8 + 0x2);
    memory.write16(MMIO.RCNT, 0x8000); // general-purpose mode
    memory.write8(MMIO.JOYCNT, 0x07);
    zeroWords(MMIO.JOYCNT, MMIO.JOY_TRANS + 0x8);
    cycles += RESET_SERIAL_CYCLES;
  } else {
    memory.write16(0x04000114, 0x8000); // an address with no register behind it
    memory.write8(MMIO.SIODATA32, 0x07);
  }
  if (flags & 0x40) {
    memory.write8(MMIO.SOUNDCNT_X, 0x00);
    memory.write8(MMIO.SOUNDCNT_X, 0x80);
    memory.write32(MMIO.SOUNDCNT_L, 0x880e0000);
    memory.write16(MMIO.SOUNDBIAS, memory.read16(MMIO.SOUNDBIAS) & 0x3ff); // the level stays, resolution 0
    // SOUND3CNT_L picks the bank that plays and the CPU writes the other: bank 0, then bank 1.
    for (const playing of [0x70, 0x00]) {
      memory.write8(MMIO.SOUND3CNT_L, playing);
      zeroWords(MMIO.WAVE_RAM, MMIO.WAVE_RAM + 0x1c);
    }
    memory.write8(MMIO.SOUNDCNT_X, 0x00);
    cycles += RESET_SOUND_CYCLES;
  }
  return cycles;
}

// ─── SWI 0x0D: GetBiosChecksum ────────────────────────────────────

/** The real BIOS sums its 16 KB a word at a time; this is that loop's time on this emulator's cycle model. */
const GET_BIOS_CHECKSUM_CYCLES = 40965;

/**
 * SWI 0x0D — GetBiosChecksum: r0 = 0xBAAE187F, the GBA BIOS's checksum (the DS's GBA mode gives
 * another), r1 = 1, r3 = 0x4000, the size it summed (GBATEK "GetBiosChecksum"; mGBA bios.c).
 */
function swiGetBiosChecksum(cpu: BiosCpu): number {
  cpu.registers[0] = 0xbaae187f;
  cpu.registers[1] = 1;
  cpu.registers[3] = 0x4000;
  return GET_BIOS_CHECKSUM_CYCLES;
}

// ─── SWI 0x19: SoundBias ─────────────────────────────────────────

/** The ramp's time per step of 2, up and down, and around it: the real BIOS's on this cycle model. */
const SOUND_BIAS_UP_CYCLES = 25;
const SOUND_BIAS_UP_STEP_CYCLES = 62;
const SOUND_BIAS_DOWN_CYCLES = 27;
const SOUND_BIAS_DOWN_STEP_CYCLES = 61;

/**
 * SWI 0x19 — SoundBias: ramp the SOUNDBIAS level (bits 1-9) by 2 per step, up to 0x200 when r0 is
 * non-zero (a level already above stays), down to 0 when r0 is zero. The resolution bits stay.
 * The ramp happens before the call returns, so the level goes straight to its end here, and the
 * call takes the ramp's time. r1 returns the level and r3 the register's address (GBATEK
 * "SoundBias"; checked against the real BIOS).
 */
function swiSoundBias(cpu: BiosCpu): number {
  const bias = cpu.memory.read16(MMIO.SOUNDBIAS);
  const level = bias & 0x3fe;
  let target: number;
  let cycles: number;
  if (cpu.registers[0]) {
    target = Math.max(level, 0x200);
    cycles = SOUND_BIAS_UP_CYCLES + ((target - level) / 2) * SOUND_BIAS_UP_STEP_CYCLES;
  } else {
    target = 0;
    cycles = SOUND_BIAS_DOWN_CYCLES + (level / 2) * SOUND_BIAS_DOWN_STEP_CYCLES;
  }
  cpu.memory.write16(MMIO.SOUNDBIAS, (bias & ~0x3fe) | target);
  cpu.registers[1] = target;
  cpu.registers[3] = MMIO.SOUNDBIAS;
  return cycles;
}

// ─── SWI 0x1F: MidiKey2Freq ─────────────────────────────────────

/**
 * The m4a sound engine's tables, which the BIOS also holds. A key's scale entry packs the octave
 * shift (high nibble, 14 down to 0) and the note (low nibble); the frequency table holds the twelve
 * notes of the top octave as 2^31 * 2^(note/12).
 */
const SCALE_TABLE = Uint8Array.from({ length: 180 }, (_, key) => ((14 - Math.floor(key / 12)) << 4) | (key % 12));
const FREQ_TABLE = Uint32Array.of(
  2147483648,
  2275179671,
  2410468894,
  2553802834,
  2705659852,
  2866546760,
  3037000500,
  3217589947,
  3408917802,
  3611622603,
  3826380858,
  4053909305,
);

/** The high 32 bits of an unsigned 32x32-bit product (the BIOS's UMULL). */
function multiplyHigh(a: number, b: number): number {
  return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n);
}

/** The rate factor for a key, from the tables. */
function keyRate(key: number): number {
  const entry = SCALE_TABLE[key]!;
  return FREQ_TABLE[entry & 0xf]! >>> (entry >> 4);
}

/**
 * SWI 0x1F — MidiKey2Freq: Convert a MIDI key number to a playback
 * frequency rate for the m4a/mp2k sound engine.
 *
 * Input:
 *   r0 = pointer to WaveData (frequency at offset +4)
 *   r1 = MIDI key number (mk)
 *   r2 = fine pitch adjustment (fp, 0-255, in 1/256 of a key)
 *
 * Returns:
 *   r0 = the frequency scaled by the key's rate, interpolated between the key and the next one by
 *        fp: about freq / 2^((180 - mk - fp/256) / 12). Keys past 178 play key 178 with fp = 255.
 *
 * The BIOS computes it with the m4a tables and 32x32 high-word multiplies (m4a MidiKeyToFreq;
 * GBATEK "MidiKey2Freq"), which this reproduces exactly.
 */
/**
 * The lookups and the two long multiplies take about this long past the dispatch (99 to 105 cycles
 * with the multiplies' operands): the real BIOS's code on this emulator's cycle model.
 */
const MIDI_KEY_2_FREQ_CYCLES = 102;

function swiMidiKey2Freq(cpu: BiosCpu): number {
  const freq = cpu.memory.read32((cpu.registers[0]! + 4) >>> 0);
  let key = cpu.registers[1]! & 0xff;
  let fine = (cpu.registers[2]! & 0xff) << 24;
  if (key > 178) {
    key = 178;
    fine = 0xff000000;
  }
  const low = keyRate(key);
  const high = keyRate(key + 1);
  cpu.registers[0] = multiplyHigh(freq, (low + multiplyHigh((high - low) >>> 0, fine >>> 0)) >>> 0) >>> 0;
  return MIDI_KEY_2_FREQ_CYCLES;
}
