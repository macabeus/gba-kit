import { describe, expect, it } from 'vitest';

import { STT_FUNC, STT_NOTYPE, STT_OBJECT, SymbolIndex } from '../symbols.js';

/**
 * Pure SymbolIndex logic, built from typed symbols directly (no ELF byte
 * fixtures). End-to-end parsing of a real `.symtab` is covered by
 * real-projects.spec.ts. These cover behaviours the minimal projects don't
 * naturally produce — range resolution and the address-encoded-alias preference.
 */
describe('SymbolIndex', () => {
  it('resolves PC ranges using st_size when present', () => {
    const idx = new SymbolIndex([
      { name: 'A', address: 0x100, size: 0x10, type: STT_FUNC },
      { name: 'B', address: 0x200, size: 0x08, type: STT_FUNC },
    ]);
    expect(idx.pcToFunction(0x100)?.name).toBe('A');
    expect(idx.pcToFunction(0x10f)?.name).toBe('A');
    expect(idx.pcToFunction(0x110)).toBeNull(); // past A's size, before B
    expect(idx.pcToFunction(0x205)?.name).toBe('B');
    expect(idx.pcToFunction(0x208)).toBeNull();
    expect(idx.pcToFunction(0x50)).toBeNull(); // before first
  });

  it('falls back to the next symbol when size is 0', () => {
    const idx = new SymbolIndex([
      { name: 'A', address: 0x100, size: 0, type: STT_FUNC },
      { name: 'B', address: 0x140, size: 0, type: STT_FUNC },
    ]);
    expect(idx.pcToFunction(0x13f)?.name).toBe('A');
    expect(idx.pcToFunction(0x140)?.name).toBe('B');
  });

  it('addressToSymbol reports name + offset', () => {
    const idx = new SymbolIndex([{ name: 'Foo', address: 0x800, size: 0x20, type: STT_FUNC }]);
    expect(idx.addressToSymbol(0x80a)).toEqual({ name: 'Foo', offset: 0xa, exact: true });
  });

  it('addressToSymbol marks a containment it INFERRED, so a guess cannot pass as a fact', () => {
    // `asm` carries no st_size — the norm for a decomp's hand-written functions — so its
    // extent is only "wherever the next symbol starts". `sized` states its own.
    const idx = new SymbolIndex([
      { name: 'sized', address: 0x100, size: 0x10, type: STT_FUNC },
      { name: 'asm', address: 0x200, size: 0, type: STT_FUNC },
      { name: 'next', address: 0x900, size: 0x10, type: STT_FUNC },
    ]);
    expect(idx.addressToSymbol(0x108)).toEqual({ name: 'sized', offset: 8, exact: true });
    // 0x600 is 1 KB past anything the ELF actually attributes to `asm`. It still
    // resolves — a useful hint — but says it is a guess.
    expect(idx.addressToSymbol(0x600)).toEqual({ name: 'asm', offset: 0x400, exact: false });
  });

  it('addressToSymbol resolves data (STT_OBJECT) symbols, not only functions', () => {
    const idx = new SymbolIndex([
      { name: 'fn', address: 0x100, size: 0x10, type: STT_FUNC },
      { name: 'gState', address: 0x03000000, size: 0x20, type: STT_OBJECT },
    ]);
    expect(idx.addressToSymbol(0x03000004)).toEqual({ name: 'gState', offset: 4, exact: true });
    expect(idx.pcToFunction(0x03000004)).toBeNull(); // data is not a function
    expect(idx.addressToSymbol(0x03000020)).toBeNull(); // past the object's size
  });

  it('extends a trailing size-0 symbol to its section end, not a single instruction', () => {
    const idx = new SymbolIndex(
      [{ name: 'last', address: 0x08000000, size: 0, type: STT_FUNC }],
      [{ addr: 0x08000000, end: 0x08000100 }],
    );
    expect(idx.pcToFunction(0x08000080)?.name).toBe('last'); // 0x80 into the section
    expect(idx.pcToFunction(0x08000100)).toBeNull(); // past the containing section
  });

  it('prefers the meaningful name over an address-encoded alias at the same address', () => {
    // Order shouldn't matter: the placeholder is collapsed away either way.
    const a = new SymbolIndex([
      { name: 'sub_08014624', address: 0x08014624, size: 0x80, type: STT_FUNC },
      { name: 'PlayerRespawnOrDeath', address: 0x08014624, size: 0x80, type: STT_FUNC },
    ]);
    expect(a.pcToFunction(0x0801466a)?.name).toBe('PlayerRespawnOrDeath');

    const b = new SymbolIndex([
      { name: 'PlayerRespawnOrDeath', address: 0x08014624, size: 0x80, type: STT_FUNC },
      { name: 'FUN_08014624', address: 0x08014624, size: 0x80, type: STT_FUNC },
    ]);
    expect(b.pcToFunction(0x0801466a)?.name).toBe('PlayerRespawnOrDeath');
  });

  it('symbolToAddress prefers a real symbol over a same-named NOTYPE linker alias, in either order', () => {
    // A NOTYPE boundary/ldscript symbol must never shadow a real FUNC/OBJECT of the
    // same name, regardless of which comes first in .symtab.
    const notypeFirst = new SymbolIndex([
      { name: 'gThing', address: 0x02000000, size: 0, type: STT_NOTYPE },
      { name: 'gThing', address: 0x03001234, size: 0x40, type: STT_OBJECT },
    ]);
    expect(notypeFirst.symbolToAddress('gThing')).toBe(0x03001234);

    const notypeSecond = new SymbolIndex([
      { name: 'gThing', address: 0x03001234, size: 0x40, type: STT_OBJECT },
      { name: 'gThing', address: 0x02000000, size: 0, type: STT_NOTYPE },
    ]);
    expect(notypeSecond.symbolToAddress('gThing')).toBe(0x03001234);

    // A NOTYPE symbol with no typed namesake still resolves (the ldscript-global case).
    const lone = new SymbolIndex([{ name: 'gAbs', address: 0x03001234, size: 0, type: STT_NOTYPE }]);
    expect(lone.symbolToAddress('gAbs')).toBe(0x03001234);
  });
});
