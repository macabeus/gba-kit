/**
 * The Play page's loop runs at the GBA's frame rate (59.7275 Hz) whatever the display's
 * refresh rate: a 120 Hz display calls `requestAnimationFrame` twice per GBA frame, and a
 * 60 Hz display a little more than once. The animation frame is stubbed so each callback
 * gets the timestamp a display of a given rate would give it.
 */
import { EmulatorBridge, FRAME_MS, FrameClock, MAX_FRAMES_PER_CALLBACK } from '@gba-kit/gba-browser';
import { FRAME_RATE } from '@gba-kit/gba-emulator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixture } from './fixtures';

describe('FrameClock', () => {
  /** The frames a display at `hz` is given over `seconds`, one `framesDue` per refresh. */
  function framesOver(hz: number, seconds: number): number {
    const clock = new FrameClock();
    let frames = 0;
    for (let i = 0; i <= hz * seconds; i++) {
      frames += clock.framesDue(1000 + (i * 1000) / hz);
    }
    return frames;
  }

  it('gives the GBA frame rate on a 60, 120 and 144 Hz display', () => {
    for (const hz of [60, 120, 144]) {
      expect(Math.abs(framesOver(hz, 10) - FRAME_RATE * 10)).toBeLessThanOrEqual(1);
    }
  });

  it('runs one frame when it starts, and one per GBA frame period after', () => {
    const clock = new FrameClock();
    expect(clock.framesDue(500)).toBe(1);
    expect(clock.framesDue(500 + FRAME_MS / 2)).toBe(0);
    expect(clock.framesDue(500 + FRAME_MS)).toBe(1);
    expect(clock.framesDue(500 + 3 * FRAME_MS)).toBe(2);
  });

  it('runs at most a few frames after a long gap, and lets the rest go', () => {
    const clock = new FrameClock();
    clock.framesDue(0);
    expect(clock.framesDue(5000)).toBe(MAX_FRAMES_PER_CALLBACK);
    expect(clock.framesDue(5000 + FRAME_MS / 2)).toBe(0);
  });

  it('starts over after reset, without counting the time it was paused', () => {
    const clock = new FrameClock();
    clock.framesDue(0);
    clock.reset();
    expect(clock.framesDue(10_000)).toBe(1);
    expect(clock.framesDue(10_000 + FRAME_MS / 2)).toBe(0);
  });
});

/** Animation-frame callbacks the bridge asked for, run by the test with the timestamps it chooses. */
const pending: FrameRequestCallback[] = [];
const saved: Partial<Record<'ImageData' | 'requestAnimationFrame' | 'cancelAnimationFrame', unknown>> = {};

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const name of ['ImageData', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    saved[name] = g[name];
  }
  g['ImageData'] = class {
    readonly data: Uint8ClampedArray;
    constructor(width: number, height: number) {
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
  g['requestAnimationFrame'] = (callback: FrameRequestCallback): number => pending.push(callback);
  g['cancelAnimationFrame'] = (): void => {
    pending.length = 0;
  };
});

afterAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete g[name];
    } else {
      g[name] = value;
    }
  }
});

describe('EmulatorBridge on a fast display', () => {
  it('runs one second of a 120 Hz display as one second of GBA frames', () => {
    const { rom } = fixture('thumb-O0');
    const bridge = new EmulatorBridge();
    bridge.loadRom(rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength) as ArrayBuffer);

    bridge.run();
    const firstFrame = bridge.gba.frameCount;
    for (let i = 0; i < 120; i++) {
      pending.shift()!(1000 + (i * 1000) / 120);
    }
    bridge.pause();

    expect(bridge.gba.frameCount - firstFrame).toBeGreaterThanOrEqual(Math.floor(FRAME_RATE) - 1);
    expect(bridge.gba.frameCount - firstFrame).toBeLessThanOrEqual(Math.ceil(FRAME_RATE));
  });
});
