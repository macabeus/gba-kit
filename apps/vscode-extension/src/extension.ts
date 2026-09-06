/**
 * The VS Code layer, deliberately thin: it registers the `gba-kit` debugger,
 * owns the Screen and Tools webviews, and exposes commands that are one custom
 * request each. Everything that knows about GBA memory, symbols or stepping
 * lives below the DAP seam.
 */
import { GbaDebugSession, newPipePath } from '@gba-kit/debug-adapter';
import { AUDIO_SAMPLE_RATE, type StateBody } from '@gba-kit/debug-adapter/protocol';
import type { ControlAction, PanelId } from '@gba-kit/debug-ui/transport';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

import { serveFrames } from './frame-server.js';
import { type BridgeSession, CONTROL_REQUESTS, HostBridge } from './host-bridge.js';
import { type Root, nonce, webviewHtml } from './webview-html.js';

const DEBUG_TYPE = 'gba-kit';

/** The session every panel follows: how to reach it, whether it should produce audio, and how to stop its feed. */
interface Live {
  session: vscode.DebugSession;
  bridge: BridgeSession;
  /** audio is mixed and carried only while a panel plays it; told again on every change */
  setAudio(wanted: boolean): void;
  dispose(): void;
}

/** The core an in-process adapter runs; a restart replaces it. */
type Core = Parameters<Parameters<GbaDebugSession['onSession']>[0]>[0];

