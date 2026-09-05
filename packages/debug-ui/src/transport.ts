/**
 * The seam between the panels and a debugger. A VS Code webview implements it
 * with `postMessage` to an extension that forwards to the debug session; a web
 * page implements it with direct calls into a `@gba-kit/debug-core` session
 * (`createSessionTransport`). The panels never know which.
 */
import type { GbaKitCommand, GbaKitRequests, StateBody } from '@gba-kit/debug-core/protocol';

import type { PanelId } from './panels/DebugPanels.js';

// A host that only serves the transport (an extension host bundling no React) imports this module alone.
export type { PanelId };

/** The execution controls a panel's toolbar can trigger; the host maps them to its debugger. */
export type ControlAction =
  | 'continue'
  | 'pause'
  | 'stepInstruction'
  | 'stepOver'
  | 'stepInto'
  | 'stepOut'
  | 'stepBack'
  | 'restart';

export type Unsubscribe = () => void;

/** The feeds a transport can subscribe to on its host. */
export type Feed = 'state' | 'frame' | 'audio' | 'labels' | 'showPanel';

export interface Transport {
  /** A `gba-kit/*` custom request. */
  request<C extends GbaKitCommand>(command: C, args?: GbaKitRequests[C]['args']): Promise<GbaKitRequests[C]['body']>;
  /** A standard execution control. */
  control(action: ControlAction): Promise<void>;
  /** Called with the current state on subscription (when known), then on every change. */
  onState(listener: (state: StateBody) => void): Unsubscribe;
  /** 240×160 RGBA frames; the host asks for one on subscription. */
  onFrame(listener: (rgba: Uint8Array, frame: number) => void): Unsubscribe;
  /** Interleaved stereo samples, when the host streams audio. */
  onAudio(listener: (samples: Float32Array, sampleRate: number) => void): Unsubscribe;
  /** The label set changed. */
  onLabels(listener: () => void): Unsubscribe;
  /** Show text to the user in an editor (a recording's script, an exported symbol file), when the host has one. */
  openText?(content: string, language: string, title: string): void;
  /**
   * Bring one of the tool panels into view (a stopped recording, in the Recording
   * tab), when the host has somewhere to show it. Whoever renders `DebugPanels`
   * hears it through `onShowPanel`; a host with several views routes it between them.
   */
  showPanel?(panel: PanelId): void;
  /** Something asked for a tool panel to be shown; `DebugPanels` selects it when it offers that tab. */
  onShowPanel?(listener: (panel: PanelId) => void): Unsubscribe;
}

// ─── postMessage transport (a webview and its host) ─────────────────────

/** Messages a webview transport sends to its host. */
export type TransportToHost =
  | { type: 'request'; id: number; command: string; args?: unknown }
  | { type: 'control'; id: number; action: ControlAction }
  | { type: 'subscribe'; what: Feed }
  /** the last listener of a feed left: the host may stop sending it */
  | { type: 'unsubscribe'; what: Feed }
  | { type: 'openText'; content: string; language: string; title: string }
  | { type: 'showPanel'; panel: PanelId };

/** Messages a host sends to a webview transport. */
export type HostToTransport =
  | { type: 'response'; id: number; body?: unknown; error?: string }
  | { type: 'state'; state: StateBody }
  | { type: 'frame'; rgba: Uint8Array; frame: number }
  | { type: 'audio'; samples: Float32Array; sampleRate: number }
  | { type: 'labels' }
  | { type: 'showPanel'; panel: PanelId };

export interface MessagePort {
  post(message: TransportToHost): void;
  /** Deliver host messages here; returns the unsubscribe. */
  listen(handler: (message: HostToTransport) => void): Unsubscribe;
}

