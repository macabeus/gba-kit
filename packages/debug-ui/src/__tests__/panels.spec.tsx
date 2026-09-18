/**
 * Panels rendered against a fixed debugger state: what the controls show for a
 * given `StateBody`, with the state hook stood in for (no host, no effects).
 */
import type { DiffGroupBody, DiffRowBody, StateBody } from '@gba-kit/debug-core/protocol';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { EditableName } from '../components.js';
import { edgeHandles, relationLabel } from '../panels/DiffGraph.js';
import { DiffGroups } from '../panels/DiffRows.js';
import { MemoryDiffPanel, nameFor, querySentence, watchExpression } from '../panels/MemoryDiffPanel.js';
import { RecordingPanel, RecordingsView } from '../panels/RecordingPanel.js';
import { ScreenPanel } from '../panels/ScreenPanel.js';
import { SaveStatesView } from '../panels/save-states.js';
import type { Transport } from '../transport.js';

const current = vi.hoisted(() => ({ state: null as StateBody | null }));
// only the state hook is stood in for; the rest run as they are, with no host to answer them
vi.mock(import('../hooks.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  useDebugState: () => current.state,
}));

const transport = {
  state: null,
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

  it("draws its actions with the editor's own icons, never emoji", () => {
    current.state = stoppedAt(0);
    const html = renderToString(<ScreenPanel transport={transport} />);
    // a codicon is a font glyph named as VS Code names it, hidden from screen readers
    expect(html).toContain('class="codicon codicon-debug-continue" aria-hidden="true"');
    expect(html).toContain('codicon-record');
    expect(html).toContain('codicon-mute');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('carries the save state drawer, which a host can turn off', () => {
    current.state = stoppedAt(0);
    const html = renderToString(<ScreenPanel transport={transport} />);
    expect(html).toContain('gk-drawer-bar');
    expect(html).toContain('Save state');
    expect(renderToString(<ScreenPanel transport={transport} saveStates={false} />)).not.toContain('gk-drawer');
  });

  /** A menu item whose host cannot serve it is not shown at all. */
  it('offers the .sav actions the host can serve, and no menu when it can serve neither', () => {
    current.state = stoppedAt(0);
    const drawer = (extra: Partial<Transport>): string =>
      renderToString(<ScreenPanel transport={{ ...transport, ...extra }} />);
    const pickFile = (): Promise<null> => Promise.resolve(null);
    const saveFile = (): Promise<boolean> => Promise.resolve(false);

    expect(drawer({})).not.toContain('gk-menu');
    expect(drawer({ pickFile })).toContain('Import from a .sav file');
    expect(drawer({ pickFile })).not.toContain('Export to a .sav file');
    expect(drawer({ saveFile })).toContain('Export to a .sav file');
    expect(drawer({ saveFile })).not.toContain('Import from a .sav file');
    const both = drawer({ pickFile, saveFile });
    expect(both).toContain('Import from a .sav file');
    expect(both).toContain('Export to a .sav file');
  });

  it('keeps the menu shut until it is opened, and says so to a screen reader', () => {
    current.state = stoppedAt(0);
    const html = renderToString(<ScreenPanel transport={{ ...transport, pickFile: () => Promise.resolve(null) }} />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<div class="gk-menu-list" role="menu" hidden=""/);
  });
});

describe('editable name', () => {
  it('shows a name, and the field that renames it, wherever one is renamed', () => {
    const shown = renderToString(
      <EditableName name="frame-1026" editing={false} onStop={() => {}} onRename={() => {}} />,
    );
    expect(shown).toContain('title="frame-1026"');
    expect(shown).not.toContain('<input');
    const editing = renderToString(
      <EditableName name="frame-1026" editing className="gk-card-name" onStop={() => {}} onRename={() => {}} />,
    );
    expect(editing).toContain('value="frame-1026"');
    expect(editing).toContain('aria-label="Rename &#x27;frame-1026&#x27;"');
    expect(editing).toContain('gk-input gk-card-name');
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
        createdAt: '2026-09-06T12:00:00.000Z',
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
    // a recording outlives the session that made it, so the row says when it was made
    expect(html).toContain(new Date('2026-09-06T12:00:00.000Z').toLocaleString());
    // and deleting one is offered only where the host can do it
    expect(html).not.toContain('codicon-trash');
    expect(renderToString(<RecordingsView takes={takes} onReplay={() => {}} onRemove={() => {}} />)).toContain(
      'codicon-trash',
    );
  });
});

describe('memory diff panel', () => {
  /** One row of each tier, as the session would hand them over. */
  const rows: DiffRowBody[] = [
    {
      address: 0x03002920,
      group: 'symbol:gEntityInfo',
      values: [1, 2, 1],
      formatted: ['1', '2', '1'],
      tier: 'sized',
      symbol: { name: 'gEntityInfo', offset: 0 },
      path: 'gEntityInfo[0].xPosBg2',
      type: 'u16',
      rank: 10,
      reasons: ['2 changed bytes within ±256'],
    },
    {
      address: 0x03000028,
      group: 'symbol:gMPlayTrack_0',
      values: [48, 0, 48],
      tier: 'inferred',
      symbol: { name: 'gMPlayTrack_0', offset: 0x20 },
      path: 'gMPlayTrack_0[3]',
      extrapolated: true,
      rank: 8,
      reasons: ['a run of 2 changed bytes'],
    },
    { address: 0x02000818, group: 'region:EWRAM', values: [1, 2, 1], tier: 'unattributed', rank: 10, reasons: [] },
  ];
  const groups: DiffGroupBody[] = [
    { key: 'symbol:gEntityInfo', tier: 'sized', label: 'gEntityInfo', rows: 1, topRank: 10 },
    { key: 'region:EWRAM', tier: 'unattributed', label: 'unattributed EWRAM', rows: 1, topRank: 10 },
  ];
  const actions = {
    tags: ['slot A', 'slot B', 'slot A'],
    onLabel: () => {},
    onBreak: () => {},
    onMute: () => {},
  };

  it('asks for a capture before it has one, and takes one without stopping first', () => {
    current.state = stoppedAt(0);
    const stopped = renderToString(<MemoryDiffPanel transport={transport} />);
    expect(stopped).toContain('Capture RAM on one screen');
    expect(stopped).not.toContain('needs a stopped machine');

    // a capture is read between two frames wherever the machine is, so the button does
    // not wait for a stop; the noise baseline runs frames itself and still does
    current.state = { ...stoppedAt(0), state: 'running' };
    const running = renderToString(<MemoryDiffPanel transport={transport} />);
    expect(running.match(/<button[^>]*title="Keep RAM as it is now"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(running).toContain('Looking for background noise needs a stopped machine');
  });

  it('an arrow names both ends, since which way is up is the whole of what it says', () => {
    // an arrow has a direction and may point either way across the canvas, so a relation
    // that is not symmetric has to say where it went up from
    expect(relationLabel('increased', 'slot A', 'slot B')).toBe('↑ went up from slot A to slot B');
    expect(relationLabel('decreased', '②', '①')).toBe('↓ went down from ② to ①');
    // the symmetric ones read as a pair rather than as a direction
    expect(relationLabel('changed', '①', '②')).toBe('≠ changed between ① and ②');
    expect(relationLabel('same', '①', '③')).toBe('= the same in ① and ③');
  });

  it('an arrow leaves the side its target is on, so its label is never behind a node', () => {
    // left to the first handle that matches, every arrow starts on a node's left edge and
    // its label lands on top of whatever sits before it
    expect(edgeHandles(0, 210)).toEqual({ sourceHandle: 'sr', targetHandle: 'tl' });
    expect(edgeHandles(420, 0)).toEqual({ sourceHandle: 'sl', targetHandle: 'tr' });
    // stacked nodes still have to pick a side, and forward is the one to prefer
    expect(edgeHandles(100, 100)).toEqual({ sourceHandle: 'sr', targetHandle: 'tl' });
  });

  it('says the query in words, so a picture of it can be checked by reading it', () => {
    const strip = [
      { id: 1, tag: 'slot A' },
      { id: 2, tag: 'slot B' },
      { id: 3, tag: 'slot A again' },
    ];
    const sentence = querySentence(
      strip,
      [
        { from: 1, to: 2, relation: 'changed' },
        { from: 2, to: 3, relation: 'changed' },
        { from: 1, to: 3, relation: 'same' },
      ],
      { 1: 0 },
    );
    expect(sentence).toContain('slot A → slot B changed');
    expect(sentence).toContain('slot A again is back to what slot A held');
    expect(sentence).toContain('slot A held 0');
    // a graph nobody has drawn on asks nothing, and says what to do about it
    expect(querySentence(strip, [], {})).toContain('Draw an arrow');
    expect(querySentence([{ id: 1, tag: 'one' }], [], {})).toContain('two states');
  });

  it('reports the odds as one of three words, with what earned them behind it', () => {
    const html = renderToString(
      <DiffGroups groups={[]} rows={rows} open={new Set()} onToggle={() => {}} total={3} actions={actions} />,
    );
    // a number gives nobody a way to disagree with the order; the words are what is read,
    // and the criteria that earned them are what the title carries
    expect(html).toContain('gk-odds-likely');
    expect(html).not.toContain('>10<');
    expect(html).toMatch(/title="Looks like a variable: [^"]+"/);
  });

  it('gives each tier its own treatment, so an inferred containment cannot read as a name', () => {
    const html = renderToString(
      <DiffGroups groups={[]} rows={rows} open={new Set()} onToggle={() => {}} total={3} actions={actions} />,
    );
    expect(html).toContain('gk-tier-sized');
    expect(html).toContain('gk-tier-inferred');
    expect(html).toContain('gk-tier-unnamed');
    // a sized row leads with the name the program vouches for
    expect(html).toContain('gEntityInfo[0].xPosBg2');
    // an inferred one leads with its address, and the symbol is only a landmark
    expect(html).toContain('0x03000028');
    expect(html).toContain('near gMPlayTrack_0 + 0x20');
    expect(html).toContain('nothing states this array has that many elements');
    // an unattributed one claims nothing at all
    expect(html).toContain('0x02000818');
    expect(html).not.toContain('near gNumMusicPlayers');
    // the matrix is one column per capture, headed by its tag
    expect(html).toContain('slot A');
    expect(html).toContain('slot B');
    expect(html).toContain('aria-rowcount="3"');
  });

  it('says when the members of a union cover the same bytes, so one reading is not the reading', () => {
    const union: DiffRowBody = {
      address: 0x03002928,
      group: 'symbol:gEntityInfo',
      values: [1, 2, 1],
      tier: 'sized',
      symbol: { name: 'gEntityInfo', offset: 8 },
      path: 'gEntityInfo[0].unk8.split.unk8',
      type: 'u8',
      alternatives: ['all'],
      rank: 9,
      reasons: [],
    };
    const html = renderToString(
      <DiffGroups groups={[]} rows={[union]} open={new Set()} onToggle={() => {}} total={1} actions={actions} />,
    );
    expect(html).toContain('gEntityInfo[0].unk8.split.unk8');
    expect(html).toContain('or .all');
  });

  it('collapses the groups and says what each holds before it is opened', () => {
    const html = renderToString(
      <DiffGroups groups={groups} rows={rows} open={new Set()} onToggle={() => {}} total={3} actions={actions} />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('unattributed EWRAM');
    expect(html).toContain('best likely');
    // nothing is expanded, so no row is rendered yet
    expect(html).not.toContain('gEntityInfo[0].xPosBg2');

    const open = renderToString(
      <DiffGroups
        groups={groups}
        rows={rows}
        open={new Set(['symbol:gEntityInfo'])}
        onToggle={() => {}}
        total={3}
        actions={actions}
      />,
    );
    expect(open).toContain('gEntityInfo[0].xPosBg2');
    expect(open).not.toContain('0x02000818');
  });

  it('says how many of a group rows this page carries, rather than claiming them all', () => {
    const many: DiffGroupBody[] = [
      { key: 'symbol:gEntityInfo', tier: 'sized', label: 'gEntityInfo', rows: 240, topRank: 10 },
      { key: 'region:EWRAM', tier: 'unattributed', label: 'unattributed EWRAM', rows: 1, topRank: 10 },
    ];
    const html = renderToString(
      <DiffGroups groups={many} rows={rows} open={new Set()} onToggle={() => {}} total={241} actions={actions} />,
    );
    // the page carries one of gEntityInfo's 240 rows, and a header that said `240 rows`
    // over a table of one is what sends a reader looking for the other 239 on screen
    expect(html).toContain('1 of 240 rows here');
    expect(html).toContain('1 row · best likely');
  });

  it('names an address by a path only where the program states one covering it', () => {
    // the row renderer never shows an inferred path as a name, and the action behind it
    // must not either: a label reaches disassembly and `.sym` with no tier to explain it
    expect(rows.map(nameFor)).toEqual(['gEntityInfo_0.xPosBg2', 'gUnk_03000028', 'gUnk_02000818']);
  });

  /** A byte of `gEntityInfo[0].xPosBg2`, which the same path names and does not name. */
  const inside: DiffRowBody = { ...rows[0]!, address: 0x03002921, pathOffset: 1 };

  it('a byte inside an object is neither named nor drawn as that object', () => {
    const html = renderToString(
      <DiffGroups groups={[]} rows={[inside]} open={new Set()} onToggle={() => {}} total={1} actions={actions} />,
    );
    // four bytes of one word carry one path: leading with the name would draw four rows
    // that look like one, and labelling them would put one identifier at four addresses
    expect(html).toContain('0x03002921');
    expect(html).toContain('in gEntityInfo[0].xPosBg2 + 0x1');
    expect(nameFor(inside)).toBe('gUnk_03002921');
    expect(nameFor(rows[0]!)).toBe('gEntityInfo_0.xPosBg2');
  });

  it('watches the variable where the program names it, and the memory where it does not', () => {
    expect(watchExpression(rows[0]!, 4)).toBe('gEntityInfo[0].xPosBg2');
    expect(watchExpression(inside, 1)).toBe('u8(0x03002921)');
    // an inferred path is a hypothesis, so what is watched is the address it is about
    expect(watchExpression(rows[1]!, 2)).toBe('u16(0x03000028)');
  });

  it('offers a watch only where the host has somewhere to put one', () => {
    const without = renderToString(
      <DiffGroups groups={[]} rows={rows} open={new Set()} onToggle={() => {}} total={3} actions={actions} />,
    );
    expect(without).not.toContain('>Watch<');
    const with_ = renderToString(
      <DiffGroups
        groups={[]}
        rows={rows}
        open={new Set()}
        onToggle={() => {}}
        total={3}
        actions={{ ...actions, onWatch: () => {} }}
      />,
    );
    expect(with_).toContain('>Watch<');
  });
});
