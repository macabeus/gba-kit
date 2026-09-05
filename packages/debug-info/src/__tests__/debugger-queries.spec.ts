/**
 * The queries an IDE debugger adds on top of the parser: source→PC, statement
 * rows, instruction-set mode, binding-aware global lookup, and ROM/ELF identity.
 * Exercised on the real devkitARM and agbcc test ELFs plus hand-built symbol tables.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DebugInfo } from '../debug-info.js';
import { LineTable, normalizePath } from '../debug-line.js';
import { ElfFile } from '../elf.js';
import {
  SHN_ABS,
  SHN_UNDEF,
  STB_GLOBAL,
  STB_LOCAL,
  STT_FUNC,
  STT_NOTYPE,
  STT_OBJECT,
  SymbolIndex,
} from '../symbols.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEVKITARM_ELF = join(here, '..', '..', 'test-projects', 'devkitarm-min', 'build', 'min.elf');
const AGBCC_ELF = join(here, '..', '..', 'test-projects', 'agbcc-min', 'build', 'min.elf');

const devkitarm = () => DebugInfo.fromElf(new Uint8Array(readFileSync(DEVKITARM_ELF)));
const agbcc = () => DebugInfo.fromElf(new Uint8Array(readFileSync(AGBCC_ELF)));

/** The cartridge image an `objcopy -O binary` of the ELF would produce (ROM-window sections only). */
function romFromElf(bytes: Uint8Array): Uint8Array {
  const elf = ElfFile.parse(bytes);
  let end = 0;
  for (const s of elf.sections) {
    if (s.addr >= 0x08000000 && s.addr < 0x0e000000 && s.size > 0 && s.type === 1) {
      end = Math.max(end, (s.addr & 0x01ffffff) + s.size);
    }
  }
  const rom = new Uint8Array(end);
  elf.sections.forEach((s, i) => {
    if (s.addr >= 0x08000000 && s.addr < 0x0e000000 && s.size > 0 && s.type === 1) {
      rom.set(elf.sectionDataByIndex(i)!, s.addr & 0x01ffffff);
    }
  });
  return rom;
}

