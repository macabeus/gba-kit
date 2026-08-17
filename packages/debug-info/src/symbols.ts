/**
 * ELF symbol table → function/object index with PC→function lookup.
 *
 * Works off `.symtab` regardless of DWARF, so PC→function resolution covers
 * every linked function (including `INCLUDE_ASM` stubs that have no DWARF).
 */
import { ElfFile } from './elf.js';
import { Cursor, cstrAt } from './reader.js';

export const STT_NOTYPE = 0;
export const STT_OBJECT = 1;
export const STT_FUNC = 2;

const STB_GLOBAL = 1; // st_info >> 4
const SHN_ABS = 0xfff1; // an absolute value, e.g. an ldscript `gFoo = 0x...;` global

export interface ElfSymbol {
  name: string;
  /** Address with the Thumb low bit cleared. */
  address: number;
  size: number;
  type: number;
}

export interface FunctionEntry {
  name: string;
  address: number;
  /** End address (exclusive). Uses st_size when present, else the next symbol. */
  end: number;
  /**
   * True when `end` came from the symbol's own `st_size` — the ELF stated the extent.
   * False when it was inferred from where the NEXT symbol starts, which is a guess
   * that is only as good as the symbol table is dense.
   *
   * This is not a detail. In a decomp ELF most symbols come from hand-written asm and
   * carry no size at all, so a lookup landing kilobytes past a function's real body
   * still resolves to it, with nothing in the answer to say the containment was never
   * established.
   */
  exact: boolean;
}

/** Address range of a loadable section, used to bound size-0 trailing symbols. */
interface SectionRange {
  addr: number;
  end: number;
}

export class SymbolIndex {
  readonly symbols: ElfSymbol[];
  /** Function entries sorted by address, for binary search. */
  readonly #functions: FunctionEntry[];
  /** Functions + data objects sorted by address, for addressToSymbol. */
  readonly #all: FunctionEntry[];
  readonly #byName = new Map<string, ElfSymbol>();

