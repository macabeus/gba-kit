/**
 * Tests the parser against REAL ELFs produced by the two minimal GBA projects in
 * ../../test-projects. The ELFs are compiled fresh before the suite runs (see
 * ../../vitest.globalSetup.ts) from vendored toolchains:
 *
 *   - agbcc-min     — agbcc (GCC 2.95), DWARF-2 line table
 *   - devkitarm-min — modern arm-none-eabi-gcc (GCC 14), DWARF-3+ line table
 *
 * Both compile the same shape, so one parametrized suite exercises the whole
 * surface across both DWARF dialects.
 *
 * Oracle: each project's Makefile generates build/oracle.json next to the ELF.
 * The test just reads that JSON and asserts DebugInfo agrees with it.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DebugInfo } from '../debug-info.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectsDir = join(here, '..', '..', 'test-projects');

interface Oracle {
  /** symbol name → address (Thumb low bit cleared, as binutils reports it). */
  symbols: Record<string, number>;
  /** "0x<addr>" of each function entry → addr2line's reference {func,file,line}. */
  lines: Record<string, { func: string; file: string; line: number }>;
}

interface Project {
  label: string;
  dir: string;
}

const PROJECTS: Project[] = [
  { label: 'agbcc-min (GCC 2.95, DWARF-2)', dir: join(projectsDir, 'agbcc-min') },
  { label: 'devkitarm-min (modern GCC, DWARF-3+)', dir: join(projectsDir, 'devkitarm-min') },
];

const FUNCS = ['add', 'square', 'bump', 'triple', 'main'] as const;

const hex = (addr: number): string => '0x' + addr.toString(16);

