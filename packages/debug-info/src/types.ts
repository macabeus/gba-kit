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
 * `.debug_str`) for DWARF 2–5, in either byte order — a big-endian payload is read
 * MSB-first, and bitfields there are allocated from the opposite end of the storage
 * unit (see {@link bitfieldAbsBitOffset}). 64-bit DWARF is not supported (the ELFs
 * are 32-bit).
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
const DW_AT_encoding = 0x3e;
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
   * for a bitfield it's the minimal span covering `bitOffset`+`bitWidth`.
   */
  size: number | null;
  /**
   * Signedness of the member's type, resolved through typedefs/cv-qualifiers to a base
   * type (`DW_AT_encoding`); null when the member's type is not a base type (arrays,
   * pointers, nested structs, enums). Offset and size alone do not carry it: the same
   * byte reads as -1 or as 255 depending only on this.
   */
  signed: boolean | null;
  /**
   * Present (true) when the member's resolved type is a pointer. Disambiguates the
   * `signed: null` 4-byte cases (pointer vs enum vs nested struct), which offset and
   * size cannot tell apart and which differ in how the value may be compared
   * (pointers compare as unsigned).
   */
  pointer?: true;
  /**
   * Pointer member only: the byte size of the type it points AT, when that type is a base
   * type (`u16 *` → 2). Absent when the target is not a base type (`void *`, `struct S *`, a
   * function pointer) or the DWARF does not size it.
   *
   * The member's own size is 4 whatever it addresses, so this describes the OTHER end — and it
   * is not decoration: pointer arithmetic scales by it, so `p - 4` on a `u16 *` and on a
   * `void *` address different bytes.
   */
  pointeeSize?: number;
  /** Pointer member only: signedness of the pointed-at base type, on the same terms as
   *  {@link pointeeSize} (`s8 *` → true). Absent whenever `pointeeSize` is. */
  pointeeSigned?: boolean;
  /**
   * Present (true) when the member's type chain crosses a volatile qualifier — the
   * `vu16 field;` MMIO idiom. Part of the declaration rather than of the layout: it
   * says repeated accesses to the field are observable and not interchangeable.
   */
  volatile?: true;
  /**
   * Present (true) when the member's type chain crosses a const qualifier — the read-only-field
   * idiom. Part of the declaration rather than of the layout, and not interchangeable with an
   * unqualified member: a write through it is a constraint violation, not another spelling.
   */
  const?: true;
  /**
   * Bitfield only: right-shift to apply to the `size`-byte value read at `offset`
   * — in the ELF's own byte order — to reach the field's least-significant bit.
   * Absent for plain members. A big-endian target allocates bitfields MSB-first, so
   * the same C declaration yields mirrored shifts there (see {@link TypeIndex}).
   */
  bitOffset?: number;
  /** Bitfield only: width in bits. Absent for plain members. */
  bitWidth?: number;
  /**
   * Array member only: the byte size of ONE element. `size` above is the WHOLE member
   * (`u8 x[16]` → 16), so it cannot express where the n-th element of that member starts;
   * this is the stride that does. Absent when the member's type is not an array — its
   * presence is what identifies one. Spelled like {@link VariableShape}'s array arm.
   */
  elemSize?: number;
  /**
   * Array member only: signedness of the ELEMENT's base type — the same fact `signed` carries
   * for a plain member (the same byte reads as -1 or as 255 depending only on it; `signed` is
   * null for an array, whose own type is not a base type). Absent when the element is not a
   * base type (an array of structs/pointers/enums), or the member is not an array.
   */
  elemSigned?: boolean;
  /**
   * Array member only: the element count — the product of the DW_TAG_subrange dimensions, so a
   * multidimensional member reports its total. Absent when no dimension bounds it (a flexible
   * array member, `char data[]`, which declares a stride but no length).
   */
  length?: number;
}

export interface StructType {
  /** The looked-up name (the struct tag, or the typedef alias that was queried). */
  name: string;
  /** DW_AT_byte_size of the struct/union, or null if absent. */
  size: number | null;
  members: StructMember[];
}

