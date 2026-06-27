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

  it('returns null for a PC outside any function/sequence', () => {
    expect(di.pcToSource(0x09000000)).toBeNull();
    expect(di.pcToFunction(0x09000000)).toBeNull();
  });
});
