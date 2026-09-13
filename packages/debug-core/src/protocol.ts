/**
 * The gba-kit extensions to the Debug Adapter Protocol: the vocabulary a session
 * answers and every client speaks, whichever way the two are connected.
 *
 * Everything a standard DAP client can do, it gets from the standard requests. What
 * an emulator has and a debugger for native code does not — a screen, buttons,
 * frames and scanlines as units of time, rewind by frames, save states, input
 * recordings, the PPU and I/O views, labels — is a custom request named
 * `gba-kit/<name>`, and a change of execution state is the `gba-kit/state` event.
 * A client that knows none of them still has a complete source debugger.
 *
 * `@gba-kit/debug-adapter` answers these requests over DAP; `@gba-kit/debug-ui`
 * answers them in-process for a page that runs the emulator itself. Both import
 * this module for the types and the few constants and argument helpers below, so
 * a panel sees the same bodies and the same argument semantics either way.
 */
import type { EventBreakpointKind } from './breakpoints.js';
import type { IoRegisterValue } from './io.js';
import type { Label } from './labels.js';
import type { SearchOptions } from './memory-search.js';
import { type BackgroundInfo, type SpriteInfo, type TilemapSnapshot, screenToJson } from './ppu.js';
import type { InputRecording, RecordedTake } from './recorder.js';
import type { EventEntry, TraceEntry } from './rings.js';
import type { HistoryInfo, Position, Session, SessionState, StopReason } from './session.js';
import { type SaveStateFile, bytesToBase64 } from './snapshot-codec.js';

/** The most a `gba-kit/importSave` payload can carry, so a client can turn a mis-picked file away before encoding it. */
export { MAX_SAVE_FILE_SIZE } from './cartridge-save.js';

/** What the head of a save-state file says about it. */
export type SaveStateMeta = Partial<Omit<SaveStateFile, 'snapshot'>>;

/** Body of the `gba-kit/state` event and response; the machine's place in time. */
export interface StateBody {
  state: SessionState;
  frame: number;
  pc: number;
  position: Position;
  /** bumps whenever the machine changes: variable handles from an older revision are stale */
  revision: number;
  /** bumps on a restart or a resync: everything derived from the old machine is stale */
  epoch: number;
  /** what rewind can reach, and the input recording in progress (`recordingStart`) */
  history: HistoryInfo;
  recording: boolean;
  /** a recording is being played back: the machine runs on its buttons, not the user's */
  replaying: boolean;
  tracing: boolean;
  /** why the machine last stopped, while it is stopped: an entry stop is not a breakpoint */
  reason?: StopReason;
  /** what that stop said, when it said anything */
  description?: string;
}

export type PpuArguments =
  | { kind: 'palette' }
  | { kind: 'tiles'; charBase: number; bpp: 4 | 8; count: number }
  | { kind: 'tilemap'; index: number }
  | { kind: 'sprites' }
  | { kind: 'backgrounds' };

export type PpuBody =
  | { kind: 'palette'; bg: number[]; obj: number[] }
  | {
      kind: 'tiles';
      charBase: number;
      bpp: 4 | 8;
      count: number;
      /** base64 of count × 64 palette indices */ pixels: string;
    }
  | { kind: 'tilemap'; tilemap: TilemapSnapshot | null }
  | { kind: 'sprites'; sprites: SpriteInfo[] }
  | { kind: 'backgrounds'; mode: number; backgrounds: BackgroundInfo[] };

export interface SavedStateInfo {
  name: string;
  path: string;
  frame: number;
  createdAt: string;
  /** the screen it was saved on: base64 RGBA, `width` × `height`; absent on a state saved before thumbnails */
  thumbnail?: string;
  width?: number;
  height?: number;
}

/** An input recording as `gba-kit/recordStop` hands it out: the log, and the same as a `press`/`wait` script. */
export interface RecordingBody {
  recording: InputRecording;
  script: string;
}

/** A finished recording as a view lists it: the log, its script, and the screen it begins on. */
export interface TakeBody extends RecordingBody {
  /** when the recording was stopped, or when the file holding it was written */
  createdAt: string;
  /** unique within a session, and stable while it is listed */
  id: number;
  /** the screen where the recording begins: base64 RGBA, `width` × `height` */
  thumbnail: string;
  width: number;
  height: number;
}

/**
 * Custom requests: `command` → its arguments and response body. `GbaKitRequests[C]['args']`
 * is what a client sends in `arguments`, `['body']` what comes back in `body`.
 */
