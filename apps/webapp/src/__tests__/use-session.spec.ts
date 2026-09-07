// @vitest-environment jsdom
/**
 * The Debug page's session hook over a real machine: when the session is
 * built, what bumps `revision`, when a loaded save state resyncs it, and what
 * a rebuilt session remembers.
 */
import { Session } from '@gba-kit/debug-core';
import type { EmulatorBridge } from '@gba-kit/gba-browser';
import { Gba } from '@gba-kit/gba-emulator';
import { act, createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type DebugSessionHandle, useDebugSession } from '../session/use-session';
import { fixture } from './fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface HarnessProps {
  emulator: EmulatorBridge;
  romData: ArrayBuffer | null;
  elfData: Uint8Array | null;
  active: boolean;
}

let latest: DebugSessionHandle | null = null;

function Harness(props: HarnessProps): null {
  latest = useDebugSession(props.emulator, props.romData, props.elfData, props.active);
  return null;
}

type FakeBridge = EmulatorBridge & { pause: ReturnType<typeof vi.fn>; refreshFrame: ReturnType<typeof vi.fn> };

/** The part of the bridge the hook uses: the machine, the pause it calls on entering Debug and the repaint on leaving. */
function bridgeOver(rom: Uint8Array): FakeBridge {
  const gba = new Gba();
  gba.loadRom(rom);
  return { gba, pause: vi.fn(), refreshFrame: vi.fn() } as unknown as FakeBridge;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('useDebugSession', () => {
  let root: Root;
  let container: HTMLDivElement;

  const render = (props: HarnessProps): Promise<void> => act(async () => root.render(createElement(Harness, props)));

  /** Session creation is asynchronous (the ROM is hashed first): settle until the hook has one. */
  const settle = async (): Promise<DebugSessionHandle> => {
    for (let i = 0; i < 20 && !latest?.session; i++) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    expect(latest?.session).not.toBeNull();
    return latest!;
  };

  beforeEach(() => {
    localStorage.clear();
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('builds the session on entering Debug, pausing Play and resyncing exactly once', async () => {
    const resync = vi.spyOn(Session.prototype, 'resync');
    const { rom, elf } = fixture('thumb-O0');
    const emulator = bridgeOver(rom);
    const romData = bufferOf(rom);
    await render({ emulator, romData, elfData: elf, active: false });
    expect(latest?.session).toBeNull();

    await render({ emulator, romData, elfData: elf, active: true });
    const handle = await settle();
    expect(handle.state).toBe('stopped');
    expect(emulator.pause).toHaveBeenCalled();
    expect(resync).toHaveBeenCalledTimes(1);
    expect(handle.session!.machine.gba).toBe(emulator.gba);
  });

  it('a loaded save state resyncs the session only while Debug is shown', async () => {
    const { rom, elf } = fixture('thumb-O0');
    const emulator = bridgeOver(rom);
    const romData = bufferOf(rom);
    await render({ emulator, romData, elfData: elf, active: true });
    const { session } = await settle();
    const resync = vi.spyOn(session!, 'resync');

    // in Play the session waits; the next Debug entry catches up with the machine
    await render({ emulator, romData, elfData: elf, active: false });
    await act(async () => latest!.onStateLoaded());
    expect(resync).not.toHaveBeenCalled();
    expect(latest!.session).toBe(session);

    await render({ emulator, romData, elfData: elf, active: true });
    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync).toHaveBeenLastCalledWith('back from Play');
    await act(async () => latest!.onStateLoaded());
    expect(resync).toHaveBeenCalledTimes(2);
    expect(resync).toHaveBeenLastCalledWith('a save state was loaded');
  });

  it('leaving Debug takes the hooks off the machine and repaints Play, so its frames cost and show nothing', async () => {
    const { rom, elf } = fixture('thumb-O0');
    const emulator = bridgeOver(rom);
    const romData = bufferOf(rom);
    await render({ emulator, romData, elfData: elf, active: true });
    const { session } = await settle();
    session!.setTracing(true);
    session!.stepFrame();
    expect(session!.trace.size).toBeGreaterThan(0);
    expect(emulator.gba.onHardwareEvent).not.toBeNull();

    await render({ emulator, romData, elfData: elf, active: false });
    expect(emulator.refreshFrame).toHaveBeenCalledTimes(2); // on leaving, and once the hooks were off
    expect(emulator.gba.onHardwareEvent).toBeNull();
    const logged = session!.trace.size;
    for (let i = 0; i < 10; i++) {
      emulator.gba.runFrame();
    }
    expect(session!.trace.size).toBe(logged);
    expect(session!.tracing).toBe(true);

    // back in Debug the hooks return, and the trace starts over from here
    await render({ emulator, romData, elfData: elf, active: true });
    expect(emulator.gba.onHardwareEvent).not.toBeNull();
    session!.stepFrame();
    expect(session!.trace.size).toBeGreaterThan(0);
  });

  it('a session still running when Play is shown yields the machine once it stops', async () => {
    const { rom, elf } = fixture('thumb-O0');
    const emulator = bridgeOver(rom);
    const romData = bufferOf(rom);
    await render({ emulator, romData, elfData: elf, active: true });
    const { session } = await settle();
    await act(async () => session!.continue());
    expect(session!.state).toBe('running');

    await render({ emulator, romData, elfData: elf, active: false });
    expect(emulator.refreshFrame).toHaveBeenCalledTimes(1);
    expect(emulator.gba.onHardwareEvent).not.toBeNull(); // not yet: the loop stops at its frame boundary
    for (let i = 0; i < 50 && emulator.gba.onHardwareEvent !== null; i++) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    expect(session!.state).toBe('stopped');
    expect(emulator.gba.onHardwareEvent).toBeNull();
    expect(emulator.refreshFrame).toHaveBeenCalledTimes(2);
  });

  it('a label edit bumps the revision the views key their caches on', async () => {
    const { rom, elf } = fixture('thumb-O0');
    const emulator = bridgeOver(rom);
    await render({ emulator, romData: bufferOf(rom), elfData: elf, active: true });
    const { session, revision } = await settle();
    const pc = session!.pc;
    await act(async () => session!.labels.set({ address: pc, label: 'renamed' }));
    expect(latest!.revision).toBe(revision + 1);
    expect(session!.disassemble(pc, 1)[0]!.label).toBe('renamed');
  });

  it('a write to the machine bumps the revision, so the memory and register views re-read at once', async () => {
    const { rom, elf } = fixture('thumb-O0');
    const emulator = bridgeOver(rom);
    await render({ emulator, romData: bufferOf(rom), elfData: elf, active: true });
    const { session, revision } = await settle();
    const address = session!.program.symbolAddress('g_frame')!;
    await act(async () => session!.writeMemory(address, new Uint8Array([0x2a, 0, 0, 0])));
    expect(latest!.revision).toBe(revision + 1);
    expect(session!.readMemory(address, 1).data[0]).toBe(0x2a);
    await act(async () => session!.setRegister(0, 1));
    expect(latest!.revision).toBe(revision + 2);
  });

  it('a session rebuilt for another ELF still has the labels saved for the ROM', async () => {
    const { rom, elf } = fixture('thumb-O0');
    const emulator = bridgeOver(rom);
    const romData = bufferOf(rom);
    await render({ emulator, romData, elfData: elf, active: true });
    const { session: first } = await settle();
    const address = first!.program.symbolAddress('add_bonus')!;
    first!.labels.set({ address, label: 'AddBonus' });
    await first!.saveLabels();

    await render({ emulator, romData, elfData: new Uint8Array(elf), active: true });
    expect(latest!.session).toBeNull();
    const { session: rebuilt } = await settle();
    expect(rebuilt).not.toBe(first);
    expect(rebuilt!.labels.at(address)?.label).toBe('AddBonus');
  });
});
