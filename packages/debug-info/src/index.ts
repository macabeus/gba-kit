/**
 * @gba-kit/debug-info
 *
 * Parse ELF symbols and DWARF debug info from a (`-g`-built) GBA ELF, and answer
 * the queries a source-level debugger needs: PC→function, name→address,
 * PC→source `file:line`, and struct field → byte offset.
 */
export { DebugInfo, type RomIdentity, type SourceLocation, type ResolvedLocation } from './debug-info.js';
export { ElfFile, ET_EXEC, ET_REL, type ElfSection } from './elf.js';
export {
  SymbolIndex,
  type ElfSymbol,
  type FunctionEntry,
  type IsaMode,
  SHN_ABS,
  SHN_COMMON,
  SHN_UNDEF,
  STB_GLOBAL,
  STB_LOCAL,
  STB_WEAK,
  STT_FUNC,
  STT_NOTYPE,
  STT_OBJECT,
} from './symbols.js';
export { LineTable, normalizePath, parseDebugLine, type LineRow, type LineRowStart } from './debug-line.js';
export { parseDebugMacinfo, type MacroDefinition } from './debug-macro.js';
export {
  TypeIndex,
  readDwarfEntries,
  type AttrValue,
  type DwarfEntry,
  type StructType,
  type StructMember,
  type MemberLocation,
  type FunctionSignature,
  type TypeFacts,
  type PathSegment,
  parsePath,
} from './types.js';
