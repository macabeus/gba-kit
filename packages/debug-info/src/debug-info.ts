/**
 * Top-level debug-info facade: parse an ELF once, then answer the queries the
 * debugger / scripting engine needs — PC→function, name→address, PC→C source.
 */
import { LineTable, parseDebugLine } from './debug-line.js';
import { ElfFile } from './elf.js';
import { type FunctionEntry, SymbolIndex } from './symbols.js';
import { type StructType, TypeIndex } from './types.js';

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
  readonly types: TypeIndex;

  /** Use {@link DebugInfo.fromElf}; this constructor is an internal detail. */
  constructor(elf: ElfFile, symbols: SymbolIndex, lines: LineTable, types: TypeIndex) {
    this.elf = elf;
    this.symbols = symbols;
    this.lines = lines;
    this.types = types;
  }

  /** Parse a (`-g`-built) GBA ELF image into a queryable DebugInfo. */
  static fromElf(bytes: Uint8Array): DebugInfo {
    const elf = ElfFile.parse(bytes);
    const symbols = SymbolIndex.fromElf(elf);
    const debugLine = elf.sectionData('.debug_line');
    const lines = debugLine ? parseDebugLine(debugLine) : new LineTable([]);
    const types = TypeIndex.fromElf(elf);
    return new DebugInfo(elf, symbols, lines, types);
  }

  /** True if the ELF actually carried a DWARF line table. */
  get hasLineInfo(): boolean {
    return this.lines.rows.length > 0;
  }

  /** True if the ELF carried DWARF struct/union type info. */
  get hasTypeInfo(): boolean {
    return this.types.hasTypes;
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
   * For a bitfield, `bitOffset`/`bitWidth` are also returned, so the field value is
   * `(read(addr + offset, size) >> bitOffset) & ((1 << bitWidth) - 1)`.
   * The path may be dotted (`'a.b'`) or an array (`['a', 'b']`).
   */
  structMember(
    structName: string,
    path: string | string[],
  ): { offset: number; size: number | null; bitOffset?: number; bitWidth?: number } | null {
    return this.types.member(structName, path);
  }

  /**
   * Like {@link structMember}, but rooted at a global/static *variable* rather than
   * a type name — the variable's type is read from its DWARF DIE. The returned
   * `offset` is relative to the variable's address.
   */
  variableMember(
    varName: string,
    path: string | string[],
  ): { offset: number; size: number | null; bitOffset?: number; bitWidth?: number } | null {
    return this.types.variableMember(varName, path);
  }

  /**
   * Resolve a `symbol` or `symbol.field.subfield` path to an absolute address and
   * byte size — the symbol address comes from `.symtab`, the field layout from the
   * variable's DWARF type, so no type name is needed. For a bare scalar symbol the
   * size is its `st_size`; for a bitfield, `bitOffset`/`bitWidth` are also returned.
   * Returns null if the symbol or any field segment can't be resolved.
   */
  resolveVariable(path: string): { address: number; size: number; bitOffset?: number; bitWidth?: number } | null {
    const dot = path.indexOf('.');
    const symbol = dot === -1 ? path : path.slice(0, dot);
    const address = this.symbolToAddress(symbol);
    if (address === null) {
      return null;
    }
    if (dot === -1) {
      const size = this.symbolSize(symbol);
      return size === null ? null : { address, size };
    }
    const member = this.types.variableMember(symbol, path.slice(dot + 1));
    if (!member || member.size === null) {
      return null;
    }
    const resolved: { address: number; size: number; bitOffset?: number; bitWidth?: number } = {
      address: address + member.offset,
      size: member.size,
    };
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
