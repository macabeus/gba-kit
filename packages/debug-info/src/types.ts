/**
 * DWARF `.debug_info` type parser — struct/union layouts and member offsets.
 *
 * The line parser ({@link ./debug-line}) only answers PC→source. This module
 * answers the other half a debugger / scripting harness needs: given a C type
 * name and a (possibly nested) field path, what byte offset does that field live
 * at, and how wide is it? Combined with a struct global's symbol address that is
 * enough to read any field straight out of memory.
 *
 * Handles the DIE forest in `.debug_info` (resolved against `.debug_abbrev` and
 * `.debug_str`) for DWARF 2–5 as emitted by agbcc (GCC 2.95) and modern
 * arm-none-eabi-gcc. 64-bit DWARF is not supported (GBA ELFs are 32-bit).
 */
import { ElfFile } from './elf.js';
import { Cursor, cstrAt } from './reader.js';

// DIE tags we care about.
const DW_TAG_array_type = 0x01;
const DW_TAG_enumeration_type = 0x04;
const DW_TAG_enumerator = 0x28;
const DW_TAG_member = 0x0d;
const DW_TAG_pointer_type = 0x0f;
const DW_TAG_structure_type = 0x13;
const DW_TAG_subrange_type = 0x21;
const DW_TAG_typedef = 0x16;
const DW_TAG_union_type = 0x17;
const DW_TAG_base_type = 0x24;
const DW_TAG_const_type = 0x26;
const DW_TAG_variable = 0x34;
const DW_TAG_volatile_type = 0x35;
const DW_TAG_restrict_type = 0x37;
const DW_TAG_atomic_type = 0x47;

// Attributes we read; all others are skipped generically by their form.
const DW_AT_name = 0x03;
const DW_AT_byte_size = 0x0b;
const DW_AT_bit_offset = 0x0c; // DWARF 2/3 bitfield: bits from the MSB of the storage unit
const DW_AT_bit_size = 0x0d; // bitfield width in bits
const DW_AT_const_value = 0x1c;
const DW_AT_upper_bound = 0x2f;
const DW_AT_data_bit_offset = 0x6b; // DWARF 4+ bitfield: absolute bit offset from the struct start
const DW_AT_count = 0x37;
const DW_AT_data_member_location = 0x38;
const DW_AT_declaration = 0x3c;
const DW_AT_type = 0x49;
const DW_AT_str_offsets_base = 0x72;

// Forms (attribute encodings).
const DW_FORM_addr = 0x01;
const DW_FORM_block2 = 0x03;
const DW_FORM_block4 = 0x04;
const DW_FORM_data2 = 0x05;
const DW_FORM_data4 = 0x06;
const DW_FORM_data8 = 0x07;
const DW_FORM_string = 0x08;
const DW_FORM_block = 0x09;
const DW_FORM_block1 = 0x0a;
const DW_FORM_data1 = 0x0b;
const DW_FORM_flag = 0x0c;
const DW_FORM_sdata = 0x0d;
const DW_FORM_strp = 0x0e;
const DW_FORM_udata = 0x0f;
const DW_FORM_ref_addr = 0x10;
const DW_FORM_ref1 = 0x11;
const DW_FORM_ref2 = 0x12;
const DW_FORM_ref4 = 0x13;
const DW_FORM_ref8 = 0x14;
const DW_FORM_ref_udata = 0x15;
const DW_FORM_indirect = 0x16;
const DW_FORM_sec_offset = 0x17;
const DW_FORM_exprloc = 0x18;
const DW_FORM_flag_present = 0x19;
const DW_FORM_strx = 0x1a;
const DW_FORM_addrx = 0x1b;
const DW_FORM_ref_sup4 = 0x1c;
const DW_FORM_strp_sup = 0x1d;
const DW_FORM_data16 = 0x1e;
const DW_FORM_line_strp = 0x1f;
const DW_FORM_ref_sig8 = 0x20;
const DW_FORM_implicit_const = 0x21;
const DW_FORM_loclistx = 0x22;
const DW_FORM_rnglistx = 0x23;
const DW_FORM_ref_sup8 = 0x24;
const DW_FORM_strx1 = 0x25;
const DW_FORM_strx2 = 0x26;
const DW_FORM_strx3 = 0x27;
const DW_FORM_strx4 = 0x28;
const DW_FORM_addrx1 = 0x29;
const DW_FORM_addrx2 = 0x2a;
const DW_FORM_addrx3 = 0x2b;
const DW_FORM_addrx4 = 0x2c;

