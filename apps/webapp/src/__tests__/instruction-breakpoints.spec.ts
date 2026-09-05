/**
 * The Debug page's instruction breakpoints are the session's: derived on every
 * render, so leaving for Play and coming back (a remount with no local state)
 * shows and honours what was set before.
 */
import { ManualHost, type StopInfo } from '@gba-kit/debug-core';
import { describe, expect, it } from 'vitest';

import { instructionAddresses, toggleInstructionBreakpoint } from '../pages/debug/instruction-breakpoints';
import { FRAME_MS, bootSession } from './fixtures';

describe('instruction breakpoints', () => {
  it('toggle sets and clears through the session, ascending and halfword-aligned', async () => {
    const session = await bootSession('thumb-O0');
    expect(instructionAddresses(session)).toEqual([]);
    expect(toggleInstructionBreakpoint(session, 0x08000241)).toEqual([0x08000240]);
    expect(toggleInstructionBreakpoint(session, 0x08000100)).toEqual([0x08000100, 0x08000240]);
    expect(toggleInstructionBreakpoint(session, 0x08000240)).toEqual([0x08000100]);
    expect(session.breakpoints.all().map((bp) => [bp.kind, bp.verified, bp.addresses])).toEqual([
      ['instruction', true, [0x08000100]],
    ]);
  });

  it('survives the Play round trip: a fresh derivation lists it, and running still stops there', async () => {
    const host = new ManualHost();
    const session = await bootSession('thumb-O0', host);
    const main = session.program.symbolAddress('main')!;
    toggleInstructionBreakpoint(session, main);

    // leaving Debug pauses the session; coming back mounts a view with no state of its own
    session.pause();
    expect(instructionAddresses(session)).toEqual([main]);
    expect(session.breakpoints.all()).toHaveLength(1);

    const stops: StopInfo[] = [];
    session.on({ stopped: (info) => stops.push(info) });
    session.continue();
    for (let i = 0; i < 300 && stops.length === 0; i++) {
      host.tick(FRAME_MS);
    }
    expect(stops[0]).toMatchObject({ reason: 'instruction breakpoint', address: main });
  });
});
