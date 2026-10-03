/**
 * GBA Frame Clock — paces an animation-frame loop at the GBA's frame rate
 *
 * A browser calls `requestAnimationFrame` at its display's refresh rate: 60, 120 or 144 Hz.
 * The GBA draws FRAME_RATE (about 59.73) frames per second. The clock turns the time between
 * two callbacks into the whole GBA frames that time holds and carries the remainder, so a
 * game runs at the GBA's speed on every display: one frame every other callback at 120 Hz,
 * and one per callback at 60 Hz with a skipped callback every few seconds.
 */
import { FRAME_RATE } from '@gba-kit/gba-emulator';

/** One GBA frame, in milliseconds. */
export const FRAME_MS = 1000 / FRAME_RATE;

/**
 * The most frames one callback runs. A longer gap (a hidden tab, a stall in the page) runs
 * this many frames and lets the rest go, so the game resumes at its speed.
 */
export const MAX_FRAMES_PER_CALLBACK = 4;

export class FrameClock {
  #last: number | null = null;
  #owedMs = 0;

  /**
   * The GBA frames due at `now`, an animation-frame timestamp in milliseconds. The first call
   * after construction or `reset` starts the clock and runs one frame.
   */
  framesDue(now: number): number {
    if (this.#last === null) {
      this.#last = now;
      this.#owedMs = 0;
      return 1;
    }
    this.#owedMs += Math.max(0, now - this.#last);
    this.#last = now;
    const frames = Math.floor(this.#owedMs / FRAME_MS);
    if (frames > MAX_FRAMES_PER_CALLBACK) {
      this.#owedMs = 0;
      return MAX_FRAMES_PER_CALLBACK;
    }
    this.#owedMs -= frames * FRAME_MS;
    return frames;
  }

  /** Start over at the next `framesDue`: call it when the loop resumes after a pause. */
  reset(): void {
    this.#last = null;
  }
}