// Location-expression opcode used to encode a constant member offset.
const DW_OP_plus_uconst = 0x23;

export interface StructMember {
  name: string;
  /** Byte offset from the start of the struct/union (of the byte holding the field). */
  offset: number;
  /**
   * Bytes to read at `offset`. For a plain member this is the member's type size;
   * for a bitfield it's the minimal little-endian span covering `bitOffset`+`bitWidth`.
   */
  size: number | null;
  /**
   * Bitfield only: right-shift to apply to the `size`-byte little-endian value read
   * at `offset` to reach the field's least-significant bit. Absent for plain members.
   */
  bitOffset?: number;
  /** Bitfield only: width in bits. Absent for plain members. */
  bitWidth?: number;
}

export interface StructType {
  /** The looked-up name (the struct tag, or the typedef alias that was queried). */
  name: string;
  /** DW_AT_byte_size of the struct/union, or null if absent. */
  size: number | null;
  members: StructMember[];
}

/** A parsed DIE: its tag plus the attributes we kept, and its child DIEs. */
interface Die {
  tag: number;
  /** Absolute offset of this DIE within `.debug_info` (its reference target). */
  offset: number;
  attrs: Map<number, AttrValue>;
  children: Die[];
}

/**
 * An attribute value, normalized across forms:
 *  - `number` for constants and (already absolutized) DIE references,
 *  - `string` for names,
 *  - `Uint8Array` for block / exprloc (e.g. a member-location expression),
 *  - `boolean` for flags.
 */
type AttrValue = number | string | Uint8Array | boolean;

/** One abbreviation declaration: a tag plus its ordered attribute specs. */
interface Abbrev {
  tag: number;
  hasChildren: boolean;
  specs: { attr: number; form: number; implicitConst?: number }[];
}

/** Per-compilation-unit context needed to decode attribute forms. */
interface UnitContext {
  /** Offset of the CU header start (base for CU-relative DIE references). */
  cuStart: number;
  version: number;
  addressSize: number;
  /** Size of a DW_FORM_ref_addr: address-sized in DWARF 2, offset-sized after. */
  refAddrSize: number;
  /** DW_AT_str_offsets_base for DW_FORM_strx, once seen on the CU DIE. */
  strOffsetsBase: number;
}

/** Struct/union member offsets and sizes, parsed from a `-g`-built ELF's DWARF. */
export class TypeIndex {
  /** Every parsed DIE, keyed by its absolute `.debug_info` offset. */
  readonly #byOffset = new Map<number, Die>();
  /** struct/union tag name → its defining DIE (definitions preferred over decls). */
  readonly #structByName = new Map<string, Die>();
  /** enum tag name → its defining DIE (definitions preferred over decls). */
  readonly #enumByName = new Map<string, Die>();
  /** typedef name → DIE it aliases (its DW_AT_type target). */
  readonly #typedefByName = new Map<string, Die>();
  /** global/static variable name → its DIE (carries DW_AT_type). */
  readonly #variableByName = new Map<string, Die>();

