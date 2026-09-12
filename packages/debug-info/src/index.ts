/**
 * @gba-kit/debug-info
 *
 * Parse ELF symbols and DWARF debug info from a (`-g`-built) GBA ELF, and answer
 * the queries a source-level debugger needs: PC→function, name→address,
 * PC→source `file:line`, and struct field → byte offset.
 */
export { DebugInfo, type RomIdentity, type SourceLocation, type ResolvedLocation } from './debug-info.js';
export { ElfFile, ET_EXEC, ET_REL, SHF_EXECINSTR, type ElfSection } from './elf.js';
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
  DwarfScopes,
  type Enumerator,
  type Memory,
  type PhysicalFrame,
  type PhysicalStack,
  type VirtualFrame,
} from './scopes.js';
export { DW_AT, DW_ATE, DW_FORM, DW_OP, DW_TAG, formClass, type FormClass } from './dwarf/constants.js';
export { EntryIndex, attrFlag, attrNum, attrStr, type DwarfSections, type UnitInfo } from './dwarf/entries.js';
export {
  entryRanges,
  locationAt,
  describeExpr,
  rangesContain,
  regName,
  type LocationAttr,
  type LocationEntry,
  type Range,
} from './dwarf/lists.js';
export { evaluate, type EvalContext, type Location } from './dwarf/expr.js';
export { FrameTable, type UnwindResult } from './dwarf/frame.js';
export {
  FRAME_METHODS,
  frameConfidence,
  type CpuState,
  type FrameMethod,
  type MachineFacts,
  type ProgramFacts,
  type TargetPolicy,
  type UnwoundFrame,
} from './unwind/types.js';
export {
  TypeResolver,
  formatBitfield,
  formatValue,
  le32,
  quoteBytes,
  toBigInt,
  toInt,
  type MemberDesc,
  type TypeDesc,
  type TypeKind,
  type ValueReader,
  type VarNode,
  type WritableScalar,
} from './dwarf/values.js';
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
