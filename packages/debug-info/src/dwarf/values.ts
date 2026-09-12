/**
 * DWARF type DIEs → a flat description a value formatter can walk, plus the
 * formatter itself. Bitfields of both DWARF dialects (2/3 `bit_offset` from the
 * MSB, 4+ `data_bit_offset` from the struct start) normalise to an absolute bit
 * offset from the struct start, little-endian.
 *
 * The formatter's one rule: a value it cannot establish is shown as unavailable,
 * never as a plausible number.
 */
import { Cursor } from '../reader.js';
import type { DwarfEntry } from '../types.js';
import { DW_AT, DW_ATE, DW_OP, DW_TAG } from './constants.js';
import { EntryIndex, attrFlag, attrNum } from './entries.js';

export type TypeKind =
  | 'int'
  | 'uint'
  | 'bool'
  | 'char'
  | 'uchar'
  | 'float'
  | 'pointer'
  | 'struct'
  | 'union'
  | 'array'
  | 'enum'
  | 'function'
  | 'void'
  | 'unknown';

export interface MemberDesc {
  name: string;
  /** byte offset from the struct start */
  offset: number;
  type: TypeDesc;
  /** bitfield: width and absolute bit offset from the struct start (LSB-first) */
  bitSize?: number;
  bitOffset?: number;
}

export interface TypeDesc {
  kind: TypeKind;
  name: string;
  size: number;
  /** pointee, or array element */
  target?: TypeDesc;
  /** array length; null when the DWARF leaves it unstated (`extern T x[]`) */
  count?: number | null;
  members?: MemberDesc[];
  /** enum: constant → name, the constant in the enum's own storage domain (see `signed`) */
  enumerators?: Map<number, string>;
  /** enum: whether its storage is read as signed (an enumerator below zero, or the compiler says so) */
  signed?: boolean;
}

const VOID: TypeDesc = { kind: 'void', name: 'void', size: 0 };

/** Resolves type DIEs into {@link TypeDesc}s, memoized, cycle-safe. */
export class TypeResolver {
  readonly #cache = new Map<number, TypeDesc>();
  constructor(readonly index: EntryIndex) {}

  describe(entry: DwarfEntry | undefined): TypeDesc {
    if (!entry) {
      return VOID;
    }
    const cached = this.#cache.get(entry.offset);
    if (cached) {
      return cached;
    }
    // Reserve the slot first so a struct that points at itself terminates.
    const desc: TypeDesc = { kind: 'unknown', name: '?', size: 0 };
    this.#cache.set(entry.offset, desc);
    Object.assign(desc, this.#build(entry));
    return desc;
  }

  /**
   * The type of `variable` as declared. A declaration's unsized array (`extern T
   * x[]`) is what it says: GCC 2.95 encodes it as upper bound 0, which the type
   * alone cannot tell from a genuine `T x[1]`; only the declaration flag can. The
   * memoized description is left alone — it is right for a definition.
   */
  describeDeclared(variable: DwarfEntry): TypeDesc {
    const typeEntry = this.index.typeOf(variable);
    const type = this.describe(typeEntry);
    if (!attrFlag(variable, DW_AT.declaration) || type.kind !== 'array' || type.count !== 1 || !typeEntry) {
      return type;
    }
    const array = this.#strip(typeEntry);
    const outer = array?.children.find((d) => d.tag === DW_TAG.subrange_type);
    if (!outer || attrNum(outer, DW_AT.count) !== undefined || attrNum(outer, DW_AT.upper_bound) !== 0) {
      return type;
    }
    const at = type.name.indexOf('[1]');
    return {
      ...type,
      name: at < 0 ? `${type.name}[]` : `${type.name.slice(0, at)}[]${type.name.slice(at + 3)}`,
      size: 0,
      count: null,
    };
  }

  /** `entry` with typedefs and cv-qualifiers peeled off. */
  #strip(entry: DwarfEntry): DwarfEntry | undefined {
    let e: DwarfEntry | undefined = entry;
    for (let depth = 0; e && depth < 8; depth++) {
      if (
        e.tag !== DW_TAG.typedef &&
        e.tag !== DW_TAG.const_type &&
        e.tag !== DW_TAG.volatile_type &&
        e.tag !== DW_TAG.restrict_type
      ) {
        return e;
      }
      e = this.index.typeOf(e);
    }
    return e;
  }

