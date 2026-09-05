/**
 * Panels rendered against a fixed debugger state: what the controls show for a
 * given `StateBody`, with the state hook stood in for (no host, no effects).
 */
import type { StateBody } from '@gba-kit/debug-core/protocol';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { RecordingPanel } from '../panels/RecordingPanel.js';
import { ScreenPanel } from '../panels/ScreenPanel.js';
import type { Transport } from '../transport.js';

const current = vi.hoisted(() => ({ state: null as StateBody | null }));
vi.mock('../hooks.js', () => ({ useDebugState: () => current.state }));

const transport = {
  request: () => Promise.reject(new Error('not in this test')),
  control: () => Promise.resolve(),
  onState: () => () => {},
  onFrame: () => () => {},
  onAudio: () => () => {},
  onLabels: () => () => {},
} satisfies Transport;

function stoppedAt(frame: number, extra: Partial<StateBody> = {}): StateBody {
  return {
    state: 'stopped',
    frame,
    pc: 0x08000100,
    position: { frame, instruction: 0, scanline: 0, cycle: 0, pc: 0x08000100 },
    revision: 1,
    epoch: 0,
    history: { earliestFrame: 0, keyframes: 1, bytes: 0, recording: false, recordingStart: null },
    recording: false,
    tracing: false,
    ...extra,
  };
}

function rewindButton(html: string): string {
  return html.match(/<button[^>]*title="Rewind 60 frames"[^>]*>/)?.[0] ?? '';
}

describe('screen panel controls', () => {
  it('offers rewind only when stopped with history behind the machine', () => {
    current.state = stoppedAt(5);
    expect(rewindButton(renderToString(<ScreenPanel transport={transport} />))).not.toContain('disabled');
    current.state = stoppedAt(5, {
      history: { earliestFrame: null, keyframes: 0, bytes: 0, recording: false, recordingStart: null },
    });
    expect(rewindButton(renderToString(<ScreenPanel transport={transport} />))).toContain('disabled');
    current.state = { ...stoppedAt(5), state: 'running' };
    expect(rewindButton(renderToString(<ScreenPanel transport={transport} />))).toContain('disabled');
    current.state = null;
    expect(rewindButton(renderToString(<ScreenPanel transport={transport} />))).toContain('disabled');
  });

  it('names the sound toggle for a screen reader', () => {
    current.state = stoppedAt(0);
    const html = renderToString(<ScreenPanel transport={transport} />);
    expect(html).toContain('aria-label="Unmute sound"');
    expect(html).toContain('aria-pressed="false"');
    expect(renderToString(<ScreenPanel transport={transport} audio={false} />)).not.toContain('Unmute sound');
  });
});

describe('recording panel', () => {
  it('says which frame the recording in progress began at', () => {
    current.state = stoppedAt(50, {
      recording: true,
      history: { earliestFrame: 0, keyframes: 1, bytes: 0, recording: true, recordingStart: 42 },
    });
    const html = renderToString(<RecordingPanel transport={transport} />);
    expect(html).toContain('recording since frame 42');
    expect(html).toContain('Stop recording');
  });
});
