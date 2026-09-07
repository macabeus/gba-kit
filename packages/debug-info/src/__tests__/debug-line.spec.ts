/**
 * `.debug_line` section-walking contract.
 *
 * The line table is a *concatenation* of independent units, so the parser's job is
 * as much finding the next unit as decoding one. These tests take the real DWARF-2
 * bytes agbcc (GCC 2.95) emitted for `test-projects/agbcc-min` and perturb the
 * section the way real producers do, asserting the decoded rows never change and
 * that no perturbation costs more than the unit it belongs to.
 *
 * The load-bearing case is the first one: agbcc sizes a unit by *predicting* the
 * encoded length of each statement, and mispredicts, so `unit_length` can stop a
 * few bytes short of the program it describes (in pokeemerald 28 of 303 units, by
 * 1–4 bytes and one by 51). Clamping to the declared end leaves the cursor
 * mid-statement, and the next unit's header is then read as line-program bytes —
 * from there a walk runs off the section and every row after it is lost. The
 * DW_LNE_end_sequence terminator, not the declared length, is what ends a unit.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { type LineRow, LineTable, parseDebugLine } from '../debug-line.js';
import { ElfFile } from '../elf.js';

const here = dirname(fileURLToPath(import.meta.url));
const elfPath = join(here, '..', '..', 'test-projects', 'agbcc-min', 'build', 'min.elf');

const elf = ElfFile.parse(new Uint8Array(readFileSync(elfPath)));
/** Real agbcc (GCC 2.95) DWARF-2 line table: two units (main.c, util.c). */
const section = elf.sectionData('.debug_line')!;
const pristine = parseDebugLine(section).rows;

