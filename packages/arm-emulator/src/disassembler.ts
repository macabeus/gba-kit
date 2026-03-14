/**
 * ARM7TDMI Disassembler — ARM and Thumb instruction disassembly
 *
 * Produces clean, readable output matching standard ARM assembly notation.
 * Used by the debugger for instruction display.
 */
import { bit, bits, signExtend } from './utils.js';

// ─── Condition Code Strings ─────────────────────────────────────────

const COND_NAMES: readonly string[] = [
  'eq',
  'ne',
  'cs',
  'cc',
  'mi',
  'pl',
  'vs',
  'vc',
  'hi',
  'ls',
  'ge',
  'lt',
  'gt',
  'le',
  '',
  'nv',
];

/** ARM data processing opcode names */
const DP_NAMES: readonly string[] = [
  'and',
  'eor',
  'sub',
  'rsb',
  'add',
  'adc',
  'sbc',
  'rsc',
  'tst',
  'teq',
  'cmp',
  'cmn',
  'orr',
  'mov',
  'bic',
  'mvn',
];

const SHIFT_NAMES: readonly string[] = ['lsl', 'lsr', 'asr', 'ror'];

const REG_NAMES: readonly string[] = [
  'r0',
  'r1',
  'r2',
  'r3',
  'r4',
  'r5',
  'r6',
  'r7',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'sp',
  'lr',
  'pc',
];

/** Format a register name */
function reg(r: number): string {
  return REG_NAMES[r & 0xf]!;
}

/** Format a hex value */
function hex(v: number): string {
  if (v < 0) {
    return `-#0x${(-v >>> 0).toString(16)}`;
  }
  return `#0x${(v >>> 0).toString(16)}`;
}

