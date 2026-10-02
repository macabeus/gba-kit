/**
 * ARM7TDMI HLE BIOS — High-Level Emulation of GBA BIOS calls
 *
 * Instead of running real BIOS ROM, we intercept SWI instructions and
 * implement the behavior in TypeScript. This is faster and doesn't
 * require a BIOS dump. The calls that steer the CPU itself (Halt, Stop,
 * IntrWait, VBlankIntrWait, CustomHalt, SoftReset) run instead as ARM code
 * from the BIOS image (bios-image.ts), entered through the SWI exception.
 *
 * Each call reports the cycles the real BIOS code would take, so a call costs the time it does on
 * hardware: the dispatch and return every SWI goes through, plus a per-function cost where the
 * function's loop is long enough to matter (mGBA src/gba/bios.c GBASwi16 and its stall counts).
 * Where mGBA counts none, the costs come from the real BIOS's own code run on this emulator's
 * cycle model.
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
 *   the BIOS image runs as ARM code, which the CPU enters through the SWI exception
 */
export function handleSwi(cpu: BiosCpu, swiNumber: number): number | null {
  if (runsInBiosCode(swiNumber)) {
    return null;
  }
  // Read before the call, which may change the registers.
  const dispatch = swiDispatchCycles(cpu);
  let cycles = 0;
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
      swiBgAffineSet(cpu);
      break;
    case 0x0f:
      swiObjAffineSet(cpu);
      break;
    case 0x10:
      swiBitUnPack(cpu);
      break;
    case 0x11:
      cycles = swiLz77UnCompWram(cpu);
      break;
    case 0x12:
      cycles = swiLz77UnCompVram(cpu);
      break;
    case 0x13:
      swiHuffUnComp(cpu);
      break;
    case 0x14:
      swiRlUnCompWram(cpu);
      break;
    case 0x15:
      swiRlUnCompVram(cpu);
      break;
    case 0x16:
      swiDiffUnFilter(cpu, 1, false);
      break;
    case 0x17:
      swiDiffUnFilter(cpu, 1, true);
      break;
    case 0x18:
      swiDiffUnFilter(cpu, 2, false);
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
  return dispatch + cycles;
}

/**
 * Whether the BIOS reads from `source`. Every function that reads a source refuses one whose
 * address bits 25-27 are all clear — the BIOS itself, and its mirrors — and returns without
 * writing anything, which keeps the BIOS from being read out through it (mGBA bios.c "Cannot
 * CpuSet from BIOS"; checked on the real BIOS for 0x00000100, 0x01FFFFF0 and 0x10000100).
 */
function readableSource(source: number): boolean {
  return (source & 0x0e000000) !== 0;
}

/**
 * CpuSet's and CpuFastSet's check: a length in r2 that is not zero, and a source whose first byte
 * and the byte r2's count of words later both pass `readableSource` (the BIOS's check at 0xBA4).
 */
function readableBlock(source: number, control: number): boolean {
  const bytes = ((control << 11) >>> 9) & 0x01ffffff;
  return bytes !== 0 && readableSource(source) && readableSource((source + bytes) >>> 0);
}

// ─── Cycle costs ──────────────────────────────────────────────────

/**
 * The cycles every call spends in the BIOS's SWI dispatch and return code, which runs from the
 * zero-wait BIOS ROM, besides the `ldrb r12, [lr, #-2]` that reads the SWI number from the
 * caller's code. mGBA counts 45 cycles plus that load's wait states, and the return's refill of
 * the caller's pipeline (2 cycles and its wait states) is the SWI instruction's own branch back
 * (GBASwi16).
 */
const SWI_DISPATCH_CYCLES = 42;

function swiDispatchCycles(cpu: BiosCpu): number {
  // While the SWI executes, registers[15] is the return address, the BIOS's lr.
  const numberAddress = (cpu.registers[15]! - 2) >>> 0;
  return SWI_DISPATCH_CYCLES + cpu.memory.accessCycles(numberAddress, 1, false);
}

