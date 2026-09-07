/**
 * The hooks against a real in-process transport: what a panel sees on its first
 * render, before any effect has run.
 */
import { ManualHost, Session } from '@gba-kit/debug-core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { useDebugState } from '../hooks.js';
import { createSessionTransport } from '../session-transport.js';
import type { Transport } from '../transport.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', '..', 'debug-core', 'test-fixtures');

async function boot(): Promise<Session> {
  return Session.create(new ManualHost(), {
    rom: new Uint8Array(readFileSync(join(fixtures, 'build', 'thumb-O0.gba'))),
    elf: new Uint8Array(readFileSync(join(fixtures, 'build', 'thumb-O0.elf'))),
    cwd: fixtures,
    exists: () => true,
  });
}

function Probe({ transport }: { transport: Transport }) {
  const state = useDebugState(transport);
  return <span>{state ? `${state.state} at frame ${state.frame}` : 'nothing yet'}</span>;
}

describe('useDebugState', () => {
  it('has the machine on the first render, with no effect run yet', async () => {
    const session = await boot();
    const transport = createSessionTransport(session);
    expect(renderToString(<Probe transport={transport} />)).toContain('stopped at frame 0');
    await transport.request('gba-kit/stepFrame');
    expect(renderToString(<Probe transport={transport} />)).toContain('stopped at frame 1');
  });

  it('has nothing to show until a host that pushes its state has pushed one', () => {
    const silent = { state: null, onState: () => () => {} } as unknown as Transport;
    expect(renderToString(<Probe transport={silent} />)).toContain('nothing yet');
  });
});
