/**
 * ELF symbol table → function/object index with PC→function lookup.
 *
 * Works off `.symtab` regardless of DWARF, so PC→function resolution covers
 * every linked function (including `INCLUDE_ASM` stubs that have no DWARF).
 */
import { ElfFile, SHF_EXECINSTR } from './elf.js';
import { Cursor, cstrAt } from './reader.js';

export const STT_NOTYPE = 0;
export const STT_OBJECT = 1;
export const STT_FUNC = 2;

export const STB_LOCAL = 0;
export const STB_GLOBAL = 1; // st_info >> 4
export const STB_WEAK = 2;

export const SHN_UNDEF = 0;
export const SHN_ABS = 0xfff1; // an absolute value, e.g. an ldscript `gFoo = 0x...;` global
export const SHN_COMMON = 0xfff2;

export interface ElfSymbol {
  name: string;
  /** Address with the Thumb low bit cleared. */
  address: number;
  size: number;
  type: number;
  /**
   * `STB_LOCAL` / `STB_GLOBAL` / `STB_WEAK`. A debugger joining a C `extern`
   * declaration to storage must only accept a global: a file-static with the same
   * spelling in another translation unit is a different object. Defaults to global
   * when absent.
   */
  bind?: number;
  /** Section header index, or `SHN_ABS` / `SHN_UNDEF` / `SHN_COMMON`. Defaults to a defined section. */
  shndx?: number;
}

/** What the instruction set is at an address, from GNU `$a` / `$t` / `$d` mapping symbols. */
export type IsaMode = 'arm' | 'thumb' | 'data';

/** The two of those an instruction can be decoded as. */
export type CodeIsa = Exclude<IsaMode, 'data'>;

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
  /** the section is marked executable, so its addresses can hold code */
  code: boolean;
}

interface MappingSymbol {
  address: number;
  mode: IsaMode;
}

export class SymbolIndex {
  readonly symbols: ElfSymbol[];
  /** Function entries sorted by address, for binary search. */
  readonly #functions: FunctionEntry[];
  /** Functions + data objects sorted by address, for addressToSymbol. */
  readonly #all: FunctionEntry[];
  readonly #byName = new Map<string, ElfSymbol>();
  /** Every symbol of a name, for binding-aware lookups. */
  readonly #allByName = new Map<string, ElfSymbol[]>();
  /** `$a` / `$t` / `$d` mapping symbols sorted by address. */
  readonly #mappings: MappingSymbol[];
  readonly #executable: SectionRange[];