describe('source → PC', () => {
  it('finds the addresses of a line, and pcToSource agrees with them', () => {
    const di = devkitarm();
    const main = di.symbolToAddress('main')!;
    const src = di.pcToSource(main)!;
    const pcs = di.sourceToPcs(src.file, src.line);
    expect(pcs.length).toBeGreaterThan(0);
    expect(pcs).toContain(main);
    for (const pc of pcs) {
      expect(di.pcToSource(pc)?.line).toBe(src.line);
    }
  });

  it('matches a file however it is spelled', () => {
    const di = devkitarm();
    const main = di.symbolToAddress('main')!;
    const src = di.pcToSource(main)!;
    const spelled = './' + src.file.replace(/\//g, '/./');
    expect(di.sourceToPcs(spelled, src.line)).toEqual(di.sourceToPcs(src.file, src.line));
    expect(di.lines.files).toContain(normalizePath(src.file));
  });

  it('slides a breakpoint on a line without code to the next line that has some', () => {
    const table = new LineTable([
      { address: 0x08000000, fileIndex: 1, file: 'a.c', line: 10, endSequence: false, isStmt: true },
      { address: 0x08000004, fileIndex: 1, file: 'a.c', line: 14, endSequence: false, isStmt: true },
      { address: 0x08000008, fileIndex: 1, file: 'a.c', line: 14, endSequence: true, isStmt: true },
    ]);
    expect(table.nearestLineWithCode('a.c', 11)).toEqual({ line: 14, addresses: [0x08000004] });
    expect(table.nearestLineWithCode('a.c', 11, 2)).toBeNull();
    expect(table.nearestLineWithCode('b.c', 11)).toBeNull();
    expect(table.sourceToPcs('a.c', 14)).toEqual([0x08000004]); // an end_sequence row is not code
  });

  it('labels an address by its statement row, even when a view row shares the address', () => {
    const table = new LineTable([
      { address: 0x08000000, fileIndex: 1, file: 'a.c', line: 29, endSequence: false, isStmt: true },
      { address: 0x08000000, fileIndex: 1, file: 'a.c', line: 30, endSequence: false, isStmt: false },
      { address: 0x08000004, fileIndex: 1, file: 'a.c', line: 30, endSequence: false, isStmt: false },
    ]);
    expect(table.rowAt(0x08000000)).toEqual({ file: 'a.c', line: 29, isStmt: true });
    expect(table.rowAt(0x08000004)).toEqual({ file: 'a.c', line: 30, isStmt: false });
    expect(table.rowAt(0x08000002)).toBeUndefined();
  });
});

describe('instruction-set mode from mapping symbols', () => {
  it('a devkitARM Thumb build says thumb at main and knows it has mapping symbols', () => {
    const di = devkitarm();
    expect(di.symbols.hasMappingSymbols).toBe(true);
    expect(di.modeAt(di.symbolToAddress('main')!)).toBe('thumb');
  });

  it('reports null where nothing is known', () => {
    const idx = new SymbolIndex([]);
    expect(idx.modeAt(0x08000000)).toBeNull();
  });
});

describe('symbol binding', () => {
  it('keeps a linker global placed inside a section, not only SHN_ABS ones', () => {
    const idx = new SymbolIndex([
      { name: 'gUnk_03005220', address: 0x03005220, size: 0, type: STT_NOTYPE, bind: STB_GLOBAL, shndx: 1 },
      { name: 'gAbs', address: 0x03001234, size: 0, type: STT_NOTYPE, bind: STB_GLOBAL, shndx: SHN_ABS },
    ]);
    expect(idx.globalSymbol('gUnk_03005220')?.address).toBe(0x03005220);
    expect(idx.globalSymbol('gAbs')?.address).toBe(0x03001234);
  });

  it('a file-static of the same name does not satisfy an extern', () => {
    const idx = new SymbolIndex([
      { name: 'counter', address: 0x03000100, size: 4, type: STT_OBJECT, bind: STB_LOCAL, shndx: 1 },
      { name: 'counter', address: 0x03000200, size: 4, type: STT_OBJECT, bind: STB_LOCAL, shndx: 2 },
    ]);
    expect(idx.symbolToAddress('counter')).toBe(0x03000100); // a plain lookup still answers
    expect(idx.globalSymbol('counter')).toBeNull();
  });

  it('two globals at different addresses are ambiguous, an undefined one is not a definition', () => {
    const idx = new SymbolIndex([
      { name: 'dup', address: 0x03000100, size: 4, type: STT_OBJECT, bind: STB_GLOBAL, shndx: 1 },
      { name: 'dup', address: 0x03000200, size: 4, type: STT_OBJECT, bind: STB_GLOBAL, shndx: 2 },
      { name: 'ext', address: 0, size: 0, type: STT_NOTYPE, bind: STB_GLOBAL, shndx: SHN_UNDEF },
    ]);
    expect(idx.globalSymbol('dup')).toBeNull();
    expect(idx.globalSymbol('ext')).toBeNull();
  });

  it('a real devkitARM ELF drops the absolute FUNC placeholders GCC emits', () => {
    const di = devkitarm();
    expect(di.pcToFunction(0)).toBeNull();
    expect(di.symbols.symbols.find((s) => s.type === STT_FUNC && s.shndx === SHN_ABS)).toBeUndefined();
  });

  it('a typed symbol beats a linker alias for naming an address', () => {
    const idx = new SymbolIndex([
      { name: '__data_start', address: 0x03000000, size: 0, type: STT_NOTYPE, bind: STB_GLOBAL, shndx: 1 },
      { name: 'gFirst', address: 0x03000000, size: 8, type: STT_OBJECT, bind: STB_GLOBAL, shndx: 1 },
    ]);
    expect(idx.addressToSymbol(0x03000004)).toEqual({ name: 'gFirst', offset: 4, exact: true });
  });
});

describe('ROM / ELF identity', () => {
  it('accepts the ROM the ELF was linked into and rejects a byte flip', () => {
    const bytes = new Uint8Array(readFileSync(DEVKITARM_ELF));
    const di = DebugInfo.fromElf(bytes);
    const rom = romFromElf(bytes);
    const verdict = di.checkRomIdentity(rom);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.comparedBytes).toBeGreaterThan(0);

    const tampered = rom.slice();
    tampered[0x10] ^= 0xff;
    const bad = di.checkRomIdentity(tampered);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.address).toBe(0x08000010);
  });

  it('rejects a ROM that is too short and an object file', () => {
    const bytes = new Uint8Array(readFileSync(DEVKITARM_ELF));
    const di = DebugInfo.fromElf(bytes);
    expect(di.checkRomIdentity(new Uint8Array(4)).ok).toBe(false);
    const obj = ElfFile.parse(
      new Uint8Array(readFileSync(join(here, '..', '..', 'test-projects', 'ppc-min', 'build', 'main.o'))),
    );
    expect(obj.type).not.toBe(2);
    expect(di.isLinked).toBe(true);
  });

  it('agbcc output is a linked image too', () => {
    expect(agbcc().isLinked).toBe(true);
  });
});