  #build(entry: DwarfEntry): TypeDesc {
    const name = this.index.name(entry);
    const size = attrNum(entry, DW_AT.byte_size) ?? 0;
    switch (entry.tag) {
      case DW_TAG.base_type: {
        const enc = attrNum(entry, DW_AT.encoding) ?? DW_ATE.signed;
        const kind: TypeKind =
          enc === DW_ATE.boolean
            ? 'bool'
            : enc === DW_ATE.float
              ? 'float'
              : enc === DW_ATE.signed_char
                ? 'char'
                : enc === DW_ATE.unsigned_char
                  ? 'uchar'
                  : enc === DW_ATE.unsigned
                    ? 'uint'
                    : 'int';
        return { kind, name: name ?? kind, size };
      }
      case DW_TAG.typedef: {
        const target = this.describe(this.index.typeOf(entry));
        return { ...target, name: name ?? target.name };
      }
      case DW_TAG.const_type:
      case DW_TAG.volatile_type:
      case DW_TAG.restrict_type: {
        const target = this.describe(this.index.typeOf(entry));
        const q = entry.tag === DW_TAG.const_type ? 'const ' : entry.tag === DW_TAG.volatile_type ? 'volatile ' : '';
        return { ...target, name: q + target.name };
      }
      case DW_TAG.pointer_type: {
        const target = this.describe(this.index.typeOf(entry));
        return { kind: 'pointer', name: `${target.name} *`, size: size || 4, target };
      }
      case DW_TAG.structure_type:
      case DW_TAG.union_type: {
        const kind: TypeKind = entry.tag === DW_TAG.union_type ? 'union' : 'struct';
        const members: MemberDesc[] = [];
        for (const m of entry.children) {
          if (m.tag !== DW_TAG.member) {
            continue;
          }
          const mtype = this.describe(this.index.typeOf(m));
          const offset = memberOffset(m);
          const member: MemberDesc = { name: this.index.name(m) ?? `<anon ${mtype.name}>`, offset, type: mtype };
          const bitSize = attrNum(m, DW_AT.bit_size);
          if (bitSize !== undefined) {
            member.bitSize = bitSize;
            const dbo = attrNum(m, DW_AT.data_bit_offset);
            if (dbo !== undefined) {
              member.bitOffset = dbo;
            } else {
              const storage = attrNum(m, DW_AT.byte_size) ?? mtype.size ?? 4;
              const fromMsb = attrNum(m, DW_AT.bit_offset) ?? 0;
              member.bitOffset = offset * 8 + (storage * 8 - fromMsb - bitSize);
            }
          }
          members.push(member);
        }
        return { kind, name: name ? `${kind} ${name}` : `${kind} {…}`, size, members };
      }
      case DW_TAG.enumeration_type: {
        const storage = size || 4;
        const raw: Array<[number, string]> = [];
        for (const e of entry.children) {
          if (e.tag === DW_TAG.enumerator) {
            const v = attrNum(e, DW_AT.const_value);
            const n = this.index.name(e);
            if (v !== undefined && n) {
              raw.push([v, n]);
            }
          }
        }
        // GCC 14 states the storage's signedness (an encoding, or an underlying type).
        // agbcc states neither and writes a negative constant as its unsigned word
        // (data4 0xffffffff for -1), so there an enumerator with the top bit of the
        // storage set is read as negative: both spellings land on the same key.
        const enc = attrNum(entry, DW_AT.encoding);
        const underlying = this.describe(this.index.typeOf(entry));
        const topBit = 2 ** (Math.min(storage, 4) * 8 - 1);
        const signed =
          enc !== undefined
            ? enc === DW_ATE.signed || enc === DW_ATE.signed_char
            : underlying.kind === 'int' || underlying.kind === 'char'
              ? true
              : underlying.kind === 'uint' || underlying.kind === 'uchar' || underlying.kind === 'bool'
                ? false
                : raw.some(([v]) => v < 0 || v >= topBit);
        const enumerators = new Map<number, string>();
        for (const [v, n] of raw) {
          enumerators.set(inDomain(v, storage, signed), n);
        }
        return { kind: 'enum', name: name ? `enum ${name}` : 'enum {…}', size: storage, enumerators, signed };
      }
      case DW_TAG.array_type: {
        const elem = this.describe(this.index.typeOf(entry));
        const dims = entry.children
          .filter((d) => d.tag === DW_TAG.subrange_type)
          .map((d) => {
            const count = attrNum(d, DW_AT.count);
            if (count !== undefined) {
              return count;
            }
            const ub = attrNum(d, DW_AT.upper_bound);
            // GCC 2.95 spells an unsized extern array as upper bound -1 (stored as 0xffffffff).
            return ub === undefined || ub === 0xffffffff || ub < 0 ? null : ub + 1;
          });
        if (dims.length === 0) {
          dims.push(null);
        }
        // Build innermost dimension first: int a[2][3] → array(2) of array(3) of int.
        let t: TypeDesc = elem;
        for (let i = dims.length - 1; i >= 0; i--) {
          const count = dims[i]!;
          t = {
            kind: 'array',
            name: `${elem.name}${dims
              .slice(i)
              .map((d) => `[${d ?? ''}]`)
              .join('')}`,
            size: count === null ? 0 : count * t.size,
            target: t,
            count,
          };
        }
        return t;
      }
      case DW_TAG.subroutine_type:
        return { kind: 'function', name: name ?? 'function', size: 0 };
      default:
        return { kind: 'unknown', name: name ?? `<tag 0x${entry.tag.toString(16)}>`, size };
    }
  }
}

