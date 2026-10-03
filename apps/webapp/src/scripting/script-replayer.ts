/**
 * Script Replayer
 *
 * Replays recorded input segments through the emulator using the same
 * GBA.pressButton/releaseButton/runFrame path that ScriptingEngine uses.
 *
 * Two replay modes:
 * - Visual: at the GBA's frame rate, paced by a FrameClock over requestAnimationFrame,
 *   reporting the active segment index for script-line highlighting.
 * - Instant: synchronous via ScriptingEngine.pressSequence() for fast replay.
 *
 * Extension points:
 * - Variable frame-rate: scale the time the FrameClock sees for slow-motion or fast-forward
 * - Debugger: pause replay at specific segments or on conditions
 * - Per-frame assertions: verify state at each frame during replay
 */
import { type EmulatorBridge, FrameClock } from '@gba-kit/gba-browser';
import { ScriptingEngine, type ScriptingHost } from '@gba-kit/gba-emulator';
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';

import type { InputSegment } from './input-recorder';
import { segmentsToPressSequenceArgs } from './script-serializer';

/** No-op ScriptingHost for browser replay */
const NOOP_HOST: ScriptingHost = {
  async writeScreenshot() {},
  async writeMemorySnapshot() {},
  async writeSaveState() {},
  async readSaveState() {
    throw new Error('Not available in browser replay');
  },
  log() {},
};

export type ReplayMode = 'from-start' | 'from-current';

/** Replay debug state — reports which segment is currently executing. */
export interface ReplayDebugState {
  /** Index of the currently executing segment (0-based). */
  segmentIndex: number;
  /** Whether replay is still running. */
  running: boolean;
}

/**
 * Replay recorded segments visually, at the GBA's frame rate.
 *
 * Iterates segment-by-segment, reporting the active segment index via
 * `onSegmentChange` so the UI can highlight the corresponding script line.
 */
export function replayVisual(
  bridge: EmulatorBridge,
  segments: InputSegment[],
  snapshot: GbaSnapshot | null,
  mode: ReplayMode,
  onSegmentChange: (state: ReplayDebugState) => void,
  onComplete: () => void,
): { cancel: () => void } {
  let cancelled = false;

  let segmentIndex = 0;
  let frameInSegment = 0;
  let activeButtons = new Set<number>();

  bridge.pause();

  if (mode === 'from-start' && snapshot) {
    bridge.loadState(snapshot);
  }

  // Notify the initial segment
  if (segments.length > 0) {
    onSegmentChange({ segmentIndex: 0, running: true });
  }

  function applySegmentButtons(seg: InputSegment) {
    const newButtons = new Set(seg.buttons);

    // Release buttons no longer pressed
    for (const bit of activeButtons) {
      if (!newButtons.has(bit)) {
        bridge.gba.input.release(bit);
      }
    }
    // Press newly pressed buttons
    for (const bit of newButtons) {
      if (!activeButtons.has(bit)) {
        bridge.gba.input.press(bit);
      }
    }
    activeButtons = newButtons;
  }

  /** Run one GBA frame of the replay; returns false once every segment has run. */
  function advance(): boolean {
    if (segmentIndex >= segments.length) {
      // Done — release all buttons
      for (const bit of activeButtons) {
        bridge.gba.input.release(bit);
      }
      activeButtons = new Set();
      onSegmentChange({ segmentIndex: segments.length - 1, running: false });
      onComplete();
      return false;
    }

    const seg = segments[segmentIndex]!;

    // On first frame of a new segment, apply its buttons
    if (frameInSegment === 0) {
      applySegmentButtons(seg);
      onSegmentChange({ segmentIndex, running: true });
    }

    bridge.runOneFrame();
    frameInSegment++;

    // Advance to next segment if this one is done
    if (frameInSegment >= seg.frames) {
      segmentIndex++;
      frameInSegment = 0;
    }
    return true;
  }

  const clock = new FrameClock();

  function step(now: number) {
    if (cancelled) {
      return;
    }
    const frames = clock.framesDue(now);
    for (let i = 0; i < frames; i++) {
      if (!advance()) {
        return;
      }
    }
    requestAnimationFrame(step);
  }

  requestAnimationFrame(step);

  return {
    cancel() {
      cancelled = true;
      for (const bit of activeButtons) {
        bridge.gba.input.release(bit);
      }
    },
  };
}

/**
 * Replay recorded segments instantly using ScriptingEngine.pressSequence().
 * No visual feedback — the final frame is rendered after completion.
 */
export async function replayInstant(
  bridge: EmulatorBridge,
  segments: InputSegment[],
  snapshot: GbaSnapshot | null,
  mode: ReplayMode,
): Promise<void> {
  bridge.pause();

  if (mode === 'from-start' && snapshot) {
    bridge.loadState(snapshot);
  }

  const engine = new ScriptingEngine(bridge.gba, NOOP_HOST);
  const args = segmentsToPressSequenceArgs(segments);
  await engine.pressSequence(args);

  // Render the final frame
  bridge.runOneFrame();
}
