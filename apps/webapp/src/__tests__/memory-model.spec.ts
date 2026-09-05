/**
 * Memory rows over what the bus actually maps: the zeros a partial read fills
 * in for SRAM without a chip, or past the ROM's end, are drawn as absent.
 */
import { describe, expect, it } from 'vitest';

import { memoryRows } from '../pages/debug/memory-model';
import { bootSession, fixture } from './fixtures';

const hexOf = (rows: ReturnType<typeof memoryRows>): string[] => rows.flatMap((r) => r.cells.map((c) => c.hex));

describe('memoryRows', () => {
  it('lays mapped bytes out as hex and ASCII, at ascending row addresses', () => {
    const data = new Uint8Array([0x41, 0x00, 0x7f, 0x20, 0x7e, 0xff, 0x30, 0x0a]);
    const rows = memoryRows({ data, readable: 8 }, 0x03000000, 4, 2);
    expect(rows.map((r) => r.address)).toEqual([0x03000000, 0x03000004]);
    expect(hexOf(rows)).toEqual(['41', '00', '7f', '20', '7e', 'ff', '30', '0a']);
    expect(rows.map((r) => r.cells.map((c) => c.ascii).join(''))).toEqual(['A.. ', '~.0.']);
    expect(rows.every((r) => r.cells.every((c) => c.mapped))).toBe(true);
  });

  it('draws every byte past `readable` as absent, not as 00', () => {
    const rows = memoryRows({ data: new Uint8Array(8), readable: 3 }, 0, 4, 2);
    expect(hexOf(rows)).toEqual(['00', '00', '00', '--', '--', '--', '--', '--']);
    expect(rows[0]!.cells.map((c) => c.ascii).join('')).toBe('... ');
    expect(rows[1]!.cells.map((c) => c.mapped)).toEqual([false, false, false, false]);
  });

  it('shows SRAM without a backup chip and the space after a ROM as unmapped', async () => {
    const session = await bootSession('thumb-O0');
    const romEnd = 0x08000000 + fixture('thumb-O0').rom.length;

    const sram = memoryRows(session.readMemory(0x0e000000, 128), 0x0e000000, 16, 8);
    expect(hexOf(sram).every((h) => h === '--')).toBe(true);

    const tail = memoryRows(session.readMemory(romEnd - 16, 128), romEnd - 16, 16, 8);
    expect(
      hexOf(tail)
        .slice(0, 16)
        .every((h) => h !== '--'),
    ).toBe(true);
    expect(
      hexOf(tail)
        .slice(16)
        .every((h) => h === '--'),
    ).toBe(true);

    const iwram = memoryRows(session.readMemory(0x03000000, 128), 0x03000000, 16, 8);
    expect(hexOf(iwram).every((h) => h !== '--')).toBe(true);
  });
});
