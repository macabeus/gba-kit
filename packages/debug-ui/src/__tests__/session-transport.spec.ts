/**
 * The in-process transport answers like the debug adapter does, against a real
 * session on the debug-core fixtures.
 */
import { type HostFiles, ManualHost, Session } from '@gba-kit/debug-core';
import { LOG } from '@gba-kit/debug-core/protocol';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createSessionTransport } from '../session-transport.js';
import type { Transport } from '../transport.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', '..', 'debug-core', 'test-fixtures');
const FRAME_MS = 1000 / 59.7275;

async function boot(files?: HostFiles): Promise<{ session: Session; host: ManualHost }> {
  const host = new ManualHost(files);
  const session = await Session.create(host, {
    rom: new Uint8Array(readFileSync(join(fixtures, 'build', 'thumb-O0.gba'))),
    elf: new Uint8Array(readFileSync(join(fixtures, 'build', 'thumb-O0.elf'))),
    cwd: fixtures,
    exists: () => true,
  });
  return { session, host };
}

async function frameOf(transport: Transport): Promise<number> {
  return (await transport.request('gba-kit/state')).frame;
}

describe('session transport', () => {
  it('reports state, steps, reads the views, and keeps states in memory', async () => {
    const { session } = await boot();
    const transport = createSessionTransport(session);
    const states: string[] = [];
    transport.onState((s) => states.push(`${s.state}:${s.frame}`));
    expect(states).toEqual(['stopped:0']);

    await transport.request('gba-kit/stepFrame');
    expect(states.at(-1)).toBe('stopped:1');
    expect(await frameOf(transport)).toBe(1);

    const io = await transport.request('gba-kit/ioRegisters');
    expect(io.registers.find((r) => r.name === 'DISPCNT')!.value).toBe(0x0403);
    const palette = await transport.request('gba-kit/ppu', { kind: 'palette' });
    expect(palette.kind === 'palette' && palette.bg.length).toBe(256);
    const tiles = await transport.request('gba-kit/ppu', { kind: 'tiles', charBase: 0, bpp: 4, count: 4 });
    expect(tiles.kind === 'tiles' && atob(tiles.pixels).length).toBe(256);
    // the same clamps as the adapter: a count beyond a character base's reach, a depth that is neither
    const clamped = await transport.request('gba-kit/ppu', {
      kind: 'tiles',
      charBase: 0,
      bpp: 7 as never,
      count: 99_999,
    });
    expect(clamped.kind === 'tiles' && [clamped.bpp, clamped.count]).toEqual([4, 2048]);
    const frame = await transport.request('gba-kit/frame');
    expect(atob(frame.rgba).length).toBe(240 * 160 * 4);

    expect((await transport.request('gba-kit/input', { button: 0, down: true })).buttons).toBe(1);
    const saved = await transport.request('gba-kit/saveState', { name: 'one' });
    expect(saved).toMatchObject({ name: 'one', frame: 1 });
    await transport.request('gba-kit/stepFrame');
    expect((await transport.request('gba-kit/listStates')).states.map((s) => s.name)).toEqual(['one']);
    await transport.request('gba-kit/loadState', { name: 'one' });
    expect(await frameOf(transport)).toBe(1);

    let labelEvents = 0;
    transport.onLabels(() => labelEvents++);
    await transport.request('gba-kit/setLabel', { address: 0x03000000, label: 'gFirst' });
    expect(labelEvents).toBe(1);
    expect((await transport.request('gba-kit/labels')).labels[0]!.label).toBe('gFirst');
    expect((await transport.request('gba-kit/eventBreakpoints')).kinds.length).toBe(7);

    const frames: number[] = [];
    transport.onFrame((rgba, n) => frames.push(rgba.length + n));
    expect(frames.length).toBeGreaterThan(0);
    // the loaded state sits at a frame boundary with the CPU asleep in wait_vblank:
    // the first step only wakes it at the interrupt vector, executing nothing yet
    await transport.control('stepInstruction');
    expect((await transport.request('gba-kit/state')).position).toMatchObject({ instruction: 0, pc: 0x18 });
    await transport.control('stepInstruction');
    expect((await transport.request('gba-kit/state')).position.instruction).toBe(1);
    await expect(transport.request('gba-kit/nope' as never)).rejects.toThrow(/unknown request/);
  });

  it('pushes a recording start and stop to state listeners, keeps the last recording, and replays it', async () => {
    const { session } = await boot();
    const transport = createSessionTransport(session);
    const seen: Array<{ recording: boolean; start: number | null }> = [];
    transport.onState((s) => seen.push({ recording: s.recording, start: s.history.recordingStart }));
    expect(await transport.request('gba-kit/lastRecording')).toEqual({ last: null });

    await transport.request('gba-kit/stepFrame');
    await transport.request('gba-kit/recordStart');
    expect(seen.at(-1)).toEqual({ recording: true, start: 1 });
    expect((await transport.request('gba-kit/buttons', { mask: 0b101 })).buttons).toBe(0b101);
    await transport.request('gba-kit/stepFrame');
    await transport.request('gba-kit/stepFrame');
    const stopped = await transport.request('gba-kit/recordStop');
    expect(seen.at(-1)).toEqual({ recording: false, start: null });
    expect(stopped.recording).toMatchObject({ startFrame: 1, frames: [0b101, 0b101] });
    expect(stopped.script).toContain("['a+select', 2]");
    expect(await transport.request('gba-kit/lastRecording')).toEqual({ last: stopped });

    await transport.request('gba-kit/buttons', { mask: 0 });
    await transport.request('gba-kit/stepFrame');
    expect(await frameOf(transport)).toBe(4);
    expect(await transport.request('gba-kit/replay', { recording: stopped.recording })).toEqual({ replayed: true });
    expect(await frameOf(transport)).toBe(3);
  });

  it('pushes a tracing toggle to state listeners even while running, and counts entries like the adapter', async () => {
    const { session, host } = await boot();
    const transport = createSessionTransport(session);
    const seen: Array<{ state: string; tracing: boolean }> = [];
    transport.onState((s) => seen.push({ state: s.state, tracing: s.tracing }));
    await transport.control('continue');
    expect(seen.at(-1)).toEqual({ state: 'running', tracing: false });
    const before = seen.length;
    expect(await transport.request('gba-kit/trace', { enabled: true, count: 0 })).toEqual({
      enabled: true,
      entries: [],
    });
    expect(seen.length).toBe(before + 1);
    expect(seen.at(-1)).toEqual({ state: 'running', tracing: true });
    await transport.request('gba-kit/trace', { enabled: true, count: 0 });
    expect(seen.length).toBe(before + 1); // already on: nothing to report

    await transport.control('pause');
    host.tick(FRAME_MS);
    expect(seen.at(-1)).toEqual({ state: 'stopped', tracing: true });
    await transport.request('gba-kit/stepFrame'); // a whole frame: hardware events to log
    for (let i = 0; i < 3; i++) {
      await transport.control('stepInstruction');
    }
    const some = await transport.request('gba-kit/trace');
    expect(some.entries.length).toBeGreaterThan(0);
    expect(some.entries.length).toBeLessThanOrEqual(LOG.traceDefault);
    expect((await transport.request('gba-kit/trace', { count: 2 })).entries.length).toBe(2);
    expect((await transport.request('gba-kit/trace', { count: 0 })).entries).toEqual([]);
    expect((await transport.request('gba-kit/events', { count: 0 })).entries).toEqual([]);
    expect((await transport.request('gba-kit/events', { count: 1 })).entries.length).toBe(1);
    expect((await transport.request('gba-kit/trace', { enabled: false, count: 0 })).enabled).toBe(false);
    expect(seen.at(-1)).toEqual({ state: 'stopped', tracing: false });
  });

  it('rewinds by whole frames, at least one, and to a frame', async () => {
    const { session } = await boot();
    const transport = createSessionTransport(session);
    await transport.request('gba-kit/stepFrame');
    await transport.request('gba-kit/stepFrame');
    expect(await frameOf(transport)).toBe(2);
    expect(await transport.request('gba-kit/rewind', { frames: 0 })).toEqual({ rewound: true });
    expect(await frameOf(transport)).toBe(1);
    expect(await transport.request('gba-kit/rewind', { frames: -5 })).toEqual({ rewound: true });
    expect(await frameOf(transport)).toBe(0);
    expect(await transport.request('gba-kit/rewind', { frames: 1 })).toEqual({ rewound: false });
    await transport.request('gba-kit/stepFrame');
    await transport.request('gba-kit/stepFrame');
    expect(await transport.request('gba-kit/rewindToFrame', { frame: 1 })).toEqual({ rewound: true });
    expect(await frameOf(transport)).toBe(1);
  });

  it('searches memory and narrows the matches', async () => {
    const { session } = await boot();
    const transport = createSessionTransport(session);
    await transport.request('gba-kit/buttons', { mask: 6 });
    await transport.request('gba-kit/stepFrame');
    await transport.request('gba-kit/stepFrame');
    const gKeys = session.evaluate('&g_keys').address!;
    const { addresses } = await transport.request('gba-kit/searchMemory', { value: 6, size: 2, region: 'iwram' });
    expect(addresses).toContain(gKeys);
    const kept = await transport.request('gba-kit/filterMemory', { addresses, value: 6, size: 2 });
    expect(kept.addresses).toContain(gKeys);
    await transport.request('gba-kit/buttons', { mask: 1 });
    await transport.request('gba-kit/stepFrame');
    await transport.request('gba-kit/stepFrame');
    const narrowed = await transport.request('gba-kit/filterMemory', { addresses, value: 1, size: 2 });
    expect(narrowed.addresses).toContain(gKeys);
    expect(narrowed.addresses.length).toBeLessThanOrEqual(addresses.length);
  });

  it('imports and exports symbol files, telling label listeners, and reports a failed save', async () => {
    const writes: string[] = [];
    let failWrites = false;
    const files: HostFiles = {
      readText: async () => null,
      readBytes: async () => null,
      writeText: async (path) => {
        if (failWrites) {
          throw new Error('EACCES: labels.json');
        }
        writes.push(path);
      },
      writeBytes: async () => {},
      list: async () => [],
      join: (...parts) => parts.join('/'),
    };
    const { session } = await boot(files);
    const transport = createSessionTransport(session);
    let labelEvents = 0;
    transport.onLabels(() => labelEvents++);
    const { imported } = await transport.request('gba-kit/importLabels', {
      text: '03000000 gFirst\n03000004 gSecond\n',
    });
    expect(imported).toBe(2);
    expect(labelEvents).toBe(1);
    expect(writes).toEqual([`${fixtures}/.gba-kit/labels.json`]);
    const { text } = await transport.request('gba-kit/exportLabels');
    expect(text).toContain('gFirst');
    expect(text).toContain('gSecond');

    failWrites = true;
    await expect(transport.request('gba-kit/setLabel', { address: 0x03000008, label: 'gThird' })).rejects.toThrow(
      'EACCES: labels.json',
    );
    expect(labelEvents).toBe(2); // the label is set in memory: views still hear of it
    expect((await transport.request('gba-kit/labels')).labels.map((l) => l.label)).toEqual([
      'gFirst',
      'gSecond',
      'gThird',
    ]);
  });

  it('hands save states to the host given for them', async () => {
    const { session } = await boot();
    const store = new Map<string, string>();
    const calls: string[] = [];
    const transport = createSessionTransport(session, {
      states: {
        list: async () => [...store.keys()].map((name) => ({ name, path: `/states/${name}`, frame: 0, createdAt: '' })),
        save: async (name, text, frame) => {
          calls.push(`save:${name}:${frame}`);
          store.set(name, text);
          return `/states/${name}`;
        },
        load: async (nameOrPath) => {
          calls.push(`load:${nameOrPath}`);
          return store.get(nameOrPath.replace('/states/', '')) ?? null;
        },
      },
    });
    await transport.request('gba-kit/stepFrame');
    const saved = await transport.request('gba-kit/saveState', { name: 'here' });
    expect(saved).toMatchObject({ name: 'here', path: '/states/here', frame: 1 });
    await transport.request('gba-kit/stepFrame');
    expect((await transport.request('gba-kit/listStates')).states.map((s) => s.path)).toEqual(['/states/here']);
    await transport.request('gba-kit/loadState', { path: '/states/here' });
    expect(await frameOf(transport)).toBe(1);
    await expect(transport.request('gba-kit/loadState', { name: 'nowhere' })).rejects.toThrow('no such state');
    expect(calls).toEqual(['save:here:1', 'load:/states/here', 'load:nowhere']);
  });

  it('maps every control onto the session', async () => {
    const { session, host } = await boot();
    const transport = createSessionTransport(session);
    await transport.control('continue');
    expect(session.state).toBe('running');
    await transport.control('pause');
    host.tick(FRAME_MS);
    expect(session.state).toBe('stopped');
    const at = session.position;
    await transport.control('stepInstruction');
    expect(session.position.instruction).toBe(at.instruction + 1);
    await transport.control('stepBack');
    expect(session.position).toEqual(at);
    await transport.control('stepOver');
    await transport.control('stepInto');
    await transport.control('stepOut');
    expect(session.state).toBe('stopped');
    const epoch = session.epoch;
    await transport.control('restart');
    expect(session.frame).toBe(0);
    expect(session.epoch).toBe(epoch + 1);
    await expect(transport.control('nope' as never)).resolves.toBeUndefined();
  });

  it('streams audio while running, and relays a request to show a panel', async () => {
    const { session, host } = await boot();
    const transport = createSessionTransport(session);
    const chunks: Array<{ samples: number; rate: number }> = [];
    const off = transport.onAudio((samples, rate) => chunks.push({ samples: samples.length, rate }));
    await transport.control('continue');
    for (let i = 0; i < 4; i++) {
      host.tick(FRAME_MS);
    }
    await transport.control('pause');
    host.tick(FRAME_MS);
    off();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.rate === 32768 && c.samples > 0 && c.samples % 2 === 0)).toBe(true);

    const shown: string[] = [];
    const stop = transport.onShowPanel!((panel) => shown.push(panel));
    transport.showPanel!('recording');
    expect(shown).toEqual(['recording']);
    stop();
    transport.showPanel!('trace');
    expect(shown).toEqual(['recording']);
  });
});
