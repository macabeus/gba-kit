/**
 * The extension-host side of a panel's transport, with no VS Code types in it so
 * it can be tested: routes a webview's messages to the debug session, and the
 * session's frames, audio, state and label changes back to the webview.
 */
import {
  type ControlAction,
  type Feed,
  type HostToTransport,
  type PanelId,
  type TransportBackend,
  type TransportToHost,
  serveTransport,
} from '@gba-kit/debug-ui/transport';

/** What the bridge needs from the debugger; the extension wires it to a `vscode.DebugSession`. */
export interface BridgeSession {
  customRequest(command: string, args?: unknown): Promise<unknown>;
  /** run a standard debugger action (continue, pause, step…) */
  control(action: ControlAction): Promise<void>;
}

export interface BridgeSink {
  post(message: HostToTransport): void;
  openText?(content: string, language: string, title: string): void;
  /** the webview asked for a tool panel to be shown; the host brings up the view that holds it */
  showPanel?(panel: PanelId): void;
  /** the feeds the webview wants changed (`subscriptions`); the host stops producing what no panel takes */
  subscriptionsChanged?(): void;
}

/** Standard DAP requests behind the transport's control actions, when the host has no command for them. */
export const CONTROL_REQUESTS: Record<ControlAction, { command: string; args?: unknown }> = {
  continue: { command: 'continue', args: { threadId: 1 } },
  pause: { command: 'pause', args: { threadId: 1 } },
  stepInstruction: { command: 'next', args: { threadId: 1, granularity: 'instruction' } },
  stepOver: { command: 'next', args: { threadId: 1 } },
  stepInto: { command: 'stepIn', args: { threadId: 1 } },
  stepOut: { command: 'stepOut', args: { threadId: 1 } },
  stepBack: { command: 'stepBack', args: { threadId: 1 } },
  restart: { command: 'restart' },
};

const NO_SESSION = 'no gba-kit debug session is active';

/**
 * One bridge per webview. `subscriptions` records which feeds the webview wants
 * right now, so frames (150 KB each) and audio only cross to a panel that plays
 * them, and stop when it stops; a hidden webview gets no frames either, just the
 * newest once it shows again.
 */
export class HostBridge {
  readonly subscriptions = new Set<Feed>();
  #session: BridgeSession | null = null;
  #lastFrame: { rgba: Uint8Array; frame: number } | null = null;
  #visible = true;
  /** a frame arrived while hidden: the webview shows an older one until it is visible again */
  #frameWithheld = false;
  /** a panel asked for before the webview could hear of it: delivered when it subscribes */
  #pendingPanel: PanelId | null = null;
  readonly #backend: TransportBackend;

  constructor(readonly sink: BridgeSink) {
    this.#backend = {
      request: (command, args) => {
        const session = this.#session;
        return session ? session.customRequest(command, args) : Promise.reject(new Error(NO_SESSION));
      },
      control: (action) => {
        const session = this.#session;
        return session ? session.control(action) : Promise.reject(new Error(NO_SESSION));
      },
      subscribe: (what) => this.#subscribe(what),
      unsubscribe: (what) => {
        if (this.subscriptions.delete(what)) {
          this.sink.subscriptionsChanged?.();
        }
      },
      openText: sink.openText?.bind(sink),
      showPanel: sink.showPanel?.bind(sink),
    };
  }

  /** The debug session this panel follows; null when none is active. */
  get session(): BridgeSession | null {
    return this.#session;
  }

  attach(session: BridgeSession | null): void {
    if (session !== this.#session) {
      // another session's screen is not this one's: a webview that (re)subscribes waits for a frame of its own
      this.#lastFrame = null;
      this.#frameWithheld = false;
    }
    this.#session = session;
    if (session && this.subscriptions.has('state')) {
      void this.#pushState(session);
    }
  }

  /**
   * Whether the webview is on screen. VS Code keeps a hidden one alive, so its
   * subscriptions stand; frames are held back from it and the newest is sent
   * once it shows again.
   */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    if (visible && this.#frameWithheld && this.#lastFrame && this.subscriptions.has('frame')) {
      this.sink.post({ type: 'frame', ...this.#lastFrame });
    }
    if (visible) {
      this.#frameWithheld = false;
    }
  }

  /** A message from the webview. */
  async receive(message: TransportToHost): Promise<void> {
    await serveTransport(message, this.#backend, (m) => this.sink.post(m));
  }

  #subscribe(what: Feed): void {
    const added = !this.subscriptions.has(what);
    this.subscriptions.add(what);
    if (what === 'state' && this.#session) {
      void this.#pushState(this.#session);
    }
    if (what === 'frame') {
      if (this.#lastFrame) {
        this.sink.post({ type: 'frame', ...this.#lastFrame });
        this.#frameWithheld = false;
      }
      void this.#session?.customRequest('gba-kit/requestFrame').catch(() => {});
    }
    if (what === 'showPanel' && this.#pendingPanel) {
      const panel = this.#pendingPanel;
      this.#pendingPanel = null;
      this.sink.post({ type: 'showPanel', panel });
    }
    if (added) {
      this.sink.subscriptionsChanged?.();
    }
  }

  async #pushState(session: BridgeSession): Promise<void> {
    try {
      const state = await session.customRequest('gba-kit/state');
      this.sink.post({ type: 'state', state: state as never });
    } catch {
      // the session is gone or not launched yet
    }
  }

  /** The session reported a state change (a `gba-kit/state` custom event). */
  state(state: unknown): void {
    if (this.subscriptions.has('state')) {
      this.sink.post({ type: 'state', state: state as never });
    }
  }

  frame(rgba: Uint8Array, frame: number): void {
    this.#lastFrame = { rgba, frame };
    if (!this.subscriptions.has('frame')) {
      return;
    }
    if (this.#visible) {
      this.sink.post({ type: 'frame', rgba, frame });
    } else {
      this.#frameWithheld = true;
    }
  }

  audio(samples: Float32Array, sampleRate: number): void {
    if (this.subscriptions.has('audio')) {
      this.sink.post({ type: 'audio', samples, sampleRate });
    }
  }

  labels(): void {
    if (this.subscriptions.has('labels')) {
      this.sink.post({ type: 'labels' });
    }
  }

  /** Select a tool panel in this webview; one still loading hears of it when its tabs subscribe. */
  showPanel(panel: PanelId): void {
    if (this.subscriptions.has('showPanel')) {
      this.sink.post({ type: 'showPanel', panel });
    } else {
      this.#pendingPanel = panel;
    }
  }
}
