/**
 * A small DWARF 2–5 reader for what the debugger needs beyond `@gba-kit/debug-info`:
 * the full DIE tree (scopes, locals, inlined subroutines), location lists, range
 * lists. gba-kit's own DIE parser is private to its `TypeIndex`; this duplicates the
 * container-level parsing so the PoC can stay outside the library. The plan moves
 * this into `@gba-kit/debug-info` (items 6, 7, 18).
 *
 * Only 32-bit DWARF, little-endian ARM.
 */

export class Cursor {
  offset: number;
  readonly view: DataView;
  constructor(
    readonly bytes: Uint8Array,
    offset = 0,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }
  get eof(): boolean {
    return this.offset >= this.bytes.length;
  }
  u8(): number {
    return this.bytes[this.offset++]!;
  }
  s8(): number {
    return this.view.getInt8(this.offset++);
  }
  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  s16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  s32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u64(): number {
    const lo = this.u32();
    const hi = this.u32();
    return hi * 0x100000000 + lo;
  }
  uleb(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if ((b & 0x80) === 0) {
        return result;
      }
    }
  }
  sleb(): number {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.u8();
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    if (b & 0x40) {
      result -= 2 ** shift;
    }
    return result;
  }
  cstr(): string {
    let end = this.offset;
    while (end < this.bytes.length && this.bytes[end] !== 0) {
      end++;
    }
    const s = new TextDecoder().decode(this.bytes.subarray(this.offset, end));
    this.offset = end + 1;
    return s;
  }
  take(n: number): Uint8Array {
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
}

// ─── constants ─────────────────────────────────────────────────────────

export const TAG = {
  array_type: 0x01,
  enumeration_type: 0x04,
  formal_parameter: 0x05,
  lexical_block: 0x0b,
  member: 0x0d,
  pointer_type: 0x0f,
  compile_unit: 0x11,
  structure_type: 0x13,
  subroutine_type: 0x15,
  typedef: 0x16,
  union_type: 0x17,
  unspecified_parameters: 0x18,
  inlined_subroutine: 0x1d,
  subrange_type: 0x21,
  base_type: 0x24,
  const_type: 0x26,
  enumerator: 0x28,
  subprogram: 0x2e,
  variable: 0x34,
  volatile_type: 0x35,
  restrict_type: 0x37,
  partial_unit: 0x3c,
} as const;

export const AT = {
  location: 0x02,
  name: 0x03,
  byte_size: 0x0b,
  bit_offset: 0x0c,
  bit_size: 0x0d,
  stmt_list: 0x10,
  low_pc: 0x11,
  high_pc: 0x12,
  language: 0x13,
  const_value: 0x1c,
  upper_bound: 0x2f,
  abstract_origin: 0x31,
  artificial: 0x34,
  count: 0x37,
  data_member_location: 0x38,
  decl_file: 0x3a,
  decl_line: 0x3b,
  declaration: 0x3c,
  encoding: 0x3e,
  external: 0x3f,
  frame_base: 0x40,
  specification: 0x47,
  type: 0x49,
  entry_pc: 0x52,
  ranges: 0x55,
  call_file: 0x58,
  call_line: 0x59,
  data_bit_offset: 0x6b,
  str_offsets_base: 0x72,
  addr_base: 0x73,
  rnglists_base: 0x74,
  loclists_base: 0x8c,
} as const;