export interface GbaKitRequests {
  /** Where the machine is; the same body the `gba-kit/state` event carries. */
  'gba-kit/state': { args?: Record<string, never>; body: StateBody };

  /** Press or release one button (GBA bit order: A, B, Select, Start, Right, Left, Up, Down, R, L). */
  'gba-kit/input': { args: { button: number; down: boolean }; body: { buttons: number } };
  /** Set every button at once, as a mask. */
  'gba-kit/buttons': { args: { mask: number }; body: { buttons: number } };

  /** Run to the end of the current hardware frame (a breakpoint inside it still stops). */
  'gba-kit/stepFrame': { args?: Record<string, never>; body: undefined };
  /** Run to the next scanline. */
  'gba-kit/stepScanline': { args?: Record<string, never>; body: undefined };
  /**
   * Rewind by whole frames, at least one (DAP `stepBack` is one instruction). From
   * inside a frame, the first frame back is the start of that frame.
   */
  'gba-kit/rewind': { args: { frames: number }; body: { rewound: boolean } };
  /** Rewind to the start of a frame, as far as history reaches. */
  'gba-kit/rewindToFrame': { args: { frame: number }; body: { rewound: boolean } };

  /** The screen right now: 240×160 RGBA, base64. For clients without a stream pipe. */
  'gba-kit/frame': {
    args?: Record<string, never>;
    body: { width: number; height: number; frame: number; rgba: string };
  };
  /**
   * Connect the frame (and optionally audio) stream to a pipe the client listens on —
   * a Unix socket path or a Windows named pipe. See {@link STREAM} for the framing.
   */
  'gba-kit/stream': { args: { path: string; audio?: boolean }; body: { connected: boolean } };
  /** Emit a frame now (a screen view just opened). Goes to the stream, if connected. */
  'gba-kit/requestFrame': { args?: Record<string, never>; body: undefined };

  /** Start recording the buttons held on every frame from here; `gba-kit/state` then reports it. */
  'gba-kit/recordStart': { args?: Record<string, never>; body: undefined };
  /** Stop recording: the input log, and the same as a `press`/`wait` script. */
  'gba-kit/recordStop': { args?: Record<string, never>; body: RecordingBody };
  /**
   * The recording `gba-kit/recordStop` last produced, whoever asked for it (a panel,
   * a command), so a view that shows recordings can show and replay it. Null until
   * a recording has been stopped in this session.
   */
  'gba-kit/lastRecording': { args?: Record<string, never>; body: { last: RecordingBody | null } };
  /** The finished recordings of this session, oldest first, at most the newest 20, each with the screen it begins on. */
  'gba-kit/recordings': { args?: Record<string, never>; body: { takes: TakeBody[] } };
  /** Forget a recording, and delete the file keeping it. False when this session has no such take. */
  'gba-kit/deleteRecording': { args: { id: number }; body: { deleted: boolean } };
  /**
   * Press a recording's buttons again: `start` (the default) puts the machine back
   * where the recording was made and reproduces it, `here` presses them from wherever
   * the machine is now.
   */
  /**
   * Replay a recording: `from` `'start'` puts the machine back where it was recorded,
   * `'here'` presses the buttons from where the machine is now. `id` names the take
   * the recording came from, when this session has it: its start state is what makes
   * `'start'` reach a frame this session never ran, in a project opened later.
   */
  'gba-kit/replay': {
    args: { recording: InputRecording; from?: 'start' | 'here'; id?: number };
    body: { replayed: boolean };
  };

  /**
   * Save the machine to `<projectDir>/.gba-kit/states/<name>.json`, with `name`
   * reduced to `[\w.-]` for the file (other characters become `_`, at most 80 of
   * them); an unnamed state is called `frame-<n>`, and `body.name` is the name the
   * state was saved under.
   */
  'gba-kit/saveState': { args?: { name?: string }; body: SavedStateInfo };
  /** Load a saved state by name, or by a `path` that `saveState` or `listStates` gave out (only the states directory is read). */
  'gba-kit/loadState': { args: { name?: string; path?: string }; body: undefined };
  'gba-kit/listStates': { args?: Record<string, never>; body: { states: SavedStateInfo[] } };
  /** Rename a saved state, by the same `name` or `path` `loadState` takes; the file is renamed with it. */
  'gba-kit/renameState': { args: { name?: string; path?: string; to: string }; body: SavedStateInfo };
  /** Delete a saved state, by the same `name` or `path` `loadState` takes. */
  'gba-kit/deleteState': { args: { name?: string; path?: string }; body: { deleted: boolean } };