  /** Use {@link TypeIndex.fromElf}; this constructor is an internal detail. */
  constructor(roots: Die[]) {
    const index = (die: Die): void => {
      this.#byOffset.set(die.offset, die);
      for (const child of die.children) {
        index(child);
      }
    };
    for (const root of roots) {
      index(root);
    }

    for (const die of this.#byOffset.values()) {
      const name = die.attrs.get(DW_AT_name);
      if (typeof name !== 'string') {
        continue;
      }
      if (die.tag === DW_TAG_structure_type || die.tag === DW_TAG_union_type) {
        const existing = this.#structByName.get(name);
        // Prefer a real definition (has members / byte_size) over a forward decl.
        if (!existing || (isDeclaration(existing) && !isDeclaration(die))) {
          this.#structByName.set(name, die);
        }
      } else if (die.tag === DW_TAG_enumeration_type) {
        const existing = this.#enumByName.get(name);
        // Prefer the copy that actually carries enumerators over a bare declaration.
        if (!existing || (existing.children.length === 0 && die.children.length > 0)) {
          this.#enumByName.set(name, die);
        }
      } else if (die.tag === DW_TAG_typedef && !this.#typedefByName.has(name)) {
        this.#typedefByName.set(name, die);
      } else if (die.tag === DW_TAG_variable && die.attrs.has(DW_AT_type)) {
        const existing = this.#variableByName.get(name);
        // The same global appears once per CU that includes its header; most are
        // forward declarations. Prefer a real definition so its type ref resolves.
        if (!existing || (isDeclaration(existing) && !isDeclaration(die))) {
          this.#variableByName.set(name, die);
        }
      }
    }
  }

  /** True if any struct/union layout was recovered from the ELF. */
  get hasTypes(): boolean {
    return this.#structByName.size > 0;
  }

  /**
   * Look up a struct or union by name and return its members with offsets/sizes.
   * Accepts either the struct tag (`struct Foo` → `"Foo"`) or a typedef alias of
   * an (often anonymous) struct (`typedef struct {…} Foo;` → `"Foo"`).
   */
  struct(name: string): StructType | null {
    const die = this.#resolveStructByName(name);
    if (!die) {
      return null;
    }
    const members: StructMember[] = [];
    for (const child of die.children) {
      if (child.tag !== DW_TAG_member) {
        continue;
      }
      const memberName = child.attrs.get(DW_AT_name);
      if (typeof memberName !== 'string') {
        continue; // anonymous member (e.g. an unnamed union) — skip
      }
      members.push({ name: memberName, ...this.#memberLayout(child) });
    }
    return { name, size: numberAttr(die, DW_AT_byte_size), members };
  }

  /**
   * Resolve a (possibly nested) member path to its location, e.g.
   * `member('GameVariables', 'rng_info.seed')`. The path may be a dotted string
   * or an array of field names. Returns the final field's `{ offset, size }`
   * (plus `bitOffset`/`bitWidth` when it's a bitfield), or null if any segment
   * can't be resolved. Only the final segment may be a bitfield.
   */
  member(
    structName: string,
    path: string | string[],
  ): { offset: number; size: number | null; bitOffset?: number; bitWidth?: number } | null {
    return this.#memberPath(this.#resolveStructByName(structName), path);
  }

  /**
   * Resolve a (possibly nested) member path rooted at a global/static *variable*
   * rather than a type name, e.g. `variableMember('g_game_vars', 'rng_info.seed')`.
   * The variable's type comes from its DWARF DIE, so callers needn't name it. The
   * returned `offset` is relative to the variable's address; pair it with
   * `symbolToAddress(varName)` (see {@link DebugInfo.resolveVariable}).
   */
  variableMember(
    varName: string,
    path: string | string[],
  ): { offset: number; size: number | null; bitOffset?: number; bitWidth?: number } | null {
    const variable = this.#variableByName.get(varName);
    if (!variable) {
      return null;
    }
    return this.#memberPath(this.#resolveStructType(variable.attrs.get(DW_AT_type)), path);
  }

  /** Walk `path` from a struct/union DIE, accumulating member byte offsets. */
  #memberPath(
    structDie: Die | null,
    path: string | string[],
  ): { offset: number; size: number | null; bitOffset?: number; bitWidth?: number } | null {
    const segments = Array.isArray(path) ? path : path.split('.');
    if (segments.length === 0) {
      return null;
    }
    let die = structDie;
    let baseOffset = 0;
    for (let i = 0; i < segments.length; i++) {
      if (!die) {
        return null;
      }
      const member = die.children.find((c) => c.tag === DW_TAG_member && c.attrs.get(DW_AT_name) === segments[i]);
      if (!member) {
        return null;
      }
      if (i + 1 === segments.length) {
        const layout = this.#memberLayout(member);
        return { ...layout, offset: baseOffset + layout.offset };
      }
      // Intermediate segments are plain struct members — accumulate their byte offset.
      baseOffset += memberOffset(member);
      die = this.#resolveStructType(member.attrs.get(DW_AT_type));
    }
    return null;
  }

