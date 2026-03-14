/**
 * ARM7TDMI HLE BIOS — High-Level Emulation of GBA BIOS calls
 *
 * Instead of running real BIOS ROM, we intercept SWI instructions and
 * implement the behavior in TypeScript. This is faster and doesn't
 * require a BIOS dump.
 *
 * Reference: GBATEK - GBA BIOS Functions
 * http://problemkaputt.de/gbatek-gba-bios-functions.htm
 */
import type { MemoryBus } from '@gba-kit/arm-emulator';

/**
 * Interface for the CPU that BIOS calls need access to.
 * Uses duck typing to avoid circular imports with ArmCpu.
 */
interface BiosCpu {
  readonly registers: Uint32Array;
  readonly memory: MemoryBus;
}

/**
 * GBA Interrupt Controller memory layout:
 *   0x04000200 - IE  (Interrupt Enable)
 *   0x04000202 - IF  (Interrupt Flags)
 *   0x04000208 - IME (Interrupt Master Enable)
 *
 * BIOS IntrWait mechanics:
 *   The BIOS IRQ handler acknowledges interrupts in IF and also sets bits
 *   at 0x03007FF8 (IWRAM). The IntrWait SWI checks this location.
 *   We implement Halt/IntrWait/VBlankIntrWait by writing to HALTCNT (0x04000301)
 *   which the system bus handles by setting interrupts.halted = true.
 */

/**
 * Callback to set IntrWait flags on the interrupt controller.
 * Set by the GBA coordinator to wire HLE IntrWait to the interrupt system.
 */
let intrWaitCallback: ((flags: number) => void) | null = null;