  /**
   * A `.sav` — a raw cartridge battery-backup dump — as a new save state: a power-on
   * machine of this ROM with the save already in its cartridge, at frame 0. `bytes` is
   * the file base64-encoded and `name` what to call the state, which is the file's name
   * without its extension; a name already taken gets `(2)`, `(3)`… rather than being
   * written over. The machine being debugged is not touched, and the state is not loaded.
   */
  'gba-kit/importSave': { args: { bytes: string; name?: string }; body: SavedStateInfo };
  /** The machine's cartridge backup memory as a `.sav`, base64-encoded and the size its declared save type gives it. */
  'gba-kit/exportSave': { args?: Record<string, never>; body: { bytes: string } };

  /** A PPU view; a `tiles` request answers `TILES.defaultCount` tiles unless told how many, at most `TILES.maxCount`. */
  'gba-kit/ppu': { args: PpuArguments; body: PpuBody };
  'gba-kit/ioRegisters': { args?: Record<string, never>; body: { registers: IoRegisterValue[] } };

  /**
   * The newest `count` trace entries (`LOG.traceDefault` when unsaid, at most `LOG.max`;
   * an explicit 0 answers none, for a client that only wants `enabled`); `enabled`
   * turns instruction tracing on or off first, which `gba-kit/state` then reports.
   */
  'gba-kit/trace': { args?: { count?: number; enabled?: boolean }; body: { enabled: boolean; entries: TraceEntry[] } };
  /** The newest `count` hardware events (`LOG.eventsDefault` when unsaid, at most `LOG.max`; an explicit 0 answers none). */
  'gba-kit/events': { args?: { count?: number }; body: { entries: EventEntry[] } };

  'gba-kit/labels': { args?: Record<string, never>; body: { labels: Label[] } };
  /** Set (or, with an empty label and no comment, remove) the label at an address. Persisted. */
  'gba-kit/setLabel': {
    args: { address: number; label?: string; comment?: string; size?: number };
    body: { labels: Label[] };
  };
  /** Import a `.sym`-style file (`03005220 gUnk_03005220`, `gFoo = 0x03000000;`). */
  'gba-kit/importLabels': { args: { text: string }; body: { imported: number } };
  'gba-kit/exportLabels': { args?: Record<string, never>; body: { text: string } };

  'gba-kit/searchMemory': { args: SearchOptions; body: { addresses: number[] } };
  /** Keep the addresses that now hold `value`. */
  'gba-kit/filterMemory': {
    args: { addresses: number[]; value: number; size: 1 | 2 | 4 };
    body: { addresses: number[] };
  };

  /** The hardware events a breakpoint can be set on (also the `exceptionBreakpointFilters` capability). */
  'gba-kit/eventBreakpoints': {
    args?: Record<string, never>;
    body: {
      kinds: Array<{ kind: EventBreakpointKind; label: string; description: string }>;
      enabled: EventBreakpointKind[];
    };
  };
}

export type GbaKitCommand = keyof GbaKitRequests;

export interface GbaKitEvents {
  /**
   * Sent on every stop, resume, rewind, restart and state load, and after every
   * write the adapter makes to the machine (a `setVariable`, a `writeMemory`, a
   * recording start or stop, tracing turned on or off) — after the response to the
   * request that caused it. `revision`, `recording` and `tracing` say what to refresh.
   */
  'gba-kit/state': StateBody;
  /** The label set changed (a `setLabel` or an import). */
  'gba-kit/labels': { count: number };
}

/**
 * Framing of the frame/audio stream a client receives on the pipe it gave to
 * `gba-kit/stream`. Little-endian throughout. Each message is a header followed by
 * a payload of `length` bytes:
 *
 * ```
 * u16 magic   0x4b47 ('GK')
 * u8  type    1 = frame, 2 = audio
 * u8  flags   0
 * u32 length  payload bytes
 * ```
 *
 * A frame payload is `u32 frameNumber, u16 width, u16 height` then width × height
 * RGBA bytes. An audio payload is `u32 sampleRate` then interleaved stereo
 * float32 samples. While the machine runs frames arrive paced (debug-core spaces
 * its frame events); when the pipe backs up the adapter drops frames but keeps the
 * newest for when it drains, so a stop's frame always reaches the client.
 *
 * The pipe is two-way: the client may write `type 3` messages back, whose payload
 * is a `u16` button mask (GBA bit order) the adapter presses at the next frame —
 * how a screen page that is not a DAP client still has a gamepad.
 */
