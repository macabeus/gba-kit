/**
 * `.debug_frame` call-frame information: enough of DWARF CFA to unwind GCC's ARM
 * output (def_cfa, def_cfa_offset/register, offset, advance_loc, restore,
 * remember/restore_state). Expression-based rules are reported as unsupported,
 * so an unwind never invents a caller.
 *
 * ARM DWARF register numbers: r0–r15 = 0–15. Return address column is 14 (lr).
 */
import { Cursor } from '../reader.js';

type Rule =
  | { kind: 'undefined' }
  | { kind: 'same' }
  | { kind: 'offset'; offset: number }
  | { kind: 'val_offset'; offset: number }
  | { kind: 'register'; reg: number }
  | { kind: 'unsupported' };

interface Cie {
  codeAlign: number;
  dataAlign: number;
  returnReg: number;
  instructions: Uint8Array;
}

interface Fde {
  cie: Cie;
  start: number;
  end: number;
  instructions: Uint8Array;
}

interface RowState {
  cfaReg: number;
  cfaOffset: number;
  cfaUnsupported: boolean;
  rules: Map<number, Rule>;
}

export interface UnwindResult {
  cfa: number;
  /** Register values in the caller, `undefined` where unknown. */
  regs: Array<number | undefined>;
  returnAddress: number;
}

export class FrameTable {
  readonly #fdes: Fde[] = [];

  constructor(section: Uint8Array | undefined, littleEndian = true) {
    if (!section) {
      return;
    }
    const cies = new Map<number, Cie>();
    const c = new Cursor(section, 0, littleEndian);
    while (c.remaining >= 8) {
      const entryOffset = c.offset;
      const length = c.u32();
      if (length === 0) {
        continue; // padding
      }
      if (length === 0xffffffff) {
        break; // 64-bit DWARF
      }
      const end = c.offset + length;
      if (end > section.length) {
        break;
      }
      const id = c.u32();
      if (id === 0xffffffff) {
        const version = c.u8();
        const augmentation = c.cstr();
        if (version >= 4) {
          c.u8(); // address_size
          c.u8(); // segment_size
        }
        const codeAlign = c.uleb();
        const dataAlign = c.sleb();
        const returnReg = version === 1 ? c.u8() : c.uleb();
        // 'z' augmentations belong to .eh_frame; GCC's .debug_frame uses "".
        if (augmentation === '') {
          cies.set(entryOffset, { codeAlign, dataAlign, returnReg, instructions: section.subarray(c.offset, end) });
        }
      } else {
        const cie = cies.get(id);
        if (cie) {
          const start = c.u32();
          const range = c.u32();
          this.#fdes.push({ cie, start: start >>> 0, end: (start + range) >>> 0, instructions: section.subarray(c.offset, end) });
        }
      }
      c.seek(end);
    }
    this.#fdes.sort((a, b) => a.start - b.start);
  }

  /** How many functions the table describes. */
  get size(): number {
    return this.#fdes.length;
  }

  /** True when `pc` lies inside a described function. */
  covers(pc: number): boolean {
    return this.#find(pc) !== null;
  }

  #find(pc: number): Fde | null {
    let lo = 0;
    let hi = this.#fdes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const f = this.#fdes[mid]!;
      if (pc < f.start) {
        hi = mid - 1;
      } else if (pc >= f.end) {
        lo = mid + 1;
      } else {
        return f;
      }
    }
    return null;
  }

  /** The CFA at `pc` given the frame's registers, or undefined without CFI. */
  cfa(pc: number, regs: ReadonlyArray<number | undefined>): number | undefined {
    const fde = this.#find(pc);
    if (!fde) {
      return undefined;
    }
    const row = this.#rowAt(fde, pc);
    if (row.cfaUnsupported) {
      return undefined;
    }
    const base = regs[row.cfaReg];
    return base === undefined ? undefined : (base + row.cfaOffset) >>> 0;
  }

  /** Registers of the caller of the frame executing at `pc` with `regs`, or null without CFI there. */
  unwind(pc: number, regs: ReadonlyArray<number | undefined>, readWord: (address: number) => number | undefined): UnwindResult | null {
    const fde = this.#find(pc);
    if (!fde) {
      return null;
    }
    const row = this.#rowAt(fde, pc);
    if (row.cfaUnsupported) {
      return null;
    }
    const base = regs[row.cfaReg];
    if (base === undefined) {
      return null;
    }
    const cfa = (base + row.cfaOffset) >>> 0;
    const out: Array<number | undefined> = regs.slice();
    for (let r = 0; r < 16; r++) {
      const rule = row.rules.get(r);
      if (!rule) {
        // Callee-saved registers keep their value; scratch ones are unknown in the caller.
        out[r] = r >= 4 && r <= 11 ? regs[r] : r === 14 ? regs[14] : undefined;
        continue;
      }
      switch (rule.kind) {
        case 'undefined':
          out[r] = undefined;
          break;
        case 'same':
          out[r] = regs[r];
          break;
        case 'offset':
          out[r] = readWord((cfa + rule.offset) >>> 0);
          break;
        case 'val_offset':
          out[r] = (cfa + rule.offset) >>> 0;
          break;
        case 'register':
          out[r] = regs[rule.reg];
          break;
        default:
          out[r] = undefined;
      }
    }
    out[13] = cfa;
    const ra = out[fde.cie.returnReg] ?? (fde.cie.returnReg === 14 ? regs[14] : undefined);
    if (ra === undefined) {
      return null;
    }
    out[15] = ra;
    return { cfa, regs: out, returnAddress: ra >>> 0 };
  }

  #rowAt(fde: Fde, pc: number): RowState {
    const cie = fde.cie;
    const initial: RowState = { cfaReg: 13, cfaOffset: 0, cfaUnsupported: false, rules: new Map() };
    runCfa(cie.instructions, cie, initial, fde.start, Infinity, null);
    const row: RowState = {
      cfaReg: initial.cfaReg,
      cfaOffset: initial.cfaOffset,
      cfaUnsupported: initial.cfaUnsupported,
      rules: new Map(initial.rules),
    };
    runCfa(fde.instructions, cie, row, fde.start, pc, initial);
    return row;
  }
}

