/**
 * What the session knows about the program being debugged: the ELF's symbols,
 * lines, types and scopes (when there is an ELF), the mapping between DWARF file
 * paths and local files, and the ROM/ELF identity verdict. Every question about
 * "which line is this" or "what is this address called" comes here.
 */
import { DebugInfo, type FunctionEntry, type IsaMode, type RomIdentity } from '@gba-kit/debug-info';

import { SourceMapper, type SourceMapperOptions } from './source-map.js';

export interface SourceLocation {
  /** the file as the ELF spells it (normalized) */
  dwarfFile: string;
  /** the local file, when one was found */
  path: string | null;
  line: number;
  func?: string;
}

export interface FunctionRange {
  name: string;
  lo: number;
  hi: number;
  exact: boolean;
}

export class Program {
  readonly debugInfo: DebugInfo | null;
  readonly sources: SourceMapper | null;
  readonly identity: RomIdentity | null;

  constructor(elf: Uint8Array | null, rom: Uint8Array, options: SourceMapperOptions) {
    if (elf) {
      this.debugInfo = DebugInfo.fromElf(elf);
      this.sources = new SourceMapper(this.debugInfo.lines.files, options);
      this.identity = this.debugInfo.checkRomIdentity(rom);
    } else {
      this.debugInfo = null;
      this.sources = null;
      this.identity = null;
    }
  }

  get hasSymbols(): boolean {
    return this.debugInfo !== null;
  }

  get hasLines(): boolean {
    return this.debugInfo?.hasLineInfo ?? false;
  }

  /** The source line whose range contains `pc` (row semantics), or null. */
  lineAt(pc: number): SourceLocation | null {
    if (!this.debugInfo || !this.sources || pc < 0x02000000) {
      return null;
    }
    const src = this.debugInfo.pcToSource(pc);
    if (!src) {
      return null;
    }
    const dwarfFile = normalizeDwarf(src.file);
    return { dwarfFile, path: this.sources.toLocal(dwarfFile), line: src.line, func: src.func };
  }

  /** The row starting exactly at `address` (a step-stop candidate when `isStmt`). */
  rowAt(address: number): { file: string; line: number; isStmt: boolean } | undefined {
    return this.debugInfo?.lines.rowAt(address);
  }

  /** The function containing `pc`: from DWARF scopes when possible, else the symbol table. */
  functionRange(pc: number): FunctionRange | null {
    if (!this.debugInfo) {
      return null;
    }
    const entry = this.debugInfo.scopes.functionAt(pc);
    if (entry) {
      const ranges = this.debugInfo.scopes.ranges(entry);
      if (ranges.length > 0) {
        return {
          name: this.debugInfo.scopes.name(entry) ?? this.symbolName(pc),
          lo: ranges[0]![0],
          hi: ranges[ranges.length - 1]![1],
          exact: true,
        };
      }
    }
    const fn: FunctionEntry | null = this.debugInfo.pcToFunction(pc);
    return fn ? { name: fn.name, lo: fn.address, hi: fn.end, exact: fn.exact } : null;
  }

  /** `name` / `name+0xNN` / `0x........` for an address. */
  symbolName(address: number): string {
    if (address < 0x4000) {
      return `<BIOS stub +0x${address.toString(16)}>`;
    }
    const fn = this.debugInfo?.pcToFunction(address);
    if (fn) {
      return address === fn.address ? fn.name : `${fn.name}+0x${(address - fn.address).toString(16)}`;
    }
    const sym = this.debugInfo?.addressToSymbol(address);
    if (sym && (sym.exact || sym.offset < 0x1000)) {
      return sym.offset === 0 ? sym.name : `${sym.name}+0x${sym.offset.toString(16)}`;
    }
    return `0x${address.toString(16).padStart(8, '0')}`;
  }

  /** A short label for a branch target or literal (null when nothing names it). */
  symbolize(address: number): string | null {
    if (!this.debugInfo) {
      return null;
    }
    const fn = this.debugInfo.pcToFunction(address);
    if (fn) {
      return address === fn.address ? fn.name : `${fn.name}+0x${(address - fn.address).toString(16)}`;
    }
    const sym = this.debugInfo.addressToSymbol(address);
    if (sym && (sym.exact || sym.offset < 0x1000)) {
      return sym.offset === 0 ? sym.name : `${sym.name}+0x${sym.offset.toString(16)}`;
    }
    return null;
  }

  /** The address of a symbol: functions, objects, linker-placed globals. */
  symbolAddress(name: string): number | null {
    return this.debugInfo?.symbolToAddress(name) ?? null;
  }

  /** The address of a defined GLOBAL symbol (the safe join for a C `extern`). */
  globalAddress(name: string): number | null {
    return this.debugInfo?.globalSymbolAddress(name) ?? null;
  }

  /** The instruction set at `address` from mapping symbols, or null when the ELF has none. */
  modeAt(address: number): IsaMode | null {
    return this.debugInfo?.modeAt(address) ?? null;
  }

  /**
   * Whether a return address points at something we can name: a DWARF function or
   * a symbol the ELF placed there. Unwinding stops where this says no, so the call
   * stack never ends in a made-up caller inside crt0's gap.
   */
  isNamedCode(address: number): boolean {
    if (!this.debugInfo) {
      return true;
    }
    if (this.debugInfo.scopes.functionAt(address)) {
      return true;
    }
    const fn = this.debugInfo.pcToFunction(address);
    return !!fn && (fn.exact || address - fn.address < 0x1000);
  }

  /** Addresses where code for a local source line starts, sliding to the next line with code. */
  lineToAddresses(localPath: string, line: number): { line: number; addresses: number[] } | null {
    if (!this.debugInfo || !this.sources) {
      return null;
    }
    const dwarfFile = this.sources.toDwarf(localPath);
    if (!dwarfFile) {
      return null;
    }
    // A statement row of the line, or the entry of a call inlined there (such a
    // line has no rows of its own); else the first later line with either, so a
    // breakpoint on a comment or a declaration slides forward like gdb's.
    for (let l = line; l <= line + SLIDE_SLACK; l++) {
      const addresses = [
        ...this.debugInfo.lines.sourceToPcs(dwarfFile, l),
        ...this.debugInfo.scopes.inlineCallSitesAt(dwarfFile, l),
      ];
      if (addresses.length > 0) {
        return { line: l, addresses: [...new Set(addresses)].sort((a, b) => a - b) };
      }
    }
    return null;
  }
}

/** how many lines a breakpoint on a line without code slides forward */
const SLIDE_SLACK = 8;

function normalizeDwarf(p: string): string {
  return p.replace(/\\/g, '/');
}