/** `v` reduced to a `size`-byte word and read in the given signedness. */
function inDomain(v: number, size: number, signed: boolean): number {
  const width = Math.min(size, 4) * 8;
  const mod = 2 ** width;
  const u = ((v % mod) + mod) % mod;
  return signed && u >= mod / 2 ? u - mod : u;
}

function memberOffset(m: DwarfEntry): number {
  const a = m.attrs.get(DW_AT.data_member_location);
  if (typeof a === 'number') {
    return a;
  }
  if (a instanceof Uint8Array && a[0] === DW_OP.plus_uconst) {
    return new Cursor(a, 1).uleb();
  }
  return 0;
}

// ─── values ────────────────────────────────────────────────────────────

/** A variable (or member, element, pointee) as a tree node the UI can show and expand. */
export interface VarNode {
  name: string;
  value: string;
  type: string;
  /** memory address when the value lives in memory (enables a memory view and writes) */
  address?: number;
  /** expandable children (struct members, array elements, a pointee), computed on demand */
  children?: () => VarNode[];
  /** array: the element at `index`, null when out of range (an unsized array has no upper bound) */
  element?: (index: number) => VarNode | null;
  /** a scalar in memory: what to write back */
  writable?: WritableScalar;
  /**
   * The value as a number, for a scalar of at most 32 bits: an expression reads it
   * through this rather than through the text. `signed` says how the word is read.
   */
  scalar?: { value: number; signed: boolean };
}

/** Where and how a scalar shown in the tree is written back. */
export interface WritableScalar {
  address: number;
  size: number;
  kind: TypeKind;
  /** enum: the names a write may use */
  enumerators?: Map<number, string>;
  /** bitfield: the bits of the `size` bytes at `address` that belong to this member */
  bitOffset?: number;
  bitSize?: number;
}

export interface ValueReader {
  /** `size` bytes at `address`, or null when any of them is unreadable. */
  read(address: number, size: number): Uint8Array | null;
  /** What names a code address (a function pointer's target), when the program knows. */
  symbolize?(address: number): string | null;
}

/**
 * Whether a value of `type` reads as signed. Every reader of the program's values —
 * the variables tree, the expression grammar — asks here, so a member cannot be
 * negative in one pane and enormous in another.
 */
export function isSignedType(type: TypeDesc): boolean {
  return type.kind === 'int' || type.kind === 'char' || (type.kind === 'enum' && type.signed === true);
}

/**
 * Where a bitfield member sits: the first byte of the storage that covers it, and
 * the bits within that storage, LSB-first. Null when the member is not a bitfield.
 */