  /**
   * The constants of an enum by name, as `{ enumeratorName: value }`. Accepts the
   * enum tag (`enum Foo` → `"Foo"`) or a typedef alias of an (often anonymous)
   * enum (`typedef enum {…} Foo;` → `"Foo"`). Names are the C enumerators
   * verbatim. Returns null if the enum isn't in the DWARF.
   */
  enumValues(name: string): Record<string, number> | null {
    const die = this.#resolveEnumByName(name);
    if (!die) {
      return null;
    }
    const values: Record<string, number> = {};
    for (const child of die.children) {
      if (child.tag !== DW_TAG_enumerator) {
        continue;
      }
      const enumeratorName = child.attrs.get(DW_AT_name);
      const value = child.attrs.get(DW_AT_const_value);
      if (typeof enumeratorName === 'string' && typeof value === 'number') {
        values[enumeratorName] = value;
      }
    }
    return values;
  }

  /** Build from an ELF's `.debug_info` (+ `.debug_abbrev` / `.debug_str`). */
  static fromElf(elf: ElfFile): TypeIndex {
    const info = elf.sectionData('.debug_info');
    const abbrev = elf.sectionData('.debug_abbrev');
    if (!info || !abbrev) {
      return new TypeIndex([]);
    }
    const debugStr = elf.sectionData('.debug_str') ?? new Uint8Array(0);
    const debugStrOffsets = elf.sectionData('.debug_str_offsets') ?? new Uint8Array(0);
    const roots = parseDebugInfo(info, abbrev, debugStr, debugStrOffsets);
    return new TypeIndex(roots);
  }

  /** Name → struct/union DIE, transparently unwrapping a typedef alias. */
  #resolveStructByName(name: string): Die | null {
    const direct = this.#structByName.get(name);
    if (direct) {
      return direct;
    }
    const typedef = this.#typedefByName.get(name);
    return typedef ? this.#resolveStructType(typedef.attrs.get(DW_AT_type)) : null;
  }

