/**
 * @gba-kit/debug-info
 *
 * Parse ELF symbols and DWARF debug info from a (`-g`-built) GBA ELF, and answer
 * the queries a source-level debugger needs: PC→function, name→address,
 * PC→source `file:line`, and struct field → byte offset.
 */
export { DebugInfo, type SourceLocation, type ResolvedLocation } from './debug-info.js';
export { ElfFile, type ElfSection } from './elf.js';
export { SymbolIndex, type ElfSymbol, type FunctionEntry, STT_FUNC, STT_NOTYPE, STT_OBJECT } from './symbols.js';
export { LineTable, parseDebugLine, type LineRow } from './debug-line.js';
export {
  TypeIndex,
  type StructType,
  type StructMember,
  type MemberLocation,
  type FunctionSignature,
  type TypeFacts,
} from './types.js';