/**
 * The internal cycles of a multiply in the BIOS's code, by how many top bytes of the product are
 * sign bits (mGBA bios.c _mulWait).
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

/** ArcTan2 reduces the angle to an octant and runs ArcTan on the smaller coordinate over the larger (mGBA _ArcTan2). */
function arcTan2Cycles(xValue: number, yValue: number): number {
  const x = xValue | 0;
  const y = yValue | 0;
  if (x === 0 || y === 0) {
    return 11;
  }
  const yOverX = ((y << 14) / x) | 0;
  const xOverY = ((x << 14) / y) | 0;
  if (y >= 0) {
    if (x >= 0 ? x >= y : -x >= y) {
      return arcTanCycles(yOverX);
    }
    return arcTanCycles(xOverY);
  }
  if (x <= 0 ? -x > -y : x >= -y) {
    return arcTanCycles(yOverX);
  }
  return arcTanCycles(xOverY);
}

/**
 * CpuSet and CpuFastSet run a loop from the BIOS ROM (mGBA hle-bios.s): per unit a compare, a
 * load (N, then I), a store (N) and the branch back; a fill loads once before the loop instead.
 * CpuFastSet moves 8 words per LDM/STM pair. Around the loop, CpuFastSet spends 48 cycles, as
 * measured on hardware (mgba-suite Timing "CpuSet": 256 words EWRAM to EWRAM), and CpuSet 3
 * fewer, the difference between the two functions' setup and exit code in hle-bios.s.
 */
const CPUSET_FIXED_CYCLES = 45;
const CPUFASTSET_FIXED_CYCLES = 48;

function cpuSetCycles(cpu: BiosCpu, src: number, dst: number, count: number, width: 2 | 4, fill: boolean): number {
  const store = cpu.memory.accessCycles(dst, width, false);
  const load = cpu.memory.accessCycles(src, width, false);
  if (fill) {
    return CPUSET_FIXED_CYCLES + load + 1 + count * (5 + store);
  }
  return CPUSET_FIXED_CYCLES + count * (7 + load + store);
}

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
 * A larger numerator never leaves the BIOS's loop on hardware; it returns the same values here.
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
 *   r0 = the angle of (x, y), 0x0000..0xFFFF for 0..2*pi
 *   r1 = ArcTan's a for the ratio it took, unchanged on an axis
 *   r3 = 0x170, which the BIOS leaves there
 *
 * The BIOS reduces the angle to an octant and runs ArcTan on (smaller << 14) / larger, a 32-bit
 * signed division truncated toward zero (mGBA bios.c _ArcTan2).
 */
function swiArcTan2(cpu: BiosCpu): number {
  const x = cpu.registers[0]! | 0;
  const y = cpu.registers[1]! | 0;
  const cycles = arcTan2Cycles(x, y);
  let angle: number;
  if (y === 0) {
    angle = x >= 0 ? 0 : 0x8000;
  } else if (x === 0) {
    angle = y >= 0 ? 0x4000 : 0xc000;
  } else {
    const yOverX = (): number => arcTanOf(cpu, ((y << 14) / x) | 0);
    const xOverY = (): number => arcTanOf(cpu, ((x << 14) / y) | 0);
    if (y >= 0) {
      if (x >= 0 && x >= y) {
        angle = yOverX();
      } else if (x < 0 && -x >= y) {
        angle = yOverX() + 0x8000;
      } else {
        angle = 0x4000 - xOverY();
      }
    } else if (x <= 0 && -x > -y) {
      angle = yOverX() + 0x8000;
    } else if (x > 0 && x >= -y) {
      angle = yOverX() + 0x10000;
    } else {
      angle = 0xc000 - xOverY();
    }
  }
  cpu.registers[0] = angle & 0xffff;
  cpu.registers[3] = 0x170;
  return cycles;
}