  /** Name → enum DIE, transparently unwrapping a typedef alias. */
  #resolveEnumByName(name: string): Die | null {
    const direct = this.#enumByName.get(name);
    if (direct) {
      return direct;
    }
    const typedef = this.#typedefByName.get(name);
    if (!typedef) {
      return null;
    }
    let die = this.#deref(typedef.attrs.get(DW_AT_type));
    const seen = new Set<number>();
    while (die && !seen.has(die.offset)) {
      seen.add(die.offset);
      if (die.tag === DW_TAG_enumeration_type) {
        return die;
      }
      if (isQualifierOrTypedef(die.tag)) {
        die = this.#deref(die.attrs.get(DW_AT_type));
        continue;
      }
      return null;
    }
    return null;
  }

  /**
   * Compute a member's read location. Plain members report `{ offset, size }`
   * (byte offset + type size). Bitfields additionally report `{ bitOffset, bitWidth }`
   * and a minimal byte `offset`/`size` such that
   * `(read(offset, size) >> bitOffset) & ((1 << bitWidth) - 1)` is the field value.
   */
  #memberLayout(member: Die): { offset: number; size: number | null; bitOffset?: number; bitWidth?: number } {
    const bitWidth = numberAttr(member, DW_AT_bit_size);
    const typeSize = this.#typeRefSize(member.attrs.get(DW_AT_type));
    if (bitWidth === null) {
      return { offset: memberOffset(member), size: typeSize };
    }
    // Bitfield: normalize both DWARF encodings to an absolute bit offset, then to a
    // little-endian byte read (offset + minimal byte span + intra-byte shift).
    const absBitOffset = bitfieldAbsBitOffset(member, typeSize);
    const offset = absBitOffset >> 3;
    const bitOffset = absBitOffset & 7;
    return { offset, size: Math.ceil((bitOffset + bitWidth) / 8), bitOffset, bitWidth };
  }

  /** Follow a type reference through typedef/qualifier chains to a struct/union. */
  #resolveStructType(ref: AttrValue | undefined): Die | null {
    let die = this.#deref(ref);
    const seen = new Set<number>();
    while (die && !seen.has(die.offset)) {
      seen.add(die.offset);
      if (die.tag === DW_TAG_structure_type || die.tag === DW_TAG_union_type) {
        // A forward-declared struct points at the real definition by name.
        return isDeclaration(die) ? this.#resolveStructByName(asString(die.attrs.get(DW_AT_name))) : die;
      }
      if (isQualifierOrTypedef(die.tag)) {
        die = this.#deref(die.attrs.get(DW_AT_type));
        continue;
      }
      return null;
    }
    return null;
  }

  /** Size in bytes of a type reference, following typedef/qualifier/array chains. */
  #typeRefSize(ref: AttrValue | undefined): number | null {
    let die = this.#deref(ref);
    const seen = new Set<number>();
    while (die && !seen.has(die.offset)) {
      seen.add(die.offset);
      switch (die.tag) {
        case DW_TAG_base_type:
        case DW_TAG_enumeration_type:
        case DW_TAG_structure_type:
        case DW_TAG_union_type:
        case DW_TAG_pointer_type:
          return numberAttr(die, DW_AT_byte_size) ?? (die.tag === DW_TAG_pointer_type ? 4 : null);
        case DW_TAG_typedef:
        case DW_TAG_const_type:
        case DW_TAG_volatile_type:
        case DW_TAG_restrict_type:
        case DW_TAG_atomic_type:
          die = this.#deref(die.attrs.get(DW_AT_type));
          continue;
        case DW_TAG_array_type: {
          const elem = this.#typeRefSize(die.attrs.get(DW_AT_type));
          if (elem === null) {
            return null;
          }
          return elem * arrayLength(die);
        }
        default:
          return numberAttr(die, DW_AT_byte_size);
      }
    }
    return null;
  }

  #deref(ref: AttrValue | undefined): Die | null {
    return typeof ref === 'number' ? (this.#byOffset.get(ref) ?? null) : null;
  }
}

/** A DIE is a forward declaration (no layout) when it carries DW_AT_declaration. */
function isDeclaration(die: Die): boolean {
  return die.attrs.get(DW_AT_declaration) === true;
}

function isQualifierOrTypedef(tag: number): boolean {
  return (
    tag === DW_TAG_typedef ||
    tag === DW_TAG_const_type ||
    tag === DW_TAG_volatile_type ||
    tag === DW_TAG_restrict_type ||
    tag === DW_TAG_atomic_type
  );
}

/** A member's offset: a constant attribute, or a `DW_OP_plus_uconst` expression. */
function memberOffset(member: Die): number {
  const value = member.attrs.get(DW_AT_data_member_location);
  if (value === undefined) {
    return 0; // omitted → offset 0 (common for the first member)
  }
  if (typeof value === 'number') {
    return value;
  }
  if (value instanceof Uint8Array && value.length >= 1 && value[0] === DW_OP_plus_uconst) {
    return new Cursor(value, 1).uleb();
  }
  return 0;
}

/**
 * Absolute bit offset of a bitfield member from the start of its struct, normalized
 * across the two DWARF encodings:
 *  - DWARF 4+: `DW_AT_data_bit_offset` is already that absolute bit offset.
 *  - DWARF 2/3: `DW_AT_bit_offset` counts from the MSB of the storage unit (whose
 *    byte size is `DW_AT_byte_size`, at `DW_AT_data_member_location`). On a
 *    little-endian target the LSB offset within the unit is
 *    `storageBits - bit_offset - bit_size`.
 */
