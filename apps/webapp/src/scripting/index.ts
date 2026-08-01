export { InputRecorder } from './input-recorder';
export type { InputSegment } from './input-recorder';

export {
  BUTTON_NAMES,
  buttonsFromString,
  buttonsToString,
  serializeToScript,
  serializeToScriptWithMapping,
  segmentsToPressSequenceArgs,
} from './script-serializer';
export type { ScriptWithMapping } from './script-serializer';

export { parseScript } from './script-parser';
export type { ScriptParseError, ScriptParseResult } from './script-parser';

export { replayVisual } from './script-replayer';
export type { ReplayMode, ReplayDebugState } from './script-replayer';

export { saveScript, loadScriptRecord, deleteScript, listScriptsByRom } from './script-db';
export type { ScriptRecord, ScriptMeta } from './script-db';
