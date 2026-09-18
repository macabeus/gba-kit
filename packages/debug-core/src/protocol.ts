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
import type { Tier } from '@gba-kit/debug-info';

import type { EventBreakpointKind } from './breakpoints.js';
import { DIFF_LIMITS, NOISE_FRAMES, rangeBytes } from './diff-limits.js';
import type { IoRegisterValue } from './io.js';
import type { Label } from './labels.js';
import { type Capture, type DiffGroup, type DiffQuery, type DiffRow, RELATIONS, type Relation } from './memory-diff.js';
import type { Mute, MuteSource } from './memory-noise.js';
import type { SearchOptions } from './memory-search.js';
import { type BackgroundInfo, type SpriteInfo, type TilemapSnapshot, screenToJson } from './ppu.js';
import type { InputRecording, RecordedTake } from './recorder.js';
import type { EventEntry, TraceEntry } from './rings.js';
import type { HistoryInfo, Position, Session, SessionState, StopReason } from './session.js';
import { type SaveStateFile, bytesToBase64 } from './snapshot-codec.js';

/** Where a mute came from, which is also what a client names it by; the type alone, so nothing here reaches the emulator. */
export type { MuteSource };

/** The most a `gba-kit/importSave` payload can carry, so a client can turn a mis-picked file away before encoding it. */
export { MAX_SAVE_FILE_SIZE } from './cartridge-save.js';

/** A typed member path as a name a label can carry and the `.sym` importer can read back. */
export { labelName } from './labels.js';

/** A capture as a client sees it: everything but the 288 KB of RAM, which never crosses. */
export interface CaptureInfo {
  id: number;
  tag: string;
  frame: number;
  createdAt: string;
  /** a capture adopted from a save state was never live in this machine */
  from: 'machine' | 'state';
  /** the screen it was taken on: base64 RGBA, `width` × `height` */
  thumbnail: string;
  width: number;
  height: number;
}

/** One candidate address, with what every capture held there. */
export interface DiffRowBody {
  address: number;
  /** the group it belongs to, so a page of rows needs no second request to be grouped */
  group: string;
  /** one per capture, in capture order — the matrix the user reads by eye */
  values: number[];
  /** how each value reads through its type (an enum by name, a bool, a bitfield) */
  formatted?: string[];
  tier: Tier;
  /** the object it is in when `tier` is `sized`, the nearest landmark when it is `inferred` */
  symbol?: { name: string; offset: number };
  /** `gEntityInfo[13].xPosBg2`, when a DWARF type reached the address */
  path?: string;
  /**
   * How far into what `path` names the address is. Absent means the object begins
   * here, which is the only case the path *names* the address rather than the one it
   * is a byte of: four bytes of one `s32` are four rows, and three of them are not it.
   */
  pathOffset?: number;
  type?: string;
  /** the other members of a union covering these bytes: no one reading of them is the reading */
  alternatives?: string[];
  /** the path went past a declared bound, so it is a hypothesis */
  extrapolated?: boolean;
  /** the read crosses out of the object the path names */
  straddles?: boolean;
  /** why it is ranked where it is, so the order is arguable rather than magic */
  rank: number;
  reasons: string[];
}

export interface DiffGroupBody {
  key: string;
  tier: Tier;
  label: string;
  rows: number;
  topRank: number;
}

/** How many candidates each kind of mute is hiding right now. */
export type MuteTally = Partial<Record<MuteSource, number>>;

