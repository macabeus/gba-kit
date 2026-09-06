/**
 * A transport over an in-process `@gba-kit/debug-core` session: what a web page
 * that runs the emulator itself uses. The custom requests are answered the way
 * the debug adapter answers them — the same bodies, the same argument semantics
 * (the count and frame helpers of `@gba-kit/debug-core/protocol`), and a state
 * notification after everything that changes the state body — so a panel sees no
 * difference between the two.
 */
import { EVENT_BREAKPOINT_KINDS, type InputRecording, type Session } from '@gba-kit/debug-core';
import {
  AUDIO_SAMPLE_RATE,
  type GbaKitCommand,
  type GbaKitRequests,
  LOG,
  type PpuArguments,
  type PpuBody,
  STREAM,
  type StateBody,
  entryCount,
  rewindFrameCount,
  tileCount,
} from '@gba-kit/debug-core/protocol';

import type { PanelId } from './panels/DebugPanels.js';
import type { ControlAction, Transport } from './transport.js';

export interface SessionTransportOptions {
  /** where a save state goes; without it, states live in memory for the page's lifetime */
  states?: {
    list(): Promise<Array<{ name: string; path: string; frame: number; createdAt: string }>>;
    save(name: string, text: string, frame: number): Promise<string>;
    load(nameOrPath: string): Promise<string | null>;
  };
  openText?: Transport['openText'];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function createSessionTransport(session: Session, options: SessionTransportOptions = {}): Transport {
  const memoryStates = new Map<string, { text: string; frame: number; createdAt: string }>();
  const labelListeners = new Set<() => void>();
  const panelListeners = new Set<(panel: PanelId) => void>();

  const state = (): StateBody => ({
    state: session.state,
    frame: session.frame,
    pc: session.pc,
    position: session.position,
    revision: session.revision,
    epoch: session.epoch,
    history: session.historyInfo(),
    recording: session.recording,
    replaying: session.replaying,
    tracing: session.tracing,
  });

  const ppu = (args: PpuArguments): PpuBody => {
    switch (args.kind) {
      case 'palette':
        return { kind: 'palette', ...session.palette() };
      case 'tiles': {
        const t = session.tiles(args.charBase, args.bpp === 8 ? 8 : 4, tileCount(args.count));
        return { kind: 'tiles', charBase: t.charBase, bpp: t.bpp, count: t.count, pixels: bytesToBase64(t.pixels) };
      }
      case 'tilemap':
        return { kind: 'tilemap', tilemap: session.tilemap(args.index) };
      case 'sprites':
        return { kind: 'sprites', sprites: session.sprites() };
      case 'backgrounds':
        return { kind: 'backgrounds', ...session.backgrounds() };
    }
  };

  /**
   * The labels changed in memory: every view hears of it, then the host's copy is
   * written. A failed write rejects the request that caused it, so the panel that
   * asked shows why the labels will not be there next time.
   */
  const labelsChanged = async (): Promise<void> => {
    labelListeners.forEach((l) => l());
    await session.saveLabels();
  };

  async function request<C extends GbaKitCommand>(
    command: C,
    args?: GbaKitRequests[C]['args'],
  ): Promise<GbaKitRequests[C]['body']> {
    type A<K extends GbaKitCommand> = NonNullable<GbaKitRequests[K]['args']>;
    const a = (args ?? {}) as never;
    switch (command) {
      case 'gba-kit/state':
        return state() as never;
      case 'gba-kit/input': {
        const { button, down } = a as A<'gba-kit/input'>;
        session.setButton(button, down);
        return { buttons: session.buttons } as never;
      }
      case 'gba-kit/buttons': {
        const { mask } = a as A<'gba-kit/buttons'>;
        session.setButtons(mask);
        return { buttons: session.buttons } as never;
      }
      case 'gba-kit/stepFrame':
        session.stepFrame();
        return undefined as never;
      case 'gba-kit/stepScanline':
        session.stepScanline();
        return undefined as never;
      case 'gba-kit/rewind':
        return { rewound: session.rewindFrames(rewindFrameCount((a as A<'gba-kit/rewind'>).frames)) } as never;
      case 'gba-kit/rewindToFrame':
        return { rewound: session.rewindToFrame((a as A<'gba-kit/rewindToFrame'>).frame) } as never;
      case 'gba-kit/frame':
        return {
          width: STREAM.width,
          height: STREAM.height,
          frame: session.frame,
          rgba: bytesToBase64(session.machine.framebufferRgba()),
        } as never;
      case 'gba-kit/stream':
        return { connected: false } as never;
      case 'gba-kit/requestFrame':
        session.requestFrame();
        return undefined as never;
      case 'gba-kit/recordStart':
        session.startRecording();
        return undefined as never;
      case 'gba-kit/recordStop': {
        const recording = session.stopRecording();
        return { recording, script: session.recordingAsScript(recording) } as never;
      }
      case 'gba-kit/lastRecording': {
        const last = session.lastRecording;
        return { last: last ? { recording: last, script: session.recordingAsScript(last) } : null } as never;
      }
      case 'gba-kit/recordings':
        return {
          takes: session.recordings.map((t) => ({
            id: t.id,
            recording: t.recording,
            script: t.script,
            thumbnail: bytesToBase64(t.thumbnail.rgba),
            width: t.thumbnail.width,
            height: t.thumbnail.height,
          })),
        } as never;
      case 'gba-kit/replay': {
        const replay = a as A<'gba-kit/replay'>;
        return {
          replayed: session.replayRecording(
            replay.recording as InputRecording,
            replay.from === 'here' ? 'here' : 'start',
          ),
        } as never;
      }
      case 'gba-kit/saveState': {
        const name = (a as A<'gba-kit/saveState'>).name?.trim() || `frame-${session.frame}`;
        const text = session.saveState(name);
        const createdAt = new Date().toISOString();
        const path = options.states ? await options.states.save(name, text, session.frame) : name;
        if (!options.states) {
          memoryStates.set(name, { text, frame: session.frame, createdAt });
        }
        return { name, path, frame: session.frame, createdAt } as never;
      }
      case 'gba-kit/loadState': {
        const { name, path } = a as A<'gba-kit/loadState'>;
        // named the same way the adapter names it, so a client reads one rejection either way
        const key = (path ?? name ?? '').trim();
        if (!key) {
          throw new Error(path !== undefined ? "'path' is empty" : "'name' is empty");
        }
        const text = options.states ? await options.states.load(key) : (memoryStates.get(key)?.text ?? null);
        if (text === null) {
          throw new Error(`no such state: ${key}`);
        }
        session.loadState(text);
        return undefined as never;
      }
      case 'gba-kit/listStates': {
        const states = options.states
          ? await options.states.list()
          : [...memoryStates.entries()].map(([name, s]) => ({
              name,
              path: name,
              frame: s.frame,
              createdAt: s.createdAt,
            }));
        return { states } as never;
      }
      case 'gba-kit/ppu':
        return ppu(a as PpuArguments) as never;
      case 'gba-kit/ioRegisters':
        return { registers: session.ioRegisters() } as never;
      case 'gba-kit/trace': {
        const { count, enabled } = a as A<'gba-kit/trace'>;
        if (enabled !== undefined) {
          session.setTracing(enabled);
        }
        return { enabled: session.tracing, entries: session.trace.last(entryCount(count, LOG.traceDefault)) } as never;
      }
      case 'gba-kit/events':
        return {
          entries: session.events.last(entryCount((a as A<'gba-kit/events'>).count, LOG.eventsDefault)),
        } as never;
      case 'gba-kit/labels':
        return { labels: session.labels.all() } as never;
      case 'gba-kit/setLabel': {
        const { address, label, comment, size } = a as A<'gba-kit/setLabel'>;
        session.labels.set({ address, label: label ?? '', comment, size });
        await labelsChanged();
        return { labels: session.labels.all() } as never;
      }
      case 'gba-kit/importLabels': {
        const imported = session.labels.importSymbols((a as A<'gba-kit/importLabels'>).text);
        await labelsChanged();
        return { imported } as never;
      }
      case 'gba-kit/exportLabels':
        return { text: session.labels.exportSymbols() } as never;
      case 'gba-kit/searchMemory':
        return { addresses: session.searchMemory(a as A<'gba-kit/searchMemory'>) } as never;
      case 'gba-kit/filterMemory': {
        const { addresses, value, size } = a as A<'gba-kit/filterMemory'>;
        return { addresses: session.filterMemory(addresses, value, size) } as never;
      }
      case 'gba-kit/eventBreakpoints':
        return {
          kinds: EVENT_BREAKPOINT_KINDS.map((k) => ({ ...k })),
          enabled: [...session.breakpoints.events],
        } as never;
      default:
        throw new Error(`unknown request '${command}'`);
    }
  }

  const control = async (action: ControlAction): Promise<void> => {
    switch (action) {
      case 'continue':
        return session.continue();
      case 'pause':
        return session.pause();
      case 'stepInstruction':
        return session.stepInstruction();
      case 'stepOver':
        return session.stepOver();
      case 'stepInto':
        return session.stepInto();
      case 'stepOut':
        return session.stepOut();
      case 'stepBack':
        session.stepBack();
        return;
      case 'restart':
        return session.restart();
    }
  };

  return {
    request,
    control,
    onState(listener) {
      listener(state());
      // every session event after which the body reads differently, like the adapter's `gba-kit/state`
      const notify = (): void => listener(state());
      return session.on({ stopped: notify, continued: notify, state: notify, recording: notify, tracing: notify });
    },
    onFrame(listener) {
      const off = session.on({ frame: listener });
      session.requestFrame();
      return off;
    },
    onAudio(listener) {
      return session.on({ audio: (samples) => listener(samples, AUDIO_SAMPLE_RATE) });
    },
    onLabels(listener) {
      labelListeners.add(listener);
      return () => labelListeners.delete(listener);
    },
    openText: options.openText,
    showPanel(panel) {
      panelListeners.forEach((l) => l(panel));
    },
    onShowPanel(listener) {
      panelListeners.add(listener);
      return () => panelListeners.delete(listener);
    },
  };
}
