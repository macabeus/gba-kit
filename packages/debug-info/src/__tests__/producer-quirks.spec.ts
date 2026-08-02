/**
 * Producer-quirk regressions: four real-compiler encodings the parser once read wrongly,
 * each pinned on a committed test-project artifact that reproduces it.
 *
 *  1. Modern gcc at -O1+ splits a function that is both inlined and emitted into an
 *     ABSTRACT DIE (name, params) plus a CONCRETE DIE (low_pc, DW_AT_abstract_origin).
 *     Indexing only same-DIE name+low_pc loses the signature — `add`/`square` in
 *     mips-min and ppc-min are the split, committed proof.
 *  2. DWARF 2/3 encode boolean attributes as DW_FORM_flag (a byte), not DWARF 4+'s
 *     DW_FORM_flag_present (true). Reading the byte as a number made every
 *     `=== true` declaration test inert: a forward-declared struct shadowed its own
 *     definition depending on LINK ORDER (agbcc-min's FwdPay: declared in main.c's CU,
 *     defined in util.c's, linked in that order), and `prototyped` was always false on
 *     modern-gcc -gdwarf-2 output (devkitarm-min's macinfo.o).
 *  3. agbcc (GCC 2.95) emits DW_AT_upper_bound 0xffffffff (DW_FORM_data4 holding -1)
 *     for a zero-length array; upper+1 on the raw u32 once claimed 2^32 elements —
 *     as a variable shape (g_zero) and as a member size (Flex.data).
 *  4. agbcc emits DW_AT_upper_bound 0 for an UNSIZED extern array — byte-identical to
 *     a real [1]. The variable's own DW_AT_declaration is the disambiguator: a
 *     declaration's single-element read is unknowable (g_ext_table, defined only in
 *     crt0.s — the ldscript/asm-placed-table idiom), while a defined [1] keeps its
 *     length (g_one_def).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DebugInfo } from '../debug-info.js';

const here = dirname(fileURLToPath(import.meta.url));
const projects = join(here, '..', '..', 'test-projects');
const load = (...p: string[]) => DebugInfo.fromElf(new Uint8Array(readFileSync(join(projects, ...p))));

const agbcc = load('agbcc-min', 'build', 'min.elf');
const macinfoObj = load('devkitarm-min', 'build', 'macinfo.o');

describe('1. signatures through the abstract/concrete split (modern gcc -O2)', () => {
  // In both BE ELFs, `add` and `square` are inlined into main AND emitted out-of-line,
  // so their name/params live on an abstract DIE the concrete one references.
  it.each(['mips-min', 'ppc-min'])('%s: add and square resolve with typed params', (project) => {
    const di = load(project, 'build', 'min.elf');
    const add = di.types.functionSignature('add');
    expect(add).toMatchObject({
      returns: { size: 4, signed: true },
      params: [
        { name: 'a', size: 4, signed: true },
        { name: 'b', size: 4, signed: true },
      ],
    });
    expect(di.types.functionSignature('square')?.params).toHaveLength(1);
  });

  it('control: a non-split definition still resolves (agbcc emits no split)', () => {
    expect(agbcc.types.functionSignature('add')?.params).toHaveLength(2);
  });
});

describe('2. DW_FORM_flag is a boolean fact, not the number 1', () => {
  it('the struct DEFINITION beats a forward declaration from an earlier CU', () => {
    // main.c's CU (linked first) has only `struct FwdPay;` — DW_AT_declaration, no
    // members. util.c's CU defines it. First-CU-wins would report an empty layout.
    const fwd = agbcc.struct('FwdPay');
    expect(fwd?.size).toBe(8);
    expect(fwd?.members).toEqual([
      { name: 'amount', offset: 0, size: 4, signed: true },
      { name: 'currency', offset: 4, size: 2, signed: true },
    ]);
  });

  it('a pointee behind the forward declaration sizes from the definition', () => {
    expect(agbcc.types.variableShape('g_fwd_ptr')).toMatchObject({
      kind: 'pointer',
      pointee: expect.objectContaining({ structName: 'FwdPay', size: 8 }),
    });
  });

  it('prototyped is read on modern-gcc DWARF-2 (DW_FORM_flag)', () => {
    expect(macinfoObj.types.functionSignature('main')?.prototyped).toBe(true);
    expect(macinfoObj.types.functionSignature('add')?.prototyped).toBe(true);
  });
});

describe('3. the 0xffffffff upper bound means zero-length, never 2^32 elements', () => {
  it('a zero-length global array has no length, like a flexible member', () => {
    expect(agbcc.types.variableShape('g_zero')).toEqual({
      kind: 'array',
      elemSize: 1,
      elemSigned: false,
      length: null,
      volatile: false,
      const: false,
    });
  });

  it('a zero-length trailing member reads exactly like modern flexible arrays', () => {
    // Mirrors the devkitarm-min `Blob.data` pin: stride reported, size and length not.
    const data = agbcc.struct('Flex')!.members.find((m) => m.name === 'data')!;
    expect(data).toEqual({ name: 'data', offset: 4, size: null, signed: null, elemSize: 1, elemSigned: false });
    expect(agbcc.resolveVariable('g_flex.data')).toBeNull();
  });

  it('control: initializer-sized arrays keep their real bounds', () => {
    // agbcc DOES size these (even the forward-declared-then-defined static), so a fix
    // for the -1 encoding must not cost them.
    expect(agbcc.types.variableShape('g_init_table')).toMatchObject({ kind: 'array', elemSize: 2, length: 4 });
    expect(agbcc.types.variableShape('g_fwd_sized_table')).toMatchObject({ kind: 'array', elemSize: 2, length: 6 });
  });
});

describe('4. an unsized extern array is not [1]', () => {
  it('a DECLARATION with upper_bound 0 reports length null', () => {
    // g_ext_table is defined only in crt0.s: no C compilation ever saw its size, and
    // the DWARF's [1] is the encoding's ambiguity, not a fact about the table.
    expect(agbcc.types.variableShape('g_ext_table')).toEqual({
      kind: 'array',
      elemSize: 2,
      elemSigned: true,
      length: null,
      volatile: false,
      const: true,
    });
  });

  it('control: a DEFINED one-element array keeps length 1', () => {
    expect(agbcc.types.variableShape('g_one_def')).toEqual({
      kind: 'array',
      elemSize: 2,
      elemSigned: true,
      length: 1,
      volatile: false,
      const: false,
    });
  });
});