/** A muted range set as a client lists it, with how many addresses it covers. */
export interface MuteBody extends Mute {
  bytes: number;
}

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

  /** The captures this session holds, oldest first; the RAM they hold stays in the session. */
  'gba-kit/captures': { args?: Record<string, never>; body: { captures: CaptureInfo[] } };
  /**
   * Take a capture of RAM as it is now, or adopt a save state as one — `state` names it
   * the way `loadState` does, and the machine being debugged does not move either way.
   */
  'gba-kit/capture': { args?: { tag?: string; state?: string; path?: string }; body: { capture: CaptureInfo } };
  /** Give a capture another tag; equal tags are what the tag filter matches on. */
  'gba-kit/retagCapture': { args: { id: number; tag: string }; body: { captures: CaptureInfo[] } };
  'gba-kit/forgetCapture': { args: { id: number }; body: { captures: CaptureInfo[] } };

  /**
   * Run the machine for a few idle frames and put it back, muting whatever moved on its
   * own and whatever the DMA copied into VRAM, OAM or palette. Every mute is an address
   * range; nothing here is muted by name.
   */
  'gba-kit/discoverNoise': {
    args?: { frames?: number };
    body: { mutes: MuteBody[]; churnBytes: number; frames: number };
  };
  'gba-kit/mutes': { args?: Record<string, never>; body: { mutes: MuteBody[] } };
  /**
   * Add, switch off or remove a mute: `ranges` adds one the user picked out, `id` with
   * `enabled` switches one, `id` with `remove` takes it away.
   */
  'gba-kit/setMute': {
    args: {
      id?: number;
      ranges?: Array<{ lo: number; hi: number }>;
      note?: string;
      enabled?: boolean;
      remove?: boolean;
    };
    body: { mutes: MuteBody[] };
  };

  /** Put the captures in this order, which is the sequence the links are read along. */
  'gba-kit/reorderCaptures': { args: { ids: number[] }; body: { captures: CaptureInfo[] } };

  /**
   * Answer a query and read a page of what it keeps. The query is asked of the whole
   * address space, so it describes the run rather than narrowing what a previous one
   * left; `reset` drops the standing answer, and takes no `query`.
   */
  'gba-kit/diffFilter': {
    args?: {
      query?: DiffQuery;
      size?: 1 | 2 | 4;
      reset?: boolean;
      from?: number;
      limit?: number;
    };
    body: {
      total: number;
      /** how many of them are placed, ranked and reachable as rows: past this the pages stop */
      detail: number;
      /** too many candidates to group, rank or order: the rows are a page in address order */
      capped: boolean;
      /** whether a query has been answered at all, so a client can tell an untouched set from a result */
      asked: boolean;
      size: 1 | 2 | 4;
      hidden: MuteTally;
      groups: DiffGroupBody[];
      /** where in the candidates this page starts, so a pager knows what it is showing */
      from: number;
      rows: DiffRowBody[];
    };
  };

  /**
   * Watch an address for writes, keeping what is already watched: the end of a memory
   * diff is a function name, and the code that writes the variable is what names it. A
   * DAP client that sets its own data breakpoints replaces the list, this one included.
   */
  'gba-kit/breakOnWrite': {
    args: { address: number; size?: 1 | 2 | 4; name?: string; access?: 'write' | 'read' | 'readWrite' };
    body: { watched: number; address: number; length: number; verified: boolean };
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

/**
 * The base64 of each capture's screen, encoded once. A capture's thumbnail never
 * changes, and every capture, adopt, retag and forget answers with the whole list:
 * encoding twelve of them again each time is 600 KB of characters per action.
 */
const thumbnails = new WeakMap<Capture, ReturnType<typeof screenToJson>>();

/**
 * A capture as a body carries it: the thumbnail base64, the RAM nowhere. Twelve
 * captures are 3.4 MB in the session and 600 KB of thumbnails; sending the RAM with
 * them would be 3.4 MB on every render.
 */
export function captureInfo(capture: Capture): CaptureInfo {
  let screen = thumbnails.get(capture);
  if (!screen) {
    screen = screenToJson(capture.thumbnail);
    thumbnails.set(capture, screen);
  }
  return {
    id: capture.id,
    tag: capture.tag,
    frame: capture.frame,
    createdAt: capture.createdAt,
    from: capture.origin,
    thumbnail: screen.rgba,
    width: screen.width,
    height: screen.height,
  };
}

/** A mute as a body carries it: what it hides, and how much of it. */
export function muteBody(mute: Mute): MuteBody {
  return { ...mute, ranges: mute.ranges.map((r) => ({ ...r })), bytes: rangeBytes(mute.ranges) };
}

/**
 * A row as a body carries it. The tiers are three separate words rather than one
 * name with a caveat, because a containment the program never stated must not read
 * like one it did.
 */
export function diffRowBody(row: DiffRow): DiffRowBody {
  const p = row.placement;
  const body: DiffRowBody = {
    address: row.address,
    group: row.group,
    values: row.values,
    tier: p.tier,
    rank: row.rank,
    reasons: row.reasons,
  };
  if (row.formatted) {
    body.formatted = row.formatted;
  }
  if (p.symbol) {
    body.symbol = { name: p.symbol.name, offset: p.symbol.offset };
  }
  if (p.path) {
    body.path = p.path;
    const offset = p.address - (p.base ?? p.address);
    if (offset > 0) {
      body.pathOffset = offset;
    }
  }
  if (p.type) {
    body.type = p.type.name;
  }
  if (p.alternatives?.length) {
    body.alternatives = [...p.alternatives];
  }
  if (p.extrapolated) {
    body.extrapolated = true;
  }
  if (p.straddles) {
    body.straddles = true;
  }
  return body;
}

export function diffGroupBody(group: DiffGroup): DiffGroupBody {
  return { key: group.key, tier: group.tier, label: group.label, rows: group.rows, topRank: group.topRank };
}

/** The captures a session holds, as every host reports them. */
export function capturesBody(session: Session): GbaKitRequests['gba-kit/captures']['body'] {
  return { captures: session.memoryDiff.captures().map(captureInfo) };
}

/** The mutes a session holds, as every host reports them. */
export function mutesBody(session: Session): GbaKitRequests['gba-kit/mutes']['body'] {
  return { mutes: session.memoryDiff.mutes.all().map(muteBody) };
}

/** A `gba-kit/breakOnWrite`, as both hosts answer it: one more watched address, and what is watched now. */
export function breakOnWriteBody(
  session: Session,
  args: NonNullable<GbaKitRequests['gba-kit/breakOnWrite']['args']>,
): GbaKitRequests['gba-kit/breakOnWrite']['body'] {
  if (!Number.isInteger(args.address) || args.address < 0 || args.address > 0xffffffff) {
    throw new Error(`not an address: ${String(args.address)}`);
  }
  const length = args.size === undefined ? 1 : diffSize(args.size);
  const access = args.access ?? 'write';
  const name = args.name?.trim() || `0x${(args.address >>> 0).toString(16).padStart(8, '0')}`;
  const all = session.watchAddress({ address: args.address, length, name, access });
  const mine = all.find((bp) => bp.address === args.address && bp.length === length && bp.access === access);
  return { watched: all.length, address: args.address, length, verified: mine?.verified ?? false };
}

/**
 * A `gba-kit/setMute`: add the ranges a user picked out as one reversible row, switch
 * an existing one off, or take it away. A mute is always a range and never a name, so
 * what a client may ask for here is ranges and ids.
 */
export function setMute(session: Session, args: NonNullable<GbaKitRequests['gba-kit/setMute']['args']>): void {
  const mutes = session.memoryDiff.mutes;
  if (args.ranges !== undefined) {
    if (!Array.isArray(args.ranges) || args.ranges.length === 0) {
      throw new Error("'ranges' must be a non-empty list of { lo, hi }");
    }
    for (const range of args.ranges) {
      if (!Number.isInteger(range?.lo) || !Number.isInteger(range?.hi) || range.hi <= range.lo) {
        throw new Error(`not an address range: ${JSON.stringify(range)}`);
      }
    }
    mutes.add(args.ranges, 'user', args.note?.trim() || 'muted by hand');
    return;
  }
  if (!Number.isInteger(args.id)) {
    throw new Error("give a mute 'id', or the 'ranges' of a new one");
  }
  const id = args.id as number;
  const done = args.remove ? mutes.remove(id) : mutes.setEnabled(id, args.enabled !== false);
  if (!done) {
    throw new Error(`no mute ${id}`);
  }
}

/**
 * A `gba-kit/diffFilter`, whole: answer the query or reset, then the counts, the groups
 * and one page of rows. Both hosts answer it from here, so neither can read an
 * argument differently or leave a field out of the body.
 */
export function diffFilterBody(
  session: Session,
  args: NonNullable<GbaKitRequests['gba-kit/diffFilter']['args']>,
): GbaKitRequests['gba-kit/diffFilter']['body'] {
  const diff = session.memoryDiff;
  let result;
  if (args.reset) {
    result = diff.reset();
  } else if (args.query !== undefined) {
    result = diff.apply(diffQuery(args.query), diffSize(args.size));
  } else {
    result = diff.result();
  }
  const window = rowWindow(args.from, args.limit);
  return {
    ...result,
    size: diff.size,
    groups: diff.groups().map(diffGroupBody),
    from: window.from,
    rows: diff.rows(window.from, window.limit).map(diffRowBody),
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

/** How a memory-diff request's arguments are read, wherever one is answered. */
export const DIFF = {
  rowsDefault: DIFF_LIMITS.rowsDefault,
  rowsMax: DIFF_LIMITS.rowsMax,
  noiseFramesDefault: NOISE_FRAMES.default,
  noiseFramesMax: NOISE_FRAMES.max,
  /** the looks a panel offers, so what it lists and what a request takes cannot drift apart */
  noiseChoices: NOISE_FRAMES.choices,
  captures: DIFF_LIMITS.captures,
} as const;

/** The `id` of a capture a request names: an id the session could have issued, so a missing field is refused here rather than inside the store. */
export function captureId(raw: unknown): number {
  if (!Number.isInteger(raw) || (raw as number) < 1) {
    throw new Error(`'id' must be a capture id, not ${String(raw)}`);
  }
  return raw as number;
}

/** The `ids` of a `gba-kit/reorderCaptures`: the order has to be captures, and all of them. */
export function captureIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    throw new Error("'ids' must be an array of capture ids");
  }
  return raw.map((id) => captureId(id));
}

/** The `tag` of a `gba-kit/retagCapture`: what the tag filter matches on, so it has to be text. */
export function captureTag(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error(`'tag' must be a string, not ${String(raw)}`);
  }
  return raw;
}