export function bitfieldPlacement(m: MemberDesc): { byteOffset: number; bits: BitPlacement } | null {
  if (m.bitSize === undefined || m.bitOffset === undefined) {
    return null;
  }
  const offset = m.bitOffset % 8;
  return {
    byteOffset: Math.floor(m.bitOffset / 8),
    bits: { offset, size: m.bitSize, span: Math.ceil((offset + m.bitSize) / 8) },
  };
}

/** A bitfield inside the storage bytes that cover it: LSB-first, and how many bytes those are. */
export interface BitPlacement {
  offset: number;
  size: number;
  span: number;
}

/** `v` as the four little-endian bytes a 32-bit machine holds it in. */
export function le32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

export function toInt(bytes: Uint8Array, signed: boolean): number {
  let v = 0;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = v * 256 + bytes[i]!;
  }
  if (signed && bytes.length > 0 && bytes.length <= 4 && bytes[bytes.length - 1]! & 0x80) {
    v -= 2 ** (bytes.length * 8);
  }
  return v;
}

/** The little-endian integer in `bytes` at full precision, any width. */
export function toBigInt(bytes: Uint8Array, signed: boolean): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  if (signed && bytes.length > 0 && bytes[bytes.length - 1]! & 0x80) {
    v -= 1n << BigInt(bytes.length * 8);
  }
  return v;
}

/** `v` as a hex word of the value's own width (two's complement at that width for a negative). */
function hex(v: number, size: number): string {
  const bytes = Math.min(size, 4);
  const mod = 2 ** (bytes * 8);
  const u = ((v % mod) + mod) % mod;
  return '0x' + u.toString(16).padStart(bytes * 2, '0');
}

/** The bytes as a hex word, any width. */
function hexBytes(bytes: Uint8Array): string {
  return (
    '0x' +
    toBigInt(bytes, false)
      .toString(16)
      .padStart(bytes.length * 2, '0')
  );
}

/**
 * `bytes` as a C string literal: printable ASCII verbatim, the usual escapes by
 * name, every other byte as `\xNN` — so a Latin-1 byte or a control character is
 * shown as the byte it is, on one line.
 */
