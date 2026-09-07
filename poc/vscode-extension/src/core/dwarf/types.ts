/**
 * DWARF type DIEs → a flat description the variable formatter can walk, plus the
 * formatter itself. Bitfields of both DWARF dialects (2/3 `bit_offset` from the
 * MSB, 4+ `data_bit_offset` from the struct start) normalise to an absolute bit
 * offset from the struct start, little-endian.
 */
import { AT, type Die, type DieIndex, TAG, attrNum } from './parse.js';

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

export interface Member {
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
  target?: TypeDesc;
  count?: number | null;
  members?: Member[];
  enumerators?: Map<number, string>;
}

const VOID: TypeDesc = { kind: 'void', name: 'void', size: 0 };

export class TypeResolver {
  readonly #cache = new Map<number, TypeDesc>();
  constructor(readonly index: DieIndex) {}

  describe(die: Die | undefined): TypeDesc {
    if (!die) {
      return VOID;
    }
    const cached = this.#cache.get(die.offset);
    if (cached) {
      return cached;
    }
    // Reserve the slot first so a struct that points at itself terminates.
    const desc: TypeDesc = { kind: 'unknown', name: '?', size: 0 };
    this.#cache.set(die.offset, desc);
    Object.assign(desc, this.#build(die));
    return desc;
  }

  #build(die: Die): TypeDesc {
    const name = this.index.name(die);
    const size = attrNum(die, AT.byte_size) ?? 0;
    switch (die.tag) {
      case TAG.base_type: {
        const enc = attrNum(die, AT.encoding) ?? 5;
        const kind: TypeKind =
          enc === 2
            ? 'bool'
            : enc === 4
              ? 'float'
              : enc === 6
                ? 'char'
                : enc === 8
                  ? 'uchar'
                  : enc === 7
                    ? 'uint'
                    : 'int';
        return { kind, name: name ?? kind, size };
      }
      case TAG.typedef: {
        const target = this.describe(this.index.typeOf(die));
        return {
          ...target,
          name: name ?? target.name,
          target: target.target,
          members: target.members,
          enumerators: target.enumerators,
          count: target.count,
        };
      }
      case TAG.const_type:
      case TAG.volatile_type:
      case TAG.restrict_type: {
        const target = this.describe(this.index.typeOf(die));
        const q = die.tag === TAG.const_type ? 'const ' : die.tag === TAG.volatile_type ? 'volatile ' : '';
        return { ...target, name: q + target.name };
      }
      case TAG.pointer_type: {
        const target = this.describe(this.index.typeOf(die));
        return { kind: 'pointer', name: `${target.name} *`, size: size || 4, target };
      }
      case TAG.structure_type:
      case TAG.union_type: {
        const kind: TypeKind = die.tag === TAG.union_type ? 'union' : 'struct';
        const members: Member[] = [];
        for (const m of die.children) {
          if (m.tag !== TAG.member) {
            continue;
          }
          const mtype = this.describe(this.index.typeOf(m));
          const offset = memberOffset(m);
          const member: Member = { name: this.index.name(m) ?? `<anon ${mtype.name}>`, offset, type: mtype };
          const bitSize = attrNum(m, AT.bit_size);
          if (bitSize !== undefined) {
            member.bitSize = bitSize;
            const dbo = attrNum(m, AT.data_bit_offset);
            if (dbo !== undefined) {
              member.bitOffset = dbo;
            } else {
              const storage = attrNum(m, AT.byte_size) ?? mtype.size ?? 4;
              const fromMsb = attrNum(m, AT.bit_offset) ?? 0;
              member.bitOffset = offset * 8 + (storage * 8 - fromMsb - bitSize);
            }
          }
          members.push(member);
        }
        return { kind, name: name ? `${kind} ${name}` : `${kind} {…}`, size, members };
      }
      case TAG.enumeration_type: {
        const enumerators = new Map<number, string>();
        for (const e of die.children) {
          if (e.tag === TAG.enumerator) {
            const v = attrNum(e, AT.const_value);
            const n = this.index.name(e);
            if (v !== undefined && n) {
              enumerators.set(v, n);
            }
          }
        }
        return { kind: 'enum', name: name ? `enum ${name}` : 'enum {…}', size: size || 4, enumerators };
      }
      case TAG.array_type: {
        const elem = this.describe(this.index.typeOf(die));
        const dims = die.children
          .filter((d) => d.tag === TAG.subrange_type)
          .map((d) => {
            const count = attrNum(d, AT.count);
            if (count !== undefined) {
              return count;
            }
            const ub = attrNum(d, AT.upper_bound);
            return ub === undefined ? null : ub + 1;
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
      case TAG.subroutine_type:
        return { kind: 'function', name: name ?? 'function', size: 0 };
      default:
        return { kind: 'unknown', name: name ?? `<tag 0x${die.tag.toString(16)}>`, size };
    }
  }
}

function memberOffset(m: Die): number {
  const a = m.attrs.get(AT.data_member_location);
  if (!a) {
    return 0;
  }
  if (typeof a.value === 'number') {
    return a.value;
  }
  if (a.value instanceof Uint8Array && a.value[0] === 0x23) {
    // DW_OP_plus_uconst N
    let result = 0;
    let shift = 0;
    for (let i = 1; i < a.value.length; i++) {
      const b = a.value[i]!;
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if ((b & 0x80) === 0) {
        break;
      }
    }
    return result;
  }
  return 0;
}

// ─── values ────────────────────────────────────────────────────────────

export interface VarNode {
  name: string;
  value: string;
  type: string;
  /** memory address when the value lives in memory (enables the memory view and writes) */
  address?: number;
  children?: () => VarNode[];
  /** scalar in memory: size in bytes, so the client can write it back */
  writable?: { address: number; size: number; kind: TypeKind };
}

export interface ValueReader {
  read(address: number, size: number): Uint8Array | null;
}

function toInt(bytes: Uint8Array, signed: boolean): number {
  let v = 0;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = v * 256 + bytes[i]!;
  }
  if (signed && bytes.length > 0 && bytes.length <= 4 && bytes[bytes.length - 1]! & 0x80) {
    v -= 2 ** (bytes.length * 8);
  }
  return v;
}

function hex(v: number, size: number): string {
  return '0x' + (v >>> 0).toString(16).padStart(Math.min(size, 4) * 2, '0');
}

/** Build the tree node for a value of `type` held in `bytes` (or at `address` for lazy reads). */
export function formatValue(
  name: string,
  type: TypeDesc,
  bytes: Uint8Array | null,
  address: number | undefined,
  reader: ValueReader,
): VarNode {
  const node: VarNode = { name, value: '', type: type.name, address };
  if (!bytes) {
    node.value = address !== undefined ? `<unreadable at ${hex(address, 4)}>` : '<optimized out>';
    return node;
  }
  switch (type.kind) {
    case 'int':
    case 'uint': {
      const v = toInt(bytes, type.kind === 'int');
      node.value = Math.abs(v) > 9 ? `${v} (${hex(v, bytes.length)})` : String(v);
      if (address !== undefined) {
        node.writable = { address, size: bytes.length, kind: type.kind };
      }
      break;
    }
    case 'bool':
      node.value = toInt(bytes, false) ? 'true' : 'false';
      if (address !== undefined) {
        node.writable = { address, size: bytes.length, kind: type.kind };
      }
      break;
    case 'char':
    case 'uchar': {
      const v = toInt(bytes, type.kind === 'char');
      const printable = v >= 32 && v < 127 ? ` '${String.fromCharCode(v)}'` : '';
      node.value = `${v}${printable}`;
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
      const v = toInt(bytes, false);
      const label = type.enumerators?.get(v);
      node.value = label ? `${label} (${v})` : `${v} (${hex(v, bytes.length)})`;
      if (address !== undefined) {
        node.writable = { address, size: bytes.length, kind: 'uint' };
      }
      break;
    }
    case 'pointer': {
      const p = toInt(bytes, false) >>> 0;
      node.value = hex(p, 4);
      const target = type.target;
      if (target && (target.kind === 'char' || target.kind === 'uchar') && p !== 0) {
        const s = reader.read(p, 32);
        if (s) {
          const end = s.indexOf(0);
          const text = new TextDecoder().decode(s.subarray(0, end < 0 ? s.length : end));
          node.value += ` "${text}${end < 0 ? '…' : ''}"`;
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
      node.children = () => members.map((m) => memberNode(m, bytes, address, reader));
      break;
    }
    case 'array': {
      const elem = type.target ?? VOID;
      const count = type.count ?? (elem.size ? Math.floor(bytes.length / elem.size) : 0);
      if ((elem.kind === 'char' || elem.kind === 'uchar') && count > 0) {
        const end = bytes.indexOf(0);
        const text = new TextDecoder().decode(bytes.subarray(0, end < 0 ? Math.min(bytes.length, count) : end));
        node.value = `"${text}"`;
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
        node.children = () => {
          const out: VarNode[] = [];
          for (let i = 0; i < Math.min(count, 256); i++) {
            out.push(
              formatValue(
                `[${i}]`,
                elem,
                bytes.subarray(i * elem.size, (i + 1) * elem.size),
                address === undefined ? undefined : address + i * elem.size,
                reader,
              ),
            );
          }
          return out;
        };
      }
      break;
    }
    case 'function':
      node.value = address !== undefined ? hex(address, 4) : type.name;
      break;
    case 'void':
      node.value = bytes.length ? hex(toInt(bytes, false), bytes.length) : 'void';
      break;
    default:
      node.value = bytes.length <= 4 ? hex(toInt(bytes, false), bytes.length) : `<${bytes.length} bytes>`;
  }
  return node;
}

function memberNode(m: Member, bytes: Uint8Array, base: number | undefined, reader: ValueReader): VarNode {
  if (m.bitSize !== undefined && m.bitOffset !== undefined) {
    const firstByte = Math.floor(m.bitOffset / 8);
    const span = Math.ceil(((m.bitOffset % 8) + m.bitSize) / 8);
    const raw = toInt(bytes.subarray(firstByte, firstByte + span), false);
    const value = Math.floor(raw / 2 ** (m.bitOffset % 8)) % 2 ** m.bitSize;
    const signed = m.type.kind === 'int' || m.type.kind === 'char';
    const v = signed && value >= 2 ** (m.bitSize - 1) ? value - 2 ** m.bitSize : value;
    return {
      name: m.name,
      value: `${v} (${m.bitSize} bits)`,
      type: m.type.name,
      address: base === undefined ? undefined : base + firstByte,
    };
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