  constructor(symbols: ElfSymbol[], sections: SectionRange[] = []) {
    this.symbols = symbols;
    for (const s of symbols) {
      const existing = this.#byName.get(s.name);
      // First definition wins, EXCEPT a typed symbol (FUNC/OBJECT) always beats a
      // NOTYPE linker alias of the same name — otherwise an ldscript/boundary symbol
      // (e.g. `_end`) that happens to appear first would shadow the real function or
      // object's address.
      if (!existing || (existing.type === STT_NOTYPE && s.type !== STT_NOTYPE)) {
        this.#byName.set(s.name, s);
      }
    }

    // Functions only, for pcToFunction (its end-gaps are between functions).
    this.#functions = buildRanges(
      symbols.filter((s) => s.type === STT_FUNC),
      sections,
    );
    // Functions + data objects, for addressToSymbol (so a PC landing in a global
    // resolves to that STT_OBJECT, not just functions).
    this.#all = buildRanges(
      symbols.filter((s) => s.type === STT_FUNC || s.type === STT_OBJECT),
      sections,
    );
  }

  /** Build from an ELF's `.symtab` (+ its linked string table). */
  static fromElf(elf: ElfFile): SymbolIndex {
    const symtab = elf.section('.symtab');
    const data = elf.sectionData('.symtab');
    if (!symtab || !data) {
      return new SymbolIndex([]);
    }
    const strtab = elf.sectionDataByIndex(symtab.link) ?? new Uint8Array(0);

    const SYM_SIZE = 16; // Elf32_Sym
    const c = new Cursor(data, 0, elf.littleEndian);
    const symbols: ElfSymbol[] = [];
    for (let off = 0; off + SYM_SIZE <= data.length; off += SYM_SIZE) {
      const stName = c.u32At(off);
      const stValue = c.u32At(off + 4);
      const stSize = c.u32At(off + 8);
      const stInfo = c.u8At(off + 12);
      const type = stInfo & 0xf;
      const bind = stInfo >> 4;
      const shndx = c.u16At(off + 14);
      // Keep functions, data objects, and linker-defined absolute globals. The latter
      // — ldscript symbols like `gFoo = 0x03000000;` that place a struct at a fixed RAM
      // address, the norm in GBA decomp — are STT_NOTYPE/STB_GLOBAL with SHN_ABS, so
      // symbolToAddress can resolve them. Restricting to SHN_ABS excludes section-
      // relative NOTYPE markers (`_end`, `__bss_start`, `_edata`), which aren't globals.
      const isLinkerGlobal = type === STT_NOTYPE && bind === STB_GLOBAL && shndx === SHN_ABS;
      if (type !== STT_FUNC && type !== STT_OBJECT && !isLinkerGlobal) {
        continue;
      }
      const name = cstrAt(strtab, stName);
      if (name === '') {
        continue;
      }
      // Thumb function symbols may carry the low bit set; normalize to the even addr.
      const address = type === STT_FUNC ? stValue & ~1 : stValue;
      symbols.push({ name, address: address >>> 0, size: stSize, type });
    }

    // Loadable section bounds, so a trailing size-0 symbol's range can extend to
    // the end of its containing section.
    const sections: SectionRange[] = elf.sections
      .filter((s) => s.addr > 0 && s.size > 0)
      .map((s) => ({ addr: s.addr, end: s.addr + s.size }));
    return new SymbolIndex(symbols, sections);
  }

  symbolToAddress(name: string): number | null {
    const s = this.#byName.get(name);
    return s ? s.address : null;
  }

  /** The full symbol record for `name`, or null. */
  symbol(name: string): ElfSymbol | null {
    return this.#byName.get(name) ?? null;
  }

  /** The function whose `[address, end)` range contains `pc`, or null (gap / before first). */
  pcToFunction(pc: number): FunctionEntry | null {
    return findContaining(this.#functions, pc);
  }

  /**
   * Nearest enclosing symbol (function or data object) as `name+0xNN`, or null.
   *
   * `exact` says whether the ELF actually placed `addr` inside that symbol (the symbol
   * declared an `st_size` covering it) or whether the containment was inferred from
   * the gap to the next symbol — see {@link FunctionEntry.exact}. An inferred hit is a
   * usable hint and is not evidence; anything written down as fact should check it.
   */
  addressToSymbol(addr: number): { name: string; offset: number; exact: boolean } | null {
    const e = findContaining(this.#all, addr);
    return e ? { name: e.name, offset: addr - e.address, exact: e.exact } : null;
  }
}

/** Entry in `entries` whose `[address, end)` range contains `pc`, or null. */
function findContaining(entries: FunctionEntry[], pc: number): FunctionEntry | null {
  if (entries.length === 0 || pc < entries[0]!.address) {
    return null;
  }
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (entries[mid]!.address <= pc) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const e = entries[lo]!;
  return pc < e.end ? e : null;
}

/**
 * Sort symbols by address, collapse same-address aliases (preferring a meaningful
 * name, then a larger size), and compute each entry's exclusive end: its own
 * st_size, else the gap to the next symbol, else (a trailing size-0 symbol) the
 * end of its containing loadable section, else a minimal 2 bytes.
 */
function buildRanges(syms: ElfSymbol[], sections: SectionRange[]): FunctionEntry[] {
  const sorted = syms.filter((s) => s.name !== '').sort((a, b) => a.address - b.address);

  const chosen: ElfSymbol[] = [];
  for (const s of sorted) {
    const last = chosen[chosen.length - 1];
    if (last && last.address === s.address) {
      if (preferSymbol(s, last)) {
        chosen[chosen.length - 1] = s;
      }
      continue;
    }
    chosen.push(s);
  }

  return chosen.map((s, i) => {
    const next = chosen[i + 1];
    const end =
      s.size > 0
        ? s.address + s.size
        : next
          ? next.address
          : (sectionEndContaining(s.address, sections) ?? s.address + 2);
    return { name: s.name, address: s.address, end, exact: s.size > 0 };
  });
}

/** End of the loadable section containing `addr`, or undefined. */
function sectionEndContaining(addr: number, sections: SectionRange[]): number | undefined {
  for (const r of sections) {
    if (addr >= r.addr && addr < r.end) {
      return r.end;
    }
  }
  return undefined;
}

/**
 * A name that just encodes its own address is a placeholder, not a real name —
 * e.g. `sub_08014624`, `FUN_8014624`, `loc_8014624`. Detected generically by a
 * trailing hex run that parses to the symbol's address (any prefix), so it isn't
 * tied to one disassembler's convention.
 */
function addressEncodedInName(name: string, address: number): boolean {
  const m = /([0-9a-fA-F]{4,8})$/.exec(name);
  if (!m) {
    return false;
  }
  return parseInt(m[1]!, 16) >>> 0 === address >>> 0;
}

/** True if `candidate` is a better symbol for an address than `current`. */
function preferSymbol(candidate: ElfSymbol, current: ElfSymbol): boolean {
  const candPlaceholder = addressEncodedInName(candidate.name, candidate.address);
  const curPlaceholder = addressEncodedInName(current.name, current.address);
  if (candPlaceholder !== curPlaceholder) {
    return curPlaceholder;
  } // pick the meaningful one
  return candidate.size > current.size; // otherwise the one with more info
}
