/**
 * Address → what holds it, on the real agbcc (DWARF 2) and devkitARM (DWARF 4+)
 * ELFs. The two test projects are byte-for-byte the same C, so every case here runs
 * against both dialects and any answer that depends on the producer shows up as a
 * disagreement between them.
 *
 * The tier is what most of this pins. `addressToSymbol` names a symbol for any
 * address whatsoever, and on a decomp most of those names are the nearest thing
 * below rather than the thing the address is in; telling the two apart is the
 * difference between a result a user can act on and one that quietly misleads.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DebugInfo } from '../debug-info.js';
import { LineTable } from '../debug-line.js';
import { ElfFile } from '../elf.js';
import { PointerIndex, type WordReader, placementAt } from '../placement.js';
import { SHN_ABS, STB_GLOBAL, STT_NOTYPE, STT_OBJECT, SymbolIndex } from '../symbols.js';
import { TypeIndex } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECTS = {
  agbcc: join(here, '..', '..', 'test-projects', 'agbcc-min', 'build', 'min.elf'),
  devkitarm: join(here, '..', '..', 'test-projects', 'devkitarm-min', 'build', 'min.elf'),
} as const;

describe.each(Object.entries(PROJECTS))('placementAt on %s', (_name, path) => {
  const info = DebugInfo.fromElf(new Uint8Array(readFileSync(path)));
  /** every address is derived from the ELF, never written down */
  const at = (symbol: string, offset = 0): number => {
    const address = info.symbols.symbolToAddress(symbol);
    if (address === null) {
      throw new Error(`the test project has no ${symbol}`);
    }
    return address + offset;
  };

  it('names a struct member, and the member of a nested struct', () => {
    // Probe: tag @0, count @4, flags @8, name @10 (6), ptr @16, inner @20 (x@20 y@24), tail @28
    expect(placementAt(info, at('g_probe', 4), 4).path).toBe('g_probe.count');
    expect(placementAt(info, at('g_probe', 20), 4).path).toBe('g_probe.inner.x');
    expect(placementAt(info, at('g_probe', 24), 2).path).toBe('g_probe.inner.y');
    expect(placementAt(info, at('g_probe', 28), 4).path).toBe('g_probe.tail');
  });

  it('follows a pointer to memory no object declares, and only where the captures agree', () => {
    // `g_probe.ptr` is an `int *`: what it points at has no symbol of its own, and exists
    // only while the pointer holds that value — which is why a static lookup never names it
    const held = at('g_probe', 16);
    const target = at('g_grid3'); // any address a declared object does not cover
    const reads =
      (value: number): WordReader =>
      (address) =>
        address === held ? value : 0;

    const pointed = target + 0x1000;
    const agreed = new PointerIndex(info, [reads(pointed), reads(pointed)]);
    const found = placementAt(info, pointed, 4, agreed);
    expect(found.tier).toBe('through');
    expect(found.path).toBe('*g_probe.ptr');
    expect(found.through).toBe('g_probe.ptr');

    // a pointer that moved between the captures names other memory in each column
    const moved = new PointerIndex(info, [reads(pointed), reads(pointed + 4)]);
    expect(placementAt(info, pointed, 4, moved).tier).toBe('unattributed');
    // and a null pointer points at nothing, rather than at the bottom of memory
    expect(placementAt(info, 0, 4, new PointerIndex(info, [reads(0), reads(0)])).tier).toBe('unattributed');
  });

  it('prefers what the program declares to what a pointer happens to be aimed at', () => {
    const declared = at('g_probe', 4);
    const aimed = new PointerIndex(info, [() => declared, () => declared]);
    // an object that says it is here outranks a pointer that is merely pointing here
    expect(placementAt(info, declared, 4, aimed).path).toBe('g_probe.count');
  });

  // only one of the two projects declares a pointer to a type it never defines
  it.skipIf(info.symbols.symbolToAddress('g_fwd_ptr') === null)(
    'leaves a pointer whose target the program never completes',
    () => {
      // `struct FwdPay;` is declared and never defined, so there is no size to walk into
      // and nothing to name past the pointer itself
      const fwd = at('g_fwd_ptr');
      const index = new PointerIndex(info, [() => fwd + 0x2000, () => fwd + 0x2000]);
      // whatever the static lookup makes of that address, no pointer was followed to it
      expect(placementAt(info, fwd + 0x2000, 4, index).tier).not.toBe('through');
    },
  );

  it('names an array element, inside a struct and at the top', () => {
    expect(placementAt(info, at('g_probe', 12), 1).path).toBe('g_probe.name[2]');
    expect(placementAt(info, at('g_rom_table', 2), 2).path).toBe('g_rom_table[1]');
  });

  it('names an element of a multi-dimensional array by every subscript', () => {
    // g_grid3 is unsigned char[2][3][4]: element [1][2][3] is at 1*12 + 2*4 + 3
    expect(placementAt(info, at('g_grid3', 12 + 8 + 3), 1).path).toBe('g_grid3[1][2][3]');
    // Grid: id @0 (4), cells @4 as [2][3] of u16, so cells[1][2] is at 4 + 1*6 + 2*2
    expect(placementAt(info, at('g_grid', 4 + 6 + 4), 2).path).toBe('g_grid.cells[1][2]');
  });

  it('ends a walk at the bitfield the address is in, with the bits to read it by', () => {
    // hearts bits 0-1, stars 2-4, cross 5-11, wide 12-15: byte 0 is hearts', byte 1 is wide's
    const first = placementAt(info, at('g_bits'), 1);
    expect(first.path).toBe('g_bits.hearts');
    expect(first.member?.bitSize).toBe(2);
    expect(first.base).toBe(at('g_bits'));
    expect(placementAt(info, at('g_bits', 1), 1).path).toBe('g_bits.wide');
    expect(placementAt(info, at('g_bits', 4), 4).path).toBe('g_bits.after');
  });

  it('a read wider than the object it lands in names where it begins and says it runs past', () => {
    const halfword = placementAt(info, at('g_probe', 8), 2);
    expect(halfword.path).toBe('g_probe.flags');
    expect(halfword.straddles).toBeUndefined();
    // the walk follows the first byte, so four bytes at a two-byte member are still that
    // member — and the caveat is what says the other half of the read is something else
    const word = placementAt(info, at('g_probe', 8), 4);
    expect(word.path).toBe('g_probe.flags');
    expect(word.base).toBe(at('g_probe', 8));
    expect(word.straddles).toBe(true);
  });

  it('says how far into the object it names an address is', () => {
    // a path is the same for every byte of what it names, and only `base` tells them apart
    const start = placementAt(info, at('g_probe', 4), 1);
    expect(start.path).toBe('g_probe.count');
    expect(start.base).toBe(at('g_probe', 4));
    const inside = placementAt(info, at('g_probe', 5), 1);
    expect(inside.path).toBe('g_probe.count');
    expect(inside.base).toBe(at('g_probe', 4));
  });

  it('calls a declared extent sized', () => {
    expect(placementAt(info, at('g_probe', 4), 4).tier).toBe('sized');
    expect(placementAt(info, at('g_counter'), 4).tier).toBe('sized');
  });
});