export const STREAM = {
  magic: 0x4b47,
  headerBytes: 8,
  frame: 1,
  audio: 2,
  input: 3,
  width: 240,
  height: 160,
} as const;

/**
 * The rate, in Hz, of the interleaved stereo samples a session's `audio` event
 * carries: what the machine mixes at, so every host that forwards them (the
 * stream's audio payload, an in-process transport) reports the same rate.
 */
export const AUDIO_SAMPLE_RATE = 32768;

/** The screen as `gba-kit/frame` answers it: the whole framebuffer, base64. */
export function frameBody(session: Session): GbaKitRequests['gba-kit/frame']['body'] {
  return {
    width: STREAM.width,
    height: STREAM.height,
    frame: session.frame,
    rgba: bytesToBase64(session.machine.framebufferRgba()),
  };
}

/**
 * One of the PPU views, as `gba-kit/ppu` answers it. The arguments come from a
 * client, so what they say a number is, is read as one.
 */
export function ppuBody(session: Session, args: PpuArguments): PpuBody {
  switch (args.kind) {
    case 'palette':
      return { kind: 'palette', ...session.palette() };
    case 'tiles': {
      const tiles = session.tiles(Number(args.charBase) >>> 0, args.bpp === 8 ? 8 : 4, tileCount(args.count));
      return {
        kind: 'tiles',
        charBase: tiles.charBase,
        bpp: tiles.bpp,
        count: tiles.count,
        pixels: bytesToBase64(tiles.pixels),
      };
    }
    case 'tilemap':
      return { kind: 'tilemap', tilemap: session.tilemap(Number(args.index)) };
    case 'sprites':
      return { kind: 'sprites', sprites: session.sprites() };
    case 'backgrounds':
      return { kind: 'backgrounds', ...session.backgrounds() };
    default:
      throw new Error(`unknown ppu view '${(args as { kind: string }).kind}'`);
  }
}

/**
 * A take as a body carries it: the screen as base64, the rest as the session holds
 * it. Both the debug adapter and the in-process transport answer with this, so the
 * two agree on the shape without either restating it.
 */
export function takeBody(take: RecordedTake): TakeBody {
  const screen = screenToJson(take.thumbnail);
  return {
    id: take.id,
    recording: take.recording,
    script: take.script,
    createdAt: take.createdAt,
    thumbnail: screen.rgba,
    width: screen.width,
    height: screen.height,
  };
}

/**
 * A saved state as a body carries it, from the metadata at the head of its file.
 * A state written before states kept a screen simply has none.
 */
export function savedStateInfo(name: string, path: string, meta: SaveStateMeta | null): SavedStateInfo {
  return {
    name,
    path,
    frame: meta?.frame ?? 0,
    createdAt: meta?.createdAt ?? '',
    thumbnail: meta?.thumbnail?.rgba,
    width: meta?.thumbnail?.width,
    height: meta?.thumbnail?.height,
  };
}

/** How many entries `gba-kit/trace` and `gba-kit/events` answer by default, and at most. */
export const LOG = {
  traceDefault: 200,
  eventsDefault: 500,
  max: 20_000,
} as const;

/** How many tiles a `gba-kit/ppu` `tiles` request answers by default, and at most (2048 4bpp tiles fill the 64 KB of background VRAM). */
export const TILES = {
  defaultCount: 512,
  maxCount: 2048,
} as const;

// ─── argument semantics, shared by every host that answers a request ──────

/**
 * The `count` of a `gba-kit/trace` or `gba-kit/events` request: `fallback` when
 * unsaid or not a number, an explicit 0 meaning none, never more than `max`.
 */
export function entryCount(raw: unknown, fallback: number, max: number = LOG.max): number {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : fallback;
}

/** The `frames` of a `gba-kit/rewind` request: whole frames, at least one. */
export function rewindFrameCount(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** The `count` of a `gba-kit/ppu` `tiles` request: `TILES.defaultCount` when unsaid or not a number, within 1..`TILES.maxCount`. */
export function tileCount(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, TILES.maxCount) : TILES.defaultCount;
}
