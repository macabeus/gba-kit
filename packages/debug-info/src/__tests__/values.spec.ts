/**
 * The value formatter on hand-built type descriptions: widths, signs, 64-bit
 * precision, enumerators below zero, bitfields of every kind, strings as bytes,
 * function pointers, and arrays whose extent the DWARF does not state.
 */
import { describe, expect, it } from 'vitest';

import { DW_AT, DW_ATE, DW_FORM, DW_TAG } from '../dwarf/constants.js';
import { EntryIndex } from '../dwarf/entries.js';
import { type TypeDesc, TypeResolver, type ValueReader, formatValue, quoteBytes, toBigInt } from '../dwarf/values.js';
import type { DwarfEntry } from '../types.js';

const none: ValueReader = { read: () => null };
const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);
const int = (size: number): TypeDesc => ({ kind: 'int', name: `s${size * 8}`, size });
const uint = (size: number): TypeDesc => ({ kind: 'uint', name: `u${size * 8}`, size });
const enumOf = (size: number, signed: boolean, names: Record<number, string>): TypeDesc => ({
  kind: 'enum',
  name: 'enum E',
  size,
  signed,
  enumerators: new Map(Object.entries(names).map(([k, v]) => [Number(k), v])),
});

describe('integers', () => {
  it('shows the hex at the value’s own width, negative ones as two’s complement of that width', () => {
    expect(formatValue('v', int(1), bytes(0x9c), 0x03000000, none).value).toBe('-100 (0x9c)');
    expect(formatValue('v', int(2), bytes(0xf0, 0xff), 0x03000000, none).value).toBe('-16 (0xfff0)');
    expect(formatValue('v', int(4), bytes(0xf0, 0xff, 0xff, 0xff), 0x03000000, none).value).toBe('-16 (0xfffffff0)');
    expect(formatValue('v', uint(2), bytes(0xf0, 0xff), 0x03000000, none).value).toBe('65520 (0xfff0)');
    expect(formatValue('v', int(2), bytes(0xf0, 0xff), undefined, none).scalar).toEqual({ value: -16, signed: true });
  });

  it('keeps 64-bit values exact: sign, precision and the full hex word', () => {
    const ff = new Uint8Array(8).fill(0xff);
    expect(formatValue('v', int(8), ff, 0x03000000, none).value).toBe('-1 (0xffffffffffffffff)');
    expect(formatValue('v', uint(8), bytes(0, 0, 0, 0, 1, 0, 0, 0), 0x03000000, none).value).toBe(
      '4294967296 (0x0000000100000000)',
    );
    const max = bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f);
    expect(formatValue('v', int(8), max, 0x03000000, none).value).toBe('9223372036854775807 (0x7fffffffffffffff)');
    expect(toBigInt(bytes(1, 0, 0, 0, 0, 0, 0, 0x80), true)).toBe(-(1n << 63n) + 1n);
    expect(formatValue('v', int(8), ff, 0x03000000, none).scalar).toBeUndefined(); // wider than a word
    expect(formatValue('v', int(8), ff, 0x03000000, none).writable).toEqual({
      address: 0x03000000,
      size: 8,
      kind: 'int',
    });
  });
});