describe('placementAt on the ldscript-table idiom', () => {
  // only agbcc-min carries `extern const short g_ext_table[]` — a table defined outside
  // any C compilation, which is how a decomp declares one at a fixed address
  const info = DebugInfo.fromElf(new Uint8Array(readFileSync(PROJECTS.agbcc)));
  const at = (symbol: string, offset = 0): number => info.symbols.symbolToAddress(symbol)! + offset;

  it('descends an array nothing gave a length, and says the bound is a hypothesis', () => {
    const beyond = placementAt(info, at('g_ext_table', 6), 2);
    expect(beyond.path).toBe('g_ext_table[3]');
    expect(beyond.extrapolated).toBe(true);
    // nothing states there are four elements, so the containment is a guess too
    expect(beyond.tier).toBe('inferred');
  });

  it('a real one-element array keeps its bound, and element 0 of it is stated', () => {
    const stated = placementAt(info, at('g_one_def'), 2);
    expect(stated.path).toBe('g_one_def[0]');
    expect(stated.extrapolated).toBeUndefined();
    expect(stated.tier).toBe('sized');
  });
});

describe('placementAt on a symbol table a decomp produces', () => {
  /**
   * The shape that made this feature need tiers at all: a decomp's ELF places its RAM
   * with the linker, so it has no EWRAM symbols, and the nearest symbol below every
   * byte of EWRAM is an `SHN_ABS` constant at address 4 — 33 MB away, in no memory at
   * all. Naming an EWRAM byte after it would be the panel's most common answer and
   * always wrong.
   */
  function info(): DebugInfo {
    const symbols = new SymbolIndex(
      [
        { name: 'gNumMusicPlayers', address: 0x4, size: 0, type: STT_NOTYPE, bind: STB_GLOBAL, shndx: SHN_ABS },
        { name: 'gSized', address: 0x03000100, size: 0x40, type: STT_OBJECT, bind: STB_GLOBAL, shndx: 1 },
        { name: 'gUnsized', address: 0x03000200, size: 0, type: STT_OBJECT, bind: STB_GLOBAL, shndx: 1 },
      ],
      [{ addr: 0x03000000, end: 0x03008000, code: false }],
    );
    const elf = ElfFile.parse(new Uint8Array(readFileSync(PROJECTS.agbcc)));
    return new DebugInfo(elf, symbols, new LineTable([]), TypeIndex.fromElf(elf));
  }

  it('refuses to name an address after a symbol that is in another memory', () => {
    const placed = placementAt(info(), 0x02000818, 1);
    expect(placed.tier).toBe('unattributed');
    expect(placed.symbol).toBeUndefined();
    // the nearest symbol below it really is that one, which is exactly the problem
    expect(info().symbols.addressToSymbol(0x02000818)?.name).toBe('gNumMusicPlayers');
  });

  it('states a containment the ELF sized, and infers one it did not', () => {
    expect(placementAt(info(), 0x03000110, 4)).toMatchObject({
      tier: 'sized',
      symbol: { name: 'gSized', offset: 0x10 },
    });
    expect(placementAt(info(), 0x03000210, 4)).toMatchObject({
      tier: 'inferred',
      symbol: { name: 'gUnsized', offset: 0x10 },
    });
  });
});