/** The `size` of a memory-diff request: a width memory is actually stepped by, so a wrong one is refused rather than rounded. */
export function diffSize(raw: unknown): 1 | 2 | 4 {
  if (raw === 1 || raw === 2 || raw === 4) {
    return raw;
  }
  throw new Error(`'size' must be 1, 2 or 4, not ${String(raw)}`);
}

/**
 * The `query` of a memory-diff request, checked down to the capture ids it names: a
 * client sends this, and a filter over 288 KB of someone else's memory is not the place
 * to find out a field was a string.
 */
export function diffQuery(raw: unknown): DiffQuery {
  const query = raw as { edges?: unknown; values?: unknown };
  if (!query || typeof query !== 'object') {
    throw new Error("'query' must be an object");
  }
  const number = (value: unknown, what: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`'${what}' must be a number, not ${String(value)}`);
    }
    return value;
  };
  const list = (value: unknown, what: string): unknown[] => {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error(`'${what}' must be an array`);
    }
    return value;
  };
  const edges = list(query.edges, 'edges').map((raw) => {
    const edge = raw as { from?: unknown; to?: unknown; relation?: unknown };
    if (!RELATIONS.includes(edge?.relation as Relation)) {
      throw new Error(`unknown relation '${String(edge?.relation)}' (${RELATIONS.join(', ')})`);
    }
    return {
      from: number(edge.from, 'from'),
      to: number(edge.to, 'to'),
      relation: edge.relation as Relation,
    };
  });
  const values = list(query.values, 'values').map((raw) => {
    const value = raw as { capture?: unknown; value?: unknown };
    return { capture: number(value?.capture, 'capture'), value: number(value?.value, 'value') };
  });
  return { edges, values };
}

/** Which page of the rows a memory-diff request asks for, within what one response carries. */
export function rowWindow(from: unknown, limit: unknown): { from: number; limit: number } {
  return {
    from: Math.max(0, Math.floor(Number(from ?? 0)) || 0),
    limit: entryCount(limit, DIFF.rowsDefault, DIFF.rowsMax) || DIFF.rowsDefault,
  };
}

/** The `frames` of a `gba-kit/discoverNoise` request: enough to see the churn saturate, never a run that hangs the client. */
export function noiseFrames(raw: unknown): number {
  if (raw === undefined || raw === null) {
    return DIFF.noiseFramesDefault;
  }
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > DIFF.noiseFramesMax) {
    throw new Error(`'frames' must be an integer from 1 to ${DIFF.noiseFramesMax}, not ${String(raw)}`);
  }
  return n;
}

/** The `count` of a `gba-kit/ppu` `tiles` request: `TILES.defaultCount` when unsaid or not a number, within 1..`TILES.maxCount`. */
export function tileCount(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, TILES.maxCount) : TILES.defaultCount;
}