function bitfieldAbsBitOffset(member: Die, typeSize: number | null): number {
  const dataBitOffset = numberAttr(member, DW_AT_data_bit_offset);
  if (dataBitOffset !== null) {
    return dataBitOffset;
  }
  const bitOffsetFromMsb = numberAttr(member, DW_AT_bit_offset) ?? 0;
  const bitWidth = numberAttr(member, DW_AT_bit_size) ?? 0;
  const storageBytes = numberAttr(member, DW_AT_byte_size) ?? typeSize ?? 0;
  const lsbWithinUnit = storageBytes * 8 - bitOffsetFromMsb - bitWidth;
  return memberOffset(member) * 8 + lsbWithinUnit;
}

/** Element count of an array DIE (product of its DW_TAG_subrange_type dimensions). */
function arrayLength(arrayDie: Die): number {
  let count = 1;
  let sawDimension = false;
  for (const child of arrayDie.children) {
    if (child.tag !== DW_TAG_subrange_type) {
      continue;
    }
    sawDimension = true;
    const explicit = numberAttr(child, DW_AT_count);
    if (explicit !== null) {
      count *= explicit;
      continue;
    }
    const upper = numberAttr(child, DW_AT_upper_bound);
    count *= upper === null ? 0 : upper + 1; // flexible/unknown bound → 0
  }
  return sawDimension ? count : 0;
}

function numberAttr(die: Die, attr: number): number | null {
  const value = die.attrs.get(attr);
  return typeof value === 'number' ? value : null;
}