const FORM = {
  addr: 0x01,
  block2: 0x03,
  block4: 0x04,
  data2: 0x05,
  data4: 0x06,
  data8: 0x07,
  string: 0x08,
  block: 0x09,
  block1: 0x0a,
  data1: 0x0b,
  flag: 0x0c,
  sdata: 0x0d,
  strp: 0x0e,
  udata: 0x0f,
  ref_addr: 0x10,
  ref1: 0x11,
  ref2: 0x12,
  ref4: 0x13,
  ref8: 0x14,
  ref_udata: 0x15,
  indirect: 0x16,
  sec_offset: 0x17,
  exprloc: 0x18,
  flag_present: 0x19,
  strx: 0x1a,
  addrx: 0x1b,
  ref_sup4: 0x1c,
  strp_sup: 0x1d,
  data16: 0x1e,
  line_strp: 0x1f,
  ref_sig8: 0x20,
  implicit_const: 0x21,
  loclistx: 0x22,
  rnglistx: 0x23,
  ref_sup8: 0x24,
  strx1: 0x25,
  strx2: 0x26,
  strx3: 0x27,
  strx4: 0x28,
  addrx1: 0x29,
  addrx2: 0x2a,
  addrx3: 0x2b,
  addrx4: 0x2c,
} as const;

/** Attribute classes that matter for interpretation. */
export type AttrClass =
  | 'address'
  | 'constant'
  | 'string'
  | 'block'
  | 'flag'
  | 'reference'
  | 'secoffset'
  | 'loclistx'
  | 'rnglistx'
  | 'addrx'
  | 'strx';

export interface Attr {
  cls: AttrClass;
  value: number | string | Uint8Array | boolean;
}

export interface Die {
  tag: number;
  offset: number;
  attrs: Map<number, Attr>;
  children: Die[];
  parent: Die | null;
  unit: Unit;
}

export interface Unit {
  offset: number;
  version: number;
  addressSize: number;
  /** DW_AT_low_pc of the CU DIE — the base for range/location list offsets */
  lowPc: number;
  root: Die;
  strOffsetsBase: number;
  addrBase: number;
  loclistsBase: number;
  rnglistsBase: number;
  /** line-table offset (DW_AT_stmt_list) — to tie a CU to its files */
  stmtList: number;
}

export interface DwarfSections {
  info: Uint8Array;
  abbrev: Uint8Array;
  str?: Uint8Array;
  lineStr?: Uint8Array;
  strOffsets?: Uint8Array;
  addr?: Uint8Array;
  loclists?: Uint8Array;
  loc?: Uint8Array;
  rnglists?: Uint8Array;
  ranges?: Uint8Array;
  frame?: Uint8Array;
}

interface Abbrev {
  tag: number;
  hasChildren: boolean;
  specs: Array<{ attr: number; form: number; implicitConst: number }>;
}

// ─── .debug_info ───────────────────────────────────────────────────────

export function parseUnits(sections: DwarfSections): Unit[] {
  const units: Unit[] = [];
  const abbrevCache = new Map<number, Map<number, Abbrev>>();
  // agbcc (GCC 2.95) omits the 0-code terminator between abbreviation tables, so a
  // table is bounded by where the next unit's table starts (gba-kit does the same).
  const abbrevStarts = collectAbbrevOffsets(sections.info);
  abbrevStarts.push(sections.abbrev.length);
  const boundaryAfter = (offset: number): number => {
    for (const b of abbrevStarts) {
      if (b > offset) {
        return b;
      }
    }
    return sections.abbrev.length;
  };
  const c = new Cursor(sections.info);
  while (c.offset + 11 <= sections.info.length) {
    const unitOffset = c.offset;
    const length = c.u32();
    if (length === 0xffffffff || length === 0) {
      break; // 64-bit DWARF or padding: not supported
    }
    const end = c.offset + length;
    const version = c.u16();
    let abbrevOffset: number;
    let addressSize: number;
    if (version >= 5) {
      const unitType = c.u8();
      addressSize = c.u8();
      abbrevOffset = c.u32();
      if (unitType !== 1 && unitType !== 3) {
        c.offset = end; // type / skeleton / split units: skip
        continue;
      }
    } else {
      abbrevOffset = c.u32();
      addressSize = c.u8();
    }
    let abbrevs = abbrevCache.get(abbrevOffset);
    if (!abbrevs) {
      abbrevs = parseAbbrevs(sections.abbrev, abbrevOffset, boundaryAfter(abbrevOffset));
      abbrevCache.set(abbrevOffset, abbrevs);
    }
    const unit: Unit = {
      offset: unitOffset,
      version,
      addressSize,
      lowPc: 0,
      root: null as unknown as Die,
      strOffsetsBase: 8,
      addrBase: 8,
      loclistsBase: 12,
      rnglistsBase: 12,
      stmtList: -1,
    };
    const root = parseDieTree(c, end, abbrevs, unit, sections);
    if (root) {
      unit.root = root;
      const lowPc = root.attrs.get(AT.low_pc);
      if (lowPc && typeof lowPc.value === 'number') {
        unit.lowPc = lowPc.value;
      }
      unit.stmtList = num(root.attrs.get(AT.stmt_list), -1);
      unit.strOffsetsBase = num(root.attrs.get(AT.str_offsets_base), unit.strOffsetsBase);
      unit.addrBase = num(root.attrs.get(AT.addr_base), unit.addrBase);
      unit.loclistsBase = num(root.attrs.get(AT.loclists_base), unit.loclistsBase);
      unit.rnglistsBase = num(root.attrs.get(AT.rnglists_base), unit.rnglistsBase);
      // strx/addrx forms were resolved with default bases during parsing; a CU that
      // sets non-default bases on its own DIE is a split-DWARF layout we do not target.
      units.push(unit);
    }
    c.offset = end;
  }
  return units;
}

