/**
 * The in-process transport answers like the debug adapter does, against a real
 * session on the debug-core fixtures.
 */
import { ManualHost, Session } from '@gba-kit/debug-core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createSessionTransport } from '../session-transport.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', '..', 'debug-core', 'test-fixtures');

async function boot(): Promise<{ session: Session; host: ManualHost }> {
  const host = new ManualHost();
  const session = await Session.create(host, {
    rom: new Uint8Array(readFileSync(join(fixtures, 'build', 'thumb-O0.gba'))),
    elf: new Uint8Array(readFileSync(join(fixtures, 'build', 'thumb-O0.elf'))),
    cwd: fixtures,
    exists: () => true,
  });
  return { session, host };
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
    expect((await transport.request('gba-kit/state')).frame).toBe(1);

    const io = await transport.request('gba-kit/ioRegisters');
    expect(io.registers.find((r) => r.name === 'DISPCNT')!.value).toBe(0x0403);
    const palette = await transport.request('gba-kit/ppu', { kind: 'palette' });
    expect(palette.kind === 'palette' && palette.bg.length).toBe(256);
    const tiles = await transport.request('gba-kit/ppu', { kind: 'tiles', charBase: 0, bpp: 4, count: 4 });
    expect(tiles.kind === 'tiles' && atob(tiles.pixels).length).toBe(256);
    const frame = await transport.request('gba-kit/frame');
    expect(atob(frame.rgba).length).toBe(240 * 160 * 4);

    expect((await transport.request('gba-kit/input', { button: 0, down: true })).buttons).toBe(1);
    const saved = await transport.request('gba-kit/saveState', { name: 'one' });
    expect(saved).toMatchObject({ name: 'one', frame: 1 });
    await transport.request('gba-kit/stepFrame');
    expect((await transport.request('gba-kit/listStates')).states.map((s) => s.name)).toEqual(['one']);
    await transport.request('gba-kit/loadState', { name: 'one' });
    expect((await transport.request('gba-kit/state')).frame).toBe(1);

    let labelEvents = 0;
    transport.onLabels(() => labelEvents++);
    await transport.request('gba-kit/setLabel', { address: 0x03000000, label: 'gFirst' });
    expect(labelEvents).toBe(1);
    expect((await transport.request('gba-kit/labels')).labels[0]!.label).toBe('gFirst');
    expect((await transport.request('gba-kit/eventBreakpoints')).kinds.length).toBe(7);

    const frames: number[] = [];
    transport.onFrame((rgba, n) => frames.push(rgba.length + n));
    expect(frames.length).toBeGreaterThan(0);
    await transport.control('stepInstruction');
    expect((await transport.request('gba-kit/state')).position.instruction).toBe(1);
    await expect(transport.request('gba-kit/nope' as never)).rejects.toThrow(/unknown request/);
  });
});
