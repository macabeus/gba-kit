/**
 * Top-level debug-info facade: parse an ELF once, then answer the queries the
 * debugger / scripting engine needs — PC→function, name→address, PC→C source.
 */
import { LineTable, parseDebugLine } from './debug-line.js';
import { type MacroDefinition, parseDebugMacinfo } from './debug-macro.js';
import { ET_EXEC, ElfFile } from './elf.js';
import { DwarfScopes } from './scopes.js';
import { type FunctionEntry, type IsaMode, SymbolIndex } from './symbols.js';
import { type MemberLocation, type StructType, TypeIndex, parsePath, readDwarfEntries } from './types.js';

export interface SourceLocation {
  file: string;
  line: number;
  /** Containing function, when known from the symbol table. */
  func?: string;
}

/** The verdict of {@link DebugInfo.checkRomIdentity}. */
export type RomIdentity =
  | { ok: true; comparedBytes: number }
  | { ok: false; reason: string; section?: string; address?: number };

const SHT_PROGBITS = 1;

/** The lowest address of any loadable section, or null when the ELF has none. */
function lowestLoadableAddress(elf: ElfFile): number | null {
  let lowest: number | null = null;
  for (const s of elf.sections) {
    if (s.addr > 0 && s.size > 0 && (lowest === null || s.addr < lowest)) {
      lowest = s.addr;
    }
  }
  return lowest;
}

/** An absolute, readable location: address + byte size, plus bitfield shift/width. */
export interface ResolvedLocation {
  address: number;
  size: number;
  bitOffset?: number;
  bitWidth?: number;
}

export class DebugInfo {
  readonly elf: ElfFile;
  readonly symbols: SymbolIndex;
  readonly lines: LineTable;
  readonly types: TypeIndex;
  /** Every `#define` the ELF recorded (`-g3`), in stream order; empty when it carried none. */
  readonly macros: MacroDefinition[];
  #scopes: DwarfScopes | null = null;

  /** Use {@link DebugInfo.fromElf}; this constructor is an internal detail. */
  constructor(elf: ElfFile, symbols: SymbolIndex, lines: LineTable, types: TypeIndex, macros: MacroDefinition[] = []) {
    this.elf = elf;
    this.symbols = symbols;
    this.lines = lines;
    this.types = types;
    this.macros = macros;
  }

  /** Parse a (`-g`-built) GBA ELF image into a queryable DebugInfo. */
  static fromElf(bytes: Uint8Array): DebugInfo {
    const elf = ElfFile.parse(bytes);
    const symbols = SymbolIndex.fromElf(elf);
    const debugLine = elf.sectionData('.debug_line');
    let lines = debugLine
      ? parseDebugLine(debugLine, elf.littleEndian, {
          lineStr: elf.sectionData('.debug_line_str'),
          str: elf.sectionData('.debug_str'),
        })
      : new LineTable([]);
    // Rows for code the linker discarded (`--gc-sections`) keep their addresses at
    // 0, below every loadable section; a PC in the BIOS stub would resolve into them.
    const lowest = lowestLoadableAddress(elf);
    if (lowest !== null && lines.rows.some((r) => r.address < lowest)) {
      lines = new LineTable(lines.rows.filter((r) => r.address >= lowest));
    }
    const types = TypeIndex.fromElf(elf);
    const macinfo = elf.sectionData('.debug_macinfo');
    return new DebugInfo(elf, symbols, lines, types, macinfo ? parseDebugMacinfo(macinfo) : []);
  }

  /**
   * Scope-level DWARF: functions, inlined calls, locals and their locations, call
   * frames, typed values. Built on first use (it walks every DIE once).
   */
  get scopes(): DwarfScopes {
    if (!this.#scopes) {
      this.#scopes = new DwarfScopes(readDwarfEntries(this.elf), this.elf, this.lines.rows);
    }
    return this.#scopes;
  }

  /** True if the ELF actually carried a DWARF line table. */
  get hasLineInfo(): boolean {
    return this.lines.rows.length > 0;
  }

  /** True if the ELF recorded preprocessor macro definitions (built with `-g3`). */
  get hasMacroInfo(): boolean {
    return this.macros.length > 0;
  }

  /** True if the ELF carried DWARF struct/union type info. */
  get hasTypeInfo(): boolean {
    return this.types.hasTypes;
  }

  pcToFunction(pc: number): FunctionEntry | null {
    return this.symbols.pcToFunction(pc);
  }