function num(a: Attr | undefined, fallback: number): number {
  return a && typeof a.value === 'number' ? a.value : fallback;
}

/** Every unit's debug_abbrev_offset, sorted: the boundaries between abutting tables. */
function collectAbbrevOffsets(info: Uint8Array): number[] {
  const offsets = new Set<number>();
  const c = new Cursor(info);
  while (c.offset + 11 <= info.length) {
    const start = c.offset;
    const length = c.u32();
    if (length === 0xffffffff || length === 0) {
      break;
    }
    const version = c.u16();
    if (version >= 5) {
      c.u8();
      c.u8();
      offsets.add(c.u32());
    } else {
      offsets.add(c.u32());
    }
    c.offset = start + 4 + length;
  }
  return [...offsets].sort((a, b) => a - b);
}

function parseAbbrevs(section: Uint8Array, offset: number, end: number): Map<number, Abbrev> {
  const table = new Map<number, Abbrev>();
  const c = new Cursor(section, offset);
  while (c.offset < end && !c.eof) {
    const code = c.uleb();
    if (code === 0 || table.has(code)) {
      break; // terminator, or we ran into the next table
    }
    const tag = c.uleb();
    const hasChildren = c.u8() === 1;
    const specs: Abbrev['specs'] = [];
    for (;;) {
      const attr = c.uleb();
      const form = c.uleb();
      let implicitConst = 0;
      if (form === FORM.implicit_const) {
        implicitConst = c.sleb();
      }
      if (attr === 0 && form === 0) {
        break;
      }
      specs.push({ attr, form, implicitConst });
    }
    table.set(code, { tag, hasChildren, specs });
  }
  return table;
}

function parseDieTree(
  c: Cursor,
  end: number,
  abbrevs: Map<number, Abbrev>,
  unit: Unit,
  sections: DwarfSections,
): Die | null {
  let root: Die | null = null;
  const stack: Die[] = [];
  while (c.offset < end) {
    const offset = c.offset;
    const code = c.uleb();
    if (code === 0) {
      stack.pop();
      if (stack.length === 0 && root) {
        break;
      }
      continue;
    }
    const abbrev = abbrevs.get(code);
    if (!abbrev) {
      break; // corrupt: stop this unit
    }
    const die: Die = {
      tag: abbrev.tag,
      offset,
      attrs: new Map(),
      children: [],
      parent: stack[stack.length - 1] ?? null,
      unit,
    };
    for (const spec of abbrev.specs) {
      const attr = readForm(c, spec.form, spec.implicitConst, unit, sections);
      if (attr) {
        die.attrs.set(spec.attr, attr);
      }
    }
    if (die.parent) {
      die.parent.children.push(die);
    } else if (!root) {
      root = die;
    }
    if (abbrev.hasChildren) {
      stack.push(die);
    } else if (stack.length === 0) {
      break;
    }
  }
  return root;
}