/** What the panels see once the session is gone: a whole state body, so every consumer of one reads it safely. */
const DISPOSED_STATE: StateBody = {
  state: 'disposed',
  frame: 0,
  pc: 0,
  position: { frame: 0, instruction: 0, scanline: 0, cycle: 0, pc: 0 },
  revision: 0,
  epoch: 0,
  history: { earliestFrame: null, keyframes: 0, bytes: 0, recording: false, recordingStart: null },
  recording: false,
  tracing: false,
};

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
    // the panels' wishes may have changed while the stream was being attached
    live?.setAudio(this.wantsAudio);
  }

  /** Whether a panel is up. */
  has(root: Root): boolean {
    return this.#panels.has(root);
  }

  /**
   * Make sure a panel exists, leaving one that already does exactly where it is: a
   * session starting should put the screen up, not pull a tab the user is reading out
   * from under them.
   */
  open(root: Root): void {
    if (!this.#panels.has(root)) {
      this.show(root);
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
      showPanel: (panel) => this.showTool(panel),
      subscriptionsChanged: () => this.#live?.setAudio(this.wantsAudio),
    });
    bridge.attach(this.#live?.bridge ?? null);
    bridge.setVisible(panel.visible);
    webview.onDidReceiveMessage((message) => void bridge.receive(message));
    panel.onDidChangeViewState((e) => bridge.setVisible(e.webviewPanel.visible));
    panel.onDidDispose(() => this.#panels.delete(root));
    this.#panels.set(root, { panel, bridge });
  }

  /** Bring the Tools view up on one of its tabs (a recording just stopped: its Recording tab), creating it if need be. */
  showTool(panel: PanelId): void {
    this.show('tools');
    this.#panels.get('tools')?.bridge.showPanel(panel);
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

  /** Whether any panel plays audio. The live session mixes and carries audio only while one does. */
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
  /** sessions whose entry stop the screen already ran past, so it happens once each */
  const ranForScreen = new Set<string>();
  const inline = new Map<string, GbaDebugSession>();
  /** stream attachments in flight, by session id; one whose session ended meanwhile is dropped, not made live */
  const pending = new Map<string, Promise<Live>>();
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
      // The screen is what a session is for, so it comes up with one; it subscribes
      // before the stream is attached, so the first frame reaches it.
      panels.open('screen');
      const attach = attachStream(session, inline.get(session.id) ?? null, panels, output);
      pending.set(session.id, attach);
      attach.then(
        (live) => {
          if (pending.get(session.id) !== attach) {
            live.dispose(); // the session ended before its stream was attached
            return;
          }
          pending.delete(session.id);
          panels.setLive(live);
        },
        (err: Error) => {
          pending.delete(session.id);
          output.appendLine(`gba-kit: could not attach the frame stream: ${err.message}`);
        },
      );
    }),

    vscode.debug.onDidTerminateDebugSession((session) => {
      pending.delete(session.id);
      ranForScreen.delete(session.id);
      inline.delete(session.id);
      if (panels.live?.session.id === session.id) {
        panels.setLive(null);
        panels.state(DISPOSED_STATE);
      }
    }),

    // State changes travel as DAP custom events: the same path a remote adapter uses.
    vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
      if (e.session.type !== DEBUG_TYPE) {
        return;
      }
      if (e.event === 'gba-kit/state') {
        panels.state(e.body);
        runForTheScreen(e.session, e.body as { state?: string; reason?: string });
      } else if (e.event === 'gba-kit/labels') {
        panels.labels();
      }
    }),

    vscode.commands.registerCommand('gba-kit.showScreen', () => {
      panels.show('screen');
      // the entry stop may have been announced before there was a screen to watch it
      void runForTheScreenNow();
    }),
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
        // the Recording tab shows the session's last recording, and can replay it
        if (await request('gba-kit/recordStop')) {
          panels.showTool('recording');
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

  /**
   * A screen exists to be watched, so the machine runs once one is up. Only the entry
   * stop is resumed, and only once per session: opening the screen while stopped at a
   * breakpoint must leave the machine exactly where the user stopped it. This does mean
   * a session with `stopOnEntry` runs on once its screen appears — set `stopOnEntry` to
   * false to skip the stop entirely, or close the screen to sit at it.
   */
  function runForTheScreen(session: vscode.DebugSession, body: { state?: string; reason?: string }): void {
    if (body.state !== 'stopped' || body.reason !== 'entry' || ranForScreen.has(session.id) || !panels.has('screen')) {
      return;
    }
    ranForScreen.add(session.id);
    void bridgeFor(session)
      .control('continue')
      .catch((err: Error) => output.appendLine(`gba-kit: could not start the machine: ${err.message}`));
  }

  /** Ask the active session where it is, and run it if it is sitting at its entry stop. */
  async function runForTheScreenNow(): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== DEBUG_TYPE) {
      return;
    }
    try {
      const body = (await session.customRequest('gba-kit/state')) as { state?: string; reason?: string };
      runForTheScreen(session, body);
    } catch {
      // the session went away between the click and the question
    }
  }

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
   * owns, told to it with `gba-kit/stream`. Either way audio is only asked for
   * while a panel plays it: the core does not mix what nobody hears.
   */
  async function attachStream(
    session: vscode.DebugSession,
    adapter: GbaDebugSession | null,
    sink: Panels,
    log: vscode.OutputChannel,
  ): Promise<Live> {
    const bridge = bridgeFor(session);
    if (adapter) {
      return attachInline(session, adapter, bridge, sink);
    }
    const pipe = newPipePath();
    const server = await serveFrames(pipe, sink, (message) => log.appendLine(`gba-kit: frame stream: ${message}`));
    let audio = sink.wantsAudio;
    const stream = async (): Promise<void> => {
      try {
        await session.customRequest('gba-kit/stream', { path: pipe, audio });
      } catch (err) {
        log.appendLine(`gba-kit: could not connect the frame stream: ${(err as Error).message}`);
      }
    };
    await stream();
    return {
      session,
      bridge,
      // the adapter connects to the same pipe again, with or without audio; the server takes the newer connection
      setAudio: (wanted) => {
        if (wanted !== audio) {
          audio = wanted;
          void stream();
        }
      },
      dispose: () => server.dispose(),
    };
  }

  /** Listen to the in-process adapter's core directly, following it across restarts. */
  function attachInline(
    session: vscode.DebugSession,
    adapter: GbaDebugSession,
    bridge: BridgeSession,
    sink: Panels,
  ): Live {
    let core: Core | null = null;
    let audio = false;
    let offFrame: (() => void) | null = null;
    let offAudio: (() => void) | null = null;
    let disposed = false;
    const listenAudio = (): void => {
      offAudio?.();
      offAudio = audio && core ? core.on({ audio: (samples) => sink.audio(samples, AUDIO_SAMPLE_RATE) }) : null;
    };
    adapter.onSession((next) => {
      if (disposed) {
        return;
      }
      // a restart brings a new core; the previous one's listeners went with it
      core = next;
      offFrame?.();
      offFrame = next.on({ frame: (rgba, frame) => sink.frame(rgba, frame) });
      listenAudio();
    });
    return {
      session,
      bridge,
      setAudio: (wanted) => {
        if (wanted !== audio) {
          audio = wanted;
          listenAudio();
        }
      },
      dispose: () => {
        disposed = true;
        offFrame?.();
        offAudio?.();
        offFrame = offAudio = null;
        core = null;
      },
    };
  }
}

export function deactivate(): void {}

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
