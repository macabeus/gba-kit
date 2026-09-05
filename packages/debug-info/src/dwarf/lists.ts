/**
 * Range lists and location lists, DWARF 2 through 5: which addresses a scope
 * covers, and which expression describes a variable at a given PC.
 */
import { Cursor } from '../reader.js';
import type { DwarfEntry } from '../types.js';
import { DW_AT, DW_FORM, DW_OP, formClass } from './constants.js';
import { addrxValue, attrAddress, type DwarfSections, type UnitInfo } from './entries.js';

export type Range = [number, number];

/** `[low, high)` ranges of a scope DIE (subprogram, lexical block, inlined subroutine, CU). */
export function entryRanges(entry: DwarfEntry, unit: UnitInfo, sections: DwarfSections): Range[] {
  const low = attrAddress(entry, DW_AT.low_pc, unit, sections);
  const high = entry.attrs.get(DW_AT.high_pc);
  if (low !== undefined && typeof high === 'number') {
    const highForm = entry.forms.get(DW_AT.high_pc) ?? DW_FORM.addr;
    const cls = formClass(highForm);
    const hi = cls === 'constant' ? low + high : cls === 'addrx' ? (addrxValue(high, unit, sections) ?? low) : high;
    return hi > low ? [[low >>> 0, hi >>> 0]] : [];
  }
  const ranges = entry.attrs.get(DW_AT.ranges);
  if (typeof ranges !== 'number') {
    return [];
  }
  const form = entry.forms.get(DW_AT.ranges) ?? DW_FORM.sec_offset;
  if (unit.version >= 5) {
    const section = sections.rnglists;
    if (!section) {
      return [];
    }
    let offset = ranges;
    if (formClass(form) === 'rnglistx') {
      const at = unit.rnglistsBase + ranges * 4;
      if (at + 4 > section.length) {
        return [];
      }
      offset = unit.rnglistsBase + new DataView(section.buffer, section.byteOffset, section.byteLength).getUint32(at, true);
    }
    return readRnglist(section, offset, unit, sections);
  }
  const section = sections.ranges;
  return section ? readLegacyRanges(section, ranges, unit.lowPc) : [];
}

function readRnglist(section: Uint8Array, offset: number, unit: UnitInfo, sections: DwarfSections): Range[] {
  const out: Range[] = [];
  let base = unit.lowPc;
  const c = new Cursor(section, offset);
  const addrx = (i: number): number => addrxValue(i, unit, sections) ?? 0;
  while (!c.eof) {
    const kind = c.u8();
    switch (kind) {
      case 0: // DW_RLE_end_of_list
        return out;
      case 1: // DW_RLE_base_addressx
        base = addrx(c.uleb());
        break;
      case 2: {
        // DW_RLE_startx_endx
        const s = addrx(c.uleb());
        const e = addrx(c.uleb());
        out.push([s, e]);
        break;
      }
      case 3: {
        // DW_RLE_startx_length
        const s = addrx(c.uleb());
        out.push([s, (s + c.uleb()) >>> 0]);
        break;
      }
      case 4: {
        // DW_RLE_offset_pair
        const s = c.uleb();
        const e = c.uleb();
        out.push([(base + s) >>> 0, (base + e) >>> 0]);
        break;
      }
      case 5: // DW_RLE_base_address
        base = c.u32();
        break;
      case 6: {
        // DW_RLE_start_end
        const s = c.u32();
        out.push([s, c.u32()]);
        break;
      }
      case 7: {
        // DW_RLE_start_length
        const s = c.u32();
        out.push([s, (s + c.uleb()) >>> 0]);
        break;
      }
      default:
        return out;
    }
  }
  return out;
}

function readLegacyRanges(section: Uint8Array, offset: number, base: number): Range[] {
  const out: Range[] = [];
  const c = new Cursor(section, offset);
  while (c.remaining >= 8) {
    const s = c.u32();
    const e = c.u32();
    if (s === 0 && e === 0) {
      break;
    }
    if (s === 0xffffffff) {
      base = e;
      continue;
    }
    out.push([(base + s) >>> 0, (base + e) >>> 0]);
  }
  return out;
}

export function rangesContain(ranges: Range[], pc: number): boolean {
  for (const [lo, hi] of ranges) {
    if (pc >= lo && pc < hi) {
      return true;
    }
  }
  return false;
}

/** One entry of a location list, kept so an "optimized out" answer can say where the value was. */
export interface LocationEntry {
  lo: number;
  hi: number;
  expr: Uint8Array;
}

export type LocationAttr =
  | { kind: 'expr'; expr: Uint8Array }
  /** no location attribute at all (a `const_value` variable, or one the compiler dropped) */
  | { kind: 'none' }
  /** a location list with no entry covering pc: optimized out here */
  | { kind: 'not-here'; entries: LocationEntry[] }
  | { kind: 'unsupported'; reason: string };

