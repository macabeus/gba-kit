/**
 * ARM7TDMI Disassembler — ARM and Thumb instruction disassembly
 *
 * The instruction tables are @match-kit/isa's ARMv4T ones, so the debugger's listing spells
 * an instruction as a decompilation project's `.s` files do (GNU as unified syntax), and the
 * text assembles back to the same bytes. This module is the debugger's
 * presentation of them: addresses as numbers, and a symbol name appended when there is one.
 *
 * Execution does not go through here: the CPU has its own decoder (arm-cpu.ts).
 */
import { type Insn, decode, formatDecoding, formatRaw, isThumbBlPrefix, isThumbBlSuffix } from '@match-kit/isa/armv4t';

/** Format an address */
function addr(v: number): string {
  return `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
}

/** A listing names an address by its number; `symbolize` adds the name after the text. */
const NUMERIC = { labelFor: (target: number): string => addr(target) };

/**
 * The instruction as text. An encoding that is no ARMv4T instruction (an undefined space,
 * half of a `bl` pair) is shown as its bytes with what it is: `.inst.n 0xDE00 @ undefined`.
 */
function textOf(insn: Insn): string {
  return formatDecoding(insn, NUMERIC) ?? formatRaw(insn);
}

/** The code or data address the instruction names: a branch or call target, a literal-pool word, an `adr`. */
function targetOf(insn: Insn): number | undefined {
  const flow = insn.flow;
  switch (flow.kind) {
    case 'branch':
    case 'bl':
    case 'adr':
    case 'mode-switch':
      return flow.target;
    case 'pool-load':
      return flow.pool;
    default:
      return undefined;
  }
}

/**
 * Disassemble a 16-bit Thumb instruction.
 *
 * @param instruction - The 16-bit instruction word
 * @param address - The address of the instruction (for PC-relative calculations)
 * @returns A human-readable disassembly string
 */
export function disassembleThumb(instruction: number, address: number): string {
  return textOf(decode('thumb', instruction & 0xffff, address));
}

/**
 * Disassemble a 32-bit ARM instruction.
 *
 * @param instruction - The 32-bit instruction word
 * @param address - The address of the instruction (for PC-relative calculations)
 * @returns A human-readable disassembly string
 */
export function disassembleArm(instruction: number, address: number): string {
  return textOf(decode('arm', instruction >>> 0, address));
}

// ─── Debugger-facing disassembly ────────────────────────────────────

export interface DisassembleOptions {
  /**
   * Name for an address an instruction refers to — a branch target, a literal-pool
   * word — appended as `<name>` / `<name+0xNN>`. Return null for no name.
   */
  symbolize?: (address: number) => string | null;
}

export interface DisassembledInstruction {
  text: string;
  /** Bytes the instruction occupies: 4 for ARM and for a merged Thumb `bl` pair, else 2. */
  size: 2 | 4;
  /** The code or data address the instruction refers to, when it names one. */
  target?: number;
}

/**
 * Disassemble the Thumb instruction at `address`, reading halfwords through
 * `read16`. A `bl` prefix/suffix pair is presented as one 4-byte `bl <target>`
 * instead of two halves.
 */
export function disassembleThumbAt(
  read16: (address: number) => number,
  address: number,
  options: DisassembleOptions = {},
): DisassembledInstruction {
  const first = read16(address) & 0xffff;
  // The halfword after it is read only for a `bl` prefix, which alone pairs with it.
  const second = isThumbBlPrefix(first) ? read16((address + 2) >>> 0) & 0xffff : 0;
  const word = isThumbBlSuffix(second) ? (first | (second << 16)) >>> 0 : first;
  return present(decode('thumb', word, address), options);
}

/** Disassemble the ARM instruction at `address`, reading words through `read32`. */
export function disassembleArmAt(
  read32: (address: number) => number,
  address: number,
  options: DisassembleOptions = {},
): DisassembledInstruction {
  return present(decode('arm', read32(address) >>> 0, address), options);
}

/** The instruction's text, with the name of the address it refers to when `symbolize` has one. */
function present(insn: Insn, options: DisassembleOptions): DisassembledInstruction {
  const text = textOf(insn);
  const target = targetOf(insn);
  if (target === undefined) {
    return { text, size: insn.size };
  }
  const name = options.symbolize?.(target);
  return { text: name ? `${text} <${name}>` : text, size: insn.size, target };
}
