/**
 * The gba-kit extensions to the Debug Adapter Protocol.
 *
 * Everything a standard DAP client can do, it gets from the standard requests. What
 * an emulator has and a debugger for native code does not — a screen, buttons,
 * frames and scanlines as units of time, rewind by frames, save states, input
 * recordings, the PPU and I/O views, labels — is a custom request named
 * `gba-kit/<name>`, and a change of execution state is the `gba-kit/state` event.
 * A client that knows none of them still has a complete source debugger.
 *
 * This module has no runtime dependencies; a client (a webview, an editor plugin)
 * imports it for the types alone.
 */
import type {
  BackgroundInfo,
  EventBreakpointKind,
  EventEntry,
  HistoryInfo,
  InputRecording,
  IoRegisterValue,
  Label,
  Position,
  SearchOptions,
  SessionState,
  SpriteInfo,
  TilemapSnapshot,
  TraceEntry,
} from '@gba-kit/debug-core';

/** Body of the `gba-kit/state` event and response; the machine's place in time. */
export interface StateBody {
  state: SessionState;
  frame: number;
  pc: number;
  position: Position;
  /** bumps whenever the machine changes: variable handles from an older revision are stale */
  revision: number;
  /** bumps on restart and state loads: everything derived from the old machine is stale */
  epoch: number;
  history: HistoryInfo;
  recording: boolean;
  tracing: boolean;
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
  /** Rewind by whole frames (DAP `stepBack` is one instruction). From inside a frame, the first frame back is the start of that frame. */
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

  'gba-kit/recordStart': { args?: Record<string, never>; body: undefined };
  /** Stop recording: the input log, and the same as a `press`/`wait` script. */
  'gba-kit/recordStop': { args?: Record<string, never>; body: { recording: InputRecording; script: string } };
  /** Replay a recording from its start frame (rewinding to it when it is in history). */
  'gba-kit/replay': { args: { recording: InputRecording }; body: { replayed: boolean } };

  /** Save the machine to `<projectDir>/.gba-kit/states/<name>.json`. */
  'gba-kit/saveState': { args?: { name?: string }; body: SavedStateInfo };
  /** Load a saved state by name or path. */
  'gba-kit/loadState': { args: { name?: string; path?: string }; body: undefined };
  'gba-kit/listStates': { args?: Record<string, never>; body: { states: SavedStateInfo[] } };

  'gba-kit/ppu': { args: PpuArguments; body: PpuBody };
  'gba-kit/ioRegisters': { args?: Record<string, never>; body: { registers: IoRegisterValue[] } };

  /** The newest `count` trace entries (default 200); `enabled` turns instruction tracing on or off first. */
  'gba-kit/trace': { args?: { count?: number; enabled?: boolean }; body: { enabled: boolean; entries: TraceEntry[] } };
  /** The newest `count` hardware events (default 500). */
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
  /** Sent on every stop, resume, rewind, restart and state load. */
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
 * float32 samples. While the machine runs frames arrive throttled and stale frames
 * are dropped when the pipe is slow; a stop always sends the current frame.
 */
export const STREAM = {
  magic: 0x4b47,
  headerBytes: 8,
  frame: 1,
  audio: 2,
  width: 240,
  height: 160,
} as const;