/** A transport that talks to its host in messages (VS Code's `acquireVsCodeApi().postMessage`). */
export function createMessageTransport(port: MessagePort): Transport {
  let nextId = 1;
  const pending = new Map<number, { resolve: (body: unknown) => void; reject: (err: Error) => void }>();
  const listeners = {
    state: new Set<(state: StateBody) => void>(),
    frame: new Set<(rgba: Uint8Array, frame: number) => void>(),
    audio: new Set<(samples: Float32Array, sampleRate: number) => void>(),
    labels: new Set<() => void>(),
    showPanel: new Set<(panel: PanelId) => void>(),
  };
  let lastState: StateBody | null = null;
  let lastFrame: { rgba: Uint8Array; frame: number } | null = null;

  port.listen((message) => {
    switch (message.type) {
      case 'response': {
        const p = pending.get(message.id);
        if (!p) {
          return;
        }
        pending.delete(message.id);
        if (message.error !== undefined) {
          p.reject(new Error(message.error));
        } else {
          p.resolve(message.body);
        }
        return;
      }
      case 'state':
        lastState = message.state;
        listeners.state.forEach((l) => l(message.state));
        return;
      case 'frame':
        lastFrame = { rgba: message.rgba, frame: message.frame };
        listeners.frame.forEach((l) => l(message.rgba, message.frame));
        return;
      case 'audio':
        listeners.audio.forEach((l) => l(message.samples, message.sampleRate));
        return;
      case 'labels':
        listeners.labels.forEach((l) => l());
        return;
      case 'showPanel':
        listeners.showPanel.forEach((l) => l(message.panel));
        return;
    }
  });

  const send = (message: TransportToHost): Promise<unknown> => {
    if (message.type !== 'request' && message.type !== 'control') {
      port.post(message);
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      pending.set(message.id, { resolve, reject });
      port.post(message);
    });
  };

  /**
   * Keep the host's idea of a feed in step with its listeners: subscribed while it
   * has any, unsubscribed once the last leaves (so 150 KB frames and audio stop
   * crossing to a panel that no longer shows them). A feed `always` subscribes on
   * every listener when the host does something on each subscription (it resends
   * the last frame).
   */
  function listen<L>(what: Feed, set: Set<L>, listener: L, always = false): Unsubscribe {
    if (set.size === 0 || always) {
      port.post({ type: 'subscribe', what });
    }
    set.add(listener);
    return () => {
      if (set.delete(listener) && set.size === 0) {
        port.post({ type: 'unsubscribe', what });
      }
    };
  }

  return {
    request: (command, args) => send({ type: 'request', id: nextId++, command, args }) as Promise<never>,
    control: (action) => send({ type: 'control', id: nextId++, action }).then(() => undefined),
    onState(listener) {
      const off = listen('state', listeners.state, listener);
      if (lastState) {
        listener(lastState);
      }
      return off;
    },
    onFrame(listener) {
      const off = listen('frame', listeners.frame, listener, true);
      if (lastFrame) {
        listener(lastFrame.rgba, lastFrame.frame);
      }
      return off;
    },
    onAudio: (listener) => listen('audio', listeners.audio, listener),
    onLabels: (listener) => listen('labels', listeners.labels, listener),
    openText: (content, language, title) => port.post({ type: 'openText', content, language, title }),
    showPanel: (panel) => port.post({ type: 'showPanel', panel }),
    // the subscription tells the host this view can show a panel: one asked for before it loaded arrives now
    onShowPanel: (listener) => listen('showPanel', listeners.showPanel, listener),
  };
}

/** What a host needs to answer a webview transport; `serveTransport` does the plumbing. */
export interface TransportBackend {
  request(command: string, args: unknown): Promise<unknown>;
  control(action: ControlAction): Promise<void>;
  subscribe(what: Feed): void;
  /** the webview's last listener of the feed left */
  unsubscribe(what: Feed): void;
  openText?(content: string, language: string, title: string): void;
  /** a webview asked for a tool panel; the host brings the view that holds it up and tells it which */
  showPanel?(panel: PanelId): void;
}

/** Handle one message from a webview transport on the host side. */
export async function serveTransport(
  message: TransportToHost,
  backend: TransportBackend,
  reply: (message: HostToTransport) => void,
): Promise<void> {
  switch (message.type) {
    case 'request':
      try {
        reply({ type: 'response', id: message.id, body: await backend.request(message.command, message.args) });
      } catch (err) {
        reply({ type: 'response', id: message.id, error: (err as Error).message });
      }
      return;
    case 'control':
      try {
        await backend.control(message.action);
        reply({ type: 'response', id: message.id });
      } catch (err) {
        reply({ type: 'response', id: message.id, error: (err as Error).message });
      }
      return;
    case 'subscribe':
      backend.subscribe(message.what);
      return;
    case 'unsubscribe':
      backend.unsubscribe(message.what);
      return;
    case 'openText':
      backend.openText?.(message.content, message.language, message.title);
      return;
    case 'showPanel':
      backend.showPanel?.(message.panel);
      return;
  }
}