/**
 * The declaration SHAPE of a global variable — what kind of thing its C type is, resolved
 * through typedefs and cv-qualifiers. A small closed set, for a consumer that needs to know how
 * a name is declared (`extern u16 tbl[]` vs a scalar vs a struct) without a full DIE→C-type
 * renderer.
 *
 * The cv-qualifiers crossed while resolving are part of the shape: `volatile` says accesses to
 * the object are observable and may not be folded or reordered, `const` that it is read-only
 * (the ROM-table spelling). For arrays the element chain's qualifiers count too — `const u16
 * tbl[]` qualifies the element type in DWARF. On the `pointer` arm they are the POINTER
 * variable's own qualifiers (`struct S *volatile g`); what it points at carries its own, on
 * {@link PointeeStruct}.
 *
 * The `struct` arm's `structName` is the name {@link TypeIndex.struct} looks the layout up by,
 * under the same rule as {@link PointeeStruct}: the tag when the type has one, otherwise the
 * typedef alias that names it.
 */
export type VariableShape =
  | { kind: 'scalar'; size: number | null; signed: boolean | null; volatile: boolean; const: boolean }
  | { kind: 'pointer'; pointee: PointeeStruct | null; volatile: boolean; const: boolean }
  | {
      kind: 'array';
      elemSize: number | null;
      elemSigned: boolean | null;
      length: number | null;
      volatile: boolean;
      const: boolean;
    }
  | { kind: 'struct'; structName: string | null; size: number | null; volatile: boolean; const: boolean };

/**
 * What a `pointer` shape points AT, when its target resolves (through typedefs/cv-qualifiers) to
 * a struct or union: enough to name that type and to size it, without a full DIE→C-type renderer.
 * `null` on the pointer arm when the target is anything else — a scalar, another pointer, a
 * function, or `void`.
 *
 * `structName` is the name {@link TypeIndex.struct} looks the layout up by, which is not always a
 * tag: for the `typedef struct {…} T;` idiom the struct itself is unnamed and `T` is the only name
 * it has, so the last typedef alias crossed on the way is reported instead. Null when the target
 * has neither — an unnamed struct reached without an alias, whose layout no name can retrieve.
 *
 * `volatile` / `const` are the TARGET's qualifiers — the ones a declaration spells to the LEFT of
 * the `*` (`volatile struct S *g`): accesses made THROUGH the pointer are observable / read-only.
 * They are a different fact from the pointer variable's own qualifiers to the right of it
 * (`struct S *volatile g`), which stay on the enclosing {@link VariableShape}.
 */
export interface PointeeStruct {
  structName: string | null;
  /** DW_AT_byte_size of the target struct/union, or null if absent (an incomplete type). */
  size: number | null;
  volatile: boolean;
  const: boolean;
}

/** A member's read location: its byte offset + size, plus bitfield shift/width. (Signedness,
 *  pointer-ness, cv-qualifiers and the array element facts are declaration facts, not locations —
 *  they stay on {@link StructMember} / `struct()`.) */
export type MemberLocation = Omit<
  StructMember,
  'name' | 'signed' | 'pointer' | 'volatile' | 'const' | 'elemSize' | 'elemSigned' | 'length'
>;

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

