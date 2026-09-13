/**
 * The seam between the panels and a debugger. A VS Code webview implements it
 * with `postMessage` to an extension that forwards to the debug session; a web
 * page implements it with direct calls into a `@gba-kit/debug-core` session
 * (`createSessionTransport`). The panels never know which.
 */
import type { GbaKitCommand, GbaKitRequests, StateBody } from '@gba-kit/debug-core/protocol';

import type { PanelId } from './panels/DebugPanels.js';
import { base64ToBytes, bytesToBase64 } from './render.js';

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
  /**
   * The state as last reported, readable while rendering, or null before the host
   * has reported one. The same object until the state changes, so React can compare
   * it by identity (`useDebugState` reads it through `useSyncExternalStore`).
   */
  readonly state: StateBody | null;
  /** Called with the current state on subscription (when known), then on every change. */
  onState(listener: (state: StateBody) => void): Unsubscribe;
  /** 240×160 RGBA frames; subscribing asks the host for a current one. */
  onFrame(listener: (rgba: Uint8Array, frame: number) => void): Unsubscribe;
  /** Interleaved stereo samples, when the host streams audio. */
  onAudio(listener: (samples: Float32Array, sampleRate: number) => void): Unsubscribe;
  /** The label set changed. */
  onLabels(listener: () => void): Unsubscribe;
  /** Show text to the user in an editor (a recording's script, an exported symbol file), when the host has one. */
  openText?(content: string, language: string, title: string): void;
  /**
   * Ask the user for a file and read it, when the host has a way to open one. Null
   * when they picked nothing. `filters` is extension lists by description, the way an
   * editor's open dialog takes them, and `maxBytes` is what the caller can take: a
   * bigger file is refused where its bytes already are, before anything copies them.
   */
  pickFile?(options: { title: string; filters: Record<string, string[]>; maxBytes: number }): Promise<{
    name: string;
    bytes: Uint8Array;
  } | null>;
  /** Write bytes to a file the user names, when the host has a way to save one. False when they cancelled. */
  saveFile?(options: {
    title: string;
    suggestedName: string;
    filters: Record<string, string[]>;
    bytes: Uint8Array;
  }): Promise<boolean>;
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
  | { type: 'pickFile'; id: number; title: string; filters: Record<string, string[]>; maxBytes: number }
  /** `bytes` is base64: nothing has crossed webview→host as a typed array here, and text always has */
  | {
      type: 'saveFile';
      id: number;
      title: string;
      suggestedName: string;
      filters: Record<string, string[]>;
      bytes: string;
    }
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

  // a message carrying an `id` is one the host answers; the rest are told, not asked
  const send = (message: TransportToHost): Promise<unknown> => {
    if (!('id' in message)) {
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
   * crossing to a panel that no longer shows them). Frames pass `always`: every new
   * listener subscribes again so the host asks the machine for a current frame, since
   * a stopped one sends no more and the frame cached here can predate the stop.
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
    get state() {
      return lastState;
    },
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
    async pickFile(options) {
      const picked = (await send({ type: 'pickFile', id: nextId++, ...options })) as {
        name: string;
        bytes: string;
      } | null;
      return picked && { name: picked.name, bytes: base64ToBytes(picked.bytes) };
    },
    saveFile: ({ bytes, ...rest }) =>
      send({ type: 'saveFile', id: nextId++, ...rest, bytes: bytesToBase64(bytes) }) as Promise<boolean>,
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
  pickFile?: Transport['pickFile'];
  saveFile?: Transport['saveFile'];
  /** a webview asked for a tool panel; the host brings the view that holds it up and tells it which */
  showPanel?(panel: PanelId): void;
}

/** What a host that can open no file answers, rather than leaving the webview waiting. */
export const NO_FILE_DIALOG = 'this host cannot open files';

/**
 * What every `pickFile` answers for a file bigger than the caller said it could take.
 * A mis-picked ROM is turned away by its length alone, before the bytes are copied
 * anywhere: an extension host that base64-encoded one first would spend a second and a
 * gigabyte doing it, and on a big enough file would run out of heap and take the whole
 * extension host down with it.
 */
export function fileTooBig(name: string, byteLength: number, maxBytes: number): string {
  return `${name} is ${byteLength} bytes; at most ${maxBytes} can be read here`;
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
    case 'pickFile':
      await answer(
        message.id,
        backend.pickFile,
        { title: message.title, filters: message.filters, maxBytes: message.maxBytes },
        reply,
        (file) => {
          if (!file) {
            return null;
          }
          if (file.bytes.length > message.maxBytes) {
            throw new Error(fileTooBig(file.name, file.bytes.length, message.maxBytes));
          }
          return { name: file.name, bytes: bytesToBase64(file.bytes) };
        },
      );
      return;
    case 'saveFile':
      await answer(
        message.id,
        backend.saveFile,
        {
          title: message.title,
          suggestedName: message.suggestedName,
          filters: message.filters,
          bytes: base64ToBytes(message.bytes),
        },
        reply,
        (kept) => kept,
      );
      return;
    case 'showPanel':
      backend.showPanel?.(message.panel);
      return;
  }
}

/**
 * Run one of the optional file-dialog capabilities and answer the message that asked
 * for it, with `wire` putting what it returned in the shape the message union declares —
 * a file's bytes cross base64-encoded, the way the ones going out do. A host without
 * the capability answers so rather than leaving the webview waiting.
 */
async function answer<A, R>(
  id: number,
  capability: ((options: A) => Promise<R>) | undefined,
  options: A,
  reply: (message: HostToTransport) => void,
  wire: (answer: R) => unknown,
): Promise<void> {
  if (!capability) {
    reply({ type: 'response', id, error: NO_FILE_DIALOG });
    return;
  }
  try {
    // `wire` runs inside the try: a file a capability should not have handed over at all
    // is refused there, and refusing is an answer like any other
    reply({ type: 'response', id, body: wire(await capability(options)) });
  } catch (err) {
    reply({ type: 'response', id, error: (err as Error).message });
  }
}
