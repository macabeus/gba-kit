export { InputRecorder } from './input-recorder';
export type { InputSegment } from './input-recorder';

export {
  buttonsToString,
  serializeToScript,
  serializeToScriptWithMapping,
  segmentsToPressSequenceArgs,
} from './script-serializer';
export type { ScriptWithMapping } from './script-serializer';

export { replayVisual } from './script-replayer';
export type { ReplayMode, ReplayDebugState } from './script-replayer';

export { saveScript, loadScriptRecord, deleteScript, listScriptsByRom } from './script-db';
export type { ScriptRecord, ScriptMeta } from './script-db';