describe.each(PROJECTS)('DebugInfo vs binutils oracle on $label', (project) => {
  const elf = join(project.dir, 'build', 'min.elf');
  const oracle = JSON.parse(readFileSync(join(project.dir, 'build', 'oracle.json'), 'utf8')) as Oracle;
  const di = DebugInfo.fromElf(new Uint8Array(readFileSync(elf)));

  it('parses a DWARF line table', () => {
    expect(di.hasLineInfo).toBe(true);
  });

  it('spans multiple compilation units (main.c + util.c)', () => {
    const files = new Set(di.lines.rows.map((r) => basename(r.file)));
    expect(files.has('main.c')).toBe(true);
    expect(files.has('util.c')).toBe(true);
  });

  it.each(FUNCS)('symbolToAddress(%s) matches nm', (fn) => {
    expect(di.symbolToAddress(fn)).toBe(oracle.symbols[fn]);
  });

  it.each(FUNCS)('pcToFunction(%s entry) matches nm', (fn) => {
    expect(di.pcToFunction(oracle.symbols[fn]!)?.name).toBe(fn);
  });

  it.each(FUNCS)('pcToSource(%s entry) matches addr2line', (fn) => {
    const addr = oracle.symbols[fn]!;
    const want = oracle.lines[hex(addr)]!;
    const src = di.pcToSource(addr);
    expect(src?.func).toBe(want.func);
    expect(basename(src!.file)).toBe(basename(want.file));
    expect(src?.line).toBe(want.line);
  });

  it('disambiguates the add/square boundary (add.end === square.start)', () => {
    // square is laid out immediately after add (contiguous, no gap), so square's
    // entry PC is simultaneously add's one-past-the-end. Assert both sides: the
    // last byte of add still resolves to add, and the boundary itself to square.
    const sq = oracle.symbols.square!;
    expect(oracle.symbols.add!).toBeLessThan(sq);
    expect(di.pcToFunction(sq - 1)?.name).toBe('add');
    expect(di.pcToFunction(sq)?.name).toBe('square');
  });

  it('resolves the global object symbol g_counter (matches nm)', () => {
    expect(di.symbolToAddress('g_counter')).toBe(oracle.symbols.g_counter);
  });

  it('resolves a linker-defined absolute global (STT_NOTYPE ldscript symbol)', () => {
    // gAbsGlobal = 0x03001234 — an ldscript/--defsym symbol, the way GBA decomps
    // place a struct at a fixed RAM address. It's STT_NOTYPE/SHN_ABS, so it only
    // resolves because the symbol index keeps absolute NOTYPE/GLOBAL symbols.
    expect(di.symbolToAddress('gAbsGlobal')).toBe(0x03001234);
    // It carries no size, so resolveVariable falls back to a 32-bit word read.
    expect(di.resolveVariable('gAbsGlobal')).toEqual({ address: 0x03001234, size: 4 });
  });

  it('returns null for a PC outside any function/sequence', () => {
    expect(di.pcToSource(0x09000000)).toBeNull();
    expect(di.pcToFunction(0x09000000)).toBeNull();
  });

  // Struct/union layout from DWARF. The shared types have an ABI-stable layout, so
  // the same numbers hold under both agbcc (DWARF-2) and modern GCC (DWARF-5).
  it('exposes DWARF type info', () => {
    expect(di.hasTypeInfo).toBe(true);
  });

  it('resolves a named struct layout (offsets + sizes) — DebugInfo.struct', () => {
    expect(di.struct('Probe')).toEqual({
      name: 'Probe',
      size: 32,
      members: [
        { name: 'tag', offset: 0, size: 1, signed: false }, // plain char is unsigned on ARM
        { name: 'count', offset: 4, size: 4, signed: true },
        { name: 'flags', offset: 8, size: 2, signed: true },
        { name: 'name', offset: 10, size: 6, signed: null }, // char[6] → element size × length; not a base type
        { name: 'ptr', offset: 16, size: 4, signed: null, pointer: true }, // pointer → 4 bytes
        { name: 'inner', offset: 20, size: 8, signed: null }, // nested struct
        { name: 'tail', offset: 28, size: 4, signed: true },
      ],
    });
  });

  it('resolves a typedef of an anonymous struct by its alias name', () => {
    // `typedef struct {…} Pair;` — no struct tag, only the typedef.
    // struct('Pair') must follow the typedef to the unnamed struct.
    expect(di.struct('Pair')).toEqual({
      name: 'Pair',
      size: 8,
      members: [
        { name: 'a', offset: 0, size: 4, signed: true },
        { name: 'b', offset: 4, size: 4, signed: true },
      ],
    });
  });

  it('resolves nested member paths — DebugInfo.structMember', () => {
    expect(di.structMember('Probe', 'count')).toEqual({ offset: 4, size: 4 });
    expect(di.structMember('Probe', 'inner.x')).toEqual({ offset: 20, size: 4 });
    expect(di.structMember('Probe', 'inner.y')).toEqual({ offset: 24, size: 2 });
    expect(di.structMember('Probe', ['inner', 'x'])).toEqual({ offset: 20, size: 4 }); // array form
  });

  it('classifies a variable declaration shape — TypeIndex.variableShape', () => {
    // scalar int: signed, 4 bytes, unqualified
    expect(di.types.variableShape('g_counter')).toEqual({
      kind: 'scalar',
      size: 4,
      signed: true,
      volatile: false,
      const: false,
    });
    // struct global, by tag name
    expect(di.types.variableShape('g_probe')).toEqual({
      kind: 'struct',
      structName: 'Probe',
      size: 32,
      volatile: false,
      const: false,
    });
    // typedef'd anonymous struct: shape resolves through the typedef (the tag is unnamed)
    expect(di.types.variableShape('g_pair')).toMatchObject({ kind: 'struct', size: 8 });
    // no DIE ⇒ null — the "is this name declared?" probe
    expect(di.types.variableShape('g_no_such')).toBeNull();
  });

  it('reports the cv-qualifiers variableShape resolves through — volatile scalar, const array, volatile struct', () => {
    // volatile unsigned short g_mmio — the MMIO idiom; the qualifier is part of the declaration
    expect(di.types.variableShape('g_mmio')).toEqual({
      kind: 'scalar',
      size: 2,
      signed: false,
      volatile: true,
      const: false,
    });
    // const short g_rom_table[3] — the ROM-table idiom; the const qualifies the ELEMENT in DWARF
    expect(di.types.variableShape('g_rom_table')).toEqual({
      kind: 'array',
      elemSize: 2,
      elemSigned: true,
      length: 3,
      volatile: false,
      const: true,
    });
    // volatile struct Cv g_cv — the qualifier survives to the struct classification
    expect(di.types.variableShape('g_cv')).toEqual({
      kind: 'struct',
      structName: 'Cv',
      size: 4,
      volatile: true,
      const: false,
    });
  });

  it('reports member base-type signedness — the s8-vs-u8 fact offsets cannot carry', () => {
    // struct Cv { signed char level; unsigned short gain; }
    expect(di.struct('Cv')).toEqual({
      name: 'Cv',
      size: 4,
      members: [
        { name: 'level', offset: 0, size: 1, signed: true },
        { name: 'gain', offset: 2, size: 2, signed: false, volatile: true }, // vu16-field idiom
      ],
    });
  });

  it('returns null for unknown types and missing members', () => {
    expect(di.struct('NoSuchType')).toBeNull();
    expect(di.structMember('Probe', 'nope')).toBeNull();
    expect(di.structMember('Probe', 'inner.nope')).toBeNull();
    expect(di.structMember('Probe', 'count.x')).toBeNull(); // can't descend into a scalar
  });

  it('reads enum constants, including explicit + continued values — DebugInfo.enumValues', () => {
    // enum Color { COLOR_RED, COLOR_GREEN = 5, COLOR_BLUE };
    expect(di.enumValues('Color')).toEqual({ COLOR_RED: 0, COLOR_GREEN: 5, COLOR_BLUE: 6 });
  });

  it('reads a typedef of an anonymous enum by its alias name', () => {
    // typedef enum { MODE_OFF, MODE_ON } Mode;
    expect(di.enumValues('Mode')).toEqual({ MODE_OFF: 0, MODE_ON: 1 });
  });

  it('returns null for an unknown enum', () => {
    expect(di.enumValues('NoSuchEnum')).toBeNull();
  });

  // Bitfields: hearts:2, stars:3, cross:7, wide:4 packed LSB-first into one unit,
  // then a plain int. Normalized identically from DWARF-2 (bit_offset from MSB)
  // and DWARF-5 (data_bit_offset).
  it('resolves bitfield members to offset + shift + width — DebugInfo.struct', () => {
    expect(di.struct('Bits')).toEqual({
      name: 'Bits',
      size: 8,
      members: [
        { name: 'hearts', offset: 0, size: 1, bitOffset: 0, bitWidth: 2, signed: false },
        { name: 'stars', offset: 0, size: 1, bitOffset: 2, bitWidth: 3, signed: false },
        { name: 'cross', offset: 0, size: 2, bitOffset: 5, bitWidth: 7, signed: false }, // crosses byte boundary → 2-byte read
        { name: 'wide', offset: 1, size: 1, bitOffset: 4, bitWidth: 4, signed: false },
        { name: 'after', offset: 4, size: 4, signed: true }, // plain member: no bitOffset/bitWidth
      ],
    });
  });

  it('resolves a struct from a second compilation unit (multi-abbrev-table)', () => {
    // UtilPair lives in util.c — a separate CU whose abbrev table abuts main.c's.
    // agbcc emits no 0-code terminator between tables, so this guards table bounding.
    expect(di.struct('UtilPair')).toEqual({
      name: 'UtilPair',
      size: 4,
      members: [
        { name: 'lo', offset: 0, size: 2, signed: true },
        { name: 'hi', offset: 2, size: 2, signed: true },
      ],
    });
  });

  it('resolves a bitfield member via structMember', () => {
    // (The runtime decode of this shape is covered end-to-end by scripting's readVariable.)
    expect(di.structMember('Bits', 'cross')).toEqual({ offset: 0, size: 2, bitOffset: 5, bitWidth: 7 });
  });

  // Variable-rooted resolution: the global's type comes from its own DWARF DIE, so
  // no type name is supplied. g_probe/g_bits/g_counter are real globals in main.c.
  it('resolves a field path from a variable symbol — DebugInfo.variableMember', () => {
    expect(di.variableMember('g_probe', 'count')).toEqual({ offset: 4, size: 4 });
    expect(di.variableMember('g_probe', 'inner.y')).toEqual({ offset: 24, size: 2 });
    expect(di.variableMember('g_bits', 'cross')).toEqual({ offset: 0, size: 2, bitOffset: 5, bitWidth: 7 });
    expect(di.variableMember('g_probe', 'nope')).toBeNull();
    expect(di.variableMember('noSuchGlobal', 'count')).toBeNull();
  });

  it('resolves a variable path to an absolute address + size — DebugInfo.resolveVariable', () => {
    const probe = di.symbolToAddress('g_probe')!;
    expect(di.resolveVariable('g_probe.inner.y')).toEqual({ address: probe + 24, size: 2 });
    // A bitfield carries its shift/width through.
    expect(di.resolveVariable('g_bits.cross')).toEqual({
      address: di.symbolToAddress('g_bits'),
      size: 2,
      bitOffset: 5,
      bitWidth: 7,
    });
    // A bare scalar global: size comes from the symbol table.
    expect(di.resolveVariable('g_counter')).toEqual({ address: di.symbolToAddress('g_counter'), size: 4 });
    expect(di.resolveVariable('noSuchGlobal')).toBeNull();
    expect(di.resolveVariable('g_probe.nope')).toBeNull();
  });
});