  /** True for a linked image; false for a relocatable object (which has no addresses to debug). */
  get isLinked(): boolean {
    return this.elf.type === ET_EXEC;
  }

  /**
   * Every address where code for `line` of `file` starts (see {@link LineTable.sourceToPcs}).
   * `file` is matched after normalization, as DWARF spells it — not as a local path.
   */
  sourceToPcs(file: string, line: number): number[] {
    return this.lines.sourceToPcs(file, line);
  }

  /** The instruction set at `address` from the ELF's mapping symbols, or null without them. */
  modeAt(address: number): IsaMode | null {
    return this.symbols.modeAt(address);
  }

  /**
   * The address of the defined GLOBAL symbol `name`, or null. Unlike
   * {@link symbolToAddress}, a file-static of the same spelling does not answer,
   * and two globals at different addresses are refused as ambiguous — the rule for
   * joining a C `extern` declaration to storage the linker placed.
   */
  globalSymbolAddress(name: string): number | null {
    return this.symbols.globalSymbol(name)?.address ?? null;
  }

  /**
   * Whether this ELF is the debug sidecar of `rom`: every loadable, initialized
   * section that lies in the cartridge window (`0x08000000–0x0DFFFFFF`) must match
   * the ROM byte for byte at its offset. A wrong ELF (another build, an object-file
   * wrapper around the ROM, a `-gdwarf` variant linked differently) fails on the
   * first section that differs, which is named so the user can see what is off.
   *
   * This checks the code and data the ELF placed in ROM. It does not compare bytes
   * the ELF says nothing about (padding, a post-link header patch), so a match is
   * "no contradiction found", not a build identity.
   */
  checkRomIdentity(rom: Uint8Array): RomIdentity {
    if (!this.isLinked) {
      return { ok: false, reason: 'not a linked image (ET_EXEC): an object file or a wrapper around raw bytes' };
    }
    let compared = 0;
    for (const s of this.elf.sections) {
      const inRom = s.addr >= 0x08000000 && s.addr < 0x0e000000;
      if (!inRom || s.size === 0 || s.type !== SHT_PROGBITS) {
        continue;
      }
      const data = this.elf.sectionDataByIndex(this.elf.sections.indexOf(s));
      if (!data) {
        continue;
      }
      const offset = s.addr & 0x01ffffff;
      if (offset + s.size > rom.length) {
        return {
          ok: false,
          reason: `section ${s.name} at 0x${s.addr.toString(16)} extends past the end of the ROM`,
          section: s.name,
        };
      }
      for (let i = 0; i < s.size; i++) {
        if (data[i] !== rom[offset + i]) {
          return {
            ok: false,
            reason: `section ${s.name} differs from the ROM at 0x${(s.addr + i).toString(16)}`,
            section: s.name,
            address: s.addr + i,
          };
        }
      }
      compared += s.size;
    }
    if (compared === 0) {
      return { ok: false, reason: 'the ELF places nothing in the cartridge window' };
    }
    return { ok: true, comparedBytes: compared };
  }

  symbolToAddress(name: string): number | null {
    return this.symbols.symbolToAddress(name);
  }

  /** The size in bytes of a named symbol (st_size), or null if unknown/0. */
  symbolSize(name: string): number | null {
    const size = this.symbols.symbol(name)?.size;
    return size ? size : null;
  }

  /**
   * Nearest enclosing symbol as `name+0xNN`, or null. `exact` distinguishes a
   * containment the ELF stated from one inferred from the next symbol's address —
   * see {@link SymbolIndex.addressToSymbol}.
   */
  addressToSymbol(addr: number): { name: string; offset: number; exact: boolean } | null {
    return this.symbols.addressToSymbol(addr);
  }

  /**
   * How many bytes the object named `name` occupies, and where that is known from —
   * or `null` when nothing states it.
   *
   * Which source answers depends on how the symbol was declared, not on the project:
   * a global DEFINED in C is `STT_OBJECT` and the assembler sizes it, giving
   * `st_size`; one PLACED by the linker (`gFoo = 0x03000000;`) is `SHN_ABS`/`NOTYPE`
   * with no size, so its extent can only come from the type of a C `extern`
   * declaration — `dwarf`. With neither, there is no extent to report. Decomps hit
   * the second case constantly, because a fixed RAM address cannot be a C definition.
   *
   * `source` is reported for the same reason {@link addressToSymbol} reports `exact`:
   * a caller bounding a write should be able to see whether a bound exists at all
   * before relying on one.
   */
  symbolExtent(name: string): { size: number; source: 'st_size' | 'dwarf' } | null {
    const st = this.symbolSize(name);
    if (st !== null) {
      return { size: st, source: 'st_size' };
    }
    const dwarf = this.types.variableSize(name);
    return dwarf !== null ? { size: dwarf, source: 'dwarf' } : null;
  }