function readForm(c: Cursor, form: number, implicitConst: number, unit: Unit, sections: DwarfSections): Attr | null {
  switch (form) {
    case FORM.addr:
      return { cls: 'address', value: unit.addressSize === 8 ? c.u64() : c.u32() };
    case FORM.data1:
      return { cls: 'constant', value: c.u8() };
    case FORM.data2:
      return { cls: 'constant', value: c.u16() };
    case FORM.data4:
      return { cls: 'constant', value: c.u32() };
    case FORM.data8:
      return { cls: 'constant', value: c.u64() };
    case FORM.data16:
      return { cls: 'block', value: c.take(16) };
    case FORM.sdata:
      return { cls: 'constant', value: c.sleb() };
    case FORM.udata:
      return { cls: 'constant', value: c.uleb() };
    case FORM.implicit_const:
      return { cls: 'constant', value: implicitConst };
    case FORM.string:
      return { cls: 'string', value: c.cstr() };
    case FORM.strp:
      return { cls: 'string', value: strAt(sections.str, c.u32()) };
    case FORM.line_strp:
      return { cls: 'string', value: strAt(sections.lineStr, c.u32()) };
    case FORM.strp_sup:
      c.u32();
      return { cls: 'string', value: '' };
    case FORM.strx:
    case FORM.strx1:
    case FORM.strx2:
    case FORM.strx3:
    case FORM.strx4: {
      const index =
        form === FORM.strx
          ? c.uleb()
          : form === FORM.strx1
            ? c.u8()
            : form === FORM.strx2
              ? c.u16()
              : form === FORM.strx3
                ? c.u16() | (c.u8() << 16)
                : c.u32();
      const table = sections.strOffsets;
      if (!table) {
        return { cls: 'string', value: '' };
      }
      const at = unit.strOffsetsBase + index * 4;
      const off = at + 4 <= table.length ? new DataView(table.buffer, table.byteOffset).getUint32(at, true) : 0;
      return { cls: 'string', value: strAt(sections.str, off) };
    }
    case FORM.addrx:
    case FORM.addrx1:
    case FORM.addrx2:
    case FORM.addrx3:
    case FORM.addrx4: {
      const index =
        form === FORM.addrx
          ? c.uleb()
          : form === FORM.addrx1
            ? c.u8()
            : form === FORM.addrx2
              ? c.u16()
              : form === FORM.addrx3
                ? c.u16() | (c.u8() << 16)
                : c.u32();
      const table = sections.addr;
      if (!table) {
        return { cls: 'addrx', value: index };
      }
      const at = unit.addrBase + index * unit.addressSize;
      const value = at + 4 <= table.length ? new DataView(table.buffer, table.byteOffset).getUint32(at, true) : 0;
      return { cls: 'address', value };
    }
    case FORM.block1:
      return { cls: 'block', value: c.take(c.u8()) };
    case FORM.block2:
      return { cls: 'block', value: c.take(c.u16()) };
    case FORM.block4:
      return { cls: 'block', value: c.take(c.u32()) };
    case FORM.block:
    case FORM.exprloc:
      return { cls: 'block', value: c.take(c.uleb()) };
    case FORM.flag:
      return { cls: 'flag', value: c.u8() !== 0 };
    case FORM.flag_present:
      return { cls: 'flag', value: true };
    case FORM.ref1:
      return { cls: 'reference', value: unit.offset + c.u8() };
    case FORM.ref2:
      return { cls: 'reference', value: unit.offset + c.u16() };
    case FORM.ref4:
      return { cls: 'reference', value: unit.offset + c.u32() };
    case FORM.ref8:
      return { cls: 'reference', value: unit.offset + c.u64() };
    case FORM.ref_udata:
      return { cls: 'reference', value: unit.offset + c.uleb() };
    case FORM.ref_addr:
      return { cls: 'reference', value: unit.version <= 2 && unit.addressSize === 8 ? c.u64() : c.u32() };
    case FORM.ref_sup4:
      c.u32();
      return null;
    case FORM.ref_sup8:
    case FORM.ref_sig8:
      c.u64();
      return null;
    case FORM.sec_offset:
      return { cls: 'secoffset', value: c.u32() };
    case FORM.loclistx:
      return { cls: 'loclistx', value: c.uleb() };
    case FORM.rnglistx:
      return { cls: 'rnglistx', value: c.uleb() };
    case FORM.indirect:
      return readForm(c, c.uleb(), implicitConst, unit, sections);
    default:
      throw new Error(`unsupported DWARF form 0x${form.toString(16)} at 0x${c.offset.toString(16)}`);
  }
}

