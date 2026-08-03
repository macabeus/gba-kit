/**
 * Script Serializer
 *
 * Converts recorded InputSegments into script text compatible with
 * the gba-kit scripting API (see SCRIPTING.md).
 *
 * All input→command mapping is centralized here. To add a new input
 * type, add its bit→name entry to BIT_TO_BUTTON_NAME.
 *
 * Extension points:
 * - Conditional/branching scripts: insert memory-check wait() calls between segments
 * - Debugger integration: generate breakpoint/assert calls at key points
 * - Per-frame assertions: emit assert() calls from captured state snapshots
 */
import type { InputSegment } from './input-recorder';

/** GBA button bit position → script button name */
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

/** Script button name → GBA button bit position (inverse of BIT_TO_BUTTON_NAME). */
const BUTTON_NAME_TO_BIT: Record<string, number> = Object.fromEntries(
  Object.entries(BIT_TO_BUTTON_NAME).map(([bit, name]) => [name, Number(bit)]),
);

/** The button names a script may use, for error messages. */
export const BUTTON_NAMES: readonly string[] = Object.values(BIT_TO_BUTTON_NAME);

/**
 * Parse a '+'-separated button name string back into bit positions.
 * Inverse of buttonsToString. Returns null if any name is unknown, so the
 * caller can report which token was bad rather than silently dropping input.
 */
export function buttonsFromString(text: string): number[] | null {
  const names = text.split('+').map((n) => n.trim());
  const bits: number[] = [];
  for (const name of names) {
    const bit = BUTTON_NAME_TO_BIT[name.toLowerCase()];
    if (bit === undefined) {
      return null;
    }
    bits.push(bit);
  }
  return bits.sort((a, b) => a - b);
}

/** Convert button bit positions to a sorted '+'-separated name string. */
export function buttonsToString(buttons: number[]): string | null {
  if (buttons.length === 0) {
    return null;
  }
  return buttons
    .slice()
    .sort((a, b) => a - b)
    .map((bit) => BIT_TO_BUTTON_NAME[bit] ?? `unknown(${bit})`)
    .join('+');
}

/**
 * Check if a sequence is "simple" — non-overlapping single-button presses
 * separated by waits. Simple sequences use press()/wait() for readability.
 */
function isSimpleSequence(segments: InputSegment[]): boolean {
  for (const seg of segments) {
    if (seg.buttons.length > 1) {
      return false;
    }
  }
  return true;
}

/** Script text with a mapping from segment index to line index for debugging. */
export interface ScriptWithMapping {
  text: string;
  lines: string[];
  /** segmentToLine[segmentIndex] = lineIndex (0-based) in `lines` */
  segmentToLine: number[];
}

/**
 * Convert recorded segments to a well-formed script string.
 * Uses press()/wait() for simple sequences, pressSequence() for complex ones.
 */
export function serializeToScript(segments: InputSegment[]): string {
  return serializeToScriptWithMapping(segments).text;
}

/**
 * Like serializeToScript, but also returns a mapping from each segment
 * index to the line index it produced. Used by the replay debugger to
 * highlight the currently executing line.
 */
export function serializeToScriptWithMapping(segments: InputSegment[]): ScriptWithMapping {
  if (segments.length === 0) {
    const text = '// No inputs recorded';
    return { text, lines: [text], segmentToLine: [] };
  }

  if (isSimpleSequence(segments)) {
    const lines: string[] = [];
    const segmentToLine: number[] = [];
    for (let i = 0; i < segments.length; i++) {
      segmentToLine.push(lines.length);
      const seg = segments[i]!;
      if (seg.buttons.length === 0) {
        lines.push(`await wait({ frames: ${seg.frames} });`);
      } else {
        const name = buttonsToString(seg.buttons)!;
        if (seg.frames === 1) {
          lines.push(`await press('${name}');`);
        } else {
          lines.push(`await press('${name}', { hold: ${seg.frames} });`);
        }
      }
    }
    return { text: lines.join('\n'), lines, segmentToLine };
  }

  // pressSequence format
  const lines: string[] = ['await pressSequence(['];
  const segmentToLine: number[] = [];

  for (let i = 0; i < segments.length; i++) {
    segmentToLine.push(lines.length);
    const seg = segments[i]!;
    const btnStr = buttonsToString(seg.buttons);
    if (btnStr === null) {
      lines.push(`  [null, ${seg.frames}],`);
    } else {
      lines.push(`  ['${btnStr}', ${seg.frames}],`);
    }
  }

  lines.push(']);');
  return { text: lines.join('\n'), lines, segmentToLine };
}

/**
 * Convert segments to pressSequence() argument format for direct replay
 * via ScriptingEngine.pressSequence().
 */
export function segmentsToPressSequenceArgs(segments: InputSegment[]): [string | null, number][] {
  return segments.map((seg) => [buttonsToString(seg.buttons), seg.frames]);
}