const u32At = (bytes: Uint8Array, off: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint32(off, true);
const setU32 = (bytes: Uint8Array, off: number, v: number): void =>
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(off, v, true);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A unit header we deliberately cannot decode, with a valid `unit_length`. */
function unmodellableUnit(version: number, body = 24): Uint8Array {
  const unit = new Uint8Array(4 + 2 + body);
  const view = new DataView(unit.buffer);
  view.setUint32(0, 2 + body, true); // unit_length covers everything after itself
  view.setUint16(4, version, true);
  unit.fill(0xaa, 6); // header we never read
  return unit;
}

/**
 * A DWARF 5 unit whose header is walkable all the way to the directory table, which
 * then describes its entries with a form no reader can size — the one shape that
 * reaches `readV5Tables`' null return.
 */
function unreadableEntryFormatUnit(): Uint8Array {
  const header = [
    1, // minimum_instruction_length
    1, // maximum_operations_per_instruction
    1, // default_is_stmt
    0xfb, // line_base (-5)
    14, // line_range
    1, // opcode_base: no standard_opcode_lengths follow
    // directory_entry_format: one (DW_LNCT_path, <a form with no encoding>) pair
    1,
    1,
    0x7f,
    1, // directories_count
    0, // where that directory's bytes would start
  ];
  const unit = new Uint8Array(12 + header.length);
  const view = new DataView(unit.buffer);
  view.setUint32(0, 8 + header.length, true); // unit_length
  view.setUint16(4, 5, true); // version
  unit[6] = 4; // address_size
  unit[7] = 0; // segment_selector_size
  view.setUint32(8, header.length, true); // header_length: the program starts past the tables
  unit.set(header, 12);
  return unit;
}

/** A 64-bit DWARF unit: the 0xffffffff escape then a 64-bit unit_length. */
function dwarf64Unit(body = 24): Uint8Array {
  const unit = new Uint8Array(4 + 8 + body);
  const view = new DataView(unit.buffer);
  view.setUint32(0, 0xffffffff, true);
  view.setUint32(4, body, true); // low half of the 64-bit length
  view.setUint32(8, 0, true); // high half
  unit.fill(0xaa, 12);
  return unit;
}

const rowsOf = (bytes: Uint8Array): LineRow[] => parseDebugLine(bytes).rows;

it('the fixture is the shape these tests assume (two units, real rows)', () => {
  expect(u32At(section, 0) + 4).toBeLessThan(section.length); // a second unit follows
  expect(pristine.length).toBeGreaterThan(20);
  expect(new Set(pristine.map((r) => r.file.split('/').pop()))).toEqual(new Set(['main.c', 'util.c']));
});

describe('a unit_length that undercounts its own line program (agbcc / GCC 2.95)', () => {
  // The producer bug is a *size misprediction*, so the bytes are correct and only
  // the length field is short: shortening it must change nothing we decode.
  it.each([1, 2, 3, 4, 7])('recovers when the first unit is declared %d bytes short', (missing) => {
    const short = section.slice();
    setU32(short, 0, u32At(short, 0) - missing);

    // The whole point: the *following* unit is still found, so no rows are lost.
    expect(rowsOf(short)).toEqual(pristine);
  });

  it('recovers on the last unit too (nothing follows it)', () => {
    const lastStart = 4 + u32At(section, 0);
    const short = section.slice();
    setU32(short, lastStart, u32At(short, lastStart) - 3);

    expect(rowsOf(short)).toEqual(pristine);
  });
});

describe('units we cannot decode are skipped by their own unit_length', () => {
  it('keeps the rest of the section when a unit of a later version comes first', () => {
    expect(rowsOf(concat(unmodellableUnit(6), section))).toEqual(pristine);
  });

  it('keeps the rest of the section when a header_length points past the unit', () => {
    // Version 5 with garbage after it: the header length lands outside the unit, so it is skipped whole.
    expect(rowsOf(concat(unmodellableUnit(5), section))).toEqual(pristine);
  });

  it('keeps the rest of the section when a DWARF 5 unit’s tables cannot be read', () => {
    // A well-formed v5 header whose directory table is described by a form this reader
    // cannot size: the file table is unknowable, so the unit is skipped by its length.
    expect(rowsOf(concat(unreadableEntryFormatUnit(), section))).toEqual(pristine);
  });

  it('keeps the rest of the section when a 64-bit DWARF unit comes first', () => {
    expect(rowsOf(concat(dwarf64Unit(), section))).toEqual(pristine);
  });

  it('steps over zero-word padding between units', () => {
    const pad = new Uint8Array(8); // two zero unit_lengths
    expect(rowsOf(concat(pad, section))).toEqual(pristine);
  });
});

describe('a DWARF 5 line program', () => {
  // The assembler of a modern toolchain emits a version 5 unit for a `.s` file even
  // when the C units next to it are version 3: the debug-core fixture links both.
  const fixture = join(here, '..', '..', '..', 'debug-core', 'test-fixtures', 'build', 'thumb-O2.elf');
  const mixed = ElfFile.parse(new Uint8Array(readFileSync(fixture)));
  const line = mixed.sectionData('.debug_line')!;
  const strings = { lineStr: mixed.sectionData('.debug_line_str'), str: mixed.sectionData('.debug_str') };

  it('reads the entry-format tables, with names from .debug_line_str', () => {
    const table = parseDebugLine(line, true, strings);
    expect(table.files).toEqual(expect.arrayContaining(['source/start.s', 'source/main.c', 'source/util.c']));
    expect(table.sourceToPcs('source/start.s', 10)).toEqual([0x08000000]);
    expect(table.sourceToPcs('source/start.s', 14)).toEqual([0x080000c4, 0x08000100]);
    expect(table.pcToSource(0x080000c4)).toMatchObject({ file: 'source/start.s', line: 14 });
    expect(table.rowAt(0x080000c4)).toMatchObject({ line: 14, isStmt: true });
  });

  it('lists the lines of a file that have code, as sourceToPcs answers them', () => {
    const table = parseDebugLine(line, true, strings);
    const lines = table.linesWithCode('source/main.c');
    expect(lines.length).toBeGreaterThan(10);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    const byQuery = [];
    for (let l = 1; l <= 200; l++) {
      if (table.sourceToPcs('source/main.c', l).length > 0) {
        byQuery.push(l);
      }
    }
    expect(lines).toEqual(byQuery);
    expect(table.linesWithCode('./source/main.c')).toEqual(lines); // matched normalized, as sourceToPcs is
    expect(table.linesWithCode('source/nowhere.c')).toEqual([]);
  });

  it('still decodes the rows without the string sections, with placeholder names', () => {
    const rows = parseDebugLine(line).rows.filter((r) => r.address === 0x080000c4 && !r.endSequence);
    expect(rows.length).toBe(1);
    expect(rows[0]!.line).toBe(14);
    expect(rows[0]!.file).toMatch(/^<str \d+>/);
  });
});

it('finds the program by header_length, not by walking the file table', () => {
  // Insert padding between the end of the file-name table and the program start,
  // growing header_length (and unit_length) to match — exactly what an unmodelled
  // header field would look like. A parser that starts the program where the file
  // table happened to end would run the padding as opcodes.
  const pad = 6;
  const programStart = 10 + u32At(section, 6);
  const grown = concat(section.slice(0, programStart), new Uint8Array(pad).fill(0xaa), section.slice(programStart));
  setU32(grown, 0, u32At(grown, 0) + pad); // unit_length
  setU32(grown, 6, u32At(grown, 6) + pad); // header_length

  expect(rowsOf(grown)).toEqual(pristine);
});

describe('a section that cannot be walked degrades instead of throwing', () => {
  // parseDebugLine is the only thing standing between a hostile .debug_line and
  // DebugInfo.fromElf, which must still deliver symbols and types. It reports what
  // it decoded and stops — it never throws, so callers need no rescue wrapper.
  it('keeps every row of the complete units when the last unit is truncated', () => {
    const cut = section.slice(0, section.length - 12);
    const rows = rowsOf(cut);

    const fromUnitOne = (rs: LineRow[]) => rs.filter((r) => r.file.endsWith('main.c'));
    expect(fromUnitOne(rows)).toEqual(fromUnitOne(pristine)); // unit 1 is untouched
    expect(rows.length).toBeLessThan(pristine.length); // unit 2 loses its cut-off tail
  });

  it('returns no rows for garbage, and terminates', () => {
    const garbage = new Uint8Array(4096);
    for (let i = 0; i < garbage.length; i++) {
      garbage[i] = (i * 37) & 0xff;
    }
    expect(() => rowsOf(garbage)).not.toThrow();
  });

  it('decodes what it can of a unit whose length runs past the section', () => {
    const overlong = section.slice(0, 64); // unit 1 claims 261 bytes; 64 are here
    const rows = rowsOf(overlong);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual(pristine.slice(0, rows.length)); // real rows, no invented ones
  });

  it('handles an empty section', () => {
    expect(rowsOf(new Uint8Array(0))).toEqual([]);
  });
});

describe('one address per run of rows for a line', () => {
  // Hand-built rows: what a producer emits for a line the optimizer split, where the
  // first row of a piece is mid-expression (is_stmt=0) and the stop is the next one.
  const row = (address: number, line: number, isStmt: boolean): LineRow => ({
    address,
    fileIndex: 1,
    file: 'main.c',
    line,
    endSequence: false,
    isStmt,
  });
  const table = new LineTable([
    row(0x100, 42, false),
    row(0x104, 42, true),
    row(0x108, 50, true),
    row(0x10c, 42, true),
    row(0x110, 60, false),
    { ...row(0x114, 60, true), endSequence: true },
  ]);

  it('records the run’s first statement row, not its first row', () => {
    expect(table.sourceToPcs('main.c', 42)).toEqual([0x104, 0x10c]);
  });

  it('gives a line whose every row is a non-statement no code at all', () => {
    expect(table.sourceToPcs('main.c', 60)).toEqual([]);
    expect(table.linesWithCode('main.c')).toEqual([42, 50]);
  });
});