/** Register the IntrWait callback (called by GBA during setup) */
export function setIntrWaitCallback(cb: (flags: number) => void): void {
  intrWaitCallback = cb;
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
 */
export function handleSwi(cpu: BiosCpu, swiNumber: number): void {
  switch (swiNumber) {
    case 0x06:
      swiDiv(cpu);
      break;
    case 0x07:
      swiDivArm(cpu);
      break;
    case 0x08:
      swiSqrt(cpu);
      break;
    case 0x09:
      swiArcTan(cpu);
      break;
    case 0x0a:
      swiArcTan2(cpu);
      break;
    case 0x0b:
      swiCpuSet(cpu);
      break;
    case 0x0c:
      swiCpuFastSet(cpu);
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
      swiLz77UnCompWram(cpu);
      break;
    case 0x12:
      swiLz77UnCompVram(cpu);
      break;
    case 0x14:
      swiRlUnCompWram(cpu);
      break;
    case 0x13:
      swiHuffUnComp(cpu);
      break;
    case 0x15:
      swiRlUnCompVram(cpu);
      break;
    case 0x02: // Halt
      swiHalt(cpu);
      break;
    case 0x04: // IntrWait
      swiIntrWait(cpu);
      break;
    case 0x05: // VBlankIntrWait
      swiVBlankIntrWait(cpu);
      break;
    case 0x19: // MidiKey2Freq
      swiMidiKey2Freq(cpu);
      break;
    case 0x1d: // SoundDriverVSync — no-op; most m4a games handle VSync inline
      break;
    default:
      break;
  }
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
 */
function swiDiv(cpu: BiosCpu): void {
  const numerator = cpu.registers[0]! | 0;
  const denominator = cpu.registers[1]! | 0;

  if (denominator === 0) {
    // Division by zero — undefined behavior, but real BIOS hangs.
    // We return 0 to avoid infinite loops.
    cpu.registers[0] = 0;
    cpu.registers[1] = 0;
    cpu.registers[3] = 0;
    return;
  }

  // JavaScript integer division truncates toward zero (like C99)
  const quotient = (numerator / denominator) | 0;
  const remainder = (numerator % denominator) | 0;

  cpu.registers[0] = quotient >>> 0;
  cpu.registers[1] = remainder >>> 0;
  cpu.registers[3] = Math.abs(quotient) >>> 0;
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
function swiDivArm(cpu: BiosCpu): void {
  // Swap r0 and r1, then call Div
  const temp = cpu.registers[0]!;
  cpu.registers[0] = cpu.registers[1]!;
  cpu.registers[1] = temp;
  swiDiv(cpu);
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
 */
function swiSqrt(cpu: BiosCpu): void {
  const value = cpu.registers[0]! >>> 0;
  cpu.registers[0] = Math.floor(Math.sqrt(value)) >>> 0;
}

// ─── SWI 0x09: ArcTan ──────────────────────────────────────────────

/**
 * SWI 0x09 — ArcTan: Arctangent.
 *
 * Input:
 *   r0 = tan (signed, 1.14 fixed point: -1.0 to +1.0 range => -0x4000 to +0x4000)
 *
 * Output:
 *   r0 = arctan(r0) in range -0x4000 to +0x4000 (representing -pi/4 to +pi/4)
 *         Actually returns in range 0xC000..0x4000 (signed), representing -pi/2..+pi/2
 */
function swiArcTan(cpu: BiosCpu): void {
  // r0 is a signed 16-bit fixed-point 1.14 value
  const tan = (cpu.registers[0]! << 16) >> 16; // sign-extend to 32-bit
  // Convert from 1.14 fixed point to float
  const tanF = tan / 0x4000;
  // Compute arctan
  const result = Math.atan(tanF);
  // Convert back to fixed-point: result is in (-pi/2, pi/2),
  // scale so that pi/2 = 0x4000
  const scaled = Math.round((result / (Math.PI / 2)) * 0x4000);
  cpu.registers[0] = scaled & 0xffff;
}

// ─── SWI 0x0A: ArcTan2 ─────────────────────────────────────────────

/**
 * SWI 0x0A — ArcTan2: Four-quadrant arctangent.
 *
 * Input:
 *   r0 = x (signed 16-bit fixed-point 1.14)
 *   r1 = y (signed 16-bit fixed-point 1.14)
 *
 * Output:
 *   r0 = arctan2(y, x) in range 0x0000..0xFFFF (representing 0..2*pi)
 */
function swiArcTan2(cpu: BiosCpu): void {
  const x = (cpu.registers[0]! << 16) >> 16;
  const y = (cpu.registers[1]! << 16) >> 16;

  if (x === 0 && y === 0) {
    cpu.registers[0] = 0;
    return;
  }

  const xf = x / 0x4000;
  const yf = y / 0x4000;
  let angle = Math.atan2(yf, xf); // -pi to pi

  // Convert to 0..2*pi
  if (angle < 0) {
    angle += 2 * Math.PI;
  }

  // Scale to 0..0x10000 (full circle), wrap to 16 bits
  const scaled = Math.round((angle / (2 * Math.PI)) * 0x10000) & 0xffff;
  cpu.registers[0] = scaled;
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
function swiCpuSet(cpu: BiosCpu): void {
  let src = cpu.registers[0]! >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  const control = cpu.registers[2]! >>> 0;

  const count = control & 0x1fffff;
  const fill = (control & (1 << 24)) !== 0;
  const word32 = (control & (1 << 26)) !== 0;

  if (word32) {
    // 32-bit transfers
    const fillValue = cpu.memory.read32(src);
    for (let i = 0; i < count; i++) {
      const value = fill ? fillValue : cpu.memory.read32(src);
      cpu.memory.write32(dst, value);
      if (!fill) {
        src = (src + 4) >>> 0;
      }
      dst = (dst + 4) >>> 0;
    }
  } else {
    // 16-bit transfers
    const fillValue = cpu.memory.read16(src);
    for (let i = 0; i < count; i++) {
      const value = fill ? fillValue : cpu.memory.read16(src);
      cpu.memory.write16(dst, value);
      if (!fill) {
        src = (src + 2) >>> 0;
      }
      dst = (dst + 2) >>> 0;
    }
  }
}

// ─── SWI 0x0C: CpuFastSet ──────────────────────────────────────────

/**
 * SWI 0x0C — CpuFastSet: Fast memory copy or fill (32-bit only, 32-byte blocks).
 *
 * Input:
 *   r0 = source address (must be word-aligned)
 *   r1 = destination address (must be word-aligned)
 *   r2 = length/mode:
 *     bits 20-0:  word count (rounded up to multiple of 8)
 *     bit 24:     0=copy, 1=fill
 *
 * Always operates in 32-bit mode, in blocks of 8 words (32 bytes).
 */
function swiCpuFastSet(cpu: BiosCpu): void {
  let src = cpu.registers[0]! >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  const control = cpu.registers[2]! >>> 0;

  let count = control & 0x1fffff;
  const fill = (control & (1 << 24)) !== 0;

  // Round up to multiple of 8
  count = (count + 7) & ~7;

  const fillValue = cpu.memory.read32(src);
  for (let i = 0; i < count; i++) {
    const value = fill ? fillValue : cpu.memory.read32(src);
    cpu.memory.write32(dst, value);
    if (!fill) {
      src = (src + 4) >>> 0;
    }
    dst = (dst + 4) >>> 0;
  }
}

// ─── SWI 0x0E: BgAffineSet ─────────────────────────────────────────

/**
 * SWI 0x0E — BgAffineSet: Compute background affine transformation parameters.
 *
 * Computes rotation/scaling/translation matrix for affine backgrounds.
 * The transformation is: Scale × Rotation × Translation, producing the
 * pa/pb/pc/pd matrix coefficients and startX/startY offsets.
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
 *   s16 pa (+0, 8.8 fixed)
 *   s16 pb (+2, 8.8 fixed)
 *   s16 pc (+4, 8.8 fixed)
 *   s16 pd (+6, 8.8 fixed)
 *   s32 startX (+8, 8.8 fixed)
 *   s32 startY (+12, 8.8 fixed)
 *
 * Formula:
 *   theta = (angle >> 8) / 128 * PI
 *   pa = sx * cos(theta),  pb = -sx * sin(theta)
 *   pc = sy * sin(theta),  pd =  sy * cos(theta)
 *   startX = srcX - (pa * dstX + pb * dstY)
 *   startY = srcY - (pc * dstX + pd * dstY)
 *
 * Reference: GBATEK "BgAffineSet" / mgba src/gba/bios.c _BgAffineSet
 */
function swiBgAffineSet(cpu: BiosCpu): void {
  let src = cpu.registers[0]! >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  let count = cpu.registers[2]! >>> 0;

  while (count--) {
    // Read source struct (20 bytes)
    // srcX/srcY are s32 in 8.8 fixed point → divide by 256 to get float
    const ox = toS32(cpu.memory.read32(src)) / 256;
    const oy = toS32(cpu.memory.read32((src + 4) >>> 0)) / 256;
    // dstX/dstY are plain s16 integers (display center)
    const cx = toS16(cpu.memory.read16((src + 8) >>> 0));
    const cy = toS16(cpu.memory.read16((src + 10) >>> 0));
    // scaleX/scaleY are s16 in 8.8 fixed point
    const sx = toS16(cpu.memory.read16((src + 12) >>> 0)) / 256;
    const sy = toS16(cpu.memory.read16((src + 14) >>> 0)) / 256;
    // Angle: only upper 8 bits used, mapped to 0..2*PI
    const theta = (cpu.memory.read16((src + 16) >>> 0) >> 8) * (Math.PI / 128);
    src = (src + 20) >>> 0;

    // Rotation
    const cosA = Math.cos(theta);
    const sinA = Math.sin(theta);

    // Scale × Rotation
    const pa = sx * cosA;
    const pb = -sx * sinA;
    const pc = sy * sinA;
    const pd = sy * cosA;

    // Translation: offset so the display center maps to the source center
    const rx = ox - (pa * cx + pb * cy);
    const ry = oy - (pc * cx + pd * cy);

    // Write destination struct (16 bytes), all values stored as 8.8 fixed point
    cpu.memory.write16(dst, toFixed8_8(pa));
    cpu.memory.write16((dst + 2) >>> 0, toFixed8_8(pb));
    cpu.memory.write16((dst + 4) >>> 0, toFixed8_8(pc));
    cpu.memory.write16((dst + 6) >>> 0, toFixed8_8(pd));
    cpu.memory.write32((dst + 8) >>> 0, toFixed8_8_32(rx));
    cpu.memory.write32((dst + 12) >>> 0, toFixed8_8_32(ry));
    dst = (dst + 16) >>> 0;
  }
}

/** Interpret a u32 read as signed 32-bit */
function toS32(v: number): number {
  return v | 0;
}

/** Interpret a u16 read as signed 16-bit */
function toS16(v: number): number {
  return (v << 16) >> 16;
}

/** Convert float to 8.8 fixed-point, masked to 16 bits */
function toFixed8_8(v: number): number {
  return Math.round(v * 256) & 0xffff;
}

/** Convert float to 8.8 fixed-point as 32-bit value */
function toFixed8_8_32(v: number): number {
  return Math.round(v * 256) >>> 0;
}

// ─── SWI 0x0F: ObjAffineSet ────────────────────────────────────────

/**
 * SWI 0x0F — ObjAffineSet: Compute affine transformation parameters.
 *
 * Input:
 *   r0 = source address (ObjAffineSource struct array)
 *   r1 = destination address (ObjAffineDest struct or OAM)
 *   r2 = number of calculations
 *   r3 = offset between dest structs (2 for BG, 8 for OBJ)
 *
 * ObjAffineSource (8 bytes):
 *   s16 sx  (scale X, 8.8 fixed point)
 *   s16 sy  (scale Y, 8.8 fixed point)
 *   u16 theta (angle, 0-0xFFFF = 0-360 degrees)
 *
 * Output (4 s16 values at dest, spaced by r3*2 bytes):
 *   pa = sx * cos(theta)
 *   pb = -sx * sin(theta)
 *   pc = sy * sin(theta)
 *   pd = sy * cos(theta)
 */
function swiObjAffineSet(cpu: BiosCpu): void {
  let src = cpu.registers[0]! >>> 0;
  let dst = cpu.registers[1]! >>> 0;
  const count = cpu.registers[2]! >>> 0;
  const offset = cpu.registers[3]! >>> 0;

  for (let i = 0; i < count; i++) {
    // Read source
    const sx = (cpu.memory.read16(src) << 16) >> 16; // signed
    const sy = (cpu.memory.read16((src + 2) >>> 0) << 16) >> 16;
    const theta = cpu.memory.read16((src + 4) >>> 0);

    // Convert angle: 0x10000 = 2*PI
    const angle = (theta / 0x10000) * 2 * Math.PI;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // Compute affine parameters (8.8 fixed point)
    // sx/sy are already in 8.8 fixed point, result should also be 8.8
    const pa = Math.round(sx * cosA) & 0xffff;
    const pb = Math.round(-sx * sinA) & 0xffff;
    const pc = Math.round(sy * sinA) & 0xffff;
    const pd = Math.round(sy * cosA) & 0xffff;

    // Write to destination with stride
    const stride = offset * 2;
    cpu.memory.write16(dst, pa);
    cpu.memory.write16((dst + stride) >>> 0, pb);
    cpu.memory.write16((dst + stride * 2) >>> 0, pc);
    cpu.memory.write16((dst + stride * 3) >>> 0, pd);

    src = (src + 8) >>> 0; // Next source entry
    dst = (dst + stride * 4) >>> 0; // Next dest block
  }
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
 */
function swiBitUnPack(cpu: BiosCpu): void {
  const src = cpu.registers[0]! >>> 0;
  const dst = cpu.registers[1]! >>> 0;
  const infoPtr = cpu.registers[2]! >>> 0;

  const srcLength = cpu.memory.read16(infoPtr);
  const srcBitWidth = cpu.memory.read8((infoPtr + 2) >>> 0);
  const dstBitWidth = cpu.memory.read8((infoPtr + 3) >>> 0);
  const dataOffset = cpu.memory.read32((infoPtr + 4) >>> 0);

  const addToZero = (dataOffset & 0x80000000) !== 0;
  const offsetValue = dataOffset & 0x7fffffff;

  const srcMask = (1 << srcBitWidth) - 1;
  let dstAddr = dst;
  let dstBuffer = 0;
  let dstBitsUsed = 0;

  for (let byteIdx = 0; byteIdx < srcLength; byteIdx++) {
    const srcByte = cpu.memory.read8((src + byteIdx) >>> 0);
    for (let bitPos = 0; bitPos < 8; bitPos += srcBitWidth) {
      let value = (srcByte >>> bitPos) & srcMask;

      if (value !== 0 || addToZero) {
        value += offsetValue;
      }

      // Mask to destination width
      value &= (1 << dstBitWidth) - 1;

      dstBuffer |= value << dstBitsUsed;
      dstBitsUsed += dstBitWidth;

      if (dstBitsUsed >= 32) {
        cpu.memory.write32(dstAddr, dstBuffer >>> 0);
        dstAddr = (dstAddr + 4) >>> 0;
        dstBuffer = 0;
        dstBitsUsed = 0;
      }
    }
  }

  // Flush remaining bits
  if (dstBitsUsed > 0) {
    cpu.memory.write32(dstAddr, dstBuffer >>> 0);
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
 */
function lz77Decompress(cpu: BiosCpu, useHalfwordWrites: boolean): void {
  const src = cpu.registers[0]! >>> 0;
  const dst = cpu.registers[1]! >>> 0;

  // Read header
  const header = cpu.memory.read32(src);
  const decompSize = header >>> 8;

  // Decompress to a local buffer first, then write to destination.
  // This avoids a bug where VRAM halfword writes delay flushing by one byte,
  // causing back-references to read stale data from memory.
  const buffer = new Uint8Array(decompSize);

  let srcPos = (src + 4) >>> 0;
  let bufPos = 0;

  while (bufPos < decompSize) {
    // Read flag byte
    const flags = cpu.memory.read8(srcPos);
    srcPos = (srcPos + 1) >>> 0;

    for (let i = 7; i >= 0 && bufPos < decompSize; i--) {
      if ((flags >> i) & 1) {
        // Compressed: reference
        const byte1 = cpu.memory.read8(srcPos);
        srcPos = (srcPos + 1) >>> 0;
        const byte2 = cpu.memory.read8(srcPos);
        srcPos = (srcPos + 1) >>> 0;

        const length = ((byte1 >> 4) & 0xf) + 3;
        const displacement = (((byte1 & 0xf) << 8) | byte2) + 1;

        for (let j = 0; j < length && bufPos < decompSize; j++) {
          buffer[bufPos] = buffer[bufPos - displacement]!;
          bufPos++;
        }
      } else {
        // Uncompressed: copy 1 byte
        buffer[bufPos] = cpu.memory.read8(srcPos);
        bufPos++;
        srcPos = (srcPos + 1) >>> 0;
      }
    }
  }

  // Write buffer to destination
  let dstPos = dst;
  if (useHalfwordWrites) {
    // VRAM: write as halfwords
    const alignedLen = decompSize & ~1;
    for (let i = 0; i < alignedLen; i += 2) {
      cpu.memory.write16(dstPos, buffer[i]! | (buffer[i + 1]! << 8));
      dstPos = (dstPos + 2) >>> 0;
    }
    if (decompSize & 1) {
      // Flush remaining byte as halfword (low byte only)
      cpu.memory.write16(dstPos, buffer[decompSize - 1]!);
    }
  } else {
    // WRAM: write as bytes
    for (let i = 0; i < decompSize; i++) {
      cpu.memory.write8(dstPos, buffer[i]!);
      dstPos = (dstPos + 1) >>> 0;
    }
  }
}

function swiLz77UnCompWram(cpu: BiosCpu): void {
  lz77Decompress(cpu, false);
}

function swiLz77UnCompVram(cpu: BiosCpu): void {
  lz77Decompress(cpu, true);
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
 */
function rlDecompress(cpu: BiosCpu, useHalfwordWrites: boolean): void {
  const src = cpu.registers[0]! >>> 0;
  const dst = cpu.registers[1]! >>> 0;

  const header = cpu.memory.read32(src);
  const decompSize = header >>> 8;

  // Decompress to local buffer then write out (same pattern as LZ77)
  const buffer = new Uint8Array(decompSize);

  let srcPos = (src + 4) >>> 0;
  let bufPos = 0;

  while (bufPos < decompSize) {
    const flag = cpu.memory.read8(srcPos);
    srcPos = (srcPos + 1) >>> 0;

    if (flag & 0x80) {
      // Compressed run
      const length = (flag & 0x7f) + 3;
      const data = cpu.memory.read8(srcPos);
      srcPos = (srcPos + 1) >>> 0;
      for (let i = 0; i < length && bufPos < decompSize; i++) {
        buffer[bufPos++] = data;
      }
    } else {
      // Uncompressed run
      const length = (flag & 0x7f) + 1;
      for (let i = 0; i < length && bufPos < decompSize; i++) {
        buffer[bufPos++] = cpu.memory.read8(srcPos);
        srcPos = (srcPos + 1) >>> 0;
      }
    }
  }

  // Write buffer to destination
  let dstPos = dst;
  if (useHalfwordWrites) {
    const alignedLen = decompSize & ~1;
    for (let i = 0; i < alignedLen; i += 2) {
      cpu.memory.write16(dstPos, buffer[i]! | (buffer[i + 1]! << 8));
      dstPos = (dstPos + 2) >>> 0;
    }
    if (decompSize & 1) {
      cpu.memory.write16(dstPos, buffer[decompSize - 1]!);
    }
  } else {
    for (let i = 0; i < decompSize; i++) {
      cpu.memory.write8(dstPos, buffer[i]!);
      dstPos = (dstPos + 1) >>> 0;
    }
  }
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
}

// ─── SWI 0x02: Halt ──────────────────────────────────────────────

/**
 * SWI 0x02 — Halt: Halt CPU until any interrupt.
 *
 * Writes to HALTCNT to put the CPU into low-power halt state.
 * The CPU resumes when any enabled interrupt fires.
 */
function swiHalt(cpu: BiosCpu): void {
  // Write to HALTCNT (0x04000301) to trigger halt
  cpu.memory.write8(0x04000301, 0);
}

// ─── SWI 0x04: IntrWait ─────────────────────────────────────────

/**
 * SWI 0x04 — IntrWait: Wait for specific interrupt(s).
 *
 * Input:
 *   r0 = 1: discard old flags first; 0: check existing flags
 *   r1 = interrupt flags to wait for (same bits as IE/IF)
 *
 * On real hardware, this loops checking IF at 0x03007FF8 (BIOS mirror).
 * We implement it by:
 * 1. Optionally clearing the requested flags in the BIOS IF mirror
 * 2. Setting the CPU to halt state
 *
 * The GBA coordinator's halt logic will fast-forward to the next event,
 * and IRQ handling will wake the CPU.
 */
function swiIntrWait(cpu: BiosCpu): void {
  const discardOld = cpu.registers[0]!;
  const waitFlags = cpu.registers[1]! & 0x3fff;

  if (discardOld) {
    // Clear the requested flags in the BIOS IF mirror at 0x03007FF8
    const biosIf = cpu.memory.read16(0x03007ff8);
    cpu.memory.write16(0x03007ff8, biosIf & ~waitFlags);
  }

  // Check if the interrupt has already occurred
  const biosIf = cpu.memory.read16(0x03007ff8);
  if (biosIf & waitFlags) {
    // Already happened — clear and return immediately
    cpu.memory.write16(0x03007ff8, biosIf & ~waitFlags);
    return;
  }

  // Set IntrWait flags so halt only breaks for the desired interrupt
  if (intrWaitCallback) {
    intrWaitCallback(waitFlags);
  }

  // Put CPU into halt state
  cpu.memory.write8(0x04000301, 0);
}

// ─── SWI 0x05: VBlankIntrWait ───────────────────────────────────

/**
 * SWI 0x05 — VBlankIntrWait: Wait for VBlank interrupt.
 *
 * Equivalent to IntrWait(1, 0x0001) — discard old flags, wait for VBlank.
 */
function swiVBlankIntrWait(cpu: BiosCpu): void {
  // Set up for VBlank wait
  cpu.registers[0] = 1; // Discard old flags
  cpu.registers[1] = 0x0001; // VBlank flag (bit 0 of IE/IF)
  swiIntrWait(cpu);
}

// ─── SWI 0x19: MidiKey2Freq ─────────────────────────────────────

/**
 * SWI 0x19 — MidiKey2Freq: Convert a MIDI key number to a playback
 * frequency rate for the m4a/mp2k sound engine.
 *
 * Input:
 *   r0 = pointer to WaveData (frequency at offset +4)
 *   r1 = MIDI key number (mk, 0-127)
 *   r2 = fine pitch adjustment (fp, 0-255)
 *
 * Returns:
 *   r0 = freq * 2^((180 - mk - fp/256) / 12)
 *
 * The wave frequency at [r0+4] is in Hz. The result is a fixed-point
 * rate value where key 60 (middle C) maps to freq * 1024.
 */
function swiMidiKey2Freq(cpu: BiosCpu): void {
  const waveData = cpu.registers[0]! >>> 0;
  const mk = cpu.registers[1]!;
  const fp = cpu.registers[2]!;

  const freq = cpu.memory.read32(waveData + 4);
  const shift = (180.0 - mk - fp / 256.0) / 12.0;
  cpu.registers[0] = (freq * Math.pow(2.0, shift)) >>> 0;
}
