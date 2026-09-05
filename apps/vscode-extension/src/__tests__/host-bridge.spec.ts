import type { HostToTransport } from '@gba-kit/debug-ui';
import { describe, expect, it } from 'vitest';

import { CONTROL_REQUESTS, HostBridge } from '../host-bridge.js';
import { nonce, webviewHtml } from '../webview-html.js';

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

    bridge.attach({
      customRequest: async (command, args) => {
        calls.push(command);
        return command === 'gba-kit/state' ? { state: 'stopped', frame: 3 } : { args };
      },
      control: async (action) => {
        calls.push(`control:${action}`);
      },
    });
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

  it('knows the DAP request behind each control', () => {
    expect(CONTROL_REQUESTS.stepInstruction).toEqual({
      command: 'next',
      args: { threadId: 1, granularity: 'instruction' },
    });
    expect(CONTROL_REQUESTS.restart.command).toBe('restart');
  });
});

describe('webview html', () => {
  it('locks the CSP to the nonce and the extension resources', () => {
    const n = nonce();
    expect(n).toMatch(/^[A-Za-z0-9]{32}$/);
    const html = webviewHtml({
      cspSource: 'vscode-resource:',
      scriptUri: 'x/webview.js',
      styleUri: 'x/webview.css',
      root: 'tools',
      nonce: n,
      screenScale: 3,
    });
    expect(html).toContain(`script-src 'nonce-${n}'`);
    expect(html).toContain('data-root="tools"');
    expect(html).toContain('data-screen-scale="3"');
    expect(html).toContain('--gk-accent: var(--vscode-textLink-foreground)');
    expect(html).not.toContain("'unsafe-eval'");
  });
});