function strAt(section: Uint8Array | undefined, offset: number): string {
  if (!section || offset >= section.length) {
    return '';
  }
  return new Cursor(section, offset).cstr();
}

// ─── attribute helpers ─────────────────────────────────────────────────

export function attrNum(die: Die, at: number): number | undefined {
  const a = die.attrs.get(at);
  return a && typeof a.value === 'number' ? a.value : undefined;
}

export function attrStr(die: Die, at: number): string | undefined {
  const a = die.attrs.get(at);
  return a && typeof a.value === 'string' ? a.value : undefined;
}

export function attrFlag(die: Die, at: number): boolean {
  const a = die.attrs.get(at);
  return a ? a.value === true || a.value === 1 : false;
}

/** A DIE index by offset, for following references. */
export class DieIndex {
  readonly #byOffset = new Map<number, Die>();
  constructor(readonly units: Unit[]) {
    const visit = (d: Die): void => {
      this.#byOffset.set(d.offset, d);
      for (const ch of d.children) {
        visit(ch);
      }
    };
    for (const u of units) {
      visit(u.root);
    }
  }
  at(offset: number | undefined): Die | undefined {
    return offset === undefined ? undefined : this.#byOffset.get(offset);
  }
  ref(die: Die, at: number): Die | undefined {
    const a = die.attrs.get(at);
    return a && a.cls === 'reference' && typeof a.value === 'number' ? this.#byOffset.get(a.value) : undefined;
  }
  /** Follow abstract_origin / specification chains to find `at`. */
  inherited(die: Die, at: number, depth = 0): Attr | undefined {
    const own = die.attrs.get(at);
    if (own || depth > 4) {
      return own;
    }
    const origin = this.ref(die, AT.abstract_origin) ?? this.ref(die, AT.specification);
    return origin ? this.inherited(origin, at, depth + 1) : undefined;
  }
  name(die: Die): string | undefined {
    const a = this.inherited(die, AT.name);
    return a && typeof a.value === 'string' ? a.value : undefined;
  }
  typeOf(die: Die): Die | undefined {
    const a = this.inherited(die, AT.type);
    return a && typeof a.value === 'number' ? this.#byOffset.get(a.value) : undefined;
  }
}

// ─── ranges ────────────────────────────────────────────────────────────

export type Range = [number, number];