function asString(value: AttrValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** Parse every compilation unit in `.debug_info` into DIE trees. */
function parseDebugInfo(
  info: Uint8Array,
  abbrev: Uint8Array,
  debugStr: Uint8Array,
  debugStrOffsets: Uint8Array,
): Die[] {
  const roots: Die[] = [];
  const abbrevTables = new Map<number, Map<number, Abbrev>>();
  // agbcc (DWARF-2) does not emit a trailing 0-code terminator on each abbrev
  // table — tables abut and are delimited only by the CUs' debug_abbrev_offset.
  // Pre-scan every CU's offset so each table parse can stop at the next table's
  // start (in addition to the standard 0-code terminator).
  const boundaries = abbrevTableBoundaries(info, abbrev.length);
  const c = new Cursor(info);

  while (c.remaining >= 4) {
    const cuStart = c.offset;
    const unitLength = c.u32();
    if (unitLength === 0 || unitLength === 0xffffffff) {
      // 0 = padding; 0xffffffff = 64-bit DWARF (unsupported). Stop entirely.
      break;
    }
    const unitEnd = c.offset + unitLength;
    const version = c.u16();

    let abbrevOffset: number;
    let addressSize: number;
    if (version >= 5) {
      const unitType = c.u8();
      addressSize = c.u8();
      abbrevOffset = c.u32();
      // Skeleton/split units carry a dwo_id we don't handle — skip the unit.
      if (unitType !== 0x01 /* DW_UT_compile */ && unitType !== 0x03 /* DW_UT_partial */) {
        c.seek(unitEnd);
        continue;
      }
    } else {
      abbrevOffset = c.u32();
      addressSize = c.u8();
    }

    let table = abbrevTables.get(abbrevOffset);
    if (!table) {
      table = parseAbbrevTable(abbrev, abbrevOffset, nextAbbrevBoundary(boundaries, abbrevOffset));
      abbrevTables.set(abbrevOffset, table);
    }

    const ctx: UnitContext = {
      cuStart,
      version,
      addressSize,
      refAddrSize: version === 2 ? addressSize : 4,
      strOffsetsBase: 0,
    };

    // Parse the CU DIE and its descendants. The top-level DIE is the compile unit.
    // An exotic/unsupported form throws; skip just that unit, keep the rest.
    try {
      const cu = parseDie(c, table, ctx, unitEnd, debugStr, debugStrOffsets);
      if (cu) {
        roots.push(cu);
      }
    } catch {
      // fall through to seek past this unit
    }
    c.seek(unitEnd);
  }

  return roots;
}

/**
 * Collect every CU's `debug_abbrev_offset` (sorted, plus the section length as a
 * final bound), so each abbrev table can be bounded to where the next one starts.
 */
function abbrevTableBoundaries(info: Uint8Array, abbrevLength: number): number[] {
  const offsets = new Set<number>();
  const c = new Cursor(info);
  while (c.remaining >= 4) {
    const unitLength = c.u32();
    if (unitLength === 0 || unitLength === 0xffffffff) {
      break;
    }
    const unitEnd = c.offset + unitLength;
    const version = c.u16();
    if (version >= 5) {
      c.u8(); // unit_type
      c.u8(); // address_size
      offsets.add(c.u32()); // debug_abbrev_offset
    } else {
      offsets.add(c.u32()); // debug_abbrev_offset
      c.u8(); // address_size
    }
    c.seek(unitEnd);
  }
  return [...offsets, abbrevLength].sort((a, b) => a - b);
}

/** The smallest table boundary strictly greater than `offset`. */
function nextAbbrevBoundary(boundaries: number[], offset: number): number {
  for (const b of boundaries) {
    if (b > offset) {
      return b;
    }
  }
  return boundaries[boundaries.length - 1]!;
}

/**
 * Parse one abbreviation table into a code → declaration map. Stops at the
 * standard 0-code terminator or at `end` (the next table's start) — agbcc omits
 * the 0-code terminator and relies on the offset boundary alone.
 */
function parseAbbrevTable(abbrev: Uint8Array, offset: number, end: number): Map<number, Abbrev> {
  const table = new Map<number, Abbrev>();
  const c = new Cursor(abbrev, offset);
  while (c.offset < end && !c.eof) {
    const code = c.uleb();
    if (code === 0) {
      break; // end of this table
    }
    const tag = c.uleb();
    const hasChildren = c.u8() !== 0;
    const specs: Abbrev['specs'] = [];
    for (;;) {
      const attr = c.uleb();
      const form = c.uleb();
      if (attr === 0 && form === 0) {
        break; // (0,0) terminates the attribute spec list
      }
      // DW_FORM_implicit_const stores its constant inline in the abbrev itself.
      specs.push(form === DW_FORM_implicit_const ? { attr, form, implicitConst: c.sleb() } : { attr, form });
    }
    table.set(code, { tag, hasChildren, specs });
  }
  return table;
}

/**
 * Parse a single DIE and (recursively) its children. Returns null at the
 * sibling-terminating null entry (abbrev code 0).
 */
function parseDie(
  c: Cursor,
  table: Map<number, Abbrev>,
  ctx: UnitContext,
  unitEnd: number,
  debugStr: Uint8Array,
  debugStrOffsets: Uint8Array,
): Die | null {
  const offset = c.offset;
  const code = c.uleb();
  if (code === 0) {
    return null; // null DIE: end of a sibling chain
  }
  const abbrev = table.get(code);
  if (!abbrev) {
    // Unknown abbrev: we can't know the DIE's length, so stop this unit safely.
    c.seek(unitEnd);
    return null;
  }

  const attrs = new Map<number, AttrValue>();
  for (const spec of abbrev.specs) {
    const value = readForm(c, spec.form, ctx, spec.implicitConst, debugStr, debugStrOffsets);
    // Capture the str_offsets base from the CU DIE before any DW_FORM_strx is read.
    if (spec.attr === DW_AT_str_offsets_base && typeof value === 'number') {
      ctx.strOffsetsBase = value;
    }
    attrs.set(spec.attr, value);
  }

  const die: Die = { tag: abbrev.tag, offset, attrs, children: [] };

  if (abbrev.hasChildren) {
    for (;;) {
      if (c.offset >= unitEnd) {
        break;
      }
      const child = parseDie(c, table, ctx, unitEnd, debugStr, debugStrOffsets);
      if (!child) {
        break; // hit the null terminator
      }
      die.children.push(child);
    }
  }

  return die;
}

/** Decode one attribute value by its form, advancing the cursor past it. */
function readForm(
  c: Cursor,
  form: number,
  ctx: UnitContext,
  implicitConst: number | undefined,
  debugStr: Uint8Array,
  debugStrOffsets: Uint8Array,
): AttrValue {
  switch (form) {
    case DW_FORM_addr:
      return readBytes(c, ctx.addressSize);
    case DW_FORM_data1:
    case DW_FORM_flag:
      return c.u8();
    case DW_FORM_data2:
      return c.u16();
    case DW_FORM_data4:
      return c.u32();
    case DW_FORM_data8:
      return readBytes(c, 8);
    case DW_FORM_data16:
      return readBlock(c, 16);
    case DW_FORM_sdata:
      return c.sleb();
    case DW_FORM_udata:
      return c.uleb();
    case DW_FORM_string:
      return c.cstr();
    case DW_FORM_strp:
    case DW_FORM_line_strp: // resolves against .debug_line_str; names here use strp
    case DW_FORM_strp_sup:
      return cstrAt(debugStr, c.u32());
    case DW_FORM_strx:
      return resolveStrx(c.uleb(), ctx, debugStr, debugStrOffsets);
    case DW_FORM_strx1:
      return resolveStrx(c.u8(), ctx, debugStr, debugStrOffsets);
    case DW_FORM_strx2:
      return resolveStrx(c.u16(), ctx, debugStr, debugStrOffsets);
    case DW_FORM_strx3:
      return resolveStrx(readBytes(c, 3), ctx, debugStr, debugStrOffsets);
    case DW_FORM_strx4:
      return resolveStrx(c.u32(), ctx, debugStr, debugStrOffsets);
    case DW_FORM_ref1:
      return ctx.cuStart + c.u8();
    case DW_FORM_ref2:
      return ctx.cuStart + c.u16();
    case DW_FORM_ref4:
      return ctx.cuStart + c.u32();
    case DW_FORM_ref8:
      return ctx.cuStart + readBytes(c, 8);
    case DW_FORM_ref_udata:
      return ctx.cuStart + c.uleb();
    case DW_FORM_ref_addr:
      return readBytes(c, ctx.refAddrSize); // already section-absolute
    case DW_FORM_sec_offset:
    case DW_FORM_ref_sup4:
      return c.u32();
    case DW_FORM_ref_sup8:
    case DW_FORM_ref_sig8:
      return readBytes(c, 8);
    case DW_FORM_addrx:
    case DW_FORM_loclistx:
    case DW_FORM_rnglistx:
      return c.uleb();
    case DW_FORM_addrx1:
      return c.u8();
    case DW_FORM_addrx2:
      return c.u16();
    case DW_FORM_addrx3:
      return readBytes(c, 3);
    case DW_FORM_addrx4:
      return c.u32();
    case DW_FORM_flag_present:
      return true;
    case DW_FORM_implicit_const:
      return implicitConst ?? 0;
    case DW_FORM_block1:
      return readBlock(c, c.u8());
    case DW_FORM_block2:
      return readBlock(c, c.u16());
    case DW_FORM_block4:
      return readBlock(c, c.u32());
    case DW_FORM_block:
    case DW_FORM_exprloc:
      return readBlock(c, c.uleb());
    case DW_FORM_indirect:
      return readForm(c, c.uleb(), ctx, implicitConst, debugStr, debugStrOffsets);
    default:
      // Unknown form: we can't size it. Surface as empty so the caller bails the unit.
      throw new Error(`Unsupported DWARF form 0x${form.toString(16)}`);
  }
}

/** Read `n` little-endian bytes (n ≤ 4 for meaningful numbers; 8 returns low 32). */
function readBytes(c: Cursor, n: number): number {
  let value = 0;
  for (let i = 0; i < n; i++) {
    value |= c.u8() << (8 * i);
  }
  return value >>> 0;
}

function readBlock(c: Cursor, len: number): Uint8Array {
  const start = c.offset;
  c.skip(len);
  return c.bytes.subarray(start, start + len);
}

/** Resolve a DW_FORM_strx index via .debug_str_offsets → .debug_str. */
function resolveStrx(index: number, ctx: UnitContext, debugStr: Uint8Array, debugStrOffsets: Uint8Array): string {
  const at = ctx.strOffsetsBase + index * 4;
  if (at + 4 > debugStrOffsets.length) {
    return '';
  }
  const c = new Cursor(debugStrOffsets);
  return cstrAt(debugStr, c.u32At(at));
}
