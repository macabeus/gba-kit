/**
 * Input Recorder
 *
 * Captures button state changes per frame during gameplay, producing a
 * sequence of input segments that map directly to script commands.
 */

/** Keyboard key → GBA button bit position (mirrors KEY_MAP in emulator.ts) */
const KEY_TO_BUTTON_BIT: Record<string, number> = {
  ArrowRight: 4,
  ArrowLeft: 5,
  ArrowUp: 6,
  ArrowDown: 7,
  z: 0, // A
  x: 1, // B
  Backspace: 2, // Select
  Enter: 3, // Start
  a: 8, // R
  s: 9, // L
};

export interface InputSegment {
  /** GBA button bit positions held during this segment */
  buttons: number[];
  /** Duration in emulator frames */
  frames: number;
}

export type RecordingState = 'idle' | 'recording' | 'stopped';

export class InputRecorder {
  #segments: InputSegment[] = [];
  #currentButtons: Set<number> = new Set();
  #currentSegmentFrames = 0;
  #state: RecordingState = 'idle';
  #totalFrames = 0;
  #totalInputs = 0;

  get state(): RecordingState {
    return this.#state;
  }

  get segments(): InputSegment[] {
    return this.#segments;
  }

  get totalFrames(): number {
    return this.#totalFrames;
  }

  get totalInputs(): number {
    return this.#totalInputs;
  }

  /** Get a live snapshot including the current in-progress segment. */
  get liveSegments(): InputSegment[] {
    if (this.#state !== 'recording') {
      return this.#segments;
    }
    if (this.#currentSegmentFrames === 0) {
      return this.#segments;
    }
    return [...this.#segments, { buttons: [...this.#currentButtons], frames: this.#currentSegmentFrames }];
  }

  start(): void {
    this.#segments = [];
    this.#currentButtons = new Set();
    this.#currentSegmentFrames = 0;
    this.#state = 'recording';
    this.#totalFrames = 0;
    this.#totalInputs = 0;
  }

  stop(): InputSegment[] {
    if (this.#state !== 'recording') {
      return this.#segments;
    }
    this.#closeCurrentSegment();
    this.#state = 'stopped';
    return this.#segments;
  }

  reset(): void {
    this.#segments = [];
    this.#currentButtons = new Set();
    this.#currentSegmentFrames = 0;
    this.#state = 'idle';
    this.#totalFrames = 0;
    this.#totalInputs = 0;
  }

  /** Called on each emulator frame. */
  onFrame(): void {
    if (this.#state !== 'recording') {
      return;
    }
    this.#currentSegmentFrames++;
    this.#totalFrames++;
  }

  /** Called when a key is pressed. Returns the button bit if it was a GBA key. */
  onKeyDown(key: string): number | undefined {
    if (this.#state !== 'recording') {
      return undefined;
    }
    const bit = KEY_TO_BUTTON_BIT[key];
    if (bit === undefined) {
      return undefined;
    }
    if (this.#currentButtons.has(bit)) {
      return bit;
    }

    this.#closeCurrentSegment();
    this.#currentButtons.add(bit);
    this.#totalInputs++;
    return bit;
  }

  /** Called when a key is released. Returns the button bit if it was a GBA key. */
  onKeyUp(key: string): number | undefined {
    if (this.#state !== 'recording') {
      return undefined;
    }
    const bit = KEY_TO_BUTTON_BIT[key];
    if (bit === undefined) {
      return undefined;
    }
    if (!this.#currentButtons.has(bit)) {
      return undefined;
    }

    this.#closeCurrentSegment();
    this.#currentButtons.delete(bit);
    return bit;
  }

  #closeCurrentSegment(): void {
    if (this.#currentSegmentFrames > 0) {
      this.#segments.push({
        buttons: [...this.#currentButtons],
        frames: this.#currentSegmentFrames,
      });
      this.#currentSegmentFrames = 0;
    }
  }
}
