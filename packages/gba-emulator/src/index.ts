/**
 * GBA Emulator — Public API
 *
 * Full GBA hardware emulation built on top of shared/arm-emulator.
 */

// Main system
export { Gba } from './gba.js';

// Subsystems
export { GbaSystemBus } from './system-bus.js';
export { Scheduler } from './scheduler.js';
export { InterruptController } from './interrupts.js';
export { TimerController } from './timers.js';
export { DmaController } from './dma.js';
export type { DmaMemoryAccess } from './dma.js';
export { InputController } from './input.js';
export { Apu } from './apu/apu.js';

// Scripting
export { ScriptingEngine } from './scripting.js';
export type { ScriptingHost, WatchHit } from './scripting.js';

// Types and constants
export {
  CPU_FREQ,
  CYCLES_PER_FRAME,
  CYCLES_PER_SCANLINE,
  DmaAddrControl,
  DmaStartTiming,
  EventId,
  FRAME_RATE,
  GbaButton,
  HBLANK_CYCLES,
  HDRAW_CYCLES,
  IrqFlag,
  MMIO,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  TIMER_PRESCALERS,
  TOTAL_SCANLINES,
  VBLANK_SCANLINES,
  VISIBLE_SCANLINES,
} from './types.js';
