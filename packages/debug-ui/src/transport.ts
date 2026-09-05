/**
 * The seam between the panels and a debugger. A VS Code webview implements it
 * with `postMessage` to an extension that forwards to the debug session; a web
 * page implements it with direct calls into a `@gba-kit/debug-core` session
 * (`createSessionTransport`). The panels never know which.
 */
import type { GbaKitCommand, GbaKitRequests, StateBody } from '@gba-kit/debug-adapter/protocol';

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
}

// ─── postMessage transport (a webview and its host) ─────────────────────

/** Messages a webview transport sends to its host. */
export type TransportToHost =
  | { type: 'request'; id: number; command: string; args?: unknown }
  | { type: 'control'; id: number; action: ControlAction }
  | { type: 'subscribe'; what: 'state' | 'frame' | 'audio' | 'labels' }
  | { type: 'openText'; content: string; language: string; title: string };

/** Messages a host sends to a webview transport. */
export type HostToTransport =
  | { type: 'response'; id: number; body?: unknown; error?: string }
  | { type: 'state'; state: StateBody }
  | { type: 'frame'; rgba: Uint8Array; frame: number }
  | { type: 'audio'; samples: Float32Array; sampleRate: number }
  | { type: 'labels' };

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

  return {
    request: (command, args) => send({ type: 'request', id: nextId++, command, args }) as Promise<never>,
    control: (action) => send({ type: 'control', id: nextId++, action }).then(() => undefined),
    onState(listener) {
      listeners.state.add(listener);
      if (lastState) {
        listener(lastState);
      } else {
        port.post({ type: 'subscribe', what: 'state' });
      }
      return () => listeners.state.delete(listener);
    },
    onFrame(listener) {
      listeners.frame.add(listener);
      if (lastFrame) {
        listener(lastFrame.rgba, lastFrame.frame);
      }
      port.post({ type: 'subscribe', what: 'frame' });
      return () => listeners.frame.delete(listener);
    },
    onAudio(listener) {
      listeners.audio.add(listener);
      port.post({ type: 'subscribe', what: 'audio' });
      return () => listeners.audio.delete(listener);
    },
    onLabels(listener) {
      listeners.labels.add(listener);
      port.post({ type: 'subscribe', what: 'labels' });
      return () => listeners.labels.delete(listener);
    },
    openText: (content, language, title) => port.post({ type: 'openText', content, language, title }),
  };
}

/** What a host needs to answer a webview transport; `serveTransport` does the plumbing. */
export interface TransportBackend {
  request(command: string, args: unknown): Promise<unknown>;
  control(action: ControlAction): Promise<void>;
  subscribe(what: 'state' | 'frame' | 'audio' | 'labels'): void;
  openText?(content: string, language: string, title: string): void;
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
    case 'openText':
      backend.openText?.(message.content, message.language, message.title);
      return;
  }
}
