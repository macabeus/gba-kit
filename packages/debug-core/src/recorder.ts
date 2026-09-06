/**
 * Input recordings: the buttons held on every frame of a range, bound to the ROM
 * and to the frame the recording started on. Replayed by the session by pushing
 * the masks through the machine; exported as gba-kit's scripting dialect for
 * humans, and kept as files under a project's `.gba-kit/recordings/`.
 */
import { base64ToBytes, bytesToBase64 } from './snapshot-codec.js';

export interface InputRecording {
  format: 'gba-kit-input';
  version: 1;
  romHash: string;
  /** the frame the first mask applies to; a recording from boot starts at 0 */
  startFrame: number;
  /** buttons held per frame, bit set = pressed (GBA button bit order) */
  frames: number[];
}

const BUTTON_NAMES = ['a', 'b', 'select', 'start', 'right', 'left', 'up', 'down', 'r', 'l'] as const;

/** A finished recording, with the screen it began on, so a view can show what it replays. */
export interface RecordedTake {
  /** unique within a session, and stable while it is listed */
  id: number;
  recording: InputRecording;
  /** the same input as a `press`/`wait` script */
  script: string;
  /** the screen where the recording begins, halved in each axis */
  thumbnail: { width: number; height: number; rgba: Uint8Array };
  /** when the recording was stopped, or when the file holding it was written */
  createdAt: string;
}

/**
 * A take as a file: the input, the screen it began on, and when it was taken. The
 * script is not stored, being what `recordingToScript` makes of the input.
 */
export interface RecordingFile {
  format: 'gba-kit-recording';
  version: 1;
  createdAt: string;
  thumbnail: { width: number; height: number; rgba: string };
  recording: InputRecording;
}

export function encodeTake(take: Omit<RecordedTake, 'id'>): string {
  const file: RecordingFile = {
    format: 'gba-kit-recording',
    version: 1,
    createdAt: take.createdAt,
    thumbnail: {
      width: take.thumbnail.width,
      height: take.thumbnail.height,
      rgba: bytesToBase64(take.thumbnail.rgba),
    },
    recording: take.recording,
  };
  return JSON.stringify(file);
}

/** Throws when the text is not one of these files, so a reader can skip it and go on. */
export function decodeTake(text: string): Omit<RecordedTake, 'id'> {
  const file = JSON.parse(text) as RecordingFile;
  const shot = file.thumbnail;
  if (file.format !== 'gba-kit-recording' || !shot || typeof shot.rgba !== 'string') {
    throw new Error('not a gba-kit recording');
  }
  return {
    recording: parseRecording(JSON.stringify(file.recording)),
    script: recordingToScript(file.recording),
    thumbnail: { width: shot.width, height: shot.height, rgba: base64ToBytes(shot.rgba) },
    createdAt: typeof file.createdAt === 'string' ? file.createdAt : '',
  };
}

/** how many buttons the GBA has: bits 0–9 of a mask, in `BUTTON_NAMES` order */
export const BUTTON_COUNT = BUTTON_NAMES.length;

export function buttonsToNames(mask: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < BUTTON_COUNT; i++) {
    if (mask & (1 << i)) {
      out.push(BUTTON_NAMES[i]!);
    }
  }
  return out;
}

export function namesToButtons(names: Iterable<string>): number {
  let mask = 0;
  for (const n of names) {
    const i = BUTTON_NAMES.indexOf(n.toLowerCase() as (typeof BUTTON_NAMES)[number]);
    if (i >= 0) {
      mask |= 1 << i;
    }
  }
  return mask;
}

/** Collapse per-frame masks into `[buttons, frames]` segments. */
export function toSegments(frames: number[]): Array<{ buttons: number; frames: number }> {
  const out: Array<{ buttons: number; frames: number }> = [];
  for (const mask of frames) {
    const last = out[out.length - 1];
    if (last && last.buttons === mask) {
      last.frames++;
    } else {
      out.push({ buttons: mask, frames: 1 });
    }
  }
  return out;
}

/** The recording as a script in gba-kit's dialect (docs/scripting.md). */
export function recordingToScript(recording: InputRecording): string {
  const segments = toSegments(recording.frames);
  if (segments.length === 0) {
    return '// No inputs recorded';
  }
  const header = `// Recorded from frame ${recording.startFrame} (ROM ${recording.romHash.slice(0, 12)})`;
  const simple = segments.every((s) => buttonsToNames(s.buttons).length <= 1);
  if (simple) {
    const lines = segments.map((seg) => {
      const names = buttonsToNames(seg.buttons);
      if (names.length === 0) {
        return `await wait({ frames: ${seg.frames} });`;
      }
      return seg.frames === 1 ? `await press('${names[0]}');` : `await press('${names[0]}', { hold: ${seg.frames} });`;
    });
    return [header, ...lines].join('\n');
  }
  const lines = [header, 'await pressSequence(['];
  for (const seg of segments) {
    const names = buttonsToNames(seg.buttons);
    lines.push(names.length === 0 ? `  [null, ${seg.frames}],` : `  ['${names.join('+')}', ${seg.frames}],`);
  }
  lines.push(']);');
  return lines.join('\n');
}

export function parseRecording(text: string): InputRecording {
  const r = JSON.parse(text) as InputRecording;
  if (r.format !== 'gba-kit-input' || !Array.isArray(r.frames)) {
    throw new Error('not a gba-kit input recording');
  }
  return r;
}
