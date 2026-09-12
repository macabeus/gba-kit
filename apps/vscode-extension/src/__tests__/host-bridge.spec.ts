import type { HostToTransport } from '@gba-kit/debug-ui/transport';
import { describe, expect, it } from 'vitest';

import { type BridgeSession, CONTROL_REQUESTS, HostBridge } from '../host-bridge.js';

/** A session that records what it was asked. */
function fakeSession(calls: string[]): BridgeSession {
  return {
    customRequest: async (command, args) => {
      calls.push(command);
      return command === 'gba-kit/state' ? { state: 'stopped', frame: 3 } : { args };
    },
    control: async (action) => {
      calls.push(`control:${action}`);
    },
  };
}

describe('host bridge', () => {
  it('routes requests and controls to the session, and feeds only what the panel subscribed to', async () => {
    const posted: HostToTransport[] = [];
    const calls: string[] = [];
    const bridge = new HostBridge({ post: (m) => posted.push(m) });
    await bridge.receive({ type: 'request', id: 1, command: 'gba-kit/state' });
    expect(posted[0]).toMatchObject({
      type: 'response',
      id: 1,
      error: expect.stringMatching(/no gba-kit debug session/),
    });

    bridge.attach(fakeSession(calls));
    await bridge.receive({ type: 'subscribe', what: 'state' });
    expect(posted[1]).toEqual({ type: 'state', state: { state: 'stopped', frame: 3 } });
    await bridge.receive({ type: 'request', id: 2, command: 'gba-kit/rewind', args: { frames: 2 } });
    expect(posted[2]).toEqual({ type: 'response', id: 2, body: { args: { frames: 2 } } });
    await bridge.receive({ type: 'control', id: 3, action: 'stepOver' });
    expect(posted[3]).toEqual({ type: 'response', id: 3 });
    expect(calls).toEqual(['gba-kit/state', 'gba-kit/rewind', 'control:stepOver']);

    bridge.frame(new Uint8Array(4), 1);
    expect(posted.length).toBe(4); // no frame subscription yet
    await bridge.receive({ type: 'subscribe', what: 'frame' });
    expect(posted[4]).toMatchObject({ type: 'frame', frame: 1 }); // the last frame, right away
    expect(calls.at(-1)).toBe('gba-kit/requestFrame');
    bridge.audio(new Float32Array(2), 32768);
    expect(posted.length).toBe(5);
    bridge.labels();
    expect(posted.length).toBe(5);
    await bridge.receive({ type: 'subscribe', what: 'labels' });
    bridge.labels();
    expect(posted.at(-1)).toEqual({ type: 'labels' });
  });

  it('stops a feed when the webview unsubscribes, and tells the host on every change', async () => {
    const posted: HostToTransport[] = [];
    const changes: string[] = [];
    const bridge = new HostBridge({
      post: (m) => posted.push(m),
      subscriptionsChanged: () => changes.push([...bridge.subscriptions].join(',')),
    });
    await bridge.receive({ type: 'subscribe', what: 'audio' });
    await bridge.receive({ type: 'subscribe', what: 'audio' }); // said twice: one change
    bridge.audio(new Float32Array(2), 32768);
    expect(posted).toEqual([{ type: 'audio', samples: new Float32Array(2), sampleRate: 32768 }]);

    await bridge.receive({ type: 'unsubscribe', what: 'audio' });
    await bridge.receive({ type: 'unsubscribe', what: 'audio' }); // already gone: no change
    bridge.audio(new Float32Array(2), 32768);
    expect(posted.length).toBe(1);
    expect(bridge.subscriptions.has('audio')).toBe(false);
    expect(changes).toEqual(['audio', '']);
  });

  it('holds frames back from a hidden webview and sends the newest once it shows again', async () => {
    const posted: HostToTransport[] = [];
    const bridge = new HostBridge({ post: (m) => posted.push(m) });
    await bridge.receive({ type: 'subscribe', what: 'frame' });
    bridge.setVisible(false);
    bridge.frame(new Uint8Array([1]), 6);
    bridge.frame(new Uint8Array([2]), 7);
    expect(posted).toEqual([]);
    bridge.setVisible(true);
    expect(posted).toEqual([{ type: 'frame', rgba: new Uint8Array([2]), frame: 7 }]);
    bridge.setVisible(false);
    bridge.setVisible(true); // nothing arrived meanwhile: nothing to catch up on
    expect(posted.length).toBe(1);
    bridge.frame(new Uint8Array([3]), 8);
    expect(posted.at(-1)).toMatchObject({ type: 'frame', frame: 8 });
  });

  it("does not replay one session's last frame to a webview following the next", async () => {
    const posted: HostToTransport[] = [];
    const bridge = new HostBridge({ post: (m) => posted.push(m) });
    bridge.attach(fakeSession([]));
    bridge.frame(new Uint8Array(4), 7);
    const calls: string[] = [];
    bridge.attach(fakeSession(calls));
    await bridge.receive({ type: 'subscribe', what: 'frame' });
    expect(posted).toEqual([]);
    expect(calls).toEqual(['gba-kit/requestFrame']);
    bridge.frame(new Uint8Array(4), 8);
    expect(posted).toEqual([{ type: 'frame', rgba: new Uint8Array(4), frame: 8 }]);
  });

  it('routes a panel request to the host, and holds one for a webview until its tabs can hear it', async () => {
    const posted: HostToTransport[] = [];
    const shown: string[] = [];
    const bridge = new HostBridge({ post: (m) => posted.push(m), showPanel: (panel) => shown.push(panel) });
    await bridge.receive({ type: 'showPanel', panel: 'recording' });
    expect(shown).toEqual(['recording']);

    bridge.showPanel('recording'); // the webview is still loading: nothing to post to yet
    expect(posted).toEqual([]);
    await bridge.receive({ type: 'subscribe', what: 'showPanel' });
    expect(posted).toEqual([{ type: 'showPanel', panel: 'recording' }]);
    bridge.showPanel('trace');
    expect(posted.at(-1)).toEqual({ type: 'showPanel', panel: 'trace' });

    const silent = new HostBridge({ post: (m) => posted.push(m) });
    await silent.receive({ type: 'showPanel', panel: 'recording' }); // a host with nowhere to show it: ignored
    expect(posted.length).toBe(2);
  });

  it('opens the file dialogs the host has, and answers when it has none', async () => {
    const posted: HostToTransport[] = [];
    const asked: unknown[] = [];
    const bridge = new HostBridge({
      post: (m) => posted.push(m),
      pickFile: async (options) => {
        asked.push(options);
        return { name: 'Klonoa (USA).sav', bytes: Uint8Array.of(1, 2, 3) };
      },
      saveFile: async (options) => {
        asked.push(options);
        return true;
      },
    });
    const filters = { 'Save files': ['sav'] };

    await bridge.receive({ type: 'pickFile', id: 1, title: 'Import a .sav file', filters });
    expect(asked[0]).toEqual({ title: 'Import a .sav file', filters });
    // the file crosses back base64-encoded, the way it crossed out
    expect(posted[0]).toEqual({ type: 'response', id: 1, body: { name: 'Klonoa (USA).sav', bytes: 'AQID' } });

    await bridge.receive({
      type: 'saveFile',
      id: 2,
      title: 'Export the cartridge save',
      suggestedName: 'save.sav',
      filters,
      bytes: 'AQID',
    });
    expect(asked[1]).toMatchObject({ suggestedName: 'save.sav', bytes: Uint8Array.of(1, 2, 3) });
    expect(posted[1]).toEqual({ type: 'response', id: 2, body: true });

    // a host with no dialog says so rather than leaving the webview waiting
    const silent = new HostBridge({ post: (m) => posted.push(m) });
    await silent.receive({ type: 'pickFile', id: 3, title: 'x', filters });
    expect(posted[2]).toEqual({ type: 'response', id: 3, error: 'this host cannot open files' });
  });

  it('knows the DAP request behind each control', () => {
    expect(CONTROL_REQUESTS.stepInstruction).toEqual({
      command: 'next',
      args: { threadId: 1, granularity: 'instruction' },
    });
    expect(CONTROL_REQUESTS.restart.command).toBe('restart');
  });
});
