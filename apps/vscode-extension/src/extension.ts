/**
 * The VS Code layer, deliberately thin: it registers the `gba-kit` debugger,
 * owns the Screen and Tools webviews, and exposes commands that are one custom
 * request each. Everything that knows about GBA memory, symbols or stepping
 * lives below the DAP seam.
 */
import { GbaDebugSession, StreamReader } from '@gba-kit/debug-adapter';
import type { ControlAction } from '@gba-kit/debug-ui';
import { accessSync, constants } from 'node:fs';
import { type Server, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

import { type BridgeSession, CONTROL_REQUESTS, HostBridge } from './host-bridge.js';
import { type Root, nonce, webviewHtml } from './webview-html.js';

const DEBUG_TYPE = 'gba-kit';

/** Per debug session: its frame stream (out-of-process) or the inline adapter. */
interface Live {
  session: vscode.DebugSession;
  bridge: BridgeSession;
  server: Server | null;
  dispose(): void;
}

const CONTROL_COMMANDS: Partial<Record<ControlAction, string>> = {
  continue: 'workbench.action.debug.continue',
  pause: 'workbench.action.debug.pause',
  stepOver: 'workbench.action.debug.stepOver',
  stepInto: 'workbench.action.debug.stepInto',
  stepOut: 'workbench.action.debug.stepOut',
  stepBack: 'workbench.action.debug.stepBack',
  restart: 'workbench.action.debug.restart',
};

class Panels {
  readonly #panels = new Map<Root, { panel: vscode.WebviewPanel; bridge: HostBridge }>();
  #live: Live | null = null;

  constructor(readonly context: vscode.ExtensionContext) {}

  get live(): Live | null {
    return this.#live;
  }

  /** The session every panel follows; frames flow from it. */
  setLive(live: Live | null): void {
    this.#live?.dispose();
    this.#live = live;
    for (const { bridge } of this.#panels.values()) {
      bridge.attach(live?.bridge ?? null);
    }
  }

  show(root: Root): void {
    const existing = this.#panels.get(root);
    if (existing) {
      existing.panel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      `gba-kit.${root}`,
      root === 'screen' ? 'GBA Screen' : 'GBA Tools',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      },
    );
    const webview = panel.webview;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    webview.html = webviewHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css')).toString(),
      root,
      nonce: nonce(),
      screenScale: vscode.workspace.getConfiguration('gba-kit').get<number>('screenScale', 2),
    });
    const bridge = new HostBridge({
      post: (message) => void webview.postMessage(message),
      openText: (content, language) => {
        void vscode.workspace
          .openTextDocument({ language, content })
          .then((doc) => vscode.window.showTextDocument(doc, vscode.ViewColumn.Active));
      },
    });
    bridge.attach(this.#live?.bridge ?? null);
    webview.onDidReceiveMessage((message) => void bridge.receive(message));
    panel.onDidDispose(() => this.#panels.delete(root));
    this.#panels.set(root, { panel, bridge });
  }

  frame(rgba: Uint8Array, frame: number): void {
    for (const { bridge } of this.#panels.values()) {
      bridge.frame(rgba, frame);
    }
  }

  audio(samples: Float32Array, sampleRate: number): void {
    for (const { bridge } of this.#panels.values()) {
      bridge.audio(samples, sampleRate);
    }
  }

  state(state: unknown): void {
    for (const { bridge } of this.#panels.values()) {
      bridge.state(state);
    }
  }

  labels(): void {
    for (const { bridge } of this.#panels.values()) {
      bridge.labels();
    }
  }

  /** Whether any panel wants audio: the stream only carries it when asked. */
  get wantsAudio(): boolean {
    return [...this.#panels.values()].some(({ bridge }) => bridge.subscriptions.has('audio'));
  }

  dispose(): void {
    this.setLive(null);
    for (const { panel } of this.#panels.values()) {
      panel.dispose();
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const panels = new Panels(context);
  const inline = new Map<string, GbaDebugSession>();
  const output = vscode.window.createOutputChannel('gba-kit');

  const bridgeFor = (session: vscode.DebugSession): BridgeSession => ({
    customRequest: (command, args) => Promise.resolve(session.customRequest(command, args)),
    control: async (action) => {
      const command = CONTROL_COMMANDS[action];
      if (command && vscode.debug.activeDebugSession?.id === session.id) {
        await vscode.commands.executeCommand(command);
      } else {
        const { command: dap, args } = CONTROL_REQUESTS[action];
        await session.customRequest(dap, args);
      }
    },
  });

  const factory: vscode.DebugAdapterDescriptorFactory = {
    createDebugAdapterDescriptor(session) {
      const mode = vscode.workspace.getConfiguration('gba-kit').get<'process' | 'inline'>('adapter', 'process');
      const node = mode === 'process' ? findNode() : null;
      if (mode === 'process' && !node) {
        output.appendLine(
          'gba-kit: `node` was not found on the PATH; running the debug adapter inside the extension host',
        );
      }
      if (node) {
        return new vscode.DebugAdapterExecutable(node, [context.asAbsolutePath(path.join('dist', 'adapter.js'))]);
      }
      const adapter = new GbaDebugSession();
      inline.set(session.id, adapter);
      return new vscode.DebugAdapterInlineImplementation(adapter);
    },
  };

  context.subscriptions.push(
    output,
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, factory),

    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type !== DEBUG_TYPE) {
        return;
      }
      void attachStream(session, inline.get(session.id) ?? null, panels, output).then((live) => panels.setLive(live));
    }),

    vscode.debug.onDidTerminateDebugSession((session) => {
      inline.delete(session.id);
      if (panels.live?.session.id === session.id) {
        panels.setLive(null);
        panels.state({ state: 'disposed', frame: 0, pc: 0 });
      }
    }),

    // State changes travel as DAP custom events: the same path a remote adapter uses.
    vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
      if (e.session.type !== DEBUG_TYPE) {
        return;
      }
      if (e.event === 'gba-kit/state') {
        panels.state(e.body);
      } else if (e.event === 'gba-kit/labels') {
        panels.labels();
      }
    }),

    vscode.commands.registerCommand('gba-kit.showScreen', () => panels.show('screen')),
    vscode.commands.registerCommand('gba-kit.showTools', () => panels.show('tools')),
    vscode.commands.registerCommand('gba-kit.stepFrame', () => request('gba-kit/stepFrame')),
    vscode.commands.registerCommand('gba-kit.stepScanline', () => request('gba-kit/stepScanline')),
    vscode.commands.registerCommand('gba-kit.rewind', () => request('gba-kit/rewind', { frames: 60 })),
    vscode.commands.registerCommand('gba-kit.toggleRecording', async () => {
      const state = (await request('gba-kit/state')) as { recording?: boolean } | undefined;
      if (!state) {
        return;
      }
      if (state.recording) {
        const result = (await request('gba-kit/recordStop')) as { script: string } | undefined;
        if (result) {
          const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: result.script });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
        }
      } else {
        await request('gba-kit/recordStart');
        vscode.window.setStatusBarMessage('GBA: recording inputs; run the command again to stop', 5000);
      }
    }),
    vscode.commands.registerCommand('gba-kit.saveState', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Name for the save state', placeHolder: 'before-boss' });
      if (name === undefined) {
        return;
      }
      const saved = (await request('gba-kit/saveState', { name })) as { path: string } | undefined;
      if (saved) {
        vscode.window.setStatusBarMessage(`GBA: state saved to ${saved.path}`, 5000);
      }
    }),
    vscode.commands.registerCommand('gba-kit.loadState', async () => {
      const body = (await request('gba-kit/listStates')) as
        | { states: Array<{ name: string; path: string; frame: number }> }
        | undefined;
      if (!body) {
        return;
      }
      if (body.states.length === 0) {
        vscode.window.showInformationMessage('GBA: no saved states for this ROM yet');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        body.states.map((s) => ({ label: s.name, description: `frame ${s.frame}`, detail: s.path, path: s.path })),
        { placeHolder: 'Load which state?' },
      );
      if (pick) {
        await request('gba-kit/loadState', { path: pick.path });
      }
    }),
    vscode.commands.registerCommand('gba-kit.importLabels', async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Symbol files': ['sym', 'txt', 'map', 'ld'] },
      });
      if (!files?.[0]) {
        return;
      }
      const text = Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString('utf8');
      const result = (await request('gba-kit/importLabels', { text })) as { imported: number } | undefined;
      if (result) {
        vscode.window.showInformationMessage(`GBA: imported ${result.imported} labels`);
      }
    }),
    vscode.commands.registerCommand('gba-kit.exportLabels', async () => {
      const result = (await request('gba-kit/exportLabels')) as { text: string } | undefined;
      if (result) {
        const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: result.text });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
      }
    }),
    { dispose: () => panels.dispose() },
  );

  async function request(command: string, args?: Record<string, unknown>): Promise<unknown> {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== DEBUG_TYPE) {
      vscode.window.showWarningMessage('No gba-kit debug session is active');
      return undefined;
    }
    try {
      return await session.customRequest(command, args);
    } catch (err) {
      vscode.window.showErrorMessage(`GBA: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Frames and audio never cross the DAP connection. An in-process adapter hands
   * them over directly; a process adapter writes them to a pipe the extension
   * owns, told to it with `gba-kit/stream`.
   */
  async function attachStream(
    session: vscode.DebugSession,
    adapter: GbaDebugSession | null,
    sink: Panels,
    log: vscode.OutputChannel,
  ): Promise<Live> {
    const bridge = bridgeFor(session);
    if (adapter) {
      let off: (() => void) | null = null;
      adapter.onSession((core) => {
        off = core.on({
          frame: (rgba, frame) => sink.frame(rgba, frame),
          audio: (samples) => sink.wantsAudio && sink.audio(samples, 32768),
        });
      });
      return { session, bridge, server: null, dispose: () => off?.() };
    }
    const pipe = pipePath();
    const server = createServer((socket) => {
      const reader = new StreamReader(
        (f) => sink.frame(f.rgba, f.frame),
        (a) => sink.audio(a.samples, a.sampleRate),
      );
      socket.on('data', (chunk: Buffer) => {
        try {
          reader.push(chunk);
        } catch (err) {
          log.appendLine(`gba-kit: frame stream: ${(err as Error).message}`);
          socket.destroy();
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipe, resolve);
    });
    try {
      await session.customRequest('gba-kit/stream', { path: pipe, audio: true });
    } catch (err) {
      log.appendLine(`gba-kit: could not connect the frame stream: ${(err as Error).message}`);
    }
    return { session, bridge, server, dispose: () => server.close() };
  }
}

export function deactivate(): void {}

function pipePath(): string {
  const id = `gba-kit-${process.pid}-${Date.now().toString(36)}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(tmpdir(), `${id}.sock`);
}

/** `node` on the PATH, so the adapter can run as its own process. */
function findNode(): string | null {
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd'] : ['node'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}
