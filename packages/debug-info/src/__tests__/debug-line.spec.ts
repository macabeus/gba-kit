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

import { type LineRow, parseDebugLine } from '../debug-line.js';
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
  it('keeps the rest of the section when a DWARF 5 unit comes first', () => {
    // DWARF 5 rewrote the header (address_size/segment_selector_size, and typed
    // directory/file entry formats), so its bytes are not a v2–v4 header.
    expect(rowsOf(concat(unmodellableUnit(5), section))).toEqual(pristine);
  });

  it('keeps the rest of the section when a 64-bit DWARF unit comes first', () => {
    expect(rowsOf(concat(dwarf64Unit(), section))).toEqual(pristine);
  });

  it('steps over zero-word padding between units', () => {
    const pad = new Uint8Array(8); // two zero unit_lengths
    expect(rowsOf(concat(pad, section))).toEqual(pristine);
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