describe('enums', () => {
  it('labels a negative enumerator, at any storage width', () => {
    const names = { [-1]: 'E_NEG', 0: 'E_ZERO', 255: 'E_BIG' };
    expect(formatValue('e', enumOf(4, true, names), bytes(0xff, 0xff, 0xff, 0xff), 0x03000000, none).value).toBe(
      'E_NEG (-1)',
    );
    expect(formatValue('e', enumOf(2, true, names), bytes(0xff, 0xff), 0x03000000, none).value).toBe('E_NEG (-1)');
    expect(formatValue('e', enumOf(1, true, { [-1]: 'E_NEG' }), bytes(0xff), 0x03000000, none).value).toBe(
      'E_NEG (-1)',
    );
    expect(formatValue('e', enumOf(1, false, { 255: 'E_BIG' }), bytes(0xff), 0x03000000, none).value).toBe(
      'E_BIG (255)',
    );
    expect(formatValue('e', enumOf(1, false, {}), bytes(0x7), 0x03000000, none).value).toBe('7 (0x07)');
    const node = formatValue('e', enumOf(1, false, { 2: 'E_TWO' }), bytes(2), 0x03000000, none);
    expect(node.scalar).toEqual({ value: 2, signed: false });
    expect(node.writable?.enumerators?.get(2)).toBe('E_TWO');
  });

  it('reads the signedness and the negative constants out of the DIEs, in either encoding', () => {
    const die = (tag: number, offset: number, attrs: Array<[number, unknown, number]>, children: DwarfEntry[] = []) =>
      ({
        tag,
        offset,
        attrs: new Map(attrs.map(([a, v]) => [a, v])),
        forms: new Map(attrs.map(([a, , f]) => [a, f])),
        children,
      }) as unknown as DwarfEntry;
    const enumerator = (offset: number, name: string, value: number, form: number): DwarfEntry =>
      die(DW_TAG.enumerator, offset, [
        [DW_AT.name, name, DW_FORM.string],
        [DW_AT.const_value, value, form],
      ]);
    // GCC 14: encoding stated, -1 as sdata. agbcc: nothing stated, -1 as data4 0xffffffff.
    const modern = die(
      DW_TAG.enumeration_type,
      0x10,
      [
        [DW_AT.name, 'Dir', DW_FORM.string],
        [DW_AT.byte_size, 1, DW_FORM.data1],
        [DW_AT.encoding, DW_ATE.signed_char, DW_FORM.data1],
      ],
      [enumerator(0x18, 'DIR_NEG', -1, DW_FORM.sdata), enumerator(0x1c, 'DIR_POS', 1, DW_FORM.data1)],
    );
    const old = die(
      DW_TAG.enumeration_type,
      0x30,
      [
        [DW_AT.name, 'Way', DW_FORM.string],
        [DW_AT.byte_size, 4, DW_FORM.data1],
      ],
      [enumerator(0x38, 'WAY_NEG', 0xffffffff, DW_FORM.data4), enumerator(0x3c, 'WAY_POS', 1, DW_FORM.data1)],
    );
    const root = {
      ...die(DW_TAG.compile_unit, 0, []),
      unitOffset: 0,
      version: 4,
      children: [modern, old],
    } as DwarfEntry;
    const types = new TypeResolver(new EntryIndex([root]));
    const dir = types.describe(modern);
    expect(dir).toMatchObject({ kind: 'enum', signed: true, size: 1 });
    expect([...dir.enumerators!]).toEqual([
      [-1, 'DIR_NEG'],
      [1, 'DIR_POS'],
    ]);
    expect(formatValue('d', dir, bytes(0xff), undefined, none).value).toBe('DIR_NEG (-1)');
    const way = types.describe(old);
    expect(way).toMatchObject({ kind: 'enum', signed: true, size: 4 });
    expect(way.enumerators!.get(-1)).toBe('WAY_NEG');
    expect(formatValue('w', way, bytes(0xff, 0xff, 0xff, 0xff), undefined, none).value).toBe('WAY_NEG (-1)');
  });
});

describe('bitfields', () => {
  const stats: TypeDesc = {
    kind: 'struct',
    name: 'struct S',
    size: 2,
    members: [
      { name: 'hp', offset: 0, type: uint(2), bitOffset: 0, bitSize: 4 },
      { name: 'e', offset: 0, type: enumOf(2, true, { [-1]: 'E_NEG', 3: 'E_THREE' }), bitOffset: 4, bitSize: 4 },
      { name: 'f', offset: 1, type: { kind: 'bool', name: 'bool', size: 1 }, bitOffset: 8, bitSize: 1 },
      { name: 'w', offset: 1, type: uint(2), bitOffset: 9, bitSize: 7 },
    ],
  };

  it('labels enum and bool bitfields, and says where to write them back', () => {
    // hp = 9, e = 0xf (-1 in 4 bits), f = 1, w = 0x2a
    const kids = Object.fromEntries(
      formatValue('s', stats, bytes(0xf9, 0x55), 0x03000000, none).children!().map((k) => [k.name, k]),
    );
    expect(kids.hp!.value).toBe('9 (4 bits)');
    expect(kids.e!.value).toBe('E_NEG (-1) (4 bits)');
    expect(kids.f!.value).toBe('true (1 bits)');
    expect(kids.w!.value).toBe('42 (7 bits)');
    expect(kids.hp!.writable).toEqual({ address: 0x03000000, size: 1, kind: 'uint', bitOffset: 0, bitSize: 4 });
    expect(kids.w!.writable).toMatchObject({ address: 0x03000001, size: 1, bitOffset: 1, bitSize: 7 });
    expect(kids.e!.writable?.enumerators?.get(3)).toBe('E_THREE');
    expect(kids.e!.scalar).toEqual({ value: -1, signed: true });
  });
});