/** Format an address */
function addr(v: number): string {
  return `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
}

/** Build a register list string like {r0, r2, r4-r7} */
function regList(mask: number, maxReg: number = 16): string {
  const parts: string[] = [];
  let i = 0;
  while (i < maxReg) {
    if (mask & (1 << i)) {
      const start = i;
      while (i + 1 < maxReg && mask & (1 << (i + 1))) {
        i++;
      }
      if (i === start) {
        parts.push(reg(start));
      } else if (i === start + 1) {
        parts.push(reg(start));
        parts.push(reg(i));
      } else {
        parts.push(`${reg(start)}-${reg(i)}`);
      }
    }
    i++;
  }
  return `{${parts.join(', ')}}`;
}

// ─── Thumb Disassembler ─────────────────────────────────────────────

/**
 * Disassemble a 16-bit Thumb instruction.
 *
 * @param instruction - The 16-bit instruction word
 * @param address - The address of the instruction (for PC-relative calculations)
 * @returns A human-readable disassembly string
 */
export function disassembleThumb(instruction: number, address: number): string {
  const instr = instruction & 0xffff;

  // Format 19: Long Branch with Link
  if ((instr & 0xf800) === 0xf000) {
    const offset11 = signExtend(instr & 0x7ff, 11);
    return `bl (prefix) ${hex(offset11 << 12)}`;
  }
  if ((instr & 0xf800) === 0xf800) {
    const offset11 = (instr & 0x7ff) << 1;
    return `bl (suffix) ${hex(offset11)}`;
  }

  // Format 18: Unconditional Branch
  if ((instr & 0xf800) === 0xe000) {
    const offset = signExtend(instr & 0x7ff, 11) * 2;
    const target = (address + 4 + offset) >>> 0;
    return `b ${addr(target)}`;
  }

  // Format 17: SWI
  if ((instr & 0xff00) === 0xdf00) {
    return `swi ${hex(instr & 0xff)}`;
  }

  // Format 16: Conditional Branch
  if ((instr & 0xf000) === 0xd000) {
    const cond = bits(instr, 11, 8);
    const offset = signExtend(instr & 0xff, 8) * 2;
    const target = (address + 4 + offset) >>> 0;
    return `b${COND_NAMES[cond]} ${addr(target)}`;
  }

  // Format 15: Multiple Load/Store
  if ((instr & 0xf000) === 0xc000) {
    const l = bit(instr, 11);
    const rb = bits(instr, 10, 8);
    const rlist = instr & 0xff;
    const op = l ? 'ldmia' : 'stmia';
    return `${op} ${reg(rb)}!, ${regList(rlist, 8)}`;
  }

  // Format 14: Push/Pop
  if ((instr & 0xf600) === 0xb400) {
    const l = bit(instr, 11);
    const r = bit(instr, 8);
    let rlist = instr & 0xff;
    if (l) {
      if (r) {
        rlist |= 1 << 15;
      } // PC
      return `pop ${regList(rlist)}`;
    } else {
      if (r) {
        rlist |= 1 << 14;
      } // LR
      return `push ${regList(rlist)}`;
    }
  }

  // Format 13: Add offset to SP
  if (((instr >>> 8) & 0xff) === 0xb0) {
    const s = bit(instr, 7);
    const offset = (instr & 0x7f) << 2;
    if (s === 0) {
      return `add sp, ${hex(offset)}`;
    } else {
      return `sub sp, ${hex(offset)}`;
    }
  }

  // Format 12: Load Address
  if ((instr & 0xf000) === 0xa000) {
    const sp = bit(instr, 11);
    const rd = bits(instr, 10, 8);
    const offset = (instr & 0xff) << 2;
    if (sp === 0) {
      return `add ${reg(rd)}, pc, ${hex(offset)}`;
    } else {
      return `add ${reg(rd)}, sp, ${hex(offset)}`;
    }
  }

  // Format 11: SP-relative Load/Store
  if ((instr & 0xf000) === 0x9000) {
    const l = bit(instr, 11);
    const rd = bits(instr, 10, 8);
    const offset = (instr & 0xff) << 2;
    const op = l ? 'ldr' : 'str';
    return `${op} ${reg(rd)}, [sp, ${hex(offset)}]`;
  }

  // Format 10: Halfword Load/Store Immediate
  if ((instr & 0xf000) === 0x8000) {
    const l = bit(instr, 11);
    const offset = bits(instr, 10, 6) << 1;
    const rb = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const op = l ? 'ldrh' : 'strh';
    return `${op} ${reg(rd)}, [${reg(rb)}, ${hex(offset)}]`;
  }

  // Format 9: Load/Store Immediate Offset
  if ((instr & 0xe000) === 0x6000) {
    const b = bit(instr, 12);
    const l = bit(instr, 11);
    const offset5 = bits(instr, 10, 6);
    const rb = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const offset = b === 0 ? offset5 << 2 : offset5;
    const suffix = b ? 'b' : '';
    const op = l ? 'ldr' : 'str';
    return `${op}${suffix} ${reg(rd)}, [${reg(rb)}, ${hex(offset)}]`;
  }

  // Format 8: Sign-Extended Load/Store
  if ((instr & 0xf200) === 0x5200) {
    const h = bit(instr, 11);
    const s = bit(instr, 10);
    const ro = bits(instr, 8, 6);
    const rb = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    let op: string;
    if (s === 0 && h === 0) {
      op = 'strh';
    } else if (s === 0 && h === 1) {
      op = 'ldrh';
    } else if (s === 1 && h === 0) {
      op = 'ldrsb';
    } else {
      op = 'ldrsh';
    }
    return `${op} ${reg(rd)}, [${reg(rb)}, ${reg(ro)}]`;
  }

  // Format 7: Register Offset Load/Store
  if ((instr & 0xf200) === 0x5000) {
    const l = bit(instr, 11);
    const b = bit(instr, 10);
    const ro = bits(instr, 8, 6);
    const rb = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const suffix = b ? 'b' : '';
    const op = l ? 'ldr' : 'str';
    return `${op}${suffix} ${reg(rd)}, [${reg(rb)}, ${reg(ro)}]`;
  }

  // Format 6: PC-Relative Load
  if ((instr & 0xf800) === 0x4800) {
    const rd = bits(instr, 10, 8);
    const offset = (instr & 0xff) << 2;
    const target = (((address + 4) & ~3) + offset) >>> 0;
    return `ldr ${reg(rd)}, [pc, ${hex(offset)}] ; =${addr(target)}`;
  }

  // Format 5: Hi Register Ops / BX
  if ((instr & 0xfc00) === 0x4400) {
    const op = bits(instr, 9, 8);
    const hd = bit(instr, 7);
    const hs = bit(instr, 6);
    const rs = bits(instr, 5, 3) | (hs << 3);
    const rd = bits(instr, 2, 0) | (hd << 3);
    switch (op) {
      case 0:
        return `add ${reg(rd)}, ${reg(rs)}`;
      case 1:
        return `cmp ${reg(rd)}, ${reg(rs)}`;
      case 2:
        return `mov ${reg(rd)}, ${reg(rs)}`;
      case 3:
        return `bx ${reg(rs)}`;
    }
  }

  // Format 4: ALU Operations
  if ((instr & 0xfc00) === 0x4000) {
    const op = bits(instr, 9, 6);
    const rs = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const aluOps = [
      'ands',
      'eors',
      'lsls',
      'lsrs',
      'asrs',
      'adcs',
      'sbcs',
      'rors',
      'tst',
      'negs',
      'cmp',
      'cmn',
      'orrs',
      'muls',
      'bics',
      'mvns',
    ];
    return `${aluOps[op]} ${reg(rd)}, ${reg(rs)}`;
  }

  // Format 3: Move/Compare/Add/Sub Immediate
  if ((instr & 0xe000) === 0x2000) {
    const op = bits(instr, 12, 11);
    const rd = bits(instr, 10, 8);
    const imm = instr & 0xff;
    const ops = ['movs', 'cmp', 'adds', 'subs'];
    return `${ops[op]} ${reg(rd)}, ${hex(imm)}`;
  }

  // Format 2: Add/Subtract
  if ((instr & 0xf800) === 0x1800) {
    const i = bit(instr, 10);
    const op = bit(instr, 9);
    const rn = bits(instr, 8, 6);
    const rs = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const opName = op ? 'subs' : 'adds';
    if (i) {
      return `${opName} ${reg(rd)}, ${reg(rs)}, ${hex(rn)}`;
    } else {
      return `${opName} ${reg(rd)}, ${reg(rs)}, ${reg(rn)}`;
    }
  }

  // Format 1: Move Shifted Register
  if ((instr & 0xe000) === 0x0000) {
    const op = bits(instr, 12, 11);
    const offset5 = bits(instr, 10, 6);
    const rs = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const shiftOps = ['lsls', 'lsrs', 'asrs'];
    if (op < 3) {
      return `${shiftOps[op]} ${reg(rd)}, ${reg(rs)}, ${hex(offset5)}`;
    }
  }

  return `dw 0x${instr.toString(16).padStart(4, '0')}`;
}

// ─── ARM Disassembler ───────────────────────────────────────────────

/** Format a barrel shifter operand for data processing */
function formatShifterOperand(instr: number, isImm: boolean): string {
  if (isImm) {
    const imm8 = instr & 0xff;
    const rotate = ((instr >>> 8) & 0xf) * 2;
    if (rotate === 0) {
      return `#0x${imm8.toString(16)}`;
    }
    const value = ((imm8 >>> rotate) | (imm8 << (32 - rotate))) >>> 0;
    return `#0x${value.toString(16)}`;
  }

  const rm = instr & 0xf;
  const shiftType = (instr >>> 5) & 3;
  const regShift = bit(instr, 4);

  if (regShift) {
    const rsReg = (instr >>> 8) & 0xf;
    return `${reg(rm)}, ${SHIFT_NAMES[shiftType]} ${reg(rsReg)}`;
  }

  const amount = (instr >>> 7) & 0x1f;
  if (amount === 0) {
    if (shiftType === 0) {
      return reg(rm); // LSL #0 is just Rm
    }
    if (shiftType === 3) {
      return `${reg(rm)}, rrx`;
    }
    // LSR #0 = LSR #32, ASR #0 = ASR #32
    return `${reg(rm)}, ${SHIFT_NAMES[shiftType]} #32`;
  }
  return `${reg(rm)}, ${SHIFT_NAMES[shiftType]} #${amount}`;
}

