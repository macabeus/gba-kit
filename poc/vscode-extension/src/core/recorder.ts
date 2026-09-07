/**
 * Input recorder + script serializer — a trimmed copy of the webapp's
 * `apps/webapp/src/scripting/{input-recorder,script-serializer}.ts`, keyed by GBA
 * button bit instead of keyboard key so it is UI-agnostic. In the real project this
 * would move into a shared package rather than be copied.
 */

const BIT_TO_BUTTON_NAME: Record<number, string> = {
  0: 'a',
  1: 'b',
  2: 'select',
  3: 'start',
  4: 'right',
  5: 'left',
  6: 'up',
  7: 'down',
  8: 'r',
  9: 'l',
};

export interface InputSegment {
  buttons: number[];
  frames: number;
}

export class InputRecorder {
  #segments: InputSegment[] = [];
  #current = new Set<number>();
  #currentFrames = 0;
  #recording = false;

  get recording(): boolean {
    return this.#recording;
  }

  start(initialButtons: Iterable<number>): void {
    this.#segments = [];
    this.#current = new Set(initialButtons);
    this.#currentFrames = 0;
    this.#recording = true;
  }

  stop(): InputSegment[] {
    if (!this.#recording) {
      return this.#segments;
    }
    this.#close();
    this.#recording = false;
    return this.#segments;
  }

  onFrame(): void {
    if (this.#recording) {
      this.#currentFrames++;
    }
  }

  onButton(bit: number, down: boolean): void {
    if (!this.#recording || this.#current.has(bit) === down) {
      return;
    }
    this.#close();
    if (down) {
      this.#current.add(bit);
    } else {
      this.#current.delete(bit);
    }
  }

  #close(): void {
    if (this.#currentFrames > 0) {
      this.#segments.push({ buttons: [...this.#current], frames: this.#currentFrames });
      this.#currentFrames = 0;
    }
  }
}

function buttonsToString(buttons: number[]): string | null {
  if (buttons.length === 0) {
    return null;
  }
  return buttons
    .slice()
    .sort((a, b) => a - b)
    .map((bit) => BIT_TO_BUTTON_NAME[bit] ?? `unknown(${bit})`)
    .join('+');
}

/** Segments -> a script in the gba-kit scripting dialect (docs/scripting.md). */
export function serializeToScript(segments: InputSegment[]): string {
  if (segments.length === 0) {
    return '// No inputs recorded';
  }
  const simple = segments.every((s) => s.buttons.length <= 1);
  if (simple) {
    return segments
      .map((seg) => {
        if (seg.buttons.length === 0) {
          return `await wait({ frames: ${seg.frames} });`;
        }
        const name = buttonsToString(seg.buttons)!;
        return seg.frames === 1 ? `await press('${name}');` : `await press('${name}', { hold: ${seg.frames} });`;
      })
      .join('\n');
  }
  const lines = ['await pressSequence(['];
  for (const seg of segments) {
    const btn = buttonsToString(seg.buttons);
    lines.push(btn === null ? `  [null, ${seg.frames}],` : `  ['${btn}', ${seg.frames}],`);
  }
  lines.push(']);');
  return lines.join('\n');
}
