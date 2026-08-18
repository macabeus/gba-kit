/**
 * Tests the parser against REAL ELFs produced by the minimal projects in
 * ../../test-projects. The ELFs are compiled fresh before the suite runs (see
 * ../../vitest.globalSetup.ts) from vendored toolchains:
 *
 *   little-endian ARM (GBA):
 *   - agbcc-min     — agbcc (GCC 2.95), DWARF-2 line table
 *   - devkitarm-min — modern arm-none-eabi-gcc (GCC 14), DWARF-3+ line table
 *
 *   big-endian (MSB-first container AND DWARF payload):
 *   - mips-min      — mips-linux-gnu-gcc, MIPS o32
 *   - ppc-min       — powerpc-linux-gnu-gcc, PowerPC 32 (also vendors a .o, below)
 *
 * The two projects within each byte order compile the same shape, so one
 * parametrized suite per byte order exercises the whole surface across both DWARF
 * dialects. The layouts differ between the groups only where the ABI differs — the
 * bitfield allocation end above all — so they are separate blocks, not one. A third
 * block then compares the four ELFs against EACH OTHER, pinning what byte order may
 * and may not change (see "cross-endian equivalence" below).
 *
 * Oracle: each project's Makefile generates build/oracle.json next to the ELF.
 * The test just reads that JSON and asserts DebugInfo agrees with it.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DebugInfo } from '../debug-info.js';
import { ElfFile } from '../elf.js';
import { Cursor } from '../reader.js';
import type { StructType, VariableShape } from '../types.js';

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

const ARM_PROJECTS: Project[] = [
  { label: 'agbcc-min (GCC 2.95, DWARF-2)', dir: join(projectsDir, 'agbcc-min') },
  { label: 'devkitarm-min (modern GCC, DWARF-3+)', dir: join(projectsDir, 'devkitarm-min') },
];

const BE_PROJECTS: Project[] = [
  { label: 'mips-min (MIPS o32, big-endian)', dir: join(projectsDir, 'mips-min') },
  { label: 'ppc-min (PowerPC 32, big-endian)', dir: join(projectsDir, 'ppc-min') },
];

const FUNCS = ['add', 'square', 'bump', 'triple', 'main'] as const;

const hex = (addr: number): string => '0x' + addr.toString(16);

describe.each(ARM_PROJECTS)('DebugInfo vs binutils oracle on $label', (project) => {
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
        // char[6] → `size` is the WHOLE member (element size × length); the element facts are
        // what an indexed read into it needs, and `signed` stays null (an array is not a base type)
        { name: 'name', offset: 10, size: 6, signed: null, elemSize: 1, elemSigned: false, length: 6, dims: [6] },
        // pointer → 4 bytes, and the pointee facts pointer arithmetic scales by
        { name: 'ptr', offset: 16, size: 4, signed: null, pointer: true, pointeeSize: 4, pointeeSigned: true },
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
    // typedef'd anonymous struct: the tag is unnamed, so the alias is the name it is known by
    expect(di.types.variableShape('g_pair')).toEqual({
      kind: 'struct',
      structName: 'Pair',
      size: 8,
      volatile: false,
      const: false,
    });
    // no DIE ⇒ null — the "is this name declared?" probe
    expect(di.types.variableShape('g_no_such')).toBeNull();
  });

  it('names an anonymous typedef struct GLOBAL the way struct() looks a layout up — the round trip', () => {
    // `typedef struct {…} Pair; Pair g_pair;` — the struct itself has no tag, so the alias is the
    // only name its layout has. The name is what makes the shape actionable: it is the argument
    // struct() takes, so a consumer holding only the global's declaration reaches its members.
    const shape = di.types.variableShape('g_pair')!;
    expect(shape.kind).toBe('struct');
    const structName = shape.kind === 'struct' ? shape.structName : null;
    expect(structName).toBe('Pair');
    expect(di.struct(structName!)).toEqual(di.struct('Pair'));
    expect(di.struct(structName!)!.members.map((m) => m.name)).toEqual(['a', 'b']);
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
      dims: [3],
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

  it('reports an array member’s element stride/signedness/count — the facts `size` cannot carry', () => {
    // `char name[6]` at offset 10: `size` is 6 (the whole member), so the position of its n-th
    // element is only derivable from the element stride, and how many there are only from `length`.
    const members = Object.fromEntries(di.struct('Probe')!.members.map((m) => [m.name, m]));
    expect(members.name).toMatchObject({ size: 6, elemSize: 1, elemSigned: false, length: 6 });
    // Non-array members carry none of the three — their presence is what marks a member an array.
    for (const plain of ['tag', 'count', 'ptr', 'inner']) {
      expect(members[plain]).not.toHaveProperty('elemSize');
      expect(members[plain]).not.toHaveProperty('elemSigned');
      expect(members[plain]).not.toHaveProperty('length');
    }
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
  // and DWARF-5 (data_bit_offset). The big-endian block below asserts the mirror
  // image of these numbers for the very same declaration.
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

  it('reports a const member, which nothing about its location says', () => {
    // `struct Shape { const int kind; … };` — const moves no field, so a consumer re-spelling
    // the declaration can only get it from here, and a write through the member is a constraint
    // violation rather than another spelling of the same access.
    const kind = di.struct('Shape')!.members.find((m) => m.name === 'kind')!;
    expect(kind).toEqual({ name: 'kind', offset: 0, size: 4, signed: true, const: true });
    // Unqualified members carry neither key — presence is the fact, as it is for volatile.
    const level = di.struct('Cv')!.members.find((m) => m.name === 'level')!;
    expect(level).not.toHaveProperty('const');
    expect(level).not.toHaveProperty('volatile');
    // The location is the same either way, so `const` is not part of one.
    expect(di.structMember('Shape', 'kind')).toEqual({ offset: 0, size: 4 });
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
    // The member still declares an element STRIDE — what it has no bound. So `elemSize` is
    // reported and `length` is absent, the two facts being independent.
    const data = di.struct('Blob')!.members.find((m) => m.name === 'data')!;
    expect(data).toEqual({
      name: 'data',
      offset: 4,
      size: null,
      signed: null,
      elemSize: 1,
      elemSigned: false,
      dims: [null],
    });
  });

  it('names an UNNAMED pointee by the typedef that aliases it', () => {
    // `typedef struct {…} Pair; Pair *g_pair_ptr;` — the struct itself has no tag, so the alias
    // is the only name its layout has, and struct() is the consumer that must accept it.
    expect(di.types.variableShape('g_pair_ptr')).toEqual({
      kind: 'pointer',
      pointee: { structName: 'Pair', size: 8, volatile: false, const: false },
      volatile: false,
      const: false,
    });
    expect(di.struct('Pair')).toEqual({
      name: 'Pair',
      size: 8,
      members: [
        { name: 'a', offset: 0, size: 4, signed: true },
        { name: 'b', offset: 4, size: 4, signed: true },
      ],
    });
  });

  it('reports a pointee’s OWN cv-qualifiers, on the side of the * they were written', () => {
    // `volatile struct Cv *g_cv_ptr;` — accesses THROUGH the pointer are observable, the pointer
    // variable itself is an ordinary object. Its mirror `struct Cv *volatile g_cv_vptr;` qualifies
    // the pointer and not its target. The two declarations differ only in that placement, so the
    // volatile must land on a different one of the two objects in each.
    expect(di.types.variableShape('g_cv_ptr')).toEqual({
      kind: 'pointer',
      pointee: { structName: 'Cv', size: 4, volatile: true, const: false },
      volatile: false,
      const: false,
    });
    expect(di.types.variableShape('g_cv_vptr')).toEqual({
      kind: 'pointer',
      pointee: { structName: 'Cv', size: 4, volatile: false, const: false },
      volatile: true,
      const: false,
    });
  });

  it('keeps a pointee’s qualifiers out of the pointer variable’s own, and vice versa', () => {
    // The same two declarations read as the pair of facts a consumer re-spelling the declaration
    // needs: each object's volatility, from its own side of the *. They are never the same walk.
    const asPointer = (name: string) => {
      const shape = di.types.variableShape(name)!;
      return shape.kind === 'pointer' ? shape : null;
    };
    const target = asPointer('g_cv_ptr')!;
    const self = asPointer('g_cv_vptr')!;

    expect([target.volatile, target.pointee!.volatile]).toEqual([false, true]);
    expect([self.volatile, self.pointee!.volatile]).toEqual([true, false]);
    // An unqualified pointer to an unqualified struct is the control: neither side is set.
    const plain = asPointer('g_pair_ptr')!;
    expect([plain.volatile, plain.pointee!.volatile, plain.const, plain.pointee!.const]).toEqual([
      false,
      false,
      false,
      false,
    ]);
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

// ---------------------------------------------------------------------------
// Big-endian. mips-min and ppc-min compile ONE shared source (their main.c/util.c
// are byte-identical), so both linked ELFs must yield the same layout — and both
// have the container AND the whole DWARF payload stored MSB-first.
// ---------------------------------------------------------------------------
describe.each(BE_PROJECTS)('DebugInfo vs binutils oracle on $label', (project) => {
  const elf = join(project.dir, 'build', 'min.elf');
  const oracle = JSON.parse(readFileSync(join(project.dir, 'build', 'oracle.json'), 'utf8')) as Oracle;
  const di = DebugInfo.fromElf(new Uint8Array(readFileSync(elf)));

  it('is a big-endian ELF (ELFDATA2MSB)', () => {
    expect(di.elf.littleEndian).toBe(false);
  });

  it('parses a DWARF line table from the big-endian payload', () => {
    expect(di.hasLineInfo).toBe(true);
    expect(di.hasTypeInfo).toBe(true);
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
    // The whole .debug_line program — header, opcodes, DW_LNE_set_address operand —
    // is read MSB-first here; a byte-order slip would put every row elsewhere.
    const addr = oracle.symbols[fn]!;
    const want = oracle.lines[hex(addr)]!;
    const src = di.pcToSource(addr);
    expect(src?.func).toBe(want.func);
    expect(basename(src!.file)).toBe(basename(want.file));
    expect(src?.line).toBe(want.line);
  });

  it('returns null for a PC outside any function/sequence', () => {
    expect(di.pcToSource(0x7f000000)).toBeNull();
    expect(di.pcToFunction(0x7f000000)).toBeNull();
  });

  it('resolves a named struct layout (offsets + sizes) — DebugInfo.struct', () => {
    // Identical to the ARM layout: both ABIs align a 32-bit int to 4 bytes.
    expect(di.struct('Probe')).toEqual({
      name: 'Probe',
      size: 32,
      members: [
        { name: 'tag', offset: 0, size: 1, signed: false },
        { name: 'count', offset: 4, size: 4, signed: true },
        { name: 'flags', offset: 8, size: 2, signed: true },
        { name: 'name', offset: 10, size: 6, signed: null, elemSize: 1, elemSigned: false, length: 6, dims: [6] },
        { name: 'ptr', offset: 16, size: 4, signed: null, pointer: true, pointeeSize: 4, pointeeSigned: true },
        { name: 'inner', offset: 20, size: 8, signed: null }, // nested struct
        { name: 'tail', offset: 28, size: 4, signed: true },
      ],
    });
    expect(di.structMember('Probe', 'inner.y')).toEqual({ offset: 24, size: 2 });
  });

  it('resolves a struct from a second compilation unit (multi-abbrev-table)', () => {
    expect(di.struct('UtilPair')).toEqual({
      name: 'UtilPair',
      size: 4,
      members: [
        { name: 'lo', offset: 0, size: 2, signed: true },
        { name: 'hi', offset: 2, size: 2, signed: true },
      ],
    });
  });

  it('reports member base-type signedness and member-level volatile', () => {
    expect(di.struct('Cv')).toEqual({
      name: 'Cv',
      size: 4,
      members: [
        { name: 'level', offset: 0, size: 1, signed: true },
        { name: 'gain', offset: 2, size: 2, signed: false, volatile: true },
      ],
    });
  });

  // THE big-endian assertion class: a big-endian target allocates bitfields from the
  // MOST significant end of the storage unit, so the identical C declaration that the
  // ARM projects pin as {hearts@0>>0, stars@0>>2, cross@0..1>>5, wide@1>>4} is the
  // mirror image here. Ground truth from the compilers' own read-modify-write of
  // `cross` (a 2-byte load at offset 0, then insert at shift 4, width 7):
  //   MIPS  lhu $t2,g_bits ; ins $t2,$v0,0x4,0x7 ; sh $t2,g_bits
  //   PPC   lhz r6,0(r7)   ; rlwimi r6,r9,4,21,27 ; sth r6,0(r7)
  it('resolves BIG-ENDIAN bitfields MSB-first — DebugInfo.struct', () => {
    expect(di.struct('Bits')).toEqual({
      name: 'Bits',
      size: 8,
      members: [
        { name: 'hearts', offset: 0, size: 1, bitOffset: 6, bitWidth: 2, signed: false }, // top 2 bits of byte 0
        { name: 'stars', offset: 0, size: 1, bitOffset: 3, bitWidth: 3, signed: false },
        { name: 'cross', offset: 0, size: 2, bitOffset: 4, bitWidth: 7, signed: false }, // crosses the byte boundary
        { name: 'wide', offset: 1, size: 1, bitOffset: 0, bitWidth: 4, signed: false }, // bottom 4 bits of byte 1
        { name: 'after', offset: 4, size: 4, signed: true }, // plain member: no bitOffset/bitWidth
      ],
    });
  });

  it('carries the big-endian bitfield shift through resolveVariable', () => {
    expect(di.resolveVariable('g_bits.cross')).toEqual({
      address: di.symbolToAddress('g_bits'),
      size: 2,
      bitOffset: 4,
      bitWidth: 7,
    });
    expect(di.variableMember('g_bits', 'wide')).toEqual({ offset: 1, size: 1, bitOffset: 0, bitWidth: 4 });
  });

  it('classifies every declaration shape — TypeIndex.variableShape', () => {
    expect(di.types.variableShape('g_counter')).toEqual({
      kind: 'scalar',
      size: 4,
      signed: true,
      volatile: false,
      const: false,
    });
    // `int *g_ptr` — the target is a scalar, so there is no struct pointee to report
    expect(di.types.variableShape('g_ptr')).toEqual({
      kind: 'pointer',
      pointee: null,
      volatile: false,
      const: false,
    });
    // `struct Probe *g_probe_ptr` — the target IS a struct, named by its tag and sized
    expect(di.types.variableShape('g_probe_ptr')).toEqual({
      kind: 'pointer',
      pointee: { structName: 'Probe', size: 32, volatile: false, const: false },
      volatile: false,
      const: false,
    });
    expect(di.types.variableShape('g_table')).toEqual({
      kind: 'array',
      elemSize: 2,
      elemSigned: true,
      length: 4,
      dims: [4],
      volatile: false,
      const: false,
    });
    // const short g_rom_table[3] — the const qualifies the ELEMENT in DWARF
    expect(di.types.variableShape('g_rom_table')).toEqual({
      kind: 'array',
      elemSize: 2,
      elemSigned: true,
      length: 3,
      dims: [3],
      volatile: false,
      const: true,
    });
    expect(di.types.variableShape('g_vol')).toEqual({
      kind: 'scalar',
      size: 4,
      signed: true,
      volatile: true,
      const: false,
    });
    expect(di.types.variableShape('g_probe')).toEqual({
      kind: 'struct',
      structName: 'Probe',
      size: 32,
      volatile: false,
      const: false,
    });
    expect(di.types.variableShape('g_cv')).toEqual({
      kind: 'struct',
      structName: 'Cv',
      size: 4,
      volatile: true,
      const: false,
    });
    expect(di.types.variableShape('g_no_such')).toBeNull();
  });

  it('names a pointee the way struct() looks a layout up — the round trip', () => {
    // The point of reporting the name: it is the argument struct() takes, so a consumer holding
    // only the pointer's own declaration can reach the layout it points at.
    const shape = di.types.variableShape('g_probe_ptr')!;
    expect(shape.kind).toBe('pointer');
    const pointee = shape.kind === 'pointer' ? shape.pointee : null;
    expect(di.struct(pointee!.structName!)).toEqual(di.struct('Probe'));
    expect(pointee!.size).toBe(di.struct('Probe')!.size);
  });

  it('resolves whole-variable reads to address + size', () => {
    expect(di.resolveVariable('g_table')).toEqual({ address: oracle.symbols.g_table, size: 8 });
    expect(di.resolveVariable('g_rom_table')).toEqual({ address: oracle.symbols.g_rom_table, size: 6 });
    expect(di.resolveVariable('g_probe.inner.y')).toEqual({ address: oracle.symbols.g_probe! + 24, size: 2 });
  });
});

// ---------------------------------------------------------------------------
// Cross-endian equivalence. The four projects declare a shared core (struct Probe /
// Inner / Bits / Cv / UtilPair and six globals) and compile it with four different
// compilers across BOTH byte orders. So:
//
//   - everything the ABI fixes must come out IDENTICAL in all four, and
//   - the one thing byte order legitimately changes — the intra-unit bitfield shift
//     — must come out MIRRORED, not merely different.
//
// The second half is the assertion that proves byte order is threaded through the
// reader rather than working by accident: a parser that ignored ELFDATA2MSB would
// either fail outright or report the little-endian shifts for the big-endian ELFs.
// ---------------------------------------------------------------------------
describe('cross-endian equivalence (same declarations, four toolchains, both byte orders)', () => {
  const load = (project: Project) => ({
    name: basename(project.dir),
    di: DebugInfo.fromElf(new Uint8Array(readFileSync(join(project.dir, 'build', 'min.elf')))),
  });
  const LE = ARM_PROJECTS.map(load);
  const BE = BE_PROJECTS.map(load);
  const ALL = [...LE, ...BE];
  type Loaded = (typeof ALL)[number];

  // Every type/global any of the four declares. The ones not present in all four are
  // enumerated by name below, so a project that genuinely lacks a shape is skipped
  // EXPLICITLY rather than dropped silently.
  const CANDIDATE_TYPES = ['Probe', 'Inner', 'Bits', 'Cv', 'UtilPair', 'Grid', 'Pair', 'Shape', 'Blob'];
  const CANDIDATE_GLOBALS = [
    'g_counter',
    'g_probe',
    'g_bits',
    'g_cv',
    'g_rom_table',
    'g_util_pair',
    'g_grid3',
    'g_grid',
    'g_ext_grid', // agbcc-min only — the unsized-outer-bound spelling is a GCC 2.95 quirk
    'g_pair', // little-endian sources only
    'g_color',
    'g_mode',
    'g_mmio',
    'g_ptr', // big-endian sources only
    'g_probe_ptr',
    'g_table',
    'g_vol',
    'g_shape', // devkitarm-min only (agbcc rejects anonymous unions / flexible arrays)
    'g_wide',
    'g_blob',
    'g_pair_ptr',
    'g_cv_ptr',
    'g_cv_vptr',
  ];

  const hasType = (p: Loaded, name: string): boolean => p.di.struct(name) !== null;
  const hasGlobal = (p: Loaded, name: string): boolean => p.di.types.variableShape(name) !== null;

  const sharedTypes = CANDIDATE_TYPES.filter((n) => ALL.every((p) => hasType(p, n)));
  const sharedGlobals = CANDIDATE_GLOBALS.filter((n) => ALL.every((p) => hasGlobal(p, n)));

  /** name → the projects that do NOT declare it, for everything not shared by all four. */
  const skipped = (names: string[], has: (p: Loaded, n: string) => boolean): Record<string, string[]> =>
    Object.fromEntries(
      names
        .map((n) => [n, ALL.filter((p) => !has(p, n)).map((p) => p.name)] as const)
        .filter(([, absent]) => absent.length > 0),
    );

  it('compares two little-endian ELFs against two big-endian ones', () => {
    expect(LE.map((p) => [p.name, p.di.elf.littleEndian])).toEqual([
      ['agbcc-min', true],
      ['devkitarm-min', true],
    ]);
    expect(BE.map((p) => [p.name, p.di.elf.littleEndian])).toEqual([
      ['mips-min', false],
      ['ppc-min', false],
    ]);
  });

  it('shares exactly this declaration set — every other shape is skipped BY NAME', () => {
    expect(sharedTypes).toEqual(['Probe', 'Inner', 'Bits', 'Cv', 'UtilPair', 'Grid']);
    expect(sharedGlobals).toEqual([
      'g_counter',
      'g_probe',
      'g_bits',
      'g_cv',
      'g_rom_table',
      'g_util_pair',
      'g_grid3',
      'g_grid',
    ]);
    // The rest, and who lacks each. These are SOURCE facts (the big-endian projects
    // declare a different set of globals; agbcc/GCC 2.95 rejects anonymous unions and
    // flexible array members), not parser gaps — pinned so a shape silently vanishing
    // from a project's DWARF fails here instead of shrinking the comparison.
    expect(skipped(CANDIDATE_TYPES, hasType)).toEqual({
      Pair: ['mips-min', 'ppc-min'],
      Shape: ['agbcc-min', 'mips-min', 'ppc-min'],
      Blob: ['agbcc-min', 'mips-min', 'ppc-min'],
    });
    expect(skipped(CANDIDATE_GLOBALS, hasGlobal)).toEqual({
      g_ext_grid: ['devkitarm-min', 'mips-min', 'ppc-min'],
      g_pair: ['mips-min', 'ppc-min'],
      g_color: ['mips-min', 'ppc-min'],
      g_mode: ['mips-min', 'ppc-min'],
      g_mmio: ['mips-min', 'ppc-min'],
      g_ptr: ['agbcc-min', 'devkitarm-min'],
      g_probe_ptr: ['agbcc-min', 'devkitarm-min'],
      g_table: ['agbcc-min', 'devkitarm-min'],
      g_vol: ['agbcc-min', 'devkitarm-min'],
      g_shape: ['agbcc-min', 'mips-min', 'ppc-min'],
      g_wide: ['agbcc-min', 'mips-min', 'ppc-min'],
      g_blob: ['agbcc-min', 'mips-min', 'ppc-min'],
      g_pair_ptr: ['agbcc-min', 'mips-min', 'ppc-min'],
      g_cv_ptr: ['agbcc-min', 'mips-min', 'ppc-min'],
      g_cv_vptr: ['agbcc-min', 'mips-min', 'ppc-min'],
    });
  });

  // The byte layout every project must report, spelled `member@offset:size`. Both
  // 32-bit ABIs align an int to 4, so these numbers are byte-order-independent.
  const SHARED_LAYOUT: Record<string, { size: number; members: string }> = {
    Probe: { size: 32, members: 'tag@0:1 count@4:4 flags@8:2 name@10:6 ptr@16:4 inner@20:8 tail@28:4' },
    Inner: { size: 8, members: 'x@0:4 y@4:2' },
    // `cross` spans the byte boundary in both byte orders, hence its 2-byte read.
    Bits: { size: 8, members: 'hearts@0:1 stars@0:1 cross@0:2 wide@1:1 after@4:4' },
    Cv: { size: 4, members: 'level@0:1 gain@2:2' },
    UtilPair: { size: 4, members: 'lo@0:2 hi@2:2' },
    Grid: { size: 16, members: 'id@0:4 cells@4:12' },
  };

  it.each(sharedTypes)('every project reports the same byte layout for %s', (type) => {
    for (const p of ALL) {
      const layout = p.di.struct(type)!;
      expect({
        project: p.name,
        size: layout.size,
        members: layout.members.map((m) => `${m.name}@${m.offset}:${m.size}`).join(' '),
      }).toEqual({ project: p.name, ...SHARED_LAYOUT[type] });
    }
  });

  /** A layout with the ONE field byte order may change (the intra-unit shift) dropped.
   *  Everything left — names, offsets, sizes, signedness, pointer-ness, member-level
   *  volatile, and bitfield WIDTHS — is ABI, so all four must agree exactly. */
  const withoutShift = (layout: StructType): StructType => ({
    ...layout,
    members: layout.members.map(({ bitOffset: _shift, ...rest }) => rest),
  });

  it.each(sharedTypes)('all four agree on every declaration fact of %s except the intra-unit shift', (type) => {
    const reference = withoutShift(LE[0]!.di.struct(type)!);
    for (const p of ALL) {
      expect({ project: p.name, layout: withoutShift(p.di.struct(type)!) }).toEqual({
        project: p.name,
        layout: reference,
      });
    }
  });

  // Declaration shapes: scalar size/signedness, array elemSize/elemSigned/length,
  // struct name/size, and the cv-qualifiers — all byte-order-independent.
  const SHARED_SHAPES: Record<string, VariableShape> = {
    g_counter: { kind: 'scalar', size: 4, signed: true, volatile: false, const: false },
    g_probe: { kind: 'struct', structName: 'Probe', size: 32, volatile: false, const: false },
    g_bits: { kind: 'struct', structName: 'Bits', size: 8, volatile: false, const: false },
    g_cv: { kind: 'struct', structName: 'Cv', size: 4, volatile: true, const: false },
    g_rom_table: { kind: 'array', elemSize: 2, elemSigned: true, length: 3, dims: [3], volatile: false, const: true },
    g_util_pair: { kind: 'struct', structName: 'UtilPair', size: 4, volatile: false, const: false },
    // RANK is byte-order- and producer-independent: the dimensions come from the
    // DW_TAG_subrange chain, which every producer spells in declaration order. A reader that
    // multiplied them away (or read them under the wrong endianness) shows up right here.
    g_grid3: {
      kind: 'array',
      elemSize: 1,
      elemSigned: false,
      length: 24,
      dims: [2, 3, 4],
      volatile: false,
      const: false,
    },
    g_grid: { kind: 'struct', structName: 'Grid', size: 16, volatile: false, const: false },
  };

  it.each(sharedGlobals)('every project classifies %s to the same shape — TypeIndex.variableShape', (name) => {
    for (const p of ALL) {
      expect({ project: p.name, shape: p.di.types.variableShape(name) }).toEqual({
        project: p.name,
        shape: SHARED_SHAPES[name],
      });
    }
  });

  // Bitfields: `unsigned hearts:2, stars:3, cross:7, wide:4` share ONE 4-byte storage
  // unit at offset 0 under both ABIs. A little-endian target fills it from the LSB, a
  // big-endian one from the MSB, so the shifts are mirror images of each other:
  //     leShift + beShift + bitWidth === size * 8
  // Ground truth for the big-endian side is the compilers' own read-modify-write of
  // `cross` (MIPS `ins $t2,$v0,0x4,0x7`, PPC `rlwimi r6,r9,4,21,27` — see above).
  const SHIFTS_LE: Record<string, number> = { hearts: 0, stars: 2, cross: 5, wide: 4 };
  const SHIFTS_BE: Record<string, number> = { hearts: 6, stars: 3, cross: 4, wide: 0 };

  it('bitfields differ ONLY in the shift, and each side matches its own ABI', () => {
    const shifts = (p: Loaded): Record<string, number | undefined> =>
      Object.fromEntries(
        p.di
          .struct('Bits')!
          .members.filter((m) => m.bitWidth !== undefined)
          .map((m) => [m.name, m.bitOffset]),
      );
    for (const p of LE) {
      expect({ project: p.name, ...shifts(p) }).toEqual({ project: p.name, ...SHIFTS_LE });
    }
    for (const p of BE) {
      expect({ project: p.name, ...shifts(p) }).toEqual({ project: p.name, ...SHIFTS_BE });
    }

    // …and they are MIRRORS of one another, not merely two different tables: each
    // field starts the same distance from the opposite end of its own read.
    for (const m of LE[0]!.di.struct('Bits')!.members) {
      if (m.bitWidth === undefined) {
        expect(m.bitOffset).toBeUndefined(); // `after` is a plain member, not a bitfield
        continue;
      }
      expect(SHIFTS_LE[m.name]! + SHIFTS_BE[m.name]! + m.bitWidth).toBe(m.size! * 8);
    }
  });

  it('carries the byte-order-correct shift all the way through resolveVariable', () => {
    // The end-to-end consumer view: same C field, same address and read size on both
    // sides, opposite shift. (`g_bits` sits at a different address per project, so the
    // address is compared to each project's own symbol.)
    for (const p of ALL) {
      const want = p.di.elf.littleEndian ? SHIFTS_LE : SHIFTS_BE;
      expect({ project: p.name, resolved: p.di.resolveVariable('g_bits.cross') }).toEqual({
        project: p.name,
        resolved: {
          address: p.di.symbolToAddress('g_bits'),
          size: 2,
          bitOffset: want.cross,
          bitWidth: 7,
        },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// ppc-min's RELOCATABLE object. PowerPC uses RELA relocations, so in a .o every
// cross-section reference inside `.debug_*` is a ZERO field plus an addend parked
// in `.rela.<section>`. Nothing in that DWARF reads correctly until ElfFile
// applies them — this is the only artifact shape that exercises that path.
// ---------------------------------------------------------------------------
describe('DebugInfo on ppc-min/build/main.o (RELA-relocated DWARF)', () => {
  const objDir = join(projectsDir, 'ppc-min', 'build');
  const bytes = new Uint8Array(readFileSync(join(objDir, 'main.o')));
  const oracle = JSON.parse(readFileSync(join(objDir, 'oracle-obj.json'), 'utf8')) as Oracle;
  const elf = ElfFile.parse(bytes);
  const di = DebugInfo.fromElf(bytes);

  /** The `.rela.debug_info` entries, decoded as { r_offset, symbol value, addend }. */
  const relocations = (): { at: number; symValue: number; addend: number }[] => {
    const rela = elf.section('.rela.debug_info')!;
    const symtab = elf.sections.find((s) => s.type === 2 /* SHT_SYMTAB */)!;
    const rc = new Cursor(bytes, 0, false);
    const symData = elf.sectionDataByIndex(elf.sections.indexOf(symtab))!;
    const sc = new Cursor(symData, 0, false);
    const out = [];
    for (let off = rela.offset; off < rela.offset + rela.size; off += 12) {
      const symIndex = rc.u32At(off + 4) >>> 8; // r_info >> 8
      out.push({ at: rc.u32At(off), symValue: sc.u32At(symIndex * 16 + 4), addend: rc.u32At(off + 8) });
    }
    return out;
  };

  it('is a big-endian relocatable object with RELA-style debug relocations', () => {
    expect(di.elf.littleEndian).toBe(false);
    expect(elf.section('.rela.debug_info')?.type).toBe(4 /* SHT_RELA */);
    // 59 of them with the toolchain CI installs; the count itself is a toolchain
    // detail, so only its order of magnitude is asserted.
    expect(relocations().length).toBeGreaterThan(20);
  });

  it('has NOTHING readable in the raw section — every relocated field is zero', () => {
    // The premise of the RELA path: unrelocated, every site reads 0, so every
    // DW_FORM_strp would resolve to .debug_str offset 0 (one and the same name).
    const raw = new Cursor(bytes, elf.section('.debug_info')!.offset, false);
    for (const { at } of relocations()) {
      expect(raw.u32At(raw.offset + at)).toBe(0);
    }
  });

  it('writes symbol value + addend at every relocation site', () => {
    const patched = new Cursor(elf.sectionData('.debug_info')!, 0, false);
    for (const { at, symValue, addend } of relocations()) {
      expect(patched.u32At(at)).toBe(symValue + addend);
    }
    // Most sites target a section symbol (st_value 0, so the addend alone would do).
    // The DW_AT_location of each global targets the data symbol itself, whose
    // st_value is NOT 0 — those are what pin the "symbol value +" half of the sum.
    const symValues = new Set(relocations().map((r) => r.symValue));
    for (const global of ['g_bits', 'g_vol', 'g_table', 'g_ptr', 'g_counter'] as const) {
      expect(oracle.symbols[global]).toBeGreaterThan(0); // nm: 4, 12, 16, 24, 28
      expect(symValues.has(oracle.symbols[global]!)).toBe(true);
    }
  });

  it('resolves DW_FORM_strp names — only reachable through the addends', () => {
    // Every name here (the struct tags, and each member name too long for
    // DW_FORM_string) is an offset into .debug_str that lives ONLY in an addend.
    expect(di.struct('Probe')?.members.map((m) => m.name)).toEqual([
      'tag',
      'count',
      'flags',
      'name',
      'ptr',
      'inner',
      'tail',
    ]);
    expect(di.struct('Bits')?.members.map((m) => m.name)).toEqual(['hearts', 'stars', 'cross', 'wide', 'after']);
    expect(di.types.variableShape('g_probe')).toEqual({
      kind: 'struct',
      structName: 'Probe',
      size: 32,
      volatile: false,
      const: false,
    });
    // A pointee is named the same way, so it is unreachable through the same addends.
    expect(di.types.variableShape('g_probe_ptr')).toEqual({
      kind: 'pointer',
      pointee: { structName: 'Probe', size: 32, volatile: false, const: false },
      volatile: false,
      const: false,
    });
    // util.c is a different object, so its type is absent here — the .o carries
    // exactly one compilation unit.
    expect(di.struct('UtilPair')).toBeNull();
  });

  it('agrees with the linked ELF on every layout it shares', () => {
    const linked = DebugInfo.fromElf(new Uint8Array(readFileSync(join(objDir, 'min.elf'))));
    for (const type of ['Probe', 'Bits', 'Cv', 'Inner']) {
      expect(di.struct(type)).toEqual(linked.struct(type));
    }
  });

  it('parses the object’s .debug_line program', () => {
    // The PCs are section-relative and .text / .text.startup BOTH start at 0 in an
    // unlinked object, so a PC does not identify a row here. Assert the rows by
    // content instead: one file, and every function-entry line addr2line reports.
    expect(new Set(di.lines.rows.map((r) => basename(r.file)))).toEqual(new Set(['main.c']));
    const lines = new Set(di.lines.rows.map((r) => r.line));
    for (const want of Object.values(oracle.lines)) {
      expect(lines.has(want.line)).toBe(true);
    }
  });
});

/**
 * Subscripted variable paths, across every toolchain and both byte orders.
 *
 * The bound is the point. An index past the end resolves to an address inside
 * whatever object the linker placed next — plausible as data, corrupting as a write,
 * and indistinguishable from the real thing once it is just an address. So each case
 * pins the in-bounds address AND the refusal, and the last valid index is asserted
 * alongside the first invalid one so an off-by-one in the bound cannot pass.
 */
describe.each([...ARM_PROJECTS, ...BE_PROJECTS])('subscripted paths — $label', ({ dir }) => {
  const di = DebugInfo.fromElf(new Uint8Array(readFileSync(join(dir, 'build', 'min.elf'))));

  it('resolves an element of an array global', () => {
    // const short g_rom_table[3] — 2-byte elements.
    const base = di.symbolToAddress('g_rom_table')!;
    expect(di.resolveVariable('g_rom_table[0]')).toEqual({ address: base, size: 2 });
    expect(di.resolveVariable('g_rom_table[1]')).toEqual({ address: base + 2, size: 2 });
    expect(di.resolveVariable('g_rom_table[2]')).toEqual({ address: base + 4, size: 2 });
  });

  it('refuses an index past the end of an array global', () => {
    expect(() => di.resolveVariable('g_rom_table[3]')).toThrow(
      /"g_rom_table" has 3 element\(s\) in dimension 0, so index 3 is past the end/,
    );
    expect(() => di.resolveVariable('g_rom_table[99]')).toThrow(/past the end/);
  });

  it('resolves an element of an array MEMBER, and bounds it', () => {
    // struct Probe { … char name[6]; … } at offset 10.
    const probe = di.symbolToAddress('g_probe')!;
    expect(di.resolveVariable('g_probe.name[0]')).toEqual({ address: probe + 10, size: 1 });
    expect(di.resolveVariable('g_probe.name[5]')).toEqual({ address: probe + 15, size: 1 });
    expect(() => di.resolveVariable('g_probe.name[6]')).toThrow(
      /"name" has 6 element\(s\) in dimension 0, so index 6 is past the end/,
    );
  });

  it('refuses to subscript something that is not an array', () => {
    expect(() => di.resolveVariable('g_probe[0]')).toThrow(/is not an array/);
  });

  it('treats malformed subscript text as unresolvable, not as a field name', () => {
    // Reading "g_rom_table[" as a member of that literal name would turn a typo into
    // "no such field", which is indistinguishable from a renamed field.
    for (const bad of ['g_rom_table[', 'g_rom_table[x]', 'g_rom_table]', 'g_rom_table[1']) {
      expect(di.resolveVariable(bad)).toBeNull();
    }
  });

  it('reports a C-defined global’s extent from st_size', () => {
    // Defined in this translation unit, so the assembler sized the symbol itself.
    expect(di.symbolExtent('g_rom_table')).toEqual({ size: 6, source: 'st_size' });
    expect(di.symbolExtent('g_probe')).toEqual({ size: 32, source: 'st_size' });
    expect(di.symbolExtent('no_such_symbol')).toBeNull();
  });
});

/**
 * Globals the LINKER places rather than C defines (`gAbsGlobal = 0x03001234;` in the
 * ldscript). They are SHN_ABS/NOTYPE with no st_size, and only the ARM projects carry
 * one. Excluding them from the address index left addressToSymbol unable to name a
 * linker-placed global at all — the norm in a decomp, where fixed RAM addresses cannot
 * be C definitions.
 */
describe.each(ARM_PROJECTS)('linker-placed globals — $label', ({ dir }) => {
  const di = DebugInfo.fromElf(new Uint8Array(readFileSync(join(dir, 'build', 'min.elf'))));

  it('resolves an address to the ldscript-placed symbol', () => {
    const addr = di.symbolToAddress('gAbsGlobal')!;
    expect(addr).toBe(0x03001234);
    // `exact: false` — the symbol states no size, so any extent is inferred.
    expect(di.addressToSymbol(addr)).toEqual({ name: 'gAbsGlobal', offset: 0, exact: false });
  });

  it('reports no extent when nothing states one', () => {
    // Placed by the ldscript and never declared with a type, so neither st_size nor
    // DWARF says how big it is. Guessing would give the write guards a bound to
    // enforce that no one ever wrote down.
    expect(di.symbolExtent('gAbsGlobal')).toBeNull();
  });

  it('does not claim it as a function', () => {
    expect(di.pcToFunction(0x03001234)).toBeNull();
  });
});