/** The DWARF string sections an attribute form may resolve a name against. */
interface DebugStrings {
  /** byte order of the DWARF payload (matches the ELF container) */
  littleEndian: boolean;
  /** `.debug_str` — DW_FORM_strp and the targets of DW_FORM_strx. */
  str: Uint8Array;
  /** `.debug_line_str` — DW_FORM_line_strp. */
  lineStr: Uint8Array;
  /** `.debug_str_offsets` — the DW_FORM_strx index table. */
  strOffsets: Uint8Array;
}

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
  /** Set when an unrecoverable form/OOB error aborts this CU; unwinds the DIE walk. */
  aborted?: boolean;
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
  /** Byte order of the target — decides which end bitfields are allocated from. */
  readonly #littleEndian: boolean;

  /** Use {@link TypeIndex.fromElf}; this constructor is an internal detail. */
  constructor(roots: Die[], littleEndian = true) {
    this.#littleEndian = littleEndian;
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
      members.push({ name: memberName, ...this.#memberLayout(child), ...this.#memberFacts(child) });
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
  member(structName: string, path: string | string[]): MemberLocation | null {
    return this.#memberPath(this.#resolveStructByName(structName), path);
  }

  /**
   * Resolve a (possibly nested) member path rooted at a global/static *variable*
   * rather than a type name, e.g. `variableMember('g_game_vars', 'rng_info.seed')`.
   * The variable's type comes from its DWARF DIE, so callers needn't name it. The
   * returned `offset` is relative to the variable's address; pair it with
   * `symbolToAddress(varName)` (see {@link DebugInfo.resolveVariable}).
   */
  variableMember(varName: string, path: string | string[]): MemberLocation | null {
    const variable = this.#variableByName.get(varName);
    if (!variable) {
      return null;
    }
    return this.#memberPath(this.#resolveStructType(variable.attrs.get(DW_AT_type)), path);
  }

  /** Byte size of a global/static variable's type, or null if unknown. */
  variableSize(varName: string): number | null {
    const variable = this.#variableByName.get(varName);
    return variable ? this.#typeRefSize(variable.attrs.get(DW_AT_type)) : null;
  }

  /**
   * Classify a global/static variable's declaration shape (scalar | pointer | array | struct),
   * resolved through typedefs/cv-qualifiers. `null` when the variable has no DWARF DIE — which
   * also makes this the "is this name declared in the project headers?" probe. An unsized
   * extern array (`extern u16 tbl[]`) classifies as `array` with `length: null`.
   */
  variableShape(varName: string): VariableShape | null {
    const variable = this.#variableByName.get(varName);
    if (!variable) {
      return null;
    }
    const cv = { volatile: false, const: false };
    const alias = { typedef: null as string | null };
    const die = this.#stripTypedefs(variable.attrs.get(DW_AT_type), cv, alias);
    if (!die) {
      return null;
    }
    switch (die.tag) {
      case DW_TAG_pointer_type:
        return { kind: 'pointer', pointee: this.#pointee(die.attrs.get(DW_AT_type)), ...cv };
      case DW_TAG_array_type: {
        // The element chain's qualifiers count toward the variable's declaration
        // (`const u16 tbl[]` qualifies the ELEMENT type in DWARF) — collect into the same cv.
        const elem = this.#stripTypedefs(die.attrs.get(DW_AT_type), cv);
        return {
          kind: 'array',
          elemSize: this.#typeRefSize(die.attrs.get(DW_AT_type)),
          elemSigned: elem ? baseTypeSignedness(elem) : null,
          length: arrayLength(die),
          ...cv,
        };
      }
      case DW_TAG_structure_type:
      case DW_TAG_union_type:
        return { kind: 'struct', ...this.#structTarget(die, alias), ...cv };
      default:
        return {
          kind: 'scalar',
          size: this.#typeRefSize(variable.attrs.get(DW_AT_type)),
          signed: baseTypeSignedness(die),
          ...cv,
        };
    }
  }

  /**
   * The struct/union a pointer's target resolves to, named the way {@link TypeIndex.struct} looks
   * a layout up and carrying the target's own cv-qualifiers (see {@link PointeeStruct}), or null
   * when the target is not a struct/union. The qualifiers are those crossed BETWEEN the pointer
   * and its target, so they are the pointee's alone — the pointer variable's own are accumulated
   * by the separate walk that reached the `DW_TAG_pointer_type` DIE.
   */
  #pointee(ref: AttrValue | undefined): PointeeStruct | null {
    const cv = { volatile: false, const: false };
    const alias = { typedef: null as string | null };
    const die = this.#stripTypedefs(ref, cv, alias);
    if (!die || (die.tag !== DW_TAG_structure_type && die.tag !== DW_TAG_union_type)) {
      return null;
    }
    return { ...this.#structTarget(die, alias), ...cv };
  }

  /**
   * Name and size a resolved struct/union DIE, given the `alias` accumulated by the walk that
   * reached it. The name is the one {@link TypeIndex.struct} looks a layout up by: the tag when
   * the type has one, else the last typedef crossed — the `typedef struct {…} T;` idiom leaves
   * the struct unnamed, so `T` is the only name its layout has. A DIE that is only a forward
   * declaration carries no `DW_AT_byte_size`, so the size is read from the definition its tag
   * resolves to.
   */
  #structTarget(die: Die, alias: { typedef: string | null }): { structName: string | null; size: number | null } {
    const tag = die.attrs.get(DW_AT_name);
    const defined = isDeclaration(die) ? this.#resolveStructByName(asString(tag)) : die;
    return {
      structName: typeof tag === 'string' ? tag : alias.typedef,
      size: defined ? numberAttr(defined, DW_AT_byte_size) : null,
    };
  }

  /** Walk `path` from a struct/union DIE, accumulating member byte offsets. */
  #memberPath(structDie: Die | null, path: string | string[]): MemberLocation | null {
    const segments = Array.isArray(path) ? path : path.split('.');
    if (segments.length === 0) {
      return null;
    }
    let die: Die | null = structDie;
    let baseOffset = 0;
    for (let i = 0; i < segments.length; i++) {
      if (!die) {
        return null;
      }
      const found = this.#findMember(die, segments[i]);
      if (!found) {
        return null;
      }
      if (i + 1 === segments.length) {
        const layout = this.#memberLayout(found.member);
        return { ...layout, offset: baseOffset + found.baseOffset + layout.offset };
      }
      // Intermediate segment: descend into its (possibly anonymous-wrapped) type.
      baseOffset += found.baseOffset + memberOffset(found.member);
      die = this.#resolveStructType(found.member.attrs.get(DW_AT_type));
    }
    return null;
  }

  /**
   * Find a named member within a struct/union, transparently descending into
   * anonymous union/struct members (whose fields are accessed as if they belonged
   * to the parent). Returns the member DIE plus the byte offset of the anonymous
   * wrappers enclosing it (0 for a direct member); the member's own offset is added
   * by the caller via {@link memberOffset} / {@link #memberLayout}.
   */
  #findMember(structDie: Die, name: string): { member: Die; baseOffset: number } | null {
    for (const child of structDie.children) {
      if (child.tag !== DW_TAG_member) {
        continue;
      }
      const childName = child.attrs.get(DW_AT_name);
      if (childName === name) {
        return { member: child, baseOffset: 0 };
      }
      if (typeof childName !== 'string' || childName === '') {
        // Anonymous union/struct member: descend, as its fields are accessed directly.
        const inner = this.#resolveStructType(child.attrs.get(DW_AT_type));
        const found = inner && this.#findMember(inner, name);
        if (found) {
          return { member: found.member, baseOffset: memberOffset(child) + found.baseOffset };
        }
      }
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
    const strings: DebugStrings = {
      littleEndian: elf.littleEndian,
      str: elf.sectionData('.debug_str') ?? new Uint8Array(0),
      lineStr: elf.sectionData('.debug_line_str') ?? new Uint8Array(0),
      strOffsets: elf.sectionData('.debug_str_offsets') ?? new Uint8Array(0),
    };
    try {
      return new TypeIndex(parseDebugInfo(info, abbrev, strings), elf.littleEndian);
    } catch {
      // Type parsing is best-effort: a malformed .debug_info must never take down
      // the rest of DebugInfo (symbols, line table). Fall back to "no types".
      return new TypeIndex([], elf.littleEndian);
    }
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
    const die = this.#stripTypedefs(typedef.attrs.get(DW_AT_type));
    return die && die.tag === DW_TAG_enumeration_type ? die : null;
  }

  /**
   * Compute a member's read location. Plain members report `{ offset, size }`
   * (byte offset + type size). Bitfields additionally report `{ bitOffset, bitWidth }`
   * and a minimal byte `offset`/`size` such that
   * `(read(offset, size) >>> bitOffset) & (2 ** bitWidth - 1)` is the field value,
   * where `read` decodes `size` bytes in the ELF's own byte order (the `2 **` form
   * stays correct for a full-width 32-bit field, where `1 << 32` wraps).
   */
  #memberLayout(member: Die): MemberLocation {
    const bitWidth = numberAttr(member, DW_AT_bit_size);
    const typeSize = this.#typeRefSize(member.attrs.get(DW_AT_type));
    if (bitWidth === null) {
      return { offset: memberOffset(member), size: typeSize };
    }
    // Bitfield: normalize both DWARF encodings to an absolute bit offset counted from
    // the end the target allocates from, then to a byte read (offset + minimal byte
    // span + intra-unit shift).
    const absBitOffset = bitfieldAbsBitOffset(member, typeSize, this.#littleEndian);
    const offset = absBitOffset >> 3;
    const bitsIntoByte = absBitOffset & 7;
    const size = Math.ceil((bitsIntoByte + bitWidth) / 8);
    // Little-endian: the bits counted so far already sit below the field, so they ARE
    // the shift. Big-endian: they sit above it, so the shift is what remains beneath.
    const bitOffset = this.#littleEndian ? bitsIntoByte : size * 8 - bitsIntoByte - bitWidth;
    return { offset, size, bitOffset, bitWidth };
  }

  /** Follow a type reference through typedef/qualifier chains to a struct/union. */
  #resolveStructType(ref: AttrValue | undefined): Die | null {
    const die = this.#stripTypedefs(ref);
    if (die && (die.tag === DW_TAG_structure_type || die.tag === DW_TAG_union_type)) {
      // A forward-declared struct points at the real definition by name.
      return isDeclaration(die) ? this.#resolveStructByName(asString(die.attrs.get(DW_AT_name))) : die;
    }
    return null;
  }

  /** Size in bytes of a type reference, following typedef/qualifier/array chains. */
  #typeRefSize(ref: AttrValue | undefined): number | null {
    const die = this.#stripTypedefs(ref);
    if (!die) {
      return null;
    }
    switch (die.tag) {
      case DW_TAG_base_type:
      case DW_TAG_enumeration_type:
      case DW_TAG_structure_type:
      case DW_TAG_union_type:
      case DW_TAG_pointer_type:
        return numberAttr(die, DW_AT_byte_size) ?? (die.tag === DW_TAG_pointer_type ? 4 : null);
      case DW_TAG_array_type: {
        const elem = this.#typeRefSize(die.attrs.get(DW_AT_type));
        const len = arrayLength(die);
        if (elem === null || len === null) {
          return null;
        }
        return elem * len;
      }
      default:
        return numberAttr(die, DW_AT_byte_size);
    }
  }

  /** A member's declaration facts: base-type signedness, pointer-ness, its cv-qualifiers, and —
   *  for an array member — its element stride/signedness/count, all resolved through
   *  typedef/cv-qualifier chains (see the {@link StructMember} field docs). */
  #memberFacts(
    member: Die,
  ): Pick<
    StructMember,
    'signed' | 'pointer' | 'pointeeSize' | 'pointeeSigned' | 'volatile' | 'const' | 'elemSize' | 'elemSigned' | 'length'
  > {
    const cv = { volatile: false, const: false };
    const die = this.#stripTypedefs(member.attrs.get(DW_AT_type), cv);
    return {
      signed: die ? baseTypeSignedness(die) : null,
      ...(die?.tag === DW_TAG_pointer_type ? { pointer: true as const, ...this.#pointeeFacts(die) } : {}),
      ...(cv.volatile ? { volatile: true as const } : {}),
      ...(cv.const ? { const: true as const } : {}),
      ...(die?.tag === DW_TAG_array_type ? this.#arrayFacts(die) : {}),
    };
  }

  /** A pointer member's target facts, when the target resolves to a BASE type. Anything else —
   *  `void *`, a struct/function pointer, an unsized target — reports nothing, so a present key
   *  is always a fact rather than a default. */
  #pointeeFacts(pointerDie: Die): Pick<StructMember, 'pointeeSize' | 'pointeeSigned'> {
    const targetRef = pointerDie.attrs.get(DW_AT_type);
    const target = this.#stripTypedefs(targetRef);
    if (!target || target.tag !== DW_TAG_base_type) {
      return {};
    }
    const pointeeSize = this.#typeRefSize(targetRef);
    const pointeeSigned = baseTypeSignedness(target);
    return {
      ...(pointeeSize !== null ? { pointeeSize } : {}),
      ...(pointeeSigned !== null ? { pointeeSigned } : {}),
    };
  }

  /** An array member's element facts. Each is omitted when the DWARF does not determine it — an
   *  unsized element type has no stride, a flexible array member no length — so a present key is
   *  always a fact, never a default. */
  #arrayFacts(arrayDie: Die): Pick<StructMember, 'elemSize' | 'elemSigned' | 'length'> {
    const elemRef = arrayDie.attrs.get(DW_AT_type);
    const elem = this.#stripTypedefs(elemRef);
    const elemSize = this.#typeRefSize(elemRef);
    const elemSigned = elem ? baseTypeSignedness(elem) : null;
    const length = arrayLength(arrayDie);
    return {
      ...(elemSize !== null ? { elemSize } : {}),
      ...(elemSigned !== null ? { elemSigned } : {}),
      ...(length !== null ? { length } : {}),
    };
  }

  /** Follow typedef / cv-qualifier links to the underlying type DIE (cycle-guarded). With a
   *  `cv` accumulator, the const/volatile qualifiers crossed on the way are recorded into it —
   *  callers that report a declaration (variableShape, #memberFacts) need them; callers that
   *  only want the underlying type omit it. The `alias` accumulator is the same idea for the last
   *  TYPEDEF name crossed, which naming an unnamed struct needs (see {@link #structTarget}) and the
   *  cv object must not carry (it is spread straight into a declaration shape). */
  #stripTypedefs(
    ref: AttrValue | undefined,
    cv?: { volatile: boolean; const: boolean },
    alias?: { typedef: string | null },
  ): Die | null {
    let die = this.#deref(ref);
    const seen = new Set<number>();
    while (die && isQualifierOrTypedef(die.tag) && !seen.has(die.offset)) {
      if (cv && die.tag === DW_TAG_volatile_type) {
        cv.volatile = true;
      }
      if (cv && die.tag === DW_TAG_const_type) {
        cv.const = true;
      }
      if (alias && die.tag === DW_TAG_typedef) {
        const name = die.attrs.get(DW_AT_name);
        if (typeof name === 'string') {
          alias.typedef = name;
        }
      }
      seen.add(die.offset);
      die = this.#deref(die.attrs.get(DW_AT_type));
    }
    return die;
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
 * Absolute bit offset of a bitfield member from the start of its struct, counted from
 * the end the target allocates bitfields from: the LSB of the first byte on a
 * little-endian target, the MSB of it on a big-endian one. Normalized across the two
 * DWARF encodings:
 *  - DWARF 4+: `DW_AT_data_bit_offset` is already that offset — DWARF numbers bits
 *    from the same end the target allocates from, so it needs no adjustment.
 *  - DWARF 2/3: `DW_AT_bit_offset` counts from the MSB of the storage unit (whose
 *    byte size is `DW_AT_byte_size`, at `DW_AT_data_member_location`). That is
 *    already the big-endian answer; on little-endian the offset within the unit
 *    flips to `storageBits - bit_offset - bit_size`.
 */
function bitfieldAbsBitOffset(member: Die, typeSize: number | null, littleEndian: boolean): number {
  const dataBitOffset = numberAttr(member, DW_AT_data_bit_offset);
  if (dataBitOffset !== null) {
    return dataBitOffset;
  }
  const bitOffsetFromMsb = numberAttr(member, DW_AT_bit_offset) ?? 0;
  if (!littleEndian) {
    return memberOffset(member) * 8 + bitOffsetFromMsb;
  }
  const bitWidth = numberAttr(member, DW_AT_bit_size) ?? 0;
  const storageBytes = numberAttr(member, DW_AT_byte_size) ?? typeSize ?? 0;
  const lsbWithinUnit = storageBytes * 8 - bitOffsetFromMsb - bitWidth;
  return memberOffset(member) * 8 + lsbWithinUnit;
}

/**
 * Element count of an array DIE (product of its DW_TAG_subrange_type dimensions),
 * or null if any dimension is flexible (no bound) or zero-length — those have no
 * fixed read size, so the member's size should surface as null, not 0.
 */
function arrayLength(arrayDie: Die): number | null {
  let count = 1;
  let sawDimension = false;
  for (const child of arrayDie.children) {
    if (child.tag !== DW_TAG_subrange_type) {
      continue;
    }
    sawDimension = true;
    const explicit = numberAttr(child, DW_AT_count);
    const upper = numberAttr(child, DW_AT_upper_bound);
    const dim = explicit !== null ? explicit : upper !== null ? upper + 1 : null;
    if (dim === null || dim <= 0) {
      return null;
    }
    count *= dim;
  }
  return sawDimension ? count : null;
}

/** Signedness of a base type from DW_AT_encoding (DW_ATE_signed/signed_char = signed;
 *  unsigned/unsigned_char/boolean = unsigned). Non-base types (enums, etc.) → null. */
function baseTypeSignedness(die: Die): boolean | null {
  if (die.tag !== DW_TAG_base_type) {
    return null;
  }
  const enc = numberAttr(die, DW_AT_encoding);
  return enc === null ? null : enc === 0x05 || enc === 0x06;
}

function numberAttr(die: Die, attr: number): number | null {
  const value = die.attrs.get(attr);
  return typeof value === 'number' ? value : null;
}

function asString(value: AttrValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** The decoded fixed header of one compilation unit in `.debug_info`. */
interface CuHeader {
  cuStart: number;
  /** Exclusive end of the unit, clamped to the section. */
  unitEnd: number;
  /** Offset of the first DIE, just past the fixed header. */
  dieStart: number;
  version: number;
  addressSize: number;
  abbrevOffset: number;
  /** DWARF 5 DW_UT_*; 0 for DWARF ≤ 4 (always a full compile unit). */
  unitType: number;
}

/**
 * Decode the fixed header of every compilation unit. The DWARF 2/3/4 and 5 header
 * layouts differ (5 inserts unit_type + address_size before debug_abbrev_offset).
 * Stops at end-of-section, a 0/0xffffffff unit_length (padding / unsupported 64-bit
 * DWARF), or the first truncated/inconsistent header — returning the units decoded
 * so far rather than throwing, so a malformed tail unit can't lose the whole section.
 */
function collectCuHeaders(info: Uint8Array, littleEndian: boolean): CuHeader[] {
  const headers: CuHeader[] = [];
  const c = new Cursor(info, 0, littleEndian);
  while (c.remaining >= 4) {
    const cuStart = c.offset;
    const unitLength = c.u32();
    if (unitLength === 0 || unitLength === 0xffffffff) {
      break;
    }
    const rawEnd = c.offset + unitLength;
    const unitEnd = Math.min(rawEnd, info.length);
    try {
      const version = c.u16();
      let abbrevOffset: number;
      let addressSize: number;
      let unitType = 0;
      if (version >= 5) {
        unitType = c.u8();
        addressSize = c.u8();
        abbrevOffset = c.u32();
      } else {
        abbrevOffset = c.u32();
        addressSize = c.u8();
      }
      headers.push({ cuStart, unitEnd, dieStart: c.offset, version, addressSize, abbrevOffset, unitType });
    } catch {
      break; // truncated header — keep the units decoded so far
    }
    if (rawEnd > info.length || unitEnd <= c.offset) {
      break; // unit runs past the section (or is degenerate) — don't trust what follows
    }
    c.seek(unitEnd);
  }
  return headers;
}

/** Parse every compilation unit in `.debug_info` into DIE trees. */
function parseDebugInfo(info: Uint8Array, abbrev: Uint8Array, strings: DebugStrings): Die[] {
  const roots: Die[] = [];
  const abbrevTables = new Map<number, Map<number, Abbrev>>();
  const headers = collectCuHeaders(info, strings.littleEndian);
  // agbcc (DWARF-2) does not emit a trailing 0-code terminator on each abbrev
  // table — tables abut and are delimited only by the CUs' debug_abbrev_offset.
  // Bound each table to the next one's start (in addition to the 0-code terminator).
  const boundaries = abbrevTableBoundaries(headers, abbrev.length);
  const c = new Cursor(info, 0, strings.littleEndian);

  for (const h of headers) {
    // Skeleton/split units carry a dwo_id we don't handle — skip the unit.
    if (h.version >= 5 && h.unitType !== 0x01 /* DW_UT_compile */ && h.unitType !== 0x03 /* DW_UT_partial */) {
      continue;
    }

    let table = abbrevTables.get(h.abbrevOffset);
    if (!table) {
      try {
        table = parseAbbrevTable(abbrev, h.abbrevOffset, nextAbbrevBoundary(boundaries, h.abbrevOffset));
      } catch {
        continue; // unparseable abbrev table — skip this unit, keep the rest
      }
      abbrevTables.set(h.abbrevOffset, table);
    }

    const ctx: UnitContext = {
      cuStart: h.cuStart,
      version: h.version,
      addressSize: h.addressSize,
      refAddrSize: h.version === 2 ? h.addressSize : 4,
      strOffsetsBase: 0,
    };

    // Parse the CU DIE and its descendants. A malformed CU DIE throws; skip just
    // that unit, keep the rest. (Errors deeper in the tree are salvaged in parseDie.)
    c.seek(h.dieStart);
    try {
      const cu = parseDie(c, table, ctx, h.unitEnd, strings);
      if (cu) {
        roots.push(cu);
      }
    } catch {
      // skip this unit
    }
  }

  return roots;
}

/**
 * Every CU's `debug_abbrev_offset` (sorted, plus the section length as a final
 * bound), so each abbrev table can be bounded to where the next one starts.
 */
function abbrevTableBoundaries(headers: CuHeader[], abbrevLength: number): number[] {
  const offsets = new Set<number>(headers.map((h) => h.abbrevOffset));
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
  strings: DebugStrings,
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
    const value = readForm(c, spec.form, ctx, spec.implicitConst, strings);
    // Capture the str_offsets base from the CU DIE before any DW_FORM_strx is read.
    if (spec.attr === DW_AT_str_offsets_base && typeof value === 'number') {
      ctx.strOffsetsBase = value;
    }
    attrs.set(spec.attr, value);
  }

  const die: Die = { tag: abbrev.tag, offset, attrs, children: [] };

  if (abbrev.hasChildren) {
    for (;;) {
      if (ctx.aborted || c.offset >= unitEnd) {
        break;
      }
      let child: Die | null;
      try {
        child = parseDie(c, table, ctx, unitEnd, strings);
      } catch {
        // An unsupported form or OOB read leaves the cursor desynced, so we can't
        // safely parse on. Mark the CU aborted (every enclosing loop bails too) but
        // keep the DIEs already parsed — one bad DIE no longer drops the whole unit.
        ctx.aborted = true;
        break;
      }
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
  strings: DebugStrings,
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
    case DW_FORM_strp_sup:
      return cstrAt(strings.str, c.u32());
    case DW_FORM_line_strp:
      return cstrAt(strings.lineStr, c.u32());
    case DW_FORM_strx:
      return resolveStrx(c.uleb(), ctx, strings);
    case DW_FORM_strx1:
      return resolveStrx(c.u8(), ctx, strings);
    case DW_FORM_strx2:
      return resolveStrx(c.u16(), ctx, strings);
    case DW_FORM_strx3:
      return resolveStrx(readBytes(c, 3), ctx, strings);
    case DW_FORM_strx4:
      return resolveStrx(c.u32(), ctx, strings);
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
      return readForm(c, c.uleb(), ctx, implicitConst, strings);
    default:
      // Unknown form: we can't size it. Surface as empty so the caller bails the unit.
      throw new Error(`Unsupported DWARF form 0x${form.toString(16)}`);
  }
}

/**
 * Read `n` little-endian bytes, returning the low 32 bits. Bytes at index ≥ 4 are
 * consumed (to advance the cursor) but don't contribute — JS bitwise ops are 32-bit,
 * so OR-ing them in would wrap the shift mod 32 and corrupt the low word. Meaningful
 * values therefore require n ≤ 4; for n = 8 (data8/ref8) the high word is dropped.
 */
function readBytes(c: Cursor, n: number): number {
  let value = 0;
  for (let i = 0; i < n; i++) {
    const byte = c.u8();
    if (i < 4) {
      value |= byte << (8 * i);
    }
  }
  return value >>> 0;
}

function readBlock(c: Cursor, len: number): Uint8Array {
  const start = c.offset;
  c.skip(len);
  return c.bytes.subarray(start, start + len);
}

/** Resolve a DW_FORM_strx index via .debug_str_offsets → .debug_str. */
function resolveStrx(index: number, ctx: UnitContext, strings: DebugStrings): string {
  const at = ctx.strOffsetsBase + index * 4;
  if (at + 4 > strings.strOffsets.length) {
    return '';
  }
  const c = new Cursor(strings.strOffsets, 0, strings.littleEndian);
  return cstrAt(strings.str, c.u32At(at));
}