export function quoteBytes(bytes: Uint8Array): string {
  const named: Record<number, string> = { 0: '\\0', 9: '\\t', 10: '\\n', 13: '\\r', 34: '\\"', 92: '\\\\' };
  let out = '';
  for (const b of bytes) {
    out += named[b] ?? (b >= 32 && b < 127 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`);
  }
  return `"${out}"`;
}

/** `'A'`, `'\n'`, `'\xe9'`: a char's glyph. */
function charLiteral(byte: number): string {
  return quoteBytes(new Uint8Array([byte]))
    .replace(/^"/, "'")
    .replace(/"$/, "'")
    .replace(/\\"/, '"');
}

/** How many elements of an unsized array are shown in its value / its children. */
const UNSIZED_PREVIEW = 6;
const UNSIZED_CHILDREN = 64;

/** Build the tree node for a value of `type` held in `bytes` (or at `address` for lazy reads). */
export function formatValue(
  name: string,
  type: TypeDesc,
  bytes: Uint8Array | null,
  address: number | undefined,
  reader: ValueReader,
): VarNode {
  const node: VarNode = { name, value: '', type: type.name, address };
  if (type.kind === 'array' && type.count === null) {
    return unsizedArray(node, type, address, reader);
  }
  if (!bytes) {
    node.value = address !== undefined ? `<unreadable at ${hex(address, 4)}>` : '<optimized out>';
    return node;
  }
  // Children are expanded later, after a write may have changed the bytes: read again when they live in memory.
  const current = (): Uint8Array => (address === undefined ? bytes : (reader.read(address, bytes.length) ?? bytes));
  switch (type.kind) {
    case 'int':
    case 'uint': {
      const signed = type.kind === 'int';
      if (bytes.length > 4) {
        const v = toBigInt(bytes, signed);
        node.value = `${v} (${hexBytes(bytes)})`;
      } else {
        const v = toInt(bytes, signed);
        node.value = Math.abs(v) > 9 ? `${v} (${hex(v, bytes.length)})` : String(v);
        node.scalar = { value: v, signed };
      }
      if (address !== undefined) {
        node.writable = { address, size: bytes.length, kind: type.kind };
      }
      break;
    }
    case 'bool': {
      const v = toInt(bytes, false);
      node.value = v ? 'true' : 'false';
      node.scalar = { value: v, signed: false };
      if (address !== undefined) {
        node.writable = { address, size: bytes.length, kind: type.kind };
      }
      break;
    }
    case 'char':
    case 'uchar': {
      const signed = type.kind === 'char';
      const v = toInt(bytes, signed);
      node.value = `${v} ${charLiteral(v & 0xff)}`;
      node.scalar = { value: v, signed };
      if (address !== undefined) {
        node.writable = { address, size: bytes.length, kind: type.kind };
      }
      break;
    }
    case 'float': {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      node.value =
        bytes.length === 8 ? String(dv.getFloat64(0, true)) : bytes.length === 4 ? String(dv.getFloat32(0, true)) : '?';
      break;
    }
    case 'enum': {
      const signed = type.signed === true;
      const v = toInt(bytes, signed);
      const label = type.enumerators?.get(v);
      node.value = label ? `${label} (${v})` : `${v} (${hex(v, bytes.length)})`;
      node.scalar = { value: v, signed };
      if (address !== undefined) {
        node.writable = { address, size: bytes.length, kind: signed ? 'int' : 'uint', enumerators: type.enumerators };
      }
      break;
    }
    case 'pointer': {
      const p = toInt(bytes, false) >>> 0;
      node.value = hex(p, 4);
      node.scalar = { value: p, signed: false };
      const target = type.target;
      if (target && (target.kind === 'char' || target.kind === 'uchar') && p !== 0) {
        const s = reader.read(p, 32);
        if (s) {
          const end = s.indexOf(0);
          node.value += ` ${quoteBytes(s.subarray(0, end < 0 ? s.length : end))}${end < 0 ? '…' : ''}`;
        }
      }
      if (target?.kind === 'function' && p !== 0) {
        const sym = reader.symbolize?.((p & ~1) >>> 0);
        if (sym) {
          node.value += `  → ${sym}${p & 1 ? ' (Thumb)' : ''}`;
        }
      }
      if (target && target.kind !== 'void' && target.kind !== 'function' && target.kind !== 'unknown' && p !== 0) {
        node.children = () => {
          const b = reader.read(p, Math.max(1, target.size));
          return [formatValue('*', target, b, p, reader)];
        };
      }
      if (address !== undefined) {
        node.writable = { address, size: bytes.length, kind: 'uint' };
      }
      break;
    }
    case 'struct':
    case 'union': {
      const members = type.members ?? [];
      const preview = members.slice(0, 4).map((m) => `${m.name}: ${memberNode(m, bytes, address, reader).value}`);
      node.value = `{${preview.join(', ')}${members.length > 4 ? ', …' : ''}}`;
      node.children = () => {
        const b = current();
        return members.map((m) => memberNode(m, b, address, reader));
      };
      break;
    }
    case 'array': {
      const elem = type.target ?? VOID;
      const count = type.count ?? (elem.size ? Math.floor(bytes.length / elem.size) : 0);
      if ((elem.kind === 'char' || elem.kind === 'uchar') && count > 0) {
        const end = bytes.indexOf(0);
        node.value = quoteBytes(bytes.subarray(0, end < 0 ? Math.min(bytes.length, count) : end));
      } else {
        const shown = Math.min(count, 6);
        const items: string[] = [];
        for (let i = 0; i < shown && elem.size; i++) {
          items.push(
            formatValue(
              String(i),
              elem,
              bytes.subarray(i * elem.size, (i + 1) * elem.size),
              address === undefined ? undefined : address + i * elem.size,
              reader,
            ).value,
          );
        }
        node.value = `[${count}] {${items.join(', ')}${count > shown ? ', …' : ''}}`;
      }
      if (elem.size && count > 0) {
        const element = (b: Uint8Array, i: number): VarNode =>
          formatValue(
            `[${i}]`,
            elem,
            b.subarray(i * elem.size, (i + 1) * elem.size),
            address === undefined ? undefined : address + i * elem.size,
            reader,
          );
        node.children = () => {
          const b = current();
          const out: VarNode[] = [];
          for (let i = 0; i < Math.min(count, 256); i++) {
            out.push(element(b, i));
          }
          return out;
        };
        node.element = (i) => (i >= 0 && i < count ? element(current(), i) : null);
      }
      break;
    }
    case 'function':
      node.value = address !== undefined ? hex(address, 4) : type.name;
      break;
    case 'void':
      node.value = bytes.length ? hexBytes(bytes) : 'void';
      break;
    default:
      node.value = bytes.length <= 8 ? hexBytes(bytes) : `<${bytes.length} bytes>`;
  }
  return node;
}

/**
 * An array whose extent the DWARF does not state (`extern T x[]`): the bytes on
 * hand say nothing about its length, so the value is a bounded preview read
 * from its address, never a count invented from a buffer size.
 */
function unsizedArray(node: VarNode, type: TypeDesc, address: number | undefined, reader: ValueReader): VarNode {
  const elem = type.target ?? VOID;
  if (address === undefined || !elem.size) {
    node.value = '<unsized array>';
    return node;
  }
  const elements = (n: number): VarNode[] => {
    const out: VarNode[] = [];
    for (let i = 0; i < n; i++) {
      const at = address + i * elem.size;
      const b = reader.read(at, elem.size);
      if (!b) {
        break;
      }
      out.push(formatValue(`[${i}]`, elem, b, at, reader));
    }
    return out;
  };
  const preview = elements(UNSIZED_PREVIEW);
  node.value = `[] {${preview.map((e) => e.value).join(', ')}${preview.length === UNSIZED_PREVIEW ? ', …' : ''}}`;
  node.children = () => elements(UNSIZED_CHILDREN);
  node.element = (i) => {
    if (i < 0) {
      return null;
    }
    const at = address + i * elem.size;
    return formatValue(`[${i}]`, elem, reader.read(at, elem.size), at, reader);
  };
  return node;
}

/**
 * A bitfield of `size` bits sitting `offset` bits into `bytes`, which are the
 * storage bytes that cover it — the width the tree shows and the width a write
 * merges back into are the same fact, so both sides read it here.
 */
export function formatBitfield(
  name: string,
  type: TypeDesc,
  bytes: Uint8Array | null,
  address: number | undefined,
  bits: BitPlacement,
): VarNode {
  if (!bytes) {
    return {
      name,
      value: address === undefined ? '<optimized out>' : `<unreadable at ${hex(address, 4)}>`,
      type: type.name,
      address,
    };
  }
  const raw = toInt(bytes, false);
  const value = Math.floor(raw / 2 ** bits.offset) % 2 ** bits.size;
  const signed = isSignedType(type);
  const v = signed && value >= 2 ** (bits.size - 1) ? value - 2 ** bits.size : value;
  const label =
    type.kind === 'enum' ? type.enumerators?.get(v) : type.kind === 'bool' ? (v ? 'true' : 'false') : undefined;
  const node: VarNode = {
    name,
    value: `${label ? (type.kind === 'enum' ? `${label} (${v})` : label) : v} (${bits.size} bits)`,
    type: type.name,
    address,
    scalar: { value: v, signed },
  };
  if (address !== undefined) {
    node.writable = {
      address,
      size: bytes.length,
      kind: type.kind,
      bitOffset: bits.offset,
      bitSize: bits.size,
      enumerators: type.kind === 'enum' ? type.enumerators : undefined,
    };
  }
  return node;
}

function memberNode(m: MemberDesc, bytes: Uint8Array, base: number | undefined, reader: ValueReader): VarNode {
  const placement = bitfieldPlacement(m);
  if (placement) {
    const { byteOffset, bits } = placement;
    return formatBitfield(
      m.name,
      m.type,
      bytes.subarray(byteOffset, byteOffset + bits.span),
      base === undefined ? undefined : base + byteOffset,
      bits,
    );
  }
  const size = m.type.size || (m.type.kind === 'pointer' ? 4 : 0);
  const slice = bytes.subarray(m.offset, m.offset + size);
  return formatValue(
    m.name,
    m.type,
    slice.length === size ? slice : null,
    base === undefined ? undefined : base + m.offset,
    reader,
  );
}