  /**
   * The layout of a struct/union by name — its size and members with byte
   * offsets. Accepts the struct tag or a typedef alias of an (often anonymous)
   * struct. Returns null if the type isn't in the DWARF.
   */
  struct(name: string): StructType | null {
    return this.types.struct(name);
  }

  /**
   * The location of a struct field, e.g. `structMember('GameVariables', 'rng_info.seed')`.
   * Add `offset` to the address of a global of that struct type and read `size` bytes.
   * `size` is null when the member's byte size can't be determined (e.g. an incomplete
   * type or flexible array) — callers must handle that before issuing a read.
   * For a bitfield, `bitOffset`/`bitWidth` are also returned (see {@link TypeIndex}
   * for the decode formula). The path may be dotted (`'a.b'`) or an array.
   */
  structMember(structName: string, path: string | string[]): MemberLocation | null {
    return this.types.member(structName, path);
  }

  /**
   * Like {@link structMember}, but rooted at a global/static *variable* rather than
   * a type name — the variable's type is read from its DWARF DIE. The returned
   * `offset` is relative to the variable's address.
   */
  variableMember(varName: string, path: string | string[]): MemberLocation | null {
    return this.types.variableMember(varName, path);
  }

  /**
   * Resolve a `symbol` or `symbol.field.subfield` path to an absolute address and
   * byte size — the symbol address comes from `.symtab`, the field layout from the
   * variable's DWARF type, so no type name is needed. For a bare symbol the size is
   * its `st_size`, else its DWARF type size, else a 32-bit word (linker-defined
   * globals carry neither). For a bitfield, `bitOffset`/`bitWidth` are also returned.
   * Returns null if the symbol or any field segment can't be resolved.
   */
  resolveVariable(path: string): ResolvedLocation | null {
    const dot = path.indexOf('.');
    const root = dot === -1 ? path : path.slice(0, dot);
    const rest = dot === -1 ? '' : path.slice(dot + 1);
    const rootSeg = parsePath(root)?.[0];
    if (!rootSeg) {
      return null;
    }
    const address = this.symbolToAddress(rootSeg.name);
    if (address === null) {
      return null;
    }

    // A subscripted root (`gLayers[4]` / `gLayers[4].field`) steps into the array
    // first; the index is bounds-checked against the DWARF extent, which is what
    // stops a computed element address from landing in the next object along.
    let base = address;
    let member: MemberLocation | null = null;
    if (rootSeg.indices.length > 0) {
      const step = this.types.variableIndex(rootSeg.name, rootSeg.indices);
      if (!step) {
        return null;
      }
      base += step.offset;
      if (rest === '') {
        if (step.size === null) {
          // Reached a row of a multi-dimensional array, not an element. Saying
          // "cannot resolve" here would blame the name; the name is fine.
          throw new Error(
            `"${path}" names a sub-array, not a value — subscript every dimension, or read it with getMemory`,
          );
        }
        return { address: base, size: step.size };
      }
      member = this.types.memberPathOf(this.types.variableElementStruct(rootSeg.name), rest);
    } else if (rest === '') {
      return { address, size: this.symbolSize(rootSeg.name) ?? this.types.variableSize(rootSeg.name) ?? 4 };
    } else {
      member = this.variableMember(rootSeg.name, rest);
    }

    if (!member || member.size === null) {
      return null;
    }
    const resolved: ResolvedLocation = { address: base + member.offset, size: member.size };
    if (member.bitOffset !== undefined) {
      resolved.bitOffset = member.bitOffset;
      resolved.bitWidth = member.bitWidth;
    }
    return resolved;
  }

  /**
   * The constants of an enum by name, as `{ enumeratorName: value }` (C names
   * verbatim). Accepts the enum tag or a typedef alias of an anonymous enum.
   * Returns null if the enum isn't in the DWARF.
   */
  enumValues(name: string): Record<string, number> | null {
    return this.types.enumValues(name);
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
