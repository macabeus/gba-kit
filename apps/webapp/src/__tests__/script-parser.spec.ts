import { describe, expect, it } from 'vitest';

import { type InputSegment, buttonsFromString, parseScript, serializeToScript } from '../scripting';

/** Unwrap a successful parse, failing the test with the errors otherwise. */
function segmentsOf(text: string): InputSegment[] {
  const result = parseScript(text);
  if (!result.ok) {
    throw new Error(`expected parse to succeed, got: ${JSON.stringify(result.errors)}`);
  }
  return result.segments;
}

describe('buttonsFromString', () => {
  it('inverts buttonsToString for single and combined buttons', () => {
    expect(buttonsFromString('a')).toEqual([0]);
    expect(buttonsFromString('right')).toEqual([4]);
    expect(buttonsFromString('a+right')).toEqual([0, 4]);
  });

  it('sorts by bit position regardless of written order', () => {
    expect(buttonsFromString('right+a')).toEqual([0, 4]);
    expect(buttonsFromString('down+start+a')).toEqual([0, 3, 7]);
  });

  it('is case-insensitive and tolerates spaces around +', () => {
    expect(buttonsFromString('A + Right')).toEqual([0, 4]);
  });

  it('returns null for an unknown name', () => {
    expect(buttonsFromString('triangle')).toBeNull();
    expect(buttonsFromString('a+triangle')).toBeNull();
  });
});

describe('parseScript — press/wait form', () => {
  it('parses a bare press as a single frame', () => {
    expect(segmentsOf("await press('a');")).toEqual([{ buttons: [0], frames: 1 }]);
  });

  it('parses press with a hold', () => {
    expect(segmentsOf("await press('a', { hold: 5 });")).toEqual([{ buttons: [0], frames: 5 }]);
  });

  it('parses wait as an empty-button segment', () => {
    expect(segmentsOf('await wait({ frames: 10 });')).toEqual([{ buttons: [], frames: 10 }]);
  });

  it('parses a combined-button press', () => {
    expect(segmentsOf("press('a+b+right+l+r', { hold: 3 });")).toEqual([{ buttons: [0, 1, 4, 8, 9], frames: 3 }]);
  });

  it('keeps statement order across many lines', () => {
    const text = ['await wait({ frames: 10 });', "await press('a');", "await press('start', { hold: 2 });"].join('\n');
    expect(segmentsOf(text)).toEqual([
      { buttons: [], frames: 10 },
      { buttons: [0], frames: 1 },
      { buttons: [3], frames: 2 },
    ]);
  });
});

describe('parseScript — pressSequence form', () => {
  it('parses a multi-line pressSequence', () => {
    const text = ['await pressSequence([', "  ['a+right', 5],", '  [null, 10],', ']);'].join('\n');
    expect(segmentsOf(text)).toEqual([
      { buttons: [0, 4], frames: 5 },
      { buttons: [], frames: 10 },
    ]);
  });

  it('parses a single-line pressSequence', () => {
    expect(segmentsOf("await pressSequence([['a', 1], [null, 2]]);")).toEqual([
      { buttons: [0], frames: 1 },
      { buttons: [], frames: 2 },
    ]);
  });

  it('parses several pressSequence calls in order', () => {
    const text = ["pressSequence([['a', 1]]);", "pressSequence([['b', 2]]);"].join('\n');
    expect(segmentsOf(text)).toEqual([
      { buttons: [0], frames: 1 },
      { buttons: [1], frames: 2 },
    ]);
  });
});

describe('parseScript — hand-editing tolerance', () => {
  it('accepts missing await and missing semicolons', () => {
    expect(segmentsOf("press('a')")).toEqual([{ buttons: [0], frames: 1 }]);
  });

  it('accepts double quotes', () => {
    expect(segmentsOf('await press("a");')).toEqual([{ buttons: [0], frames: 1 }]);
  });

  it('ignores line and block comments and blank lines', () => {
    const text = ['// boot combo', '/* several', '   lines */', '', "await press('a'); // trailing", ''].join('\n');
    expect(segmentsOf(text)).toEqual([{ buttons: [0], frames: 1 }]);
  });

  it('does not treat a // inside a string as a comment', () => {
    const result = parseScript("await press('a//b');");
    expect(result.ok).toBe(false);
  });

  it('parses the empty-recording placeholder as zero segments', () => {
    expect(segmentsOf('// No inputs recorded')).toEqual([]);
  });
});

describe('parseScript — errors', () => {
  it('reports unknown buttons with a line number', () => {
    const result = parseScript(["await press('a');", "await press('triangle');"].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(2);
    expect(result.errors[0]!.message).toContain('triangle');
  });

  it('rejects unsupported commands instead of skipping them', () => {
    const result = parseScript("await screenshot({ name: 'x' });");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors[0]!.message).toContain('unsupported statement');
  });

  it('rejects a malformed pressSequence entry rather than dropping it', () => {
    const result = parseScript("await pressSequence([['a', 1], ['b']]);");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors[0]!.message).toContain('malformed');
  });

  it('rejects zero-frame durations', () => {
    expect(parseScript('await wait({ frames: 0 });').ok).toBe(false);
  });

  it('reports every bad line, not just the first', () => {
    const result = parseScript(["await press('triangle');", 'await frobnicate();'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.map((e) => e.line)).toEqual([1, 2]);
  });
});

describe('parseScript round-trips serializeToScript', () => {
  const cases: Record<string, InputSegment[]> = {
    'simple form (single buttons only)': [
      { buttons: [], frames: 10 },
      { buttons: [0], frames: 1 },
      { buttons: [], frames: 5 },
      { buttons: [3], frames: 3 },
    ],
    'pressSequence form (has a combined press)': [
      { buttons: [0, 4], frames: 5 },
      { buttons: [], frames: 10 },
      { buttons: [0, 1, 4, 8, 9], frames: 2 },
    ],
    'single segment': [{ buttons: [9], frames: 42 }],
  };

  for (const [name, segments] of Object.entries(cases)) {
    it(`recovers the original segments — ${name}`, () => {
      expect(segmentsOf(serializeToScript(segments))).toEqual(segments);
    });
  }
});

describe('parseScript — segment line mapping', () => {
  it('maps each pressSequence entry to its own line', () => {
    const text = ['// header', 'await pressSequence([', "  ['a', 5],", '  [null, 10],', ']);'].join('\n');
    const result = parseScript(text);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.segmentLines).toEqual([2, 3]);
  });

  it('maps press/wait statements to their own lines, skipping comments', () => {
    const text = ['// header', '', "await press('a');", '// note', 'await wait({ frames: 4 });'].join('\n');
    const result = parseScript(text);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.segmentLines).toEqual([2, 4]);
  });
});