/** The location expression of `entry`'s attribute `at` that is valid at `pc`. */
export function locationAt(entry: DwarfEntry, at: number, pc: number, unit: UnitInfo, sections: DwarfSections): LocationAttr {
  const v = entry.attrs.get(at);
  if (v === undefined) {
    return { kind: 'none' };
  }
  if (v instanceof Uint8Array) {
    return { kind: 'expr', expr: v };
  }
  if (typeof v !== 'number') {
    return { kind: 'unsupported', reason: 'odd location form' };
  }
  const form = entry.forms.get(at) ?? DW_FORM.sec_offset;
  if (unit.version >= 5) {
    const section = sections.loclists;
    if (!section) {
      return { kind: 'unsupported', reason: 'no .debug_loclists' };
    }
    let offset = v;
    if (formClass(form) === 'loclistx') {
      const at2 = unit.loclistsBase + v * 4;
      if (at2 + 4 > section.length) {
        return { kind: 'unsupported', reason: 'loclistx out of range' };
      }
      offset = unit.loclistsBase + new DataView(section.buffer, section.byteOffset, section.byteLength).getUint32(at2, true);
    }
    return readLoclist(section, offset, pc, unit, sections);
  }
  const section = sections.loc;
  if (!section) {
    return { kind: 'unsupported', reason: 'no .debug_loc' };
  }
  return readLegacyLoclist(section, v, unit.lowPc, pc);
}

function readLoclist(section: Uint8Array, offset: number, pc: number, unit: UnitInfo, sections: DwarfSections): LocationAttr {
  const c = new Cursor(section, offset);
  let base = unit.lowPc;
  const addrx = (i: number): number => addrxValue(i, unit, sections) ?? 0;
  let fallback: Uint8Array | null = null;
  const entries: LocationEntry[] = [];
  while (!c.eof) {
    const kind = c.u8();
    let lo = 0;
    let hi = 0;
    switch (kind) {
      case 0: // DW_LLE_end_of_list
        return fallback ? { kind: 'expr', expr: fallback } : { kind: 'not-here', entries };
      case 1: // DW_LLE_base_addressx
        base = addrx(c.uleb());
        continue;
      case 2: // DW_LLE_startx_endx
        lo = addrx(c.uleb());
        hi = addrx(c.uleb());
        break;
      case 3: // DW_LLE_startx_length
        lo = addrx(c.uleb());
        hi = (lo + c.uleb()) >>> 0;
        break;
      case 4: // DW_LLE_offset_pair
        lo = (base + c.uleb()) >>> 0;
        hi = (base + c.uleb()) >>> 0;
        break;
      case 5: {
        // DW_LLE_default_location
        fallback = c.take(c.uleb());
        continue;
      }
      case 6: // DW_LLE_base_address
        base = c.u32();
        continue;
      case 7: // DW_LLE_start_end
        lo = c.u32();
        hi = c.u32();
        break;
      case 8: // DW_LLE_start_length
        lo = c.u32();
        hi = (lo + c.uleb()) >>> 0;
        break;
      default:
        return { kind: 'unsupported', reason: `DW_LLE ${kind}` };
    }
    const expr = c.take(c.uleb());
    if (pc >= lo && pc < hi) {
      return { kind: 'expr', expr };
    }
    entries.push({ lo, hi, expr });
  }
  return { kind: 'not-here', entries };
}

function readLegacyLoclist(section: Uint8Array, offset: number, base: number, pc: number): LocationAttr {
  const c = new Cursor(section, offset);
  const entries: LocationEntry[] = [];
  while (c.remaining >= 8) {
    const s = c.u32();
    const e = c.u32();
    if (s === 0 && e === 0) {
      break;
    }
    if (s === 0xffffffff) {
      base = e;
      continue;
    }
    const expr = c.take(c.u16());
    const lo = (base + s) >>> 0;
    const hi = (base + e) >>> 0;
    if (pc >= lo && pc < hi) {
      return { kind: 'expr', expr };
    }
    entries.push({ lo, hi, expr });
  }
  return { kind: 'not-here', entries };
}

/** A one-glance rendering of a location expression: `r0`, `[sp+8]`, `[frame base-40]`. */
export function describeExpr(expr: Uint8Array): string {
  if (expr.length === 0) {
    return 'empty';
  }
  const op = expr[0]!;
  const sleb = (): number => new Cursor(expr, 1).sleb();
  if (op >= DW_OP.reg0 && op <= DW_OP.reg31) {
    return regName(op - DW_OP.reg0);
  }
  if (op >= DW_OP.breg0 && op <= DW_OP.breg31) {
    const off = sleb();
    return `[${regName(op - DW_OP.breg0)}${off >= 0 ? '+' : ''}${off}]`;
  }
  if (op === DW_OP.fbreg) {
    const off = sleb();
    return `[frame base${off >= 0 ? '+' : ''}${off}]`;
  }
  if (op === DW_OP.addr) {
    return `0x${new Cursor(expr, 1).u32().toString(16)}`;
  }
  if (op === DW_OP.call_frame_cfa) {
    return 'cfa';
  }
  if (op === DW_OP.entry_value || op === DW_OP.GNU_entry_value) {
    return 'entry value';
  }
  if (expr.includes(DW_OP.piece)) {
    return 'pieces';
  }
  return `op 0x${op.toString(16)}`;
}

export function regName(n: number): string {
  return n === 13 ? 'sp' : n === 14 ? 'lr' : n === 15 ? 'pc' : `r${n}`;
}
