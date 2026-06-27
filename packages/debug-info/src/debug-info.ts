/**
 * Top-level debug-info facade: parse an ELF once, then answer the queries the
 * debugger / scripting engine needs — PC→function, name→address, PC→C source.
 */
import { LineTable, parseDebugLine } from './debug-line.js';
import { ElfFile } from './elf.js';
import { type FunctionEntry, SymbolIndex } from './symbols.js';

export interface SourceLocation {
  file: string;
  line: number;
  /** Containing function, when known from the symbol table. */
  func?: string;
}

export class DebugInfo {
  readonly elf: ElfFile;
  readonly symbols: SymbolIndex;
  readonly lines: LineTable;

  /** Use {@link DebugInfo.fromElf}; this constructor is an internal detail. */
  constructor(elf: ElfFile, symbols: SymbolIndex, lines: LineTable) {
    this.elf = elf;
    this.symbols = symbols;
    this.lines = lines;
  }

  /** Parse a (`-g`-built) GBA ELF image into a queryable DebugInfo. */
  static fromElf(bytes: Uint8Array): DebugInfo {
    const elf = ElfFile.parse(bytes);
    const symbols = SymbolIndex.fromElf(elf);
    const debugLine = elf.sectionData('.debug_line');
    const lines = debugLine ? parseDebugLine(debugLine) : new LineTable([]);
    return new DebugInfo(elf, symbols, lines);
  }

  /** True if the ELF actually carried a DWARF line table. */
  get hasLineInfo(): boolean {
    return this.lines.rows.length > 0;
  }

  pcToFunction(pc: number): FunctionEntry | null {
    return this.symbols.pcToFunction(pc);
  }

  symbolToAddress(name: string): number | null {
    return this.symbols.symbolToAddress(name);
  }

  /** The size in bytes of a named symbol (st_size), or null if unknown/0. */
  symbolSize(name: string): number | null {
    const size = this.symbols.symbol(name)?.size;
    return size ? size : null;
  }

  addressToSymbol(addr: number): { name: string; offset: number } | null {
    return this.symbols.addressToSymbol(addr);
  }

  /** Map a runtime PC to `{ file, line, func }`, or null if not in C code. */
  pcToSource(pc: number): SourceLocation | null {
    const src = this.lines.pcToSource(pc);
    if (!src) {
      return null;
    }
    const fn = this.symbols.pcToFunction(pc);
    return fn ? { ...src, func: fn.name } : src;
  }
}
