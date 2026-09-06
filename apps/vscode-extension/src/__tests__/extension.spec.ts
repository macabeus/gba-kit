/**
 * The extension activated against a stand-in `vscode`: what the panels are told
 * when a session starts, wants audio, ends, or ends before its frame stream was
 * attached.
 */
import { FrameStream, STREAM } from '@gba-kit/debug-adapter';
import type { HostToTransport, TransportToHost } from '@gba-kit/debug-ui/transport';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface Listener {
  (e: unknown): void;
}

/** A webview panel that keeps what the host posts and lets the test speak for its webview. */
class FakePanel {
  readonly posted: HostToTransport[] = [];
  visible = true;
  #receive: ((m: unknown) => void) | null = null;
  #viewState: ((e: unknown) => void) | null = null;
  readonly webview = {
    cspSource: 'vscode-resource:',
    html: '',
    asWebviewUri: (uri: unknown) => uri,
    postMessage: async (m: HostToTransport): Promise<boolean> => {
      this.posted.push(m);
      return true;
    },
    onDidReceiveMessage: (l: (m: unknown) => void) => {
      this.#receive = l;
      return { dispose() {} };
    },
  };

  onDidChangeViewState(l: (e: unknown) => void): { dispose(): void } {
    this.#viewState = l;
    return { dispose() {} };
  }
  onDidDispose(): { dispose(): void } {
    return { dispose() {} };
  }
  reveal(): void {}
  dispose(): void {}

  /** The webview said something. */
  deliver(message: TransportToHost): void {
    this.#receive?.(message);
  }
  show(visible: boolean): void {
    this.visible = visible;
    this.#viewState?.({ webviewPanel: this });
  }
}

const stub = vi.hoisted(() => ({
  start: [] as Array<(e: unknown) => void>,
  terminate: [] as Array<(e: unknown) => void>,
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  panels: [] as unknown[],
  /** the view id of each panel created, in order */
  created: [] as string[],
  log: [] as string[],
  createPanel: null as (() => unknown) | null,
}));

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  const event =
    (list: Listener[]) =>
    (l: Listener): { dispose(): void } => {
      list.push(l);
      return disposable;
    };
  const uri = (path: string): { path: string; toString(): string } => ({ path, toString: () => path });
  return {
    ViewColumn: { Active: -1, Beside: -2 },
    Uri: { joinPath: (base: { path: string }, ...parts: string[]) => uri([base.path, ...parts].join('/')) },
    window: {
      createOutputChannel: () => ({ appendLine: (line: string) => stub.log.push(line), dispose() {} }),
      createWebviewPanel: (id: string) => {
        const panel = stub.createPanel!();
        stub.panels.push(panel);
        stub.created.push(id);
        return panel;
      },
      showWarningMessage: () => undefined,
      showErrorMessage: () => undefined,
      showInformationMessage: () => undefined,
      setStatusBarMessage: () => undefined,
    },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
    commands: {
      registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
        stub.commands.set(id, fn);
        return disposable;
      },
      executeCommand: async () => undefined,
    },
    debug: {
      registerDebugAdapterDescriptorFactory: () => disposable,
      onDidStartDebugSession: event(stub.start),
      onDidTerminateDebugSession: event(stub.terminate),
      onDidReceiveDebugSessionCustomEvent: event([]),
      activeDebugSession: undefined,
    },
    DebugAdapterExecutable: class {},
    DebugAdapterInlineImplementation: class {},
  };
});

/** A process-mode session (no inline adapter registered for it) that records its requests. */
function fakeSession(id: string, gate?: Promise<void>) {
  const calls: Array<{ command: string; args: unknown }> = [];
  return {
    id,
    type: 'gba-kit',
    name: id,
    calls,
    customRequest: async (command: string, args?: unknown): Promise<unknown> => {
      calls.push({ command, args });
      if (command === 'gba-kit/stream' && gate) {
        await gate;
      }
      return {};
    },
  };
}

const PIXELS = new Uint8Array(STREAM.width * STREAM.height * 4);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) {
      throw new Error('condition not met in time');
    }
    await wait(5);
  }
};

