import type { DebugInfo, SourceLocation } from '@gba-kit/debug-info';
import { describe, expect, it } from 'vitest';

import { type DisasmLine, buildSourceRows, matchSegmentsIndex, toRenderItems } from '../pages/debug/source-model';

describe('matchSegmentsIndex', () => {
  const candidates = [
    { segments: ['proj', 'src', 'code_0.c'] },
    { segments: ['proj', 'src', 'code_1.c'] },
    { segments: ['proj', 'source', 'game.c'] },
  ];

  it('matches a relative DWARF path by trailing segments', () => {
    expect(matchSegmentsIndex('src/code_1.c', candidates)).toBe(1);
  });

  it('matches an absolute DWARF path by trailing segments', () => {
    expect(matchSegmentsIndex('/balatro-gba/source/game.c', candidates)).toBe(2);
  });

  it('returns -1 when nothing shares even the basename', () => {
    expect(matchSegmentsIndex('lib/tonc_math.h', candidates)).toBe(-1);
  });

  it('prefers the longer trailing overlap on basename collisions', () => {
    const dup = [{ segments: ['a', 'foo', 'util.c'] }, { segments: ['b', 'bar', 'util.c'] }];
    expect(matchSegmentsIndex('x/bar/util.c', dup)).toBe(1);
  });

  it('returns -1 on an ambiguous basename tie rather than guessing the first', () => {
    // Two util.c in different dirs; the DWARF path only matches on the basename,
    // so neither can be preferred — load nothing instead of the wrong file.
    const dup = [{ segments: ['a', 'foo', 'util.c'] }, { segments: ['b', 'bar', 'util.c'] }];
    expect(matchSegmentsIndex('util.c', dup)).toBe(-1);
  });
});

/** Minimal DebugInfo stand-in: only `lines.pcToSource` is used by the model. */
function fakeDi(map: Record<number, SourceLocation>): DebugInfo {
  return { lines: { pcToSource: (pc: number) => map[pc] ?? null } } as unknown as DebugInfo;
}

describe('buildSourceRows', () => {
  it('disassembles the range and attaches each instruction its source location', () => {
    const disasm = (addr: number, count: number): DisasmLine[] =>
      Array.from({ length: count }, (_, i) => ({ address: addr + i * 2, mnemonic: `op${i}` }));
    const di = fakeDi({
      0x100: { file: 'a.c', line: 10 },
      0x102: { file: 'a.c', line: 10 },
      0x104: { file: 'a.c', line: 11 },
    });
    const rows = buildSourceRows(disasm, di, 0x100, 0x106);
    expect(rows).toEqual([
      { address: 0x100, mnemonic: 'op0', src: { file: 'a.c', line: 10 } },
      { address: 0x102, mnemonic: 'op1', src: { file: 'a.c', line: 10 } },
      { address: 0x104, mnemonic: 'op2', src: { file: 'a.c', line: 11 } },
    ]);
  });
});

describe('toRenderItems', () => {
  it('interleaves file dividers, C lines (once per change), and asm; marks current', () => {
    const rows = [
      { address: 0x100, mnemonic: 'op0', src: { file: 'src/a.c', line: 10 } },
      { address: 0x102, mnemonic: 'op1', src: { file: 'src/a.c', line: 10 } },
      { address: 0x104, mnemonic: 'op2', src: { file: 'src/a.c', line: 11 } },
    ];
    const getLine = (_file: string, line: number) => `LINE ${line}`;
    const items = toRenderItems(rows, getLine, { file: 'src/a.c', line: 11 }, 0x104);
    expect(items).toEqual([
      { kind: 'file', file: 'a.c' },
      { kind: 'cline', file: 'src/a.c', line: 10, text: 'LINE 10', active: false },
      { kind: 'asm', address: 0x100, mnemonic: 'op0', current: false },
      { kind: 'asm', address: 0x102, mnemonic: 'op1', current: false },
      { kind: 'cline', file: 'src/a.c', line: 11, text: 'LINE 11', active: true },
      { kind: 'asm', address: 0x104, mnemonic: 'op2', current: true },
    ]);
  });

  it('passes null source text through (sources not loaded) without a header per asm row', () => {
    const rows = [
      { address: 0x200, mnemonic: 'x', src: { file: 'q.c', line: 5 } },
      { address: 0x202, mnemonic: 'y', src: null },
    ];
    const items = toRenderItems(rows, () => null, null, 0x999);
    expect(items).toEqual([
      { kind: 'file', file: 'q.c' },
      { kind: 'cline', file: 'q.c', line: 5, text: null, active: false },
      { kind: 'asm', address: 0x200, mnemonic: 'x', current: false },
      { kind: 'asm', address: 0x202, mnemonic: 'y', current: false }, // no src -> no header
    ]);
  });
});
