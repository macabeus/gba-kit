/**
 * @gba-kit/debug-info
 *
 * Parse ELF symbols and DWARF debug info from a (`-g`-built) GBA ELF, and answer
 * the queries a source-level debugger needs: PC→function, name→address, and
 * PC→source `file:line`.
 */
export { DebugInfo, type SourceLocation } from './debug-info.js';
export { ElfFile, type ElfSection } from './elf.js';
export { SymbolIndex, type ElfSymbol, type FunctionEntry, STT_FUNC, STT_OBJECT } from './symbols.js';
export { LineTable, parseDebugLine, type LineRow } from './debug-line.js';
