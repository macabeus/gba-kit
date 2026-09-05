/**
 * The extension-host side of a panel's transport, with no VS Code types in it so
 * it can be tested: routes a webview's messages to the debug session, and the
 * session's frames, audio, state and label changes back to the webview.
 */
import type { HostToTransport, TransportBackend, TransportToHost } from '@gba-kit/debug-ui';
import { serveTransport } from '@gba-kit/debug-ui';
import type { ControlAction } from '@gba-kit/debug-ui';

/** What the bridge needs from the debugger; the extension wires it to a `vscode.DebugSession`. */
export interface BridgeSession {
  customRequest(command: string, args?: unknown): Promise<unknown>;
  /** run a standard debugger action (continue, pause, step…) */
  control(action: ControlAction): Promise<void>;
}

export interface BridgeSink {
  post(message: HostToTransport): void;
  openText?(content: string, language: string, title: string): void;
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

/**
 * One bridge per webview. `subscriptions` records which feeds the webview wants,
 * so frames (150 KB each) only cross to a panel that shows them.
 */
export class HostBridge {
  readonly subscriptions = new Set<'state' | 'frame' | 'audio' | 'labels'>();
  #session: BridgeSession | null = null;
  #lastFrame: { rgba: Uint8Array; frame: number } | null = null;

  constructor(readonly sink: BridgeSink) {}

  /** The debug session this panel follows; null when none is active. */
  get session(): BridgeSession | null {
    return this.#session;
  }

  attach(session: BridgeSession | null): void {
    this.#session = session;
    if (session && this.subscriptions.has('state')) {
      void this.#pushState(session);
    }
  }

  /** A message from the webview. */
  async receive(message: TransportToHost): Promise<void> {
    const backend: TransportBackend = {
      request: (command, args) => {
        const session = this.#session;
        if (!session) {
          return Promise.reject(new Error('no gba-kit debug session is active'));
        }
        return session.customRequest(command, args);
      },
      control: (action) => {
        const session = this.#session;
        if (!session) {
          return Promise.reject(new Error('no gba-kit debug session is active'));
        }
        return session.control(action);
      },
      subscribe: (what) => {
        this.subscriptions.add(what);
        if (what === 'state' && this.#session) {
          void this.#pushState(this.#session);
        }
        if (what === 'frame') {
          if (this.#lastFrame) {
            this.sink.post({ type: 'frame', ...this.#lastFrame });
          }
          void this.#session?.customRequest('gba-kit/requestFrame').catch(() => {});
        }
      },
      openText: this.sink.openText?.bind(this.sink),
    };
    await serveTransport(message, backend, (m) => this.sink.post(m));
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
    if (this.subscriptions.has('frame')) {
      this.sink.post({ type: 'frame', rgba, frame });
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
}
