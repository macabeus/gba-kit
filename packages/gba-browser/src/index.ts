// Core
export { EmulatorBridge } from './emulator.js';
export type { EmulatorState, EmulatorCallbacks, Breakpoint } from './emulator.js';

// Save state persistence
export { computeRomHash, saveState, loadState, deleteState, renameState, listByRom } from './savestate-db.js';
export type { SaveStateRecord, SaveStateMeta } from './savestate-db.js';