/**
 * Disassemble a 32-bit ARM instruction.
 *
 * @param instruction - The 32-bit instruction word
 * @param address - The address of the instruction (for PC-relative calculations)
 * @returns A human-readable disassembly string
 */
export function disassembleArm(instruction: number, address: number): string {
  const instr = instruction >>> 0;
  const cond = (instr >>> 28) & 0xf;
  const condStr = COND_NAMES[cond]!;

  // SWI
  if ((instr & 0x0f000000) === 0x0f000000) {
    const swiNum = instr & 0x00ffffff;
    return `swi${condStr} ${hex(swiNum)}`;
  }

  // Branch (B/BL)
  if ((instr & 0x0e000000) === 0x0a000000) {
    const link = bit(instr, 24);
    const offset = signExtend(instr & 0x00ffffff, 24) << 2;
    const target = (address + 8 + offset) >>> 0;
    return `${link ? 'bl' : 'b'}${condStr} ${addr(target)}`;
  }

  // Block Data Transfer (LDM/STM)
  if ((instr & 0x0e000000) === 0x08000000) {
    const pre = bit(instr, 24);
    const up = bit(instr, 23);
    const s = bit(instr, 22);
    const wb = bit(instr, 21);
    const load = bit(instr, 20);
    const rn = bits(instr, 19, 16);
    const rlist = instr & 0xffff;

    let suffix: string;
    if (load) {
      suffix = up ? (pre ? 'ib' : 'ia') : pre ? 'db' : 'da';
    } else {
      suffix = up ? (pre ? 'ib' : 'ia') : pre ? 'db' : 'da';
    }

    const op = load ? 'ldm' : 'stm';
    const wbStr = wb ? '!' : '';
    const sStr = s ? '^' : '';
    return `${op}${condStr}${suffix} ${reg(rn)}${wbStr}, ${regList(rlist)}${sStr}`;
  }

  // Single Data Transfer (LDR/STR) — immediate offset (bit 25=0)
  if ((instr & 0x0c000000) === 0x04000000) {
    const isRegOffset = bit(instr, 25);
    const pre = bit(instr, 24);
    const up = bit(instr, 23);
    const byteMode = bit(instr, 22);
    const wb = bit(instr, 21);
    const load = bit(instr, 20);
    const rn = bits(instr, 19, 16);
    const rd = bits(instr, 15, 12);

    const op = load ? 'ldr' : 'str';
    const suffix = byteMode ? 'b' : '';
    const sign = up ? '' : '-';

    let offsetStr: string;
    if (isRegOffset) {
      const rm = instr & 0xf;
      const shiftType = (instr >>> 5) & 3;
      const shiftAmount = (instr >>> 7) & 0x1f;
      if (shiftAmount === 0 && shiftType === 0) {
        offsetStr = `${sign}${reg(rm)}`;
      } else {
        offsetStr = `${sign}${reg(rm)}, ${SHIFT_NAMES[shiftType]} #${shiftAmount}`;
      }
    } else {
      const offset = instr & 0xfff;
      offsetStr = offset === 0 ? '' : `${sign}#0x${offset.toString(16)}`;
    }

    if (pre) {
      const wbStr = wb ? '!' : '';
      if (offsetStr === '') {
        return `${op}${condStr}${suffix} ${reg(rd)}, [${reg(rn)}]${wbStr}`;
      }
      return `${op}${condStr}${suffix} ${reg(rd)}, [${reg(rn)}, ${offsetStr}]${wbStr}`;
    } else {
      return `${op}${condStr}${suffix} ${reg(rd)}, [${reg(rn)}], ${offsetStr}`;
    }
  }

  // BX
  if ((instr & 0x0ffffff0) === 0x012fff10) {
    const rm = instr & 0xf;
    return `bx${condStr} ${reg(rm)}`;
  }

  // Multiply (MUL/MLA)
  if ((instr & 0x0fc000f0) === 0x00000090) {
    const accumulate = bit(instr, 21);
    const setFlags = bit(instr, 20);
    const rd = bits(instr, 19, 16);
    const rn = bits(instr, 15, 12);
    const rs = bits(instr, 11, 8);
    const rm = instr & 0xf;
    const sStr = setFlags ? 's' : '';
    if (accumulate) {
      return `mla${condStr}${sStr} ${reg(rd)}, ${reg(rm)}, ${reg(rs)}, ${reg(rn)}`;
    } else {
      return `mul${condStr}${sStr} ${reg(rd)}, ${reg(rm)}, ${reg(rs)}`;
    }
  }

  // Long Multiply (UMULL/UMLAL/SMULL/SMLAL)
  if ((instr & 0x0f8000f0) === 0x00800090) {
    const isSigned = bit(instr, 22);
    const accumulate = bit(instr, 21);
    const setFlags = bit(instr, 20);
    const rdHi = bits(instr, 19, 16);
    const rdLo = bits(instr, 15, 12);
    const rs = bits(instr, 11, 8);
    const rm = instr & 0xf;
    const sStr = setFlags ? 's' : '';
    let op: string;
    if (isSigned) {
      op = accumulate ? 'smlal' : 'smull';
    } else {
      op = accumulate ? 'umlal' : 'umull';
    }
    return `${op}${condStr}${sStr} ${reg(rdLo)}, ${reg(rdHi)}, ${reg(rm)}, ${reg(rs)}`;
  }

  // SWP/SWPB
  if ((instr & 0x0fb00ff0) === 0x01000090) {
    const byteMode = bit(instr, 22);
    const rn = bits(instr, 19, 16);
    const rd = bits(instr, 15, 12);
    const rm = instr & 0xf;
    const suffix = byteMode ? 'b' : '';
    return `swp${condStr}${suffix} ${reg(rd)}, ${reg(rm)}, [${reg(rn)}]`;
  }

  // Halfword transfers (LDRH/STRH/LDRSB/LDRSH)
  if ((instr & 0x0e000090) === 0x00000090 && (instr & 0x00000060) !== 0) {
    // Check it's not a multiply
    const pre = bit(instr, 24);
    const up = bit(instr, 23);
    const immOffset = bit(instr, 22);
    const wb = bit(instr, 21);
    const load = bit(instr, 20);
    const rn = bits(instr, 19, 16);
    const rd = bits(instr, 15, 12);
    const sh = bits(instr, 6, 5);
    const sign = up ? '' : '-';

    let opName: string;
    if (load) {
      switch (sh) {
        case 0b01:
          opName = 'ldrh';
          break;
        case 0b10:
          opName = 'ldrsb';
          break;
        case 0b11:
          opName = 'ldrsh';
          break;
        default:
          opName = 'ldr?';
      }
    } else {
      opName = 'strh';
    }

    let offsetStr: string;
    if (immOffset) {
      const offset = ((instr >>> 4) & 0xf0) | (instr & 0xf);
      offsetStr = offset === 0 ? '' : `${sign}#0x${offset.toString(16)}`;
    } else {
      const rm = instr & 0xf;
      offsetStr = `${sign}${reg(rm)}`;
    }

    if (pre) {
      const wbStr = wb ? '!' : '';
      if (offsetStr === '') {
        return `${opName}${condStr} ${reg(rd)}, [${reg(rn)}]${wbStr}`;
      }
      return `${opName}${condStr} ${reg(rd)}, [${reg(rn)}, ${offsetStr}]${wbStr}`;
    } else {
      return `${opName}${condStr} ${reg(rd)}, [${reg(rn)}], ${offsetStr}`;
    }
  }

  // MRS
  if ((instr & 0x0fbf0fff) === 0x010f0000) {
    const useSPSR = bit(instr, 22);
    const rd = bits(instr, 15, 12);
    return `mrs${condStr} ${reg(rd)}, ${useSPSR ? 'spsr' : 'cpsr'}`;
  }

  // MSR (register)
  if ((instr & 0x0fbffff0) === 0x0129f000) {
    const useSPSR = bit(instr, 22);
    const rm = instr & 0xf;
    const fieldMask = bits(instr, 19, 16);
    const fields = formatPsrFields(fieldMask);
    return `msr${condStr} ${useSPSR ? 'spsr' : 'cpsr'}${fields}, ${reg(rm)}`;
  }

  // MSR (immediate)
  if ((instr & 0x0dbff000) === 0x0128f000) {
    const useSPSR = bit(instr, 22);
    const fieldMask = bits(instr, 19, 16);
    const imm8 = instr & 0xff;
    const rotate = ((instr >>> 8) & 0xf) * 2;
    const value = rotate === 0 ? imm8 : ((imm8 >>> rotate) | (imm8 << (32 - rotate))) >>> 0;
    const fields = formatPsrFields(fieldMask);
    return `msr${condStr} ${useSPSR ? 'spsr' : 'cpsr'}${fields}, #0x${value.toString(16)}`;
  }

  // Data Processing
  if ((instr & 0x0c000000) === 0x00000000) {
    const isImm = bit(instr, 25);
    const opcode = bits(instr, 24, 21);
    const setFlags = bit(instr, 20);
    const rn = bits(instr, 19, 16);
    const rd = bits(instr, 15, 12);
    const sStr = setFlags ? 's' : '';
    const op = DP_NAMES[opcode]!;
    const operand2 = formatShifterOperand(instr, isImm === 1);

    // Test instructions (don't write to Rd)
    if (opcode >= 0x8 && opcode <= 0xb) {
      return `${op}${condStr} ${reg(rn)}, ${operand2}`;
    }

    // MOV/MVN (don't use Rn)
    if (opcode === 0xd || opcode === 0xf) {
      return `${op}${condStr}${sStr} ${reg(rd)}, ${operand2}`;
    }

    return `${op}${condStr}${sStr} ${reg(rd)}, ${reg(rn)}, ${operand2}`;
  }

  return `dw 0x${instr.toString(16).padStart(8, '0')}`;
}

/** Format PSR field mask for MSR instructions */
function formatPsrFields(mask: number): string {
  let fields = '_';
  if (mask & 1) {
    fields += 'c';
  }
  if (mask & 2) {
    fields += 'x';
  }
  if (mask & 4) {
    fields += 's';
  }
  if (mask & 8) {
    fields += 'f';
  }
  return fields;
}