describe('strings, chars and pointers', () => {
  it('quotes bytes as a C literal: no replacement characters, no raw control characters', () => {
    const chars = (n: number): TypeDesc => ({
      kind: 'array',
      name: `char[${n}]`,
      size: n,
      count: n,
      target: { kind: 'char', name: 'char', size: 1 },
    });
    expect(formatValue('s', chars(8), bytes(0x4b, 0xe9, 0x6c, 0x6f, 0x6e, 0, 0, 0), undefined, none).value).toBe(
      '"K\\xe9lon"',
    );
    expect(formatValue('s', chars(4), bytes(0x09, 0x0a, 0x1b, 0), undefined, none).value).toBe('"\\t\\n\\x1b"');
    expect(formatValue('s', chars(4), bytes(0xff, 0xfe, 0x41, 0), undefined, none).value).toBe('"\\xff\\xfeA"');
    expect(quoteBytes(bytes(0x22, 0x5c))).toBe('"\\"\\\\"');
    expect(formatValue('c', { kind: 'char', name: 'char', size: 1 }, bytes(0xe9), undefined, none).value).toBe(
      "-23 '\\xe9'",
    );
    expect(formatValue('c', { kind: 'uchar', name: 'u8', size: 1 }, bytes(0x41), undefined, none).value).toBe("65 'A'");
    const p: TypeDesc = { kind: 'pointer', name: 'char *', size: 4, target: { kind: 'char', name: 'char', size: 1 } };
    const reader: ValueReader = {
      read: (a, n) => (a === 0x02000000 ? bytes(0x4b, 0xe9, 0x0a, 0x41, 0, ...new Array(n - 5).fill(0)) : null),
    };
    expect(formatValue('p', p, bytes(0, 0, 0, 0x02), 0x03000000, reader).value).toBe('0x02000000 "K\\xe9\\nA"');
  });

  it('names what a function pointer points at', () => {
    const fp: TypeDesc = {
      kind: 'pointer',
      name: 'void (*)(void)',
      size: 4,
      target: { kind: 'function', name: 'void (void)', size: 0 },
    };
    const reader: ValueReader = { read: () => null, symbolize: (a) => (a === 0x08000114 ? 'isr' : null) };
    expect(formatValue('h', fp, bytes(0x15, 0x01, 0x00, 0x08), 0x03007ffc, reader).value).toBe(
      '0x08000115  → isr (Thumb)',
    );
    expect(formatValue('h', fp, bytes(0x14, 0x01, 0x00, 0x08), 0x03007ffc, reader).value).toBe('0x08000114  → isr');
    expect(formatValue('h', fp, bytes(0, 0, 0, 0), 0x03007ffc, reader).value).toBe('0x00000000');
  });
});

describe('unsized arrays', () => {
  const pattern: ValueReader = {
    read: (address, size) => {
      const out = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        out[i] = (address + i) & 0xff;
      }
      return out;
    },
  };
  const unsized: TypeDesc = { kind: 'array', name: 'int[]', size: 0, count: null, target: int(4) };

  it('re-reads memory when expanded, so a write made since shows', () => {
    let word = 1;
    const live: ValueReader = { read: (_a, n) => new Uint8Array(n).map((_, i) => (i === 0 ? word : 0)) };
    const s: TypeDesc = {
      kind: 'struct',
      name: 'struct S',
      size: 4,
      members: [{ name: 'v', offset: 0, type: int(4) }],
    };
    const node = formatValue('s', s, live.read(0x03000000, 4), 0x03000000, live);
    expect(node.children!()[0]!.value).toBe('1');
    word = 9;
    expect(node.children!()[0]!.value).toBe('9');
    const arr: TypeDesc = { kind: 'array', name: 'int[1]', size: 4, count: 1, target: int(4) };
    const a = formatValue('a', arr, live.read(0x03000000, 4), 0x03000000, live);
    word = 3;
    expect(a.element!(0)!.value).toBe('3');
  });

  it('previews from its address instead of inventing a count from a buffer', () => {
    const node = formatValue('a', unsized, bytes(1, 1, 1, 1), 0x03000000, pattern);
    expect(node.value.startsWith('[] {')).toBe(true);
    expect(node.value).not.toContain('[1]');
    expect(node.children!().length).toBe(64);
    expect(node.element!(70)!.address).toBe(0x03000000 + 70 * 4);
    expect(node.element!(-1)).toBeNull();
    expect(formatValue('a', unsized, null, undefined, pattern).value).toBe('<unsized array>');
  });

  it('a sized array bounds its elements', () => {
    const sized: TypeDesc = { kind: 'array', name: 'int[2]', size: 8, count: 2, target: int(4) };
    const node = formatValue('a', sized, bytes(1, 0, 0, 0, 2, 0, 0, 0), 0x03000000, none);
    expect(node.element!(1)!.value).toBe('2');
    expect(node.element!(2)).toBeNull();
  });
});