/** ArcTan for ArcTan2: the angle, with the polynomial's a left in r1. */
function arcTanOf(cpu: BiosCpu, tan: number): number {
  const { angle, a } = arcTan(tan);
  cpu.registers[1] = a >>> 0;
  return angle;
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
  if (!readableBlock(src, control)) {
    return 0;
  }
  const cycles = cpuSetCycles(cpu, src, dst, count, word32 ? 4 : 2, fill);

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
  if (!readableBlock(src, control)) {
    return 0;
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
function swiBgAffineSet(cpu: BiosCpu): void {
  let src = cpu.registers[0]! >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  let count = cpu.registers[2]! >>> 0;

  while (count--) {
    const ox = cpu.memory.read32(src) | 0;
    const oy = cpu.memory.read32((src + 4) >>> 0) | 0;
    const cx = toS16(cpu.memory.read16((src + 8) >>> 0));
    const cy = toS16(cpu.memory.read16((src + 10) >>> 0));
    const sx = toS16(cpu.memory.read16((src + 12) >>> 0));
    const sy = toS16(cpu.memory.read16((src + 14) >>> 0));
    const angle = cpu.memory.read16((src + 16) >>> 0);
    src = (src + 20) >>> 0;

    const [pa, pb, pc, pd] = affineMatrix(sx, sy, angle);
    cpu.memory.write16(dst, pa & 0xffff);
    cpu.memory.write16((dst + 2) >>> 0, pb & 0xffff);
    cpu.memory.write16((dst + 4) >>> 0, pc & 0xffff);
    cpu.memory.write16((dst + 6) >>> 0, pd & 0xffff);
    cpu.memory.write32((dst + 8) >>> 0, (ox - Math.imul(pa, cx) - Math.imul(pb, cy)) >>> 0);
    cpu.memory.write32((dst + 12) >>> 0, (oy - Math.imul(pc, cx) - Math.imul(pd, cy)) >>> 0);
    dst = (dst + 16) >>> 0;
  }
  cpu.registers[0] = src;
  cpu.registers[1] = dst;
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
function swiObjAffineSet(cpu: BiosCpu): void {
  let src = cpu.registers[0]! >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  const count = cpu.registers[2]! >>> 0;
  const stride = cpu.registers[3]! >>> 0;

  for (let i = 0; i < count; i++) {
    const sx = toS16(cpu.memory.read16(src));
    const sy = toS16(cpu.memory.read16((src + 2) >>> 0));
    const angle = cpu.memory.read16((src + 4) >>> 0);

    affineMatrix(sx, sy, angle).forEach((value, k) => {
      cpu.memory.write16((dst + k * stride) >>> 0, value & 0xffff);
    });

    src = (src + 8) >>> 0;
    dst = (dst + stride * 4) >>> 0;
  }
  cpu.registers[0] = src;
  cpu.registers[1] = dst;
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
 * Units fill 32-bit words from the low bits up, and the BIOS stores each word once it is full: a
 * last partial word stays unwritten, and r3 ends as the count of its bits. A unit the offset
 * carries past its width spills into the next unit's bits (mGBA bios.c _unBitPack; checked
 * against the real BIOS).
 */
function swiBitUnPack(cpu: BiosCpu): void {
  let src = cpu.registers[0]! >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  const infoPtr = cpu.registers[2]! >>> 0;
  if (!readableSource(src)) {
    return;
  }

  const srcLength = cpu.memory.read16(infoPtr);
  const srcBitWidth = cpu.memory.read8((infoPtr + 2) >>> 0);
  const dstBitWidth = cpu.memory.read8((infoPtr + 3) >>> 0);
  const dataOffset = cpu.memory.read32((infoPtr + 4) >>> 0);

  const addToZero = (dataOffset & 0x80000000) !== 0;
  const offsetValue = dataOffset & 0x7fffffff;
  const srcMask = (1 << srcBitWidth) - 1;
  let word = 0;
  let bitsUsed = 0;

  for (let byteIdx = 0; byteIdx < srcLength; byteIdx++) {
    const srcByte = cpu.memory.read8(src);
    src = (src + 1) >>> 0;
    for (let bitPos = 0; bitPos < 8; bitPos += srcBitWidth) {
      let value = (srcByte >>> bitPos) & srcMask;
      if (value !== 0 || addToZero) {
        value += offsetValue;
      }
      word = (word | (value << bitsUsed)) >>> 0;
      bitsUsed += dstBitWidth;
      if (bitsUsed === 32) {
        cpu.memory.write32(dst, word);
        dst = (dst + 4) >>> 0;
        word = 0;
        bitsUsed = 0;
      }
    }
  }
  cpu.registers[0] = src;
  cpu.registers[1] = dst;
  cpu.registers[3] = bitsUsed;
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
      return this.#memory.accessCycles(address, 1, false);
    }
    if ((address & 1) === 0) {
      this.#held = byte;
      return 0;
    }
    const halfword = (address & ~1) >>> 0;
    this.#memory.write16(halfword, this.#held | (byte << 8));
    return this.#memory.accessCycles(halfword, 2, false);
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
function lz77Decompress(cpu: BiosCpu, useHalfwordWrites: boolean): number {
  let src = cpu.registers[0]! >>> 0;
  if (!readableSource(src)) {
    return 0;
  }

  // The BIOS's cycles, counted the way mGBA's _unLz77 counts them: a load is its access plus an I
  // cycle, a store its access, and each pass of the loop adds the instructions around them.
  const memory = cpu.memory;
  const load = (address: number, width: 1 | 2 | 4): number => memory.accessCycles(address, width, false) + 1;
  let cycles = 20 + load(src, 4);

  let remaining = memory.read32(src) >>> 8;
  src = (src + 4) >>> 0;
  const output = new DecompressorOutput(memory, cpu.registers[1]! >>> 0, useHalfwordWrites);

  while (remaining > 0) {
    cycles += 14 + load(src, 1);
    const flags = memory.read8(src);
    src = (src + 1) >>> 0;

    for (let i = 7; i >= 0 && remaining > 0; i--) {
      cycles += 14 + 18;
      if ((flags >> i) & 1) {
        cycles += load(src, 1) + load((src + 1) >>> 0, 1);
        const byte1 = memory.read8(src);
        const byte2 = memory.read8((src + 1) >>> 0);
        src = (src + 2) >>> 0;

        const length = ((byte1 >> 4) & 0xf) + 3;
        let from = (output.address - (((byte1 & 0xf) << 8) | byte2) - 1) >>> 0;
        for (let j = 0; j < length; j++) {
          cycles += useHalfwordWrites ? 10 + load(from & ~1, 2) + 4 : 10 + load(from, 1);
          cycles += output.put(output.read(from));
          from = (from + 1) >>> 0;
          remaining--;
        }
      } else {
        cycles += load(src, 1);
        cycles += output.put(memory.read8(src));
        src = (src + 1) >>> 0;
        remaining--;
      }
    }
  }
  cpu.registers[0] = src;
  cpu.registers[1] = output.end;
  cpu.registers[3] = output.heldByte;
  return cycles;
}

function swiLz77UnCompWram(cpu: BiosCpu): number {
  return lz77Decompress(cpu, false);
}

function swiLz77UnCompVram(cpu: BiosCpu): number {
  return lz77Decompress(cpu, true);
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
function rlDecompress(cpu: BiosCpu, useHalfwordWrites: boolean): void {
  let src = cpu.registers[0]! >>> 0;
  if (!readableSource(src)) {
    return;
  }
  const memory = cpu.memory;
  let remaining = memory.read32(src) >>> 8;
  src = (src + 4) >>> 0;
  const output = new DecompressorOutput(memory, cpu.registers[1]! >>> 0, useHalfwordWrites);

  while (remaining > 0) {
    const flag = memory.read8(src);
    src = (src + 1) >>> 0;
    if (flag & 0x80) {
      const length = (flag & 0x7f) + 3;
      const data = memory.read8(src);
      src = (src + 1) >>> 0;
      for (let i = 0; i < length; i++) {
        output.put(data);
      }
      remaining -= length;
    } else {
      const length = (flag & 0x7f) + 1;
      for (let i = 0; i < length; i++) {
        output.put(memory.read8(src));
        src = (src + 1) >>> 0;
      }
      remaining -= length;
    }
  }
  cpu.registers[0] = src;
  cpu.registers[1] = output.end;
  cpu.registers[3] = 0x170;
}

function swiRlUnCompWram(cpu: BiosCpu): void {
  rlDecompress(cpu, false);
}

function swiRlUnCompVram(cpu: BiosCpu): void {
  rlDecompress(cpu, true);
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
 */
function swiHuffUnComp(cpu: BiosCpu): void {
  const src = cpu.registers[0]! >>> 0;
  const dst = cpu.registers[1]! >>> 0;
  if (!readableSource(src)) {
    return;
  }

  const header = cpu.memory.read32(src);
  const bits = header & 0xf; // 4 or 8
  const decompSize = header >>> 8;

  if (decompSize === 0) {
    return;
  }

  // Tree table
  const treeSizeByte = cpu.memory.read8((src + 4) >>> 0);
  const treeBytes = (treeSizeByte << 1) + 1;
  const treeBase = (src + 5) >>> 0; // memory address of root node

  // Bitstream starts after the tree, aligned to 4 bytes
  let streamPos = (treeBase + treeBytes + 3) & ~3;

  let remaining = decompSize;
  let dstPos = dst;
  let block = 0;
  let bitsSeen = 0;

  // Current node pointer (memory address in the tree)
  let nPointer = treeBase;

  while (remaining > 0) {
    const bitstream = cpu.memory.read32(streamPos);
    streamPos = (streamPos + 4) >>> 0;

    for (let i = 31; i >= 0 && remaining > 0; i--) {
      const currentBit = (bitstream >>> i) & 1;
      const node = cpu.memory.read8(nPointer);
      const offset = node & 0x3f;

      // Child pair address (mgba formula)
      const next = ((nPointer & ~1) + offset * 2 + 2) >>> 0;

      const isRight = currentBit === 1;
      const childAddr = isRight ? (next + 1) >>> 0 : next;
      const isLeaf = isRight ? !!(node & 0x40) : !!(node & 0x80);

      if (isLeaf) {
        const value = cpu.memory.read8(childAddr);
        block |= (value & ((1 << bits) - 1)) << bitsSeen;
        bitsSeen += bits;

        if (bitsSeen >= 32) {
          cpu.memory.write32(dstPos, block >>> 0);
          dstPos = (dstPos + 4) >>> 0;
          remaining -= 4;
          block = 0;
          bitsSeen = 0;
        }

        // Reset to root
        nPointer = treeBase;
      } else {
        nPointer = childAddr;
      }
    }
  }
  cpu.registers[0] = streamPos;
  cpu.registers[1] = dstPos;
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
 * against the real BIOS).
 */
function swiDiffUnFilter(cpu: BiosCpu, unitBytes: 1 | 2, vram: boolean): void {
  let src = cpu.registers[0]! >>> 0;
  if (!readableSource(src)) {
    return;
  }
  const memory = cpu.memory;
  const size = memory.read32(src) >>> 8;
  src = (src + 4) >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  const output = new DecompressorOutput(memory, dst, vram);
  let unit = 0;
  let difference = 0;
  for (let remaining = size; remaining > 0; remaining -= unitBytes) {
    if (unitBytes === 1) {
      unit = (unit + memory.read8(src)) & 0xff;
      output.put(unit);
    } else {
      difference = memory.read16(src);
      unit = (unit + difference) & 0xffff;
      memory.write16(dst, unit);
      dst = (dst + 2) >>> 0;
    }
    src = (src + unitBytes) >>> 0;
  }
  cpu.registers[0] = src;
  cpu.registers[1] = unitBytes === 1 ? output.end : dst;
  cpu.registers[3] = unitBytes === 1 ? 0x170 : difference;
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
