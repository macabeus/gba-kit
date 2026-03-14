import { describe, expect, it } from 'vitest';

import {
  type InputSegment,
  buttonsToString,
  segmentsToPressSequenceArgs,
  serializeToScript,
  serializeToScriptWithMapping,
} from '../scripting';

describe('buttonsToString', () => {
  it('returns null for empty buttons', () => {
    expect(buttonsToString([])).toBeNull();
  });

  it('converts single button', () => {
    expect(buttonsToString([0])).toBe('a');
    expect(buttonsToString([4])).toBe('right');
  });

  it('converts multiple buttons sorted by bit position', () => {
    expect(buttonsToString([4, 0])).toBe('a+right');
    expect(buttonsToString([7, 3, 0])).toBe('a+start+down');
  });
});

describe('serializeToScript', () => {
  it('returns comment for empty segments', () => {
    expect(serializeToScript([])).toBe('// No inputs recorded');
  });

  it('serializes simple single-button sequence with press/wait', () => {
    const segments: InputSegment[] = [
      { buttons: [], frames: 10 },
      { buttons: [0], frames: 1 },
      { buttons: [], frames: 5 },
      { buttons: [3], frames: 3 },
    ];

    const result = serializeToScript(segments);
    expect(result).toBe(
      `await wait({ frames: 10 });\n` +
        `await press('a');\n` +
        `await wait({ frames: 5 });\n` +
        `await press('start', { hold: 3 });`,
    );
  });

  it('serializes overlapping buttons with pressSequence', () => {
    const segments: InputSegment[] = [
      { buttons: [4], frames: 5 },
      { buttons: [4, 0], frames: 3 },
      { buttons: [0], frames: 2 },
    ];

    const result = serializeToScript(segments);
    expect(result).toBe(
      `await pressSequence([\n` + `  ['right', 5],\n` + `  ['a+right', 3],\n` + `  ['a', 2],\n` + `]);`,
    );
  });

  it('handles wait-only segments in pressSequence', () => {
    const segments: InputSegment[] = [
      { buttons: [4, 0], frames: 3 },
      { buttons: [], frames: 10 },
      { buttons: [1], frames: 2 },
    ];

    const result = serializeToScript(segments);
    expect(result).toContain('[null, 10],');
  });

  it('serializes single press with hold=1 without hold option', () => {
    const segments: InputSegment[] = [{ buttons: [0], frames: 1 }];
    const result = serializeToScript(segments);
    expect(result).toBe("await press('a');");
  });
});

describe('serializeToScriptWithMapping', () => {
  it('maps simple segments 1:1 to lines', () => {
    const segments: InputSegment[] = [
      { buttons: [], frames: 10 },
      { buttons: [0], frames: 1 },
      { buttons: [], frames: 5 },
    ];

    const result = serializeToScriptWithMapping(segments);
    expect(result.lines).toHaveLength(3);
    expect(result.segmentToLine).toEqual([0, 1, 2]);
    expect(result.lines[0]).toBe('await wait({ frames: 10 });');
    expect(result.lines[1]).toBe("await press('a');");
    expect(result.lines[2]).toBe('await wait({ frames: 5 });');
  });

  it('maps pressSequence segments with +1 offset for the header line', () => {
    const segments: InputSegment[] = [
      { buttons: [4], frames: 5 },
      { buttons: [4, 0], frames: 3 },
      { buttons: [0], frames: 2 },
    ];

    const result = serializeToScriptWithMapping(segments);
    // Line 0: 'await pressSequence(['
    // Line 1: segment 0
    // Line 2: segment 1
    // Line 3: segment 2
    // Line 4: ']);'
    expect(result.lines).toHaveLength(5);
    expect(result.segmentToLine).toEqual([1, 2, 3]);
    expect(result.lines[0]).toBe('await pressSequence([');
    expect(result.lines[4]).toBe(']);');
  });

  it('returns empty mapping for no segments', () => {
    const result = serializeToScriptWithMapping([]);
    expect(result.segmentToLine).toEqual([]);
    expect(result.lines).toEqual(['// No inputs recorded']);
  });

  it('text matches serializeToScript output', () => {
    const segments: InputSegment[] = [
      { buttons: [4], frames: 5 },
      { buttons: [4, 0], frames: 3 },
    ];

    const mapping = serializeToScriptWithMapping(segments);
    const text = serializeToScript(segments);
    expect(mapping.text).toBe(text);
  });
});

describe('segmentsToPressSequenceArgs', () => {
  it('converts segments to pressSequence argument format', () => {
    const segments: InputSegment[] = [
      { buttons: [4], frames: 30 },
      { buttons: [], frames: 10 },
      { buttons: [4, 1], frames: 5 },
    ];

    const args = segmentsToPressSequenceArgs(segments);
    expect(args).toEqual([
      ['right', 30],
      [null, 10],
      ['b+right', 5],
    ]);
  });
});