/** [low, high) ranges of a scope DIE (subprogram, lexical block, inlined subroutine, CU). */
export function dieRanges(die: Die, sections: DwarfSections): Range[] {
  const low = die.attrs.get(AT.low_pc);
  const high = die.attrs.get(AT.high_pc);
  if (low && typeof low.value === 'number' && high && typeof high.value === 'number') {
    const hi = high.cls === 'constant' ? low.value + high.value : high.value;
    return [[low.value >>> 0, hi >>> 0]];
  }
  const ranges = die.attrs.get(AT.ranges);
  if (!ranges || typeof ranges.value !== 'number') {
    return [];
  }
  const unit = die.unit;
  if (unit.version >= 5) {
    const section = sections.rnglists;
    if (!section) {
      return [];
    }
    let offset = ranges.value;
    if (ranges.cls === 'rnglistx') {
      const at = unit.rnglistsBase + ranges.value * 4;
      if (at + 4 > section.length) {
        return [];
      }
      offset = unit.rnglistsBase + new DataView(section.buffer, section.byteOffset).getUint32(at, true);
    }
    return readRnglist(section, offset, unit.lowPc, sections.addr, unit);
  }
  const section = sections.ranges;
  if (!section) {
    return [];
  }
  return readLegacyRanges(section, ranges.value, unit.lowPc);
}

