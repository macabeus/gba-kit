/**
 * Panels rendered against a fixed debugger state: what the controls show for a
 * given `StateBody`, with the state hook stood in for (no host, no effects).
 */
import type { StateBody } from '@gba-kit/debug-core/protocol';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { RecordingPanel, RecordingsView } from '../panels/RecordingPanel.js';
import { SaveStatesView } from '../panels/SaveStateDrawer.js';
import { ScreenPanel } from '../panels/ScreenPanel.js';
import type { Transport } from '../transport.js';

const current = vi.hoisted(() => ({ state: null as StateBody | null }));
// only the state hook is stood in for; the rest run as they are, with no host to answer them
vi.mock(import('../hooks.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  useDebugState: () => current.state,
}));

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
    replaying: false,
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

  it('carries the save state drawer, which a host can turn off', () => {
    current.state = stoppedAt(0);
    const html = renderToString(<ScreenPanel transport={transport} />);
    expect(html).toContain('gk-drawer-bar');
    expect(html).toContain('+ Save state');
    expect(renderToString(<ScreenPanel transport={transport} saveStates={false} />)).not.toContain('gk-drawer');
  });
});

describe('save state drawer', () => {
  it('shows a card per state, newest first, and says where one without a screen sits', () => {
    const states = [
      {
        name: 'the start',
        path: '/states/the_start.json',
        frame: 0,
        createdAt: '',
        thumbnail: 'AAAAAA==',
        width: 1,
        height: 1,
      },
      { name: 'boss', path: '/states/boss.json', frame: 900, createdAt: '' },
    ];
    const html = renderToString(
      <SaveStatesView states={states} onLoad={() => {}} onRename={() => {}} onRemove={() => {}} />,
    );
    expect(html.indexOf('boss')).toBeLessThan(html.indexOf('the start'));
    expect(html).toContain('the screen at frame 0');
    expect(html).toContain('frame 900'); // saved before thumbnails: the frame stands in for the screen
    expect(html).toContain('Load &#x27;boss&#x27; (frame 900)');
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

  it('lists a recording as a row of thumbnail, script and the two ways to replay it', () => {
    const takes = [
      {
        id: 1,
        recording: {
          format: 'gba-kit-input' as const,
          version: 1 as const,
          romHash: 'r',
          startFrame: 12,
          frames: [1, 1, 0],
        },
        script: "await press('a', { hold: 2 });",
        thumbnail: 'AAAAAA==',
        width: 120,
        height: 80,
      },
    ];
    const opened: number[] = [];
    const html = renderToString(
      <RecordingsView takes={takes} onReplay={() => {}} onOpenScript={(t) => opened.push(t.id)} />,
    );
    for (const column of ['Thumbnail', 'Script', 'Actions']) {
      expect(html).toContain(`<th>${column}</th>`);
    }
    expect(html).toContain('From where recorded');
    expect(html).toContain('From here');
    expect(html).toContain('await press(&#x27;a&#x27;, { hold: 2 });');
    expect(html).toContain('frame 12');
    expect(html).toContain('gk-float'); // the script's own open button, not a row of buttons
    expect(html).not.toContain('Open log');
    expect(html).not.toContain('Open as script');
    // a host with nowhere to open a script simply does not offer it
    expect(renderToString(<RecordingsView takes={takes} onReplay={() => {}} />)).not.toContain('gk-float');
  });
});