// Shapes/symbols present only in devkitarm-min — agbcc (GCC 2.95) rejects anonymous
// unions, and agbcc-min's custom linker script emits no boundary markers — so these
// run against devkitarm-min alone.
describe('DebugInfo on devkitarm-min-only shapes', () => {
  const di = DebugInfo.fromElf(new Uint8Array(readFileSync(join(projectsDir, 'devkitarm-min', 'build', 'min.elf'))));

  it('descends into an anonymous union to resolve its fields', () => {
    // struct Shape { int kind; union { int circle; short pair; }; };
    expect(di.structMember('Shape', 'circle')).toEqual({ offset: 4, size: 4 });
    expect(di.structMember('Shape', 'pair')).toEqual({ offset: 4, size: 2 });
    const shape = di.symbolToAddress('g_shape')!;
    expect(di.variableMember('g_shape', 'circle')).toEqual({ offset: 4, size: 4 });
    expect(di.resolveVariable('g_shape.pair')).toEqual({ address: shape + 4, size: 2 });
  });

  it('reports the byte size of an 8-byte global (long long)', () => {
    expect(di.resolveVariable('g_wide')).toEqual({ address: di.symbolToAddress('g_wide'), size: 8 });
  });

  it('reports null size for a flexible array member (no fixed read size)', () => {
    // struct Blob { int len; char data[]; };
    expect(di.structMember('Blob', 'len')).toEqual({ offset: 0, size: 4 });
    expect(di.structMember('Blob', 'data')).toEqual({ offset: 4, size: null });
    // The null size propagates, so resolveVariable refuses to size the read.
    expect(di.resolveVariable('g_blob.data')).toBeNull();
  });

  it('keeps absolute ldscript globals but excludes section-relative linker markers', () => {
    // `gAbsGlobal` is STT_NOTYPE with SHN_ABS — an ldscript-placed data global we want.
    expect(di.symbolToAddress('gAbsGlobal')).toBe(0x03001234);
    // `_end` / `__bss_start` are also STT_NOTYPE/STB_GLOBAL and present in the symtab,
    // but section-relative (not SHN_ABS): boundary markers, not data globals. The
    // SHN_ABS filter must exclude them, so symbolToAddress returns null.
    expect(di.symbolToAddress('_end')).toBeNull();
    expect(di.symbolToAddress('__bss_start')).toBeNull();
  });
});