  constructor(symbols: ElfSymbol[], sections: SectionRange[] = [], mappings: MappingSymbol[] = []) {
    this.symbols = symbols;
    this.#executable = sections.filter((s) => s.code);
    for (const s of symbols) {
      const existing = this.#byName.get(s.name);
      // First definition wins, EXCEPT a typed symbol (FUNC/OBJECT) always beats a
      // NOTYPE linker alias of the same name — otherwise an ldscript/boundary symbol
      // (e.g. `_end`) that happens to appear first would shadow the real function or
      // object's address.
      if (!existing || (existing.type === STT_NOTYPE && s.type !== STT_NOTYPE)) {
        this.#byName.set(s.name, s);
      }
      const list = this.#allByName.get(s.name);
      if (list) {
        list.push(s);
      } else {
        this.#allByName.set(s.name, [s]);
      }
    }

    // Functions only, for pcToFunction (its end-gaps are between functions).
    this.#functions = buildRanges(
      symbols.filter((s) => s.type === STT_FUNC),
      sections,
    );
    // Functions + data, for addressToSymbol (so an address landing in a global
    // resolves to it, not just to functions). Linker-defined globals are included
    // because in a decomp they ARE the data globals: an ldscript `gFoo = 0x03000000;`
    // is NOTYPE/SHN_ABS, a `gFoo = .;` inside a section is NOTYPE with that section's
    // index, and excluding them would leave addressToSymbol unable to name a single global
    // in such an ELF. They carry no st_size, so their extent is inferred and reported as
    // such — see `exact`.
    this.#all = buildRanges(
      symbols.filter((s) => s.type === STT_FUNC || s.type === STT_OBJECT || s.type === STT_NOTYPE),
      sections,
    );
    this.#mappings = [...mappings].sort((a, b) => a.address - b.address);
  }

  /** Build from an ELF's `.symtab` (+ its linked string table). */
  static fromElf(elf: ElfFile): SymbolIndex {
    const symtab = elf.section('.symtab');
    const data = elf.sectionData('.symtab');
    if (!symtab || !data) {
      return new SymbolIndex([]);
    }
    const strtab = elf.sectionDataByIndex(symtab.link) ?? new Uint8Array(0);

    // Loadable section bounds, so a trailing size-0 symbol's range can extend to
    // the end of its containing section, and so a section-placed linker symbol can
    // be told apart from a marker in a non-loadable one.
    const loadable = new Set<number>();
    const sections: SectionRange[] = [];
    elf.sections.forEach((s, i) => {
      if (s.addr > 0 && s.size > 0) {
        loadable.add(i);
        sections.push({ addr: s.addr, end: s.addr + s.size, code: (s.flags & SHF_EXECINSTR) !== 0 });
      }
    });

    const SYM_SIZE = 16; // Elf32_Sym
    const c = new Cursor(data, 0, elf.littleEndian);
    const symbols: ElfSymbol[] = [];
    const mappings: MappingSymbol[] = [];
    for (let off = 0; off + SYM_SIZE <= data.length; off += SYM_SIZE) {
      const stName = c.u32At(off);
      const stValue = c.u32At(off + 4);
      const stSize = c.u32At(off + 8);
      const stInfo = c.u8At(off + 12);
      const type = stInfo & 0xf;
      const bind = stInfo >> 4;
      const shndx = c.u16At(off + 14);
      const name = cstrAt(strtab, stName);
      if (name === '') {
        continue;
      }

      // GNU ARM mapping symbols: `$a` (ARM code), `$t` (Thumb code), `$d` (data),
      // optionally suffixed `.N`. Local, untyped, and the only per-address record of
      // which instruction set a byte belongs to.
      if (type === STT_NOTYPE && name.length >= 2 && name[0] === '$' && (name.length === 2 || name[2] === '.')) {
        const mode = name[1] === 'a' ? 'arm' : name[1] === 't' ? 'thumb' : name[1] === 'd' ? 'data' : null;
        if (mode && loadable.has(shndx)) {
          mappings.push({ address: stValue >>> 0, mode });
        }
        continue;
      }

      if (shndx === SHN_UNDEF || shndx === SHN_COMMON) {
        continue; // declared here, defined elsewhere (or nowhere)
      }
      // A FUNC with an absolute value is not code this ELF holds (GCC emits
      // `__sync_synchronize` as `FUNC ABS 0`); resolving a PC into it would name a
      // function that does not exist at that address.
      if (type === STT_FUNC && shndx === SHN_ABS) {
        continue;
      }
      // Keep functions, data objects, and linker-defined globals: ldscript symbols
      // that place a struct at a fixed RAM address (`gFoo = 0x03000000;` → SHN_ABS, or
      // `gFoo = .;` inside a section → that section's index), the norm in GBA decomp.
      // Section-relative markers in non-loadable sections are not globals.
      const isLinkerGlobal =
        type === STT_NOTYPE && (bind === STB_GLOBAL || bind === STB_WEAK) && (shndx === SHN_ABS || loadable.has(shndx));
      if (type !== STT_FUNC && type !== STT_OBJECT && !isLinkerGlobal) {
        continue;
      }
      // Thumb function symbols may carry the low bit set; normalize to the even addr.
      const address = type === STT_FUNC ? stValue & ~1 : stValue;
      symbols.push({ name, address: address >>> 0, size: stSize, type, bind, shndx });
    }

    return new SymbolIndex(symbols, sections, mappings);
  }

  symbolToAddress(name: string): number | null {
    const s = this.#byName.get(name);
    return s ? s.address : null;
  }

  /** The full symbol record for `name`, or null. */
  symbol(name: string): ElfSymbol | null {
    return this.#byName.get(name) ?? null;
  }

  /**
   * The one DEFINED GLOBAL (or weak) symbol named `name`, or null. This is the
   * lookup a C `extern` declaration may be joined to: a file-static of the same
   * spelling never qualifies, and two globals at different addresses are ambiguous.
   */
  globalSymbol(name: string): ElfSymbol | null {
    const candidates = (this.#allByName.get(name) ?? []).filter((s) => {
      const bind = s.bind ?? STB_GLOBAL;
      const shndx = s.shndx ?? 1;
      return (bind === STB_GLOBAL || bind === STB_WEAK) && shndx !== SHN_UNDEF && shndx !== SHN_COMMON;
    });
    const first = candidates[0];
    if (!first) {
      return null;
    }
    return candidates.every((s) => s.address === first.address) ? first : null;
  }

  /** The function whose `[address, end)` range contains `pc`, or null (gap / before first). */
  pcToFunction(pc: number): FunctionEntry | null {
    return findContaining(this.#functions, pc);
  }

  /**
   * The extent of the nearest enclosing symbol of any type, or null. Where
   * {@link pcToFunction} answers only for symbols the ELF typed `STT_FUNC`, this
   * answers for the hand-written assembly that carries no `.type` at all — crt0 is
   * all of it — so an address that has a name also has bounds. `exact` is false
   * whenever the extent came from the next symbol's address rather than an
   * `st_size`.
   */
  symbolRangeAt(address: number): FunctionEntry | null {
    return findContaining(this.#all, address);
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

  /**
   * The instruction set at `address` according to the nearest mapping symbol at or
   * before it, or null when the ELF has none there (agbcc emits none; then the
   * caller falls back to the CPU's current mode or to a symbol's Thumb bit).
   */
  modeAt(address: number): IsaMode | null {
    const m = this.#mappings;
    if (m.length === 0 || address < m[0]!.address) {
      return null;
    }
    let lo = 0;
    let hi = m.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (m[mid]!.address <= address) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return m[lo]!.mode;
  }

  /**
   * Whether `address` lies in a section the ELF marked executable. A symbol is not
   * the only thing that vouches for code: crt0's `bl main` returns into a NOTYPE
   * symbol of size 0, and a mapping symbol can name an `__ewram_end`-style boundary
   * that no instruction lives at.
   */
  isExecutable(address: number): boolean {
    return this.#executable.some((s) => address >= s.addr && address < s.end);
  }

  /** True when the ELF carries mapping symbols at all. */
  get hasMappingSymbols(): boolean {
    return this.#mappings.length > 0;
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
  // A typed symbol names the object; a linker alias at the same address only points at it.
  if ((candidate.type === STT_NOTYPE) !== (current.type === STT_NOTYPE)) {
    return current.type === STT_NOTYPE;
  }
  return candidate.size > current.size; // otherwise the one with more info
}
