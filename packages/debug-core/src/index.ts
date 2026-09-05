/**
 * @gba-kit/debug-core — an IDE-agnostic debugging session for GBA programs.
 *
 * A `Session` owns one emulated machine and answers in addresses, frames,
 * symbols and typed values: breakpoints of every kind, stepping by instruction,
 * statement, frame or scanline, call stacks with inlined layers, locals and
 * globals from the DWARF, replay-exact rewind, a trace ring, a hardware event
 * log, labels, input recordings, save states, and the palette/tile/map/sprite
 * and I/O views. A Debug Adapter Protocol server, a browser app, or a test drive
 * it the same way.
 */
export {
  Session,
  type HistoryInfo,
  type Position,
  type SessionEvents,
  type SessionOptions,
  type SessionState,
  type StopInfo,
  type StopReason,
} from './session.js';
export { Machine, REGISTER_NAMES, isCodeAddress, regionOf, romHash } from './machine.js';
export { Program, type FunctionRange, type SourceLocation } from './program.js';
export { SourceMapper, type SourceMapperOptions } from './source-map.js';
export {
  Inspector,
  hex8,
  type DisassembledLine,
  type EvaluateResult,
  type Scope,
  type StackFrame,
} from './inspector.js';
export {
  BreakpointStore,
  EVENT_BREAKPOINT_KINDS,
  type Breakpoint,
  type BreakpointKind,
  type BreakpointSpec,
  type DataAccess,
  type DataBreakpoint,
  type DataBreakpointSpec,
  type EventBreakpointKind,
} from './breakpoints.js';
export {
  compileExpression,
  compileHitCondition,
  compileLogMessage,
  type CompiledExpr,
  type ExprEnv,
} from './expression.js';
export { RewindHistory, type RewindOptions } from './rewind.js';
export { applySnapshotDelta, decodeDelta, deltaSnapshot, encodeDelta, type SnapshotDelta } from './delta.js';
export { Ring, type EventEntry, type TimeStamp, type TraceEntry } from './rings.js';
export { LabelStore, type Label, type LabelsFile } from './labels.js';
export {
  buttonsToNames,
  namesToButtons,
  parseRecording,
  recordingToScript,
  toSegments,
  type InputRecording,
} from './recorder.js';
export {
  decodeSaveState,
  encodeSaveState,
  base64ToBytes,
  bytesToBase64,
  type SaveStateFile,
} from './snapshot-codec.js';
export {
  backgroundsSnapshot,
  paletteSnapshot,
  rgb555,
  spritesSnapshot,
  tilemapSnapshot,
  tilesSnapshot,
  type BackgroundInfo,
  type RgbColor,
  type SpriteInfo,
  type TilemapEntry,
  type TilemapSnapshot,
  type TilesSnapshot,
} from './ppu.js';
export {
  IO_REGISTERS,
  ioRegisterAt,
  ioSnapshot,
  type IoField,
  type IoRegisterDef,
  type IoRegisterValue,
} from './io.js';
export { filterMemory, searchMemory, type SearchOptions, type SearchRegion } from './memory-search.js';
export { ManualHost, timerHost, type Host, type HostFiles } from './host.js';
export type { VarNode } from '@gba-kit/debug-info';
