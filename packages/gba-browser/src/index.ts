// Core
export { EmulatorBridge } from './emulator.js';
export type { EmulatorState, EmulatorCallbacks, Breakpoint } from './emulator.js';
export { FrameClock, FRAME_MS, MAX_FRAMES_PER_CALLBACK } from './frame-clock.js';

// Save state persistence
export { computeRomHash, saveState, loadState, deleteState, renameState, listByRom } from './savestate-db.js';
export type { SaveStateRecord, SaveStateMeta } from './savestate-db.js';
