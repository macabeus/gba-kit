import { describe, expect, it } from 'vitest';

import { InputRecorder } from '../scripting';

describe('InputRecorder', () => {
  it('starts in idle state', () => {
    const recorder = new InputRecorder();
    expect(recorder.state).toBe('idle');
    expect(recorder.segments).toEqual([]);
    expect(recorder.totalFrames).toBe(0);
    expect(recorder.totalInputs).toBe(0);
  });

  it('ignores input when not recording', () => {
    const recorder = new InputRecorder();
    expect(recorder.onKeyDown('z')).toBeUndefined();
    expect(recorder.onKeyUp('z')).toBeUndefined();
    recorder.onFrame();
    expect(recorder.totalFrames).toBe(0);
  });

  it('records a simple button press', () => {
    const recorder = new InputRecorder();
    recorder.start();
    expect(recorder.state).toBe('recording');

    // Wait 10 frames with no input
    for (let i = 0; i < 10; i++) {
      recorder.onFrame();
    }

    // Press 'z' (A button, bit 0)
    recorder.onKeyDown('z');

    // Hold for 5 frames
    for (let i = 0; i < 5; i++) {
      recorder.onFrame();
    }

    // Release
    recorder.onKeyUp('z');

    // Wait 3 more frames
    for (let i = 0; i < 3; i++) {
      recorder.onFrame();
    }

    const segments = recorder.stop();
    expect(recorder.state).toBe('stopped');
    expect(segments).toEqual([
      { buttons: [], frames: 10 },
      { buttons: [0], frames: 5 },
      { buttons: [], frames: 3 },
    ]);
    expect(recorder.totalFrames).toBe(18);
    expect(recorder.totalInputs).toBe(1);
  });

  it('records overlapping button presses', () => {
    const recorder = new InputRecorder();
    recorder.start();

    // Press right (bit 4)
    recorder.onKeyDown('ArrowRight');
    for (let i = 0; i < 5; i++) {
      recorder.onFrame();
    }

    // Also press A (bit 0) while right is still held
    recorder.onKeyDown('z');
    for (let i = 0; i < 3; i++) {
      recorder.onFrame();
    }

    // Release right, A still held
    recorder.onKeyUp('ArrowRight');
    for (let i = 0; i < 2; i++) {
      recorder.onFrame();
    }

    // Release A
    recorder.onKeyUp('z');

    const segments = recorder.stop();
    expect(segments).toEqual([
      { buttons: [4], frames: 5 },
      { buttons: [4, 0], frames: 3 },
      { buttons: [0], frames: 2 },
    ]);
    expect(recorder.totalInputs).toBe(2);
  });

  it('ignores non-GBA keys', () => {
    const recorder = new InputRecorder();
    recorder.start();
    expect(recorder.onKeyDown('q')).toBeUndefined();
    expect(recorder.onKeyUp('q')).toBeUndefined();
    expect(recorder.totalInputs).toBe(0);
  });

  it('ignores duplicate key presses', () => {
    const recorder = new InputRecorder();
    recorder.start();
    recorder.onKeyDown('z');
    for (let i = 0; i < 3; i++) {
      recorder.onFrame();
    }
    recorder.onKeyDown('z'); // duplicate
    for (let i = 0; i < 2; i++) {
      recorder.onFrame();
    }
    recorder.onKeyUp('z');

    const segments = recorder.stop();
    // Should be a single segment of 5 frames with button pressed
    expect(segments).toEqual([{ buttons: [0], frames: 5 }]);
    expect(recorder.totalInputs).toBe(1);
  });

  it('provides live segments including in-progress segment', () => {
    const recorder = new InputRecorder();
    recorder.start();

    recorder.onKeyDown('z');
    for (let i = 0; i < 3; i++) {
      recorder.onFrame();
    }

    // Live segments should include the in-progress segment
    expect(recorder.liveSegments).toEqual([{ buttons: [0], frames: 3 }]);

    recorder.onKeyUp('z');
    for (let i = 0; i < 2; i++) {
      recorder.onFrame();
    }

    expect(recorder.liveSegments).toEqual([
      { buttons: [0], frames: 3 },
      { buttons: [], frames: 2 },
    ]);
  });

  it('resets cleanly', () => {
    const recorder = new InputRecorder();
    recorder.start();
    recorder.onKeyDown('z');
    for (let i = 0; i < 5; i++) {
      recorder.onFrame();
    }
    recorder.stop();

    recorder.reset();
    expect(recorder.state).toBe('idle');
    expect(recorder.segments).toEqual([]);
    expect(recorder.totalFrames).toBe(0);
    expect(recorder.totalInputs).toBe(0);
  });

  it('maps all GBA buttons correctly', () => {
    const recorder = new InputRecorder();
    const keyToBit: [string, number][] = [
      ['z', 0],
      ['x', 1],
      ['Backspace', 2],
      ['Enter', 3],
      ['ArrowRight', 4],
      ['ArrowLeft', 5],
      ['ArrowUp', 6],
      ['ArrowDown', 7],
      ['a', 8],
      ['s', 9],
    ];

    for (const [key, expectedBit] of keyToBit) {
      recorder.start();
      const bit = recorder.onKeyDown(key);
      expect(bit).toBe(expectedBit);
      recorder.stop();
      recorder.reset();
    }
  });
});
