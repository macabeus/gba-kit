/**
 * Script Parser
 *
 * Turns script text back into InputSegments — the inverse of script-serializer,
 * so a script that was recorded, downloaded and later loaded from disk replays
 * identically. Hand-written scripts work too, as long as they stick to the
 * input subset of the scripting API.
 *
 * Both serializer output shapes are accepted:
 *   await press('a');  await press('a', { hold: 5 });  await wait({ frames: 10 });
 *   await pressSequence([ ['a+right', 5], [null, 10] ]);
 * plus the usual hand-editing variance: `await` optional, single or double
 * quotes, optional trailing semicolons, comments and blank lines anywhere.
 *
 * Anything else is a hard error rather than a silent skip: a replay tool that
 * quietly ignored `await screenshot(...)` would run something other than what
 * the file says.
 *
 * Extension points:
 * - To support a new input command, add a matcher to parseStatement.
 * - Non-input commands (screenshot, assert) need a richer segment model than
 *   InputSegment before they can be represented here.
 */
import type { InputSegment } from './input-recorder';
import { BUTTON_NAMES, buttonsFromString } from './script-serializer';

export interface ScriptParseError {
  /** 1-based line number in the original text. */
  line: number;
  message: string;
}

export type ScriptParseResult =
  | {
      ok: true;
      segments: InputSegment[];
      /**
       * segmentLines[i] = 0-based line in the original text that produced
       * segments[i], so a loaded file can be displayed verbatim and still
       * highlight the right line while replaying.
       */
      segmentLines: number[];
    }
  | { ok: false; errors: ScriptParseError[] };

/**
 * Blank out `//` and block comments, replacing them with spaces so that every
 * remaining character keeps its original offset (and therefore its line
 * number) for error reporting. Quoted strings are respected so a `//` inside
 * a button name is not treated as a comment.
 */
function blankComments(text: string): string {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        i += text[i] === '\\' ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') {
          out[i] = ' ';
        }
        i++;
      }
      // Blank the closing */ too, if it is there.
      for (let k = i; k < Math.min(i + 2, text.length); k++) {
        out[k] = ' ';
      }
      i += 2;
      continue;
    }
    i++;
  }
  return out.join('');
}

interface Statement {
  text: string;
  /** Offset of the statement's first character in the original text. */
  offset: number;
}

/**
 * Split into statements at top-level `;`, ignoring semicolons nested inside
 * brackets or strings. A trailing statement without a semicolon is kept.
 */
function splitStatements(text: string): Statement[] {
  const statements: Statement[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  const push = (end: number) => {
    const raw = text.slice(start, end);
    if (raw.trim().length > 0) {
      const lead = raw.length - raw.trimStart().length;
      statements.push({ text: raw.trim(), offset: start + lead });
    }
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        i += text[i] === '\\' ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    } else if (ch === ';' && depth <= 0) {
      push(i);
      start = i + 1;
    }
    i++;
  }
  push(text.length);
  return statements;
}

const PRESS_RE = /^(?:await\s+)?press\(\s*(['"])(.*?)\1\s*(?:,\s*\{\s*hold\s*:\s*(\d+)\s*\}\s*)?\)$/;
const WAIT_RE = /^(?:await\s+)?wait\(\s*\{\s*frames\s*:\s*(\d+)\s*\}\s*\)$/;
const PRESS_SEQUENCE_RE = /^(?:await\s+)?pressSequence\(\s*\[([\s\S]*)\]\s*\)$/;
const ENTRY_RE = /\[\s*(?:(['"])(.*?)\1|null)\s*,\s*(\d+)\s*\]/g;

/** Segments produced by one statement, with each one's offset inside it. */
interface ParsedStatement {
  segments: InputSegment[];
  /** offsets[i] = character offset of segments[i] within the statement text. */
  offsets: number[];
}

/** Parse one statement into segments, or return an error message. */
function parseStatement(stmt: string): ParsedStatement | string {
  const press = PRESS_RE.exec(stmt);
  if (press) {
    const bits = buttonsFromString(press[2]!);
    if (bits === null || bits.length === 0) {
      return `unknown button '${press[2]}' (expected one or more of ${BUTTON_NAMES.join(', ')}, joined by '+')`;
    }
    const frames = press[3] === undefined ? 1 : Number(press[3]);
    if (frames < 1) {
      return 'hold must be at least 1 frame';
    }
    return { segments: [{ buttons: bits, frames }], offsets: [0] };
  }

  const wait = WAIT_RE.exec(stmt);
  if (wait) {
    const frames = Number(wait[1]);
    if (frames < 1) {
      return 'frames must be at least 1';
    }
    return { segments: [{ buttons: [], frames }], offsets: [0] };
  }

  const sequence = PRESS_SEQUENCE_RE.exec(stmt);
  if (sequence) {
    const body = sequence[1]!;
    // The regex anchors `pressSequence(` then `[`, so the body starts just
    // after the first `[` — used to map entry offsets back to the statement.
    const bodyStart = stmt.indexOf('[') + 1;
    const segments: InputSegment[] = [];
    const offsets: number[] = [];
    ENTRY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ENTRY_RE.exec(body)) !== null) {
      const name = match[2];
      const frames = Number(match[3]);
      if (frames < 1) {
        return 'each pressSequence entry needs at least 1 frame';
      }
      if (name === undefined) {
        segments.push({ buttons: [], frames });
      } else {
        const bits = buttonsFromString(name);
        if (bits === null || bits.length === 0) {
          return `unknown button '${name}' (expected one or more of ${BUTTON_NAMES.join(', ')}, joined by '+')`;
        }
        segments.push({ buttons: bits, frames });
      }
      offsets.push(bodyStart + match.index);
    }
    // Guard against a malformed entry being silently skipped: everything in the
    // array body other than the matched entries must be separators.
    const leftover = body.replace(ENTRY_RE, '').replace(/[\s,]/g, '');
    if (leftover.length > 0 || (segments.length === 0 && body.trim().length > 0)) {
      return "malformed pressSequence entry — expected ['button', frames] or [null, frames]";
    }
    return { segments, offsets };
  }

  return 'unsupported statement — only press(), wait() and pressSequence() can be replayed';
}

/**
 * Parse script text into the segments a replayer can run.
 *
 * A file with no input commands at all parses to zero segments rather than an
 * error, so the placeholder the serializer writes for an empty recording
 * ("// No inputs recorded") round-trips.
 */
export function parseScript(text: string): ScriptParseResult {
  const blanked = blankComments(text);
  const errors: ScriptParseError[] = [];
  const segments: InputSegment[] = [];
  const segmentLines: number[] = [];

  // Offsets of each line start, so an offset maps to a line by binary search.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  /** 0-based line index containing `offset`. */
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  };

  for (const stmt of splitStatements(blanked)) {
    const result = parseStatement(stmt.text);
    if (typeof result === 'string') {
      errors.push({ line: lineAt(stmt.offset) + 1, message: result });
    } else {
      for (let i = 0; i < result.segments.length; i++) {
        segments.push(result.segments[i]!);
        segmentLines.push(lineAt(stmt.offset + (result.offsets[i] ?? 0)));
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, segments, segmentLines };
}