function runCfa(program: Uint8Array, cie: Cie, state: RowState, startLoc: number, targetPc: number, initial: RowState | null): void {
  const c = new Cursor(program, 0, true);
  let loc = startLoc;
  const saved: RowState[] = [];
  const advance = (delta: number): boolean => {
    loc = (loc + delta * cie.codeAlign) >>> 0;
    return loc > targetPc;
  };
  const restore = (r: number): void => {
    const rule = initial?.rules.get(r);
    if (rule) {
      state.rules.set(r, rule);
    } else {
      state.rules.delete(r);
    }
  };
  while (!c.eof) {
    const op = c.u8();
    const high = op & 0xc0;
    const low = op & 0x3f;
    if (high === 0x40) {
      if (advance(low)) {
        return;
      }
      continue;
    }
    if (high === 0x80) {
      state.rules.set(low, { kind: 'offset', offset: c.uleb() * cie.dataAlign });
      continue;
    }
    if (high === 0xc0) {
      restore(low);
      continue;
    }
    switch (op) {
      case 0x00: // nop
        break;
      case 0x01: // set_loc
        loc = c.u32();
        if (loc > targetPc) {
          return;
        }
        break;
      case 0x02:
        if (advance(c.u8())) {
          return;
        }
        break;
      case 0x03:
        if (advance(c.u16())) {
          return;
        }
        break;
      case 0x04:
        if (advance(c.u32())) {
          return;
        }
        break;
      case 0x05: {
        // offset_extended
        const r = c.uleb();
        state.rules.set(r, { kind: 'offset', offset: c.uleb() * cie.dataAlign });
        break;
      }
      case 0x06: // restore_extended
        restore(c.uleb());
        break;
      case 0x07: // undefined
        state.rules.set(c.uleb(), { kind: 'undefined' });
        break;
      case 0x08: // same_value
        state.rules.set(c.uleb(), { kind: 'same' });
        break;
      case 0x09: {
        // register
        const r = c.uleb();
        state.rules.set(r, { kind: 'register', reg: c.uleb() });
        break;
      }
      case 0x0a: // remember_state
        saved.push({ cfaReg: state.cfaReg, cfaOffset: state.cfaOffset, cfaUnsupported: state.cfaUnsupported, rules: new Map(state.rules) });
        break;
      case 0x0b: {
        // restore_state
        const s = saved.pop();
        if (s) {
          state.cfaReg = s.cfaReg;
          state.cfaOffset = s.cfaOffset;
          state.cfaUnsupported = s.cfaUnsupported;
          state.rules = s.rules;
        }
        break;
      }
      case 0x0c: // def_cfa
        state.cfaReg = c.uleb();
        state.cfaOffset = c.uleb();
        state.cfaUnsupported = false;
        break;
      case 0x0d: // def_cfa_register
        state.cfaReg = c.uleb();
        state.cfaUnsupported = false;
        break;
      case 0x0e: // def_cfa_offset
        state.cfaOffset = c.uleb();
        break;
      case 0x0f: // def_cfa_expression
        c.skip(c.uleb());
        state.cfaUnsupported = true;
        break;
      case 0x10: {
        // expression
        const r = c.uleb();
        c.skip(c.uleb());
        state.rules.set(r, { kind: 'unsupported' });
        break;
      }
      case 0x11: {
        // offset_extended_sf
        const r = c.uleb();
        state.rules.set(r, { kind: 'offset', offset: c.sleb() * cie.dataAlign });
        break;
      }
      case 0x12: // def_cfa_sf
        state.cfaReg = c.uleb();
        state.cfaOffset = c.sleb() * cie.dataAlign;
        state.cfaUnsupported = false;
        break;
      case 0x13: // def_cfa_offset_sf
        state.cfaOffset = c.sleb() * cie.dataAlign;
        break;
      case 0x14: {
        // val_offset
        const r = c.uleb();
        state.rules.set(r, { kind: 'val_offset', offset: c.uleb() * cie.dataAlign });
        break;
      }
      case 0x15: {
        // val_offset_sf
        const r = c.uleb();
        state.rules.set(r, { kind: 'val_offset', offset: c.sleb() * cie.dataAlign });
        break;
      }
      case 0x16: {
        // val_expression
        const r = c.uleb();
        c.skip(c.uleb());
        state.rules.set(r, { kind: 'unsupported' });
        break;
      }
      case 0x2e: // GNU_args_size
        c.uleb();
        break;
      case 0x2f: {
        // GNU_negative_offset_extended
        const r = c.uleb();
        state.rules.set(r, { kind: 'offset', offset: -c.uleb() * cie.dataAlign });
        break;
      }
      default:
        return; // unknown opcode: stop applying, keep what we have
    }
  }
}
