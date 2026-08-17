/**
 * Subscripted variable paths, against the committed agbcc (GCC 2.95 / DWARF-2) ELF.
 *
 * The point of the bounds check is not tidiness. An index past the end resolves to an
 * address inside whatever object follows the array, which reads as plausible data and
 * writes as corruption of something the caller never named — and an address alone
 * cannot say which was meant. Expressing the index is what makes it checkable, so
 * these tests pin both halves: the in-bounds address, and the refusal.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DebugInfo } from '../debug-info.js';
import { parsePath } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const ELF = join(here, '..', '..', 'test-projects', 'agbcc-min', 'build', 'min.elf');
const di = DebugInfo.fromElf(new Uint8Array(readFileSync(ELF)));

describe('parsePath', () => {
  it('splits members and subscripts', () => {
    expect(parsePath('a')).toEqual([{ name: 'a', indices: [] }]);
    expect(parsePath('a.b')).toEqual([
      { name: 'a', indices: [] },
      { name: 'b', indices: [] },
    ]);
    expect(parsePath('a[2].b[3][4]')).toEqual([
      { name: 'a', indices: [2] },
      { name: 'b', indices: [3, 4] },
    ]);
  });

  it('rejects malformed text rather than reading it as a field name', () => {
    // Returning a segment named "a[" would turn a typo into "no such field", which is
    // indistinguishable from a renamed field.
    for (const bad of ['a[', 'a[x]', 'a]', '[0]', 'a[1', 'a[-1]']) {
      expect(parsePath(bad)).toBeNull();
    }
  });
});

describe('subscripted variable paths', () => {
  it('resolves an element of a multi-dimensional array', () => {
    const base = di.symbolToAddress('g_init_table')!;
    // const unsigned short g_init_table[][2] = {{1,2},{3,4}} — row-major, 2-byte elements.
    expect(di.resolveVariable('g_init_table[0][0]')).toEqual({ address: base, size: 2 });
    expect(di.resolveVariable('g_init_table[0][1]')).toEqual({ address: base + 2, size: 2 });
    expect(di.resolveVariable('g_init_table[1][0]')).toEqual({ address: base + 4, size: 2 });
    expect(di.resolveVariable('g_init_table[1][1]')).toEqual({ address: base + 6, size: 2 });
  });

  it('refuses an index past the end, in any dimension', () => {
    expect(() => di.resolveVariable('g_init_table[2][0]')).toThrow(
      /2 element\(s\) in dimension 0, so index 2 is past the end/,
    );
    expect(() => di.resolveVariable('g_init_table[0][2]')).toThrow(
      /2 element\(s\) in dimension 1, so index 2 is past the end/,
    );
    // Positive control: the last valid index of each dimension still resolves.
    expect(di.resolveVariable('g_init_table[1][1]')).not.toBeNull();
  });

  it('bounds a forward-declared array by its definition', () => {
    // static const unsigned short g_fwd_sized_table[][2] — declared unsized, defined [3][2].
    expect(di.resolveVariable('g_fwd_sized_table[2][1]')).not.toBeNull();
    expect(() => di.resolveVariable('g_fwd_sized_table[3][0]')).toThrow(/index 3 is past the end/);
  });

  it('says a partly-subscripted array is not a value', () => {
    // Blaming the name ("cannot resolve") would be wrong — the name is fine, the
    // subscripting is incomplete.
    expect(() => di.resolveVariable('g_init_table[0]')).toThrow(/names a sub-array, not a value/);
  });

  it('does not bound a dimension the DWARF leaves unstated', () => {
    // `extern const short g_ext_grid[][4]`: the outer extent is not in this ELF, so any
    // index is admissible there while the inner one is still checked. A guard must not
    // invent a bound it was never given — GCC 2.95 spells the unsized outer dimension
    // as extent 1, and treating that literally would reject every index above 0.
    const shape = di.types.variableShape('g_ext_grid');
    expect(shape).toMatchObject({ kind: 'array', dims: [null, 4] });
  });

  it('refuses to subscript something that is not an array', () => {
    expect(() => di.resolveVariable('g_probe[0]')).toThrow(/is not an array/);
  });
});