/** The stream pipes this extension host has bound (a socket file each, on POSIX). */
const boundPipes = (): string[] =>
  process.platform === 'win32' ? [] : readdirSync(tmpdir()).filter((f) => f.startsWith(`gba-kit-${process.pid}-`));

const subscriptions: Array<{ dispose(): void }> = [];

describe('extension', () => {
  beforeAll(async () => {
    stub.createPanel = () => new FakePanel();
    const { activate } = await import('../extension.js');
    activate({
      subscriptions,
      extensionUri: { path: '/ext', toString: () => '/ext' },
      asAbsolutePath: (p: string) => `/ext/${p}`,
    } as never);
  });

  afterAll(() => {
    for (const s of subscriptions) {
      s.dispose();
    }
  });

  it('a session that ends while its stream is being attached never becomes live, and its pipe is unbound', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const dead = fakeSession('dead', gate);
    stub.start.forEach((l) => l(dead));
    // a session brings the screen up on its own, before its stream is even attached
    expect(stub.created).toEqual(['gba-kit.screen']);
    await until(() => dead.calls.some((c) => c.command === 'gba-kit/stream'));
    const pipes = boundPipes();
    stub.terminate.forEach((l) => l(dead));
    release();
    await wait(50);
    if (process.platform !== 'win32') {
      expect(pipes.length).toBe(1);
      expect(boundPipes()).toEqual([]);
    }

    stub.commands.get('gba-kit.showScreen')!(); // the panel is already up: revealed, not stacked
    expect(stub.created).toEqual(['gba-kit.screen']);
    const screen = stub.panels[0] as FakePanel;
    screen.deliver({ type: 'subscribe', what: 'state' });
    await wait(20);
    expect(dead.calls.map((c) => c.command)).toEqual(['gba-kit/stream']); // the panel follows no session
    expect(screen.posted).toEqual([]);
  });

  it('asks the live session for audio only while a panel plays it, and tells the panels when it ends', async () => {
    const live = fakeSession('live');
    const streams = (): unknown[] => live.calls.filter((c) => c.command === 'gba-kit/stream').map((c) => c.args);
    stub.start.forEach((l) => l(live));
    // the panel already follows state (from the test above): attaching pushes it the state right away
    const screen = stub.panels[0] as FakePanel;
    await until(() => screen.posted.length === 1);
    expect(screen.posted[0]).toEqual({ type: 'state', state: {} });
    expect(streams()).toEqual([{ path: expect.any(String), audio: false }]);
    const pipe = (streams()[0] as { path: string }).path;

    screen.deliver({ type: 'subscribe', what: 'audio' });
    await until(() => streams().length === 2);
    expect(streams()[1]).toEqual({ path: pipe, audio: true });
    screen.deliver({ type: 'unsubscribe', what: 'audio' });
    await until(() => streams().length === 3);
    expect(streams()[2]).toEqual({ path: pipe, audio: false });
    await wait(20);
    expect(streams().length).toBe(3);

    // frames come through the pipe, and only reach a panel that is on screen
    const adapter = new FrameStream();
    await adapter.connect(pipe);
    screen.deliver({ type: 'subscribe', what: 'frame' });
    const frames = (): number[] =>
      screen.posted.filter((m) => m.type === 'frame').map((m) => (m as { frame: number }).frame);
    adapter.sendFrame(PIXELS, 1);
    await until(() => frames().length === 1);
    screen.show(false);
    adapter.sendFrame(PIXELS, 2);
    adapter.sendFrame(PIXELS, 3);
    await wait(50);
    expect(frames()).toEqual([1]);
    screen.show(true);
    expect(frames()).toEqual([1, 3]);
    adapter.close();

    stub.terminate.forEach((l) => l(live));
    await wait(50);
    expect(screen.posted.at(-1)).toMatchObject({ type: 'state', state: { state: 'disposed' } });
    if (process.platform !== 'win32') {
      expect(boundPipes()).toEqual([]);
    }
  });
});