function readRnglist(
  section: Uint8Array,
  offset: number,
  base: number,
  addrSection: Uint8Array | undefined,
  unit: Unit,
): Range[] {
  const out: Range[] = [];
  const c = new Cursor(section, offset);
  const addrx = (i: number): number => {
    if (!addrSection) {
      return 0;
    }
    const at = unit.addrBase + i * unit.addressSize;
    return at + 4 <= addrSection.length
      ? new DataView(addrSection.buffer, addrSection.byteOffset).getUint32(at, true)
      : 0;
  };
  while (!c.eof) {
    const kind = c.u8();
    switch (kind) {
      case 0: // end_of_list
        return out;
      case 1: // base_addressx
        base = addrx(c.uleb());
        break;
      case 2: {
        // startx_endx
        const s = addrx(c.uleb());
        const e = addrx(c.uleb());
        out.push([s, e]);
        break;
      }
      case 3: {
        // startx_length
        const s = addrx(c.uleb());
        const l = c.uleb();
        out.push([s, s + l]);
        break;
      }
      case 4: {
        // offset_pair
        const s = c.uleb();
        const e = c.uleb();
        out.push([(base + s) >>> 0, (base + e) >>> 0]);
        break;
      }
      case 5: // base_address
        base = c.u32();
        break;
      case 6: {
        // start_end
        const s = c.u32();
        const e = c.u32();
        out.push([s, e]);
        break;
      }
      case 7: {
        // start_length
        const s = c.u32();
        const l = c.uleb();
        out.push([s, (s + l) >>> 0]);
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
  while (c.offset + 8 <= section.length) {
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

// ─── location lists ────────────────────────────────────────────────────

export type LocationAttr =
  | { kind: 'expr'; expr: Uint8Array }
  | { kind: 'none' } // no location attribute at all (e.g. a const_value variable)
  | { kind: 'not-here'; entries: Array<{ lo: number; hi: number; expr: Uint8Array }> } // no entry covers pc: optimized out here
  | { kind: 'unsupported'; reason: string };

/** The location expression of `die` valid at `pc`, resolving location lists. */
export function locationAt(die: Die, at: number, pc: number, sections: DwarfSections): LocationAttr {
  const a = die.attrs.get(at);
  if (!a) {
    return { kind: 'none' };
  }
  if (a.cls === 'block' && a.value instanceof Uint8Array) {
    return { kind: 'expr', expr: a.value };
  }
  if (typeof a.value !== 'number') {
    return { kind: 'unsupported', reason: 'odd location form' };
  }
  const unit = die.unit;
  if (unit.version >= 5) {
    const section = sections.loclists;
    if (!section) {
      return { kind: 'unsupported', reason: 'no .debug_loclists' };
    }
    let offset = a.value;
    if (a.cls === 'loclistx') {
      const at2 = unit.loclistsBase + a.value * 4;
      if (at2 + 4 > section.length) {
        return { kind: 'unsupported', reason: 'loclistx out of range' };
      }
      offset = unit.loclistsBase + new DataView(section.buffer, section.byteOffset).getUint32(at2, true);
    }
    return readLoclist(section, offset, unit.lowPc, pc, sections.addr, unit);
  }
  const section = sections.loc;
  if (!section) {
    return { kind: 'unsupported', reason: 'no .debug_loc' };
  }
  return readLegacyLoclist(section, a.value, unit.lowPc, pc);
}

function readLoclist(
  section: Uint8Array,
  offset: number,
  base: number,
  pc: number,
  addrSection: Uint8Array | undefined,
  unit: Unit,
): LocationAttr {
  const c = new Cursor(section, offset);
  const addrx = (i: number): number => {
    if (!addrSection) {
      return 0;
    }
    const at = unit.addrBase + i * unit.addressSize;
    return at + 4 <= addrSection.length
      ? new DataView(addrSection.buffer, addrSection.byteOffset).getUint32(at, true)
      : 0;
  };
  let fallback: Uint8Array | null = null;
  const entries: Array<{ lo: number; hi: number; expr: Uint8Array }> = [];
  while (!c.eof) {
    const kind = c.u8();
    let lo = 0;
    let hi = 0;
    switch (kind) {
      case 0:
        return fallback ? { kind: 'expr', expr: fallback } : { kind: 'not-here', entries };
      case 1:
        base = addrx(c.uleb());
        continue;
      case 2:
        lo = addrx(c.uleb());
        hi = addrx(c.uleb());
        break;
      case 3:
        lo = addrx(c.uleb());
        hi = lo + c.uleb();
        break;
      case 4:
        lo = (base + c.uleb()) >>> 0;
        hi = (base + c.uleb()) >>> 0;
        break;
      case 5: {
        // default_location
        const len = c.uleb();
        fallback = c.take(len);
        continue;
      }
      case 6:
        base = c.u32();
        continue;
      case 7:
        lo = c.u32();
        hi = c.u32();
        break;
      case 8:
        lo = c.u32();
        hi = (lo + c.uleb()) >>> 0;
        break;
      default:
        return { kind: 'unsupported', reason: `DW_LLE ${kind}` };
    }
    const len = c.uleb();
    const expr = c.take(len);
    if (pc >= lo && pc < hi) {
      return { kind: 'expr', expr };
    }
    entries.push({ lo, hi, expr });
  }
  return { kind: 'not-here', entries };
}

function readLegacyLoclist(section: Uint8Array, offset: number, base: number, pc: number): LocationAttr {
  const c = new Cursor(section, offset);
  const entries: Array<{ lo: number; hi: number; expr: Uint8Array }> = [];
  while (c.offset + 8 <= section.length) {
    const s = c.u32();
    const e = c.u32();
    if (s === 0 && e === 0) {
      break;
    }
    if (s === 0xffffffff) {
      base = e;
      continue;
    }
    const len = c.u16();
    const expr = c.take(len);
    if (pc >= base + s && pc < base + e) {
      return { kind: 'expr', expr };
    }
    entries.push({ lo: (base + s) >>> 0, hi: (base + e) >>> 0, expr });
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
  if (op >= 0x50 && op <= 0x6f) {
    return regName(op - 0x50);
  }
  if (op >= 0x70 && op <= 0x8f) {
    const off = sleb();
    return `[${regName(op - 0x70)}${off >= 0 ? '+' : ''}${off}]`;
  }
  if (op === 0x91) {
    const off = sleb();
    return `[frame base${off >= 0 ? '+' : ''}${off}]`;
  }
  if (op === 0x03) {
    return `0x${new Cursor(expr, 1).u32().toString(16)}`;
  }
  if (op === 0x9c) {
    return 'cfa';
  }
  if (op === 0xa3 || op === 0xf3) {
    return 'entry value';
  }
  if (expr.includes(0x93)) {
    return 'pieces';
  }
  return `op 0x${op.toString(16)}`;
}

function regName(n: number): string {
  return n === 13 ? 'sp' : n === 14 ? 'lr' : n === 15 ? 'pc' : `r${n}`;
}
