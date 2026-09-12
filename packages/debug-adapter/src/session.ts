/**
 * `GbaDebugSession` — the Debug Adapter Protocol face of a `@gba-kit/debug-core`
 * session. Everything an editor with a DAP client can do it gets from here:
 * breakpoints of every kind, stepping, the call stack, scopes and values, hover
 * and watch evaluation, disassembly, memory, step-back and reverse-continue.
 * Emulator-only operations are `gba-kit/*` custom requests (see protocol.ts).
 *
 * No editor imports here: the same class runs as a process on stdio for any
 * editor, or in-process where a host prefers that.
 */
import {
  BUTTON_COUNT,
  type Breakpoint,
  type DataAccess,
  EVENT_BREAKPOINT_KINDS,
  type EventBreakpointKind,
  type FrameMethod,
  type InputRecording,
  MAX_RECORDINGS,
  REGISTER_NAMES,
  type RecordedTake,
  type Scope,
  type SearchOptions,
  Session,
  type StackFrame,
  type StopInfo,
  type VarNode,
  base64ToBytes,
  bytesToBase64,
  decodeTake,
  encodeTake,
  freeStateName,
  hex8,
  regionOf,
  renameSaveState,
  saveStateMeta,
  splitAssignment,
} from '@gba-kit/debug-core';
import { createNodeHost, fileExists } from '@gba-kit/debug-core/node';
import { DebugSession, Event, Handles, InitializedEvent, OutputEvent, TerminatedEvent } from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AUDIO_SAMPLE_RATE,
  type GbaKitCommand,
  type GbaKitRequests,
  LOG,
  type PpuArguments,
  type SaveStateMeta,
  type SavedStateInfo,
  type StateBody,
  entryCount,
  frameBody,
  ppuBody,
  rewindFrameCount,
  savedStateInfo,
  takeBody,
} from './protocol.js';
import { FrameStream } from './stream.js';

export interface LaunchArguments extends DebugProtocol.LaunchRequestArguments {
  /** the `.gba` ROM */
  rom: string;
  /** the ELF the ROM was made from, built with `-g`; defaults to the ROM's sibling `.elf` when one exists (null: none) */
  elf?: string | null;
  /** the project root relative DWARF paths resolve against (default: the ROM's directory) */
  cwd?: string;
  /** where `.gba-kit/` lives: labels, save states and recordings (default: `cwd`) */
  projectDir?: string;
  /** DWARF path prefix → local prefix, for sources compiled elsewhere (a Docker build) */
  sourceMap?: Record<string, string>;
  /** stop at the entry point before running (default true) */
  stopOnEntry?: boolean;
  /** debug an ELF whose loadable bytes differ from the ROM anyway */
  allowElfMismatch?: boolean;
  rewind?: { keyframeInterval?: number; fullEvery?: number; maxBytes?: number };
}

/** What a `variablesReference` stands for. */
interface HandleTarget {
  /** the machine revision the cached nodes were read at (a write bumps it: read again) and the epoch (a restart: stale) */
  revision: number;
  epoch: number;
  scope?: Scope['kind'];
  /** the stack frame a scope belongs to, so a local can be named from its handle */
  frameId?: number;
  /** expression naming the container, when its children can be named (`g_player.pos`) */
  prefix: string | null;
  expand: () => VarNode[];
  nodes: VarNode[] | null;
}

/** What every breakpoint request last asked for, so a restart's new session gets the same set. */
interface BreakpointSet {
  source: Map<string, Parameters<Session['setSourceBreakpoints']>[1]>;
  functions: Parameters<Session['setFunctionBreakpoints']>[0];
  instructions: Parameters<Session['setInstructionBreakpoints']>[0];
  data: Parameters<Session['setDataBreakpoints']>[0];
  events: EventBreakpointKind[];
}

type DataSpec = BreakpointSet['data'][number];

const THREAD_ID = 1;
const CONFIGURATION_TIMEOUT_MS = 5000;
/** instructions one `disassemble` answers at most; a larger `instructionCount` is clamped, not refused */
const MAX_DISASSEMBLE = 4096;
/** bytes one `readMemory` answers at most, so a count cannot allocate gigabytes */
const MAX_READ_MEMORY = 16 * 1024 * 1024;
/** bytes one data breakpoint may watch: a whole RAM region at most, never all of memory */
const MAX_WATCH_BYTES = 0x40000;
/** how much of a save state holds its metadata (the snapshot follows; see `encodeSaveState`) */
/** enough of a state file for its metadata, whose largest key is the 120×80 screen it was saved on */
const STATE_HEAD_BYTES = 64 * 1024;
const DATA_ACCESS: readonly DataAccess[] = ['read', 'write', 'readWrite'];

/**
 * Error ids. Only a launch failure is shown to the user as a notification; every
 * other error is answered in place (a hover, a Watch row, an input box), where the
 * editor already renders it.
 */
const ERR = {
  launch: 1000,
  noSession: 1001,
  state: 1002,
  evaluate: 1003,
  unknownRequest: 1004,
  request: 1005,
  setVariable: 1007,
  /** a `variablesReference` from before the machine moved or was restarted: expand again */
  stale: 1008,
} as const;

/** A `variablesReference` the machine has moved away from. */
class StaleReferenceError extends Error {}

/** A stop reason the protocol names, or one of ours (clients show `description`). */
function dapReason(info: StopInfo): string {
  return info.reason;
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_]\w*$/.test(name);
}

/** `parent.child`, `parent[3]`, `(*(parent))`; null when the child cannot be named in the expression grammar. */
function childExpression(prefix: string | null, name: string): string | null {
  if (prefix === null) {
    return null;
  }
  if (name.startsWith('[')) {
    return prefix + name;
  }
  // The one row a pointer has is what it points at. The whole dereference is
  // parenthesised, since a member or a subscript written after it would otherwise
  // bind to the pointer rather than to the pointee.
  if (name === '*') {
    return `(*(${prefix}))`;
  }
  if (isIdentifier(name)) {
    return `${prefix}.${name}`;
  }
  return null;
}

// ─── argument checks: a malformed request is refused by name, never as a TypeError ───

function need<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`missing '${what}'`);
  }
  return value;
}

function needString(value: unknown, what: string): string {
  if (typeof need(value, what) !== 'string') {
    throw new Error(`'${what}' must be a string`);
  }
  return value as string;
}

function optionalString(value: unknown, what: string): string | undefined {
  return value === undefined || value === null ? undefined : needString(value, what);
}

function needInteger(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`'${what}' must be an integer from ${min} to ${max}, not ${String(value)}`);
  }
  return value;
}

/** A memory reference the adapter handed out (`0x03001234`) or a decimal address, plus an offset, within the bus. */
function parseAddress(reference: unknown, offset?: number): number {
  if (typeof reference !== 'string' || !/^(0x[0-9a-f]{1,8}|\d{1,10})$/i.test(reference)) {
    throw new Error(`not an address: ${String(reference)}`);
  }
  if (offset !== undefined && !Number.isInteger(offset)) {
    throw new Error(`not an offset: ${String(offset)}`);
  }
  const base = /^0x/i.test(reference) ? parseInt(reference, 16) : Number(reference);
  const address = base + (offset ?? 0);
  if (address < 0 || address > 0xffffffff) {
    throw new Error(`address out of range: ${reference}${offset ? ` + ${offset}` : ''}`);
  }
  return address;
}

function isBase64(text: string): boolean {
  return text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text);
}

/** The search options of a `searchMemory` / `filterMemory`, checked: a bad size would step memory wrongly. */
function searchOptions(args: { value?: unknown; size?: unknown; region?: unknown; limit?: unknown }): SearchOptions {
  if (typeof args.value !== 'number' || !Number.isFinite(args.value)) {
    throw new Error(`'value' must be a number, not ${String(args.value)}`);
  }
  if (args.size !== 1 && args.size !== 2 && args.size !== 4) {
    throw new Error(`'size' must be 1, 2 or 4, not ${String(args.size)}`);
  }
  if (args.region !== undefined && args.region !== 'iwram' && args.region !== 'ewram' && args.region !== 'both') {
    throw new Error(`unknown region '${String(args.region)}' (iwram, ewram or both)`);
  }
  const options: SearchOptions = { value: args.value, size: args.size, region: args.region };
  if (args.limit !== undefined) {
    options.limit = needInteger(args.limit, 'limit', 1, Number.MAX_SAFE_INTEGER);
  }
  return options;
}

/** `r0`–`r12`, `sp`, `lr` and `pc` by name; -1 for anything else (`cpsr` is not written directly). */
function registerIndex(name: string): number {
  const i = (REGISTER_NAMES as readonly string[]).indexOf(name);
  return i >= 0 && i <= 15 ? i : -1;
}

/** A state name as a file name: anything a path could not carry becomes `_`. */
function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 80);
}

function fileKind(file: string): 'file' | 'directory' | 'missing' {
  try {
    return statSync(file).isFile() ? 'file' : 'directory';
  } catch {
    return 'missing';
  }
}

/** The path of `what` from the launch configuration, which must name a file. */
function existingFile(file: string, what: string): string {
  const kind = fileKind(file);
  if (kind === 'missing') {
    throw new Error(`${what} not found: ${file}`);
  }
  if (kind === 'directory') {
    throw new Error(`${what} is not a file: ${file}`);
  }
  return file;
}

/** A breakpoint as DAP reports it back: what the session made of what was asked for. */
function breakpointBody(bp: Breakpoint): DebugProtocol.Breakpoint {
  return {
    id: bp.id,
    verified: bp.verified,
    message: bp.message,
    instructionReference: bp.addresses[0] !== undefined ? `0x${hex8(bp.addresses[0])}` : undefined,
  };
}

/** The arguments of one `gba-kit/*` request. */
type Args<K extends GbaKitCommand> = NonNullable<GbaKitRequests[K]['args']>;

export class GbaDebugSession extends DebugSession {
  #session: Session | null = null;
  /** told of every session: the launch's, and each restart's */
  readonly #sessionListeners: Array<(session: Session) => void> = [];
  #launchArgs: LaunchArguments | null = null;
  #unwire: (() => void) | null = null;
  #configurationDone: (() => void) | null = null;
  #stopOnEntry = true;
  /** epochs of the sessions a restart replaced, so `epoch` keeps growing across restarts */
  #epochBase = 0;
  readonly #handles = new Handles<HandleTarget>();
  readonly #stream = new FrameStream();
  #audioOff: (() => void) | null = null;
  /** whether the stream's client asked for audio (a restart's session subscribes again) */
  #audioWanted = false;
  /** whether the client asked to be told when what it holds has gone stale */
  #clientTakesInvalidated = false;
  /** the stop the machine is sitting on, so `gba-kit/state` can say what it was */
  #lastStop: StopInfo | null = null;
  /** while set, session events queue here so a response can go out first */
  #deferred: DebugProtocol.Event[] | null = null;
  readonly #breakpoints: BreakpointSet = { source: new Map(), functions: [], instructions: [], data: [], events: [] };

  constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.#stream.onInput = (mask) => {
      const s = this.#session;
      if (s && s.state !== 'disposed') {
        s.setButtons(mask);
      }
    };
  }

  /** The core session, once `launch` has created it (for an in-process host that wants the frames directly). */
  get session(): Session | null {
    return this.#session;
  }

  /** Called with the session once launched, and again with each session a restart creates. */
  onSession(cb: (session: Session) => void): void {
    this.#sessionListeners.push(cb);
    if (this.#session) {
      cb(this.#session);
    }
  }

  // ─── lifecycle ─────────────────────────────────────────────────────

  protected override initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args?: DebugProtocol.InitializeRequestArguments,
  ): void {
    this.#clientTakesInvalidated = args?.supportsInvalidatedEvent === true;
    response.body = {
      supportsConfigurationDoneRequest: true,
      supportsSteppingGranularity: true,
      // Step-back is replay-exact: one instruction back, registers and memory as they were.
      supportsStepBack: true,
      supportsEvaluateForHovers: true,
      supportsDisassembleRequest: true,
      supportsInstructionBreakpoints: true,
      supportsFunctionBreakpoints: true,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
      supportsLogPoints: true,
      supportsBreakpointLocationsRequest: true,
      supportsReadMemoryRequest: true,
      supportsWriteMemoryRequest: true,
      supportsDataBreakpoints: true,
      supportsSetVariable: true,
      // A restart reloads the ROM and ELF from disk, so a rebuilt program is picked up.
      supportsRestartRequest: true,
      supportsTerminateRequest: true,
      supportsLoadedSourcesRequest: true,
      // Hardware events are the "exceptions" of a console: VBlank, IRQ, DMA, ...
      exceptionBreakpointFilters: EVENT_BREAKPOINT_KINDS.map((k) => ({
        filter: k.kind,
        label: k.label,
        description: k.description,
      })),
      supportsGotoTargetsRequest: false,
      supportsValueFormattingOptions: false,
    };
    this.sendResponse(response);
  }

  protected override async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArguments): Promise<void> {
    if (this.#session) {
      this.sendErrorResponse(response, ERR.launch, 'gba-kit: already launched; restart, or disconnect first');
      return;
    }
    try {
      const launch = args ?? ({} as LaunchArguments);
      const session = await this.#createSession(launch);
      this.#adopt(session, launch);

      // Breakpoints arrive between `initialized` and `configurationDone`; the session
      // exists now, so they apply directly. The launch response waits for them, so
      // the first run already honors them.
      this.sendEvent(new InitializedEvent());
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        this.#configurationDone = resolve;
        timer = setTimeout(resolve, CONFIGURATION_TIMEOUT_MS);
        timer.unref?.();
      });
      clearTimeout(timer);
      this.#configurationDone = null;

      this.sendResponse(response);
      this.#begin(session, { reason: 'entry', address: session.pc, description: 'at the entry point' });
    } catch (err) {
      this.sendErrorResponse(response, ERR.launch, `gba-kit: ${(err as Error).message}`);
    }
  }

  async #createSession(args: LaunchArguments): Promise<Session> {
    if (!args.rom) {
      throw new Error('"rom" is required in the launch configuration');
    }
    existingFile(args.rom, 'ROM');
    const cwd = args.cwd ?? path.dirname(args.rom);
    let elfPath: string | undefined;
    if (args.elf === null) {
      elfPath = undefined; // explicitly none
    } else if (args.elf) {
      elfPath = existingFile(args.elf, 'ELF');
    } else {
      const sibling = args.rom.replace(/\.gba$/i, '') + '.elf';
      if (fileKind(sibling) === 'file') {
        elfPath = sibling;
        this.#log(`gba-kit: using ${sibling} (set "elf" in the launch configuration to choose another)\n`);
      }
    }
    const rom = new Uint8Array(await readFile(args.rom));
    const elf = elfPath ? new Uint8Array(await readFile(elfPath)) : null;
    const session = await Session.create(createNodeHost(), {
      rom,
      elf,
      cwd,
      projectDir: args.projectDir,
      sourceMap: args.sourceMap,
      exists: fileExists,
      caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
      rewind: args.rewind,
    });

    const program = session.program;
    if (!elf) {
      this.#log(`gba-kit: loaded ${path.basename(args.rom)} without an ELF: addresses and registers only, no source\n`);
    } else if (!program.hasSymbols) {
      this.#log(`gba-kit: ${path.basename(elfPath!)} has no symbols or debug info; build with -g\n`, 'stderr');
    } else {
      const identity = program.identity;
      if (identity && !identity.ok) {
        const where = identity.section
          ? ` (${identity.section}${identity.address !== undefined ? ` at 0x${hex8(identity.address)}` : ''})`
          : '';
        const message = `${path.basename(elfPath!)} does not match ${path.basename(args.rom)}: ${identity.reason}${where}`;
        if (!args.allowElfMismatch) {
          throw new Error(
            `${message}. Rebuild so the ROM and ELF come from the same link, or set "allowElfMismatch": true`,
          );
        }
        this.#log(`gba-kit: ${message}; continuing because allowElfMismatch is set\n`, 'stderr');
      }
      const files = program.sources?.localFiles ?? [];
      this.#log(
        `gba-kit: loaded ${path.basename(args.rom)} + ${path.basename(elfPath!)}` +
          (program.hasLines ? `; ${files.length} source files found on disk` : '; no line info') +
          '\n',
      );
      if (program.hasLines && files.length === 0) {
        this.#log(
          'gba-kit: no source file of the ELF exists under "cwd"; set "cwd" or "sourceMap" in the launch configuration\n',
          'stderr',
        );
      }
    }
    await this.#loadRecordings(session);
    return session;
  }

  /** Make `session` the one every request goes to. */
  #adopt(session: Session, args: LaunchArguments): void {
    this.#session = session;
    this.#launchArgs = args;
    this.#stopOnEntry = args.stopOnEntry ?? true;
    this.#unwire = session.on({
      stopped: (info) => this.#sendStopped(info),
      continued: () => {
        this.#handles.reset();
        this.#lastStop = null;
        this.#emit(new Event('continued', { threadId: THREAD_ID, allThreadsContinued: true }));
        this.#emit(new Event('gba-kit/state', this.#stateBody()));
      },
      // a client keys its record and trace toggles on the state body
      recording: () => this.#emit(new Event('gba-kit/state', this.#stateBody())),
      tracing: () => this.#emit(new Event('gba-kit/state', this.#stateBody())),
      output: (text, category) => this.#emit(new OutputEvent(text, category === 'log' ? 'console' : category)),
      frame: (rgba, frame) => this.#stream.sendFrame(rgba, frame),
    });
    for (const cb of this.#sessionListeners) {
      cb(session);
    }
  }

  /** Start a freshly booted session the way the launch configuration says: stopped at entry, or running. */
  #begin(session: Session, entry: StopInfo): void {
    if (this.#stopOnEntry) {
      this.#sendStopped(entry);
      session.requestFrame();
    } else {
      session.continue();
    }
  }

  #listenAudio(session: Session): void {
    this.#audioOff?.();
    this.#audioOff = session.on({ audio: (samples) => this.#stream.sendAudio(samples, AUDIO_SAMPLE_RATE) });
  }

  #sendStopped(info: StopInfo): void {
    this.#handles.reset();
    this.#lastStop = info;
    const body: DebugProtocol.StoppedEvent['body'] = {
      reason: dapReason(info),
      threadId: THREAD_ID,
      allThreadsStopped: true,
      description: info.description,
      hitBreakpointIds: info.breakpointIds,
    };
    this.#emit(new Event('stopped', body));
    this.#emit(new Event('gba-kit/state', this.#stateBody()));
  }

  /** Send now, or queue behind the response being built. */
  #emit(event: DebugProtocol.Event): void {
    if (this.#deferred) {
      this.#deferred.push(event);
    } else {
      this.sendEvent(event);
    }
  }

  /**
   * Tell the client that what it is holding no longer describes the machine, so the
   * variables it shows are re-fetched: `invalidated` for a client that takes it, and
   * `gba-kit/state` for every client.
   */
  #invalidateVariables(): void {
    if (this.#clientTakesInvalidated) {
      this.#emit(new Event('invalidated', { areas: ['variables'], threadId: THREAD_ID }));
    }
    this.#emit(new Event('gba-kit/state', this.#stateBody()));
  }

  #log(text: string, category: 'console' | 'stderr' = 'console'): void {
    this.#emit(new OutputEvent(text, category));
  }

  #stateBody(): StateBody {
    const s = this.#require();
    return {
      state: s.state,
      frame: s.frame,
      pc: s.pc,
      position: s.position,
      revision: s.revision,
      epoch: s.epoch + this.#epochBase,
      history: s.historyInfo(),
      recording: s.recording,
      replaying: s.replaying,
      tracing: s.tracing,
      reason: s.state === 'stopped' ? this.#lastStop?.reason : undefined,
      description: s.state === 'stopped' ? this.#lastStop?.description : undefined,
    };
  }

  #require(): Session {
    if (!this.#session) {
      throw new Error('no emulator session');
    }
    return this.#session;
  }

  /** An error the editor renders where the request was made (a hover, a Watch row, an input box), not as a notification. */
  #fail(response: DebugProtocol.Response, id: number, message: string): void {
    this.sendErrorResponse(response, { id, format: message, showUser: false });
  }

  protected override configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): void {
    this.sendResponse(response);
    this.#configurationDone?.();
    this.#configurationDone = null;
  }

  protected override async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
    await this.#dispose();
    this.sendResponse(response);
    this.shutdown();
  }

  protected override async terminateRequest(response: DebugProtocol.TerminateResponse): Promise<void> {
    await this.#dispose();
    this.sendResponse(response);
    this.sendEvent(new TerminatedEvent());
  }

  async #dispose(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    this.#stream.close();
    if (session) {
      await this.#retire(session);
    }
  }

  /** Let go of a session: its labels are saved, its events no longer ours. */
  async #retire(session: Session): Promise<void> {
    this.#unwire?.();
    this.#unwire = null;
    this.#audioOff?.();
    this.#audioOff = null;
    await this.#saveLabels(session);
    session.dispose();
  }

  async #saveLabels(session: Session): Promise<void> {
    try {
      if (session.labels.dirty) {
        await session.saveLabels();
      }
    } catch (err) {
      this.#log(`gba-kit: could not save labels: ${(err as Error).message}\n`, 'stderr');
    }
  }

  /**
   * Restart is a fresh launch: the ROM and ELF are read from disk again (the
   * editor's build task has usually just rewritten them), with the configuration
   * the client passes or the one it launched with. Breakpoints carry over, set on
   * the new program by the same names and lines; history, trace and events do not.
   */
  protected override async restartRequest(
    response: DebugProtocol.RestartResponse,
    args: DebugProtocol.RestartArguments,
  ): Promise<void> {
    const current = this.#session;
    if (!current || !this.#launchArgs) {
      this.#fail(response, ERR.noSession, 'no emulator session');
      return;
    }
    const next = (args?.arguments as LaunchArguments | undefined) ?? this.#launchArgs;
    let session: Session;
    try {
      // the new session reads the labels file: the old one's edits go there first
      await this.#saveLabels(current);
      session = await this.#createSession(next);
    } catch (err) {
      this.sendErrorResponse(response, ERR.launch, `gba-kit: cannot restart: ${(err as Error).message}`);
      return;
    }
    this.#epochBase += current.epoch + 1;
    await this.#retire(current);
    this.#adopt(session, next);
    this.#restoreBreakpoints(session);
    if (this.#stream.connected && this.#audioWanted) {
      this.#listenAudio(session);
    }
    this.#handles.reset();
    this.sendResponse(response);
    this.#begin(session, { reason: 'restart', address: session.pc, description: 'restarted from the ROM on disk' });
  }

  /** Set on a new session what the client last asked for; a data breakpoint follows its name to the rebuilt address. */
  #restoreBreakpoints(session: Session): void {
    const bps = this.#breakpoints;
    for (const [file, specs] of bps.source) {
      session.setSourceBreakpoints(file, specs);
    }
    session.setFunctionBreakpoints(bps.functions);
    session.setInstructionBreakpoints(bps.instructions);
    session.setDataBreakpoints(
      bps.data.map((spec) => {
        const target = session.dataBreakpointTarget(spec.name, spec.length);
        return target ? { ...spec, address: target.address } : spec;
      }),
    );
    session.setEventBreakpoints(bps.events);
  }

  // ─── execution control ─────────────────────────────────────────────

  /**
   * Run `action`, then answer: the response first, then the events it raised (a
   * `continued`, a synchronous step's `stopped`, the `gba-kit/state` after a
   * write) — the protocol, and VS Code's bookkeeping, expect response → event.
   * An error becomes an error response with `code` (a stale reference its own),
   * shown by the editor in place, never as a notification.
   */
  #answer(response: DebugProtocol.Response, action: () => void, code: number, prefix = ''): void {
    this.#deferred = [];
    try {
      action();
    } catch (err) {
      this.#deferred = null;
      const message = (err as Error).message;
      this.#fail(response, err instanceof StaleReferenceError ? ERR.stale : code, `${prefix}${message}`);
      return;
    }
    const events = this.#deferred;
    this.#deferred = null;
    this.sendResponse(response);
    for (const e of events) {
      this.sendEvent(e);
    }
  }

  /** Run an action that moves the machine, which (unless told otherwise) must be stopped. */
  #exec(response: DebugProtocol.Response, action: (session: Session) => void, requireStopped = true): void {
    const session = this.#requireSession(response);
    if (!session) {
      return;
    }
    if (requireStopped && session.state !== 'stopped') {
      this.#fail(response, ERR.state, `cannot ${response.command} while the machine is ${session.state}`);
      return;
    }
    this.#answer(response, () => action(session), ERR.request, `${response.command}: `);
  }

  protected override continueRequest(response: DebugProtocol.ContinueResponse): void {
    response.body = { allThreadsContinued: true };
    this.#exec(response, (s) => s.continue());
  }

  protected override pauseRequest(response: DebugProtocol.PauseResponse): void {
    this.#exec(response, (s) => s.pause(), false);
  }

  protected override nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    this.#exec(response, (s) => (args.granularity === 'instruction' ? s.stepInstruction() : s.stepOver()));
  }

  protected override stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    this.#exec(response, (s) => (args.granularity === 'instruction' ? s.stepInstruction() : s.stepInto()));
  }

  protected override stepOutRequest(response: DebugProtocol.StepOutResponse): void {
    this.#exec(response, (s) => s.stepOut());
  }

  protected override stepBackRequest(response: DebugProtocol.StepBackResponse): void {
    this.#exec(response, (s) => {
      if (!s.stepBack()) {
        this.#stayStopped(s, 'no earlier history');
      }
    });
  }

  protected override reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse): void {
    this.#exec(response, (s) => {
      if (!s.reverseContinue()) {
        this.#stayStopped(s, 'no earlier history');
      }
    });
  }

  /** The client assumes the machine ran after a step request: tell it we are still here. */
  #stayStopped(session: Session, why: string): void {
    this.#log(`gba-kit: ${why}\n`);
    this.#sendStopped({ reason: 'step', address: session.pc, description: why });
  }

  // ─── threads, stack, scopes, variables ─────────────────────────────

  protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [{ id: THREAD_ID, name: 'ARM7TDMI' }] };
    this.sendResponse(response);
  }

  protected override stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments,
  ): void {
    this.#inspect(response, (s) => {
      const stack = s.stack();
      const rows: DebugProtocol.StackFrame[] = stack.frames.map((f) => ({
        id: f.index,
        name: frameName(f),
        source: f.source ? this.#source(f.source.path) : undefined,
        line: f.source?.line ?? 0,
        column: f.source ? 1 : 0,
        instructionPointerReference: `0x${hex8(f.address)}`,
        presentationHint: f.heuristic ? 'subtle' : 'normal',
      }));
      // Where the stack ends, and why, as the last row: a walk that stopped because
      // nothing further could be established looks exactly like one that ran out of
      // program unless it says so. It is not a frame, so it carries an id no frame
      // can have, which keeps a client from asking it for scopes or variables.
      rows.push({
        id: -1,
        name: `— the stack ends here: ${stack.end}`,
        line: 0,
        column: 0,
        presentationHint: 'label',
      });
      const start = args.startFrame ?? 0;
      response.body = {
        stackFrames: args.levels ? rows.slice(start, start + args.levels) : rows.slice(start),
        totalFrames: rows.length,
      };
    });
  }

  protected override scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    this.#inspect(response, (s) => {
      response.body = {
        scopes: s.scopes(args.frameId).map(
          (scope): DebugProtocol.Scope => ({
            // The protocol has no per-scope hint, so the name is the only place a
            // caveat about the values inside can be read.
            name: scope.doubt ? `${scope.name} — ${scope.doubt}` : scope.name,
            presentationHint: scope.kind === 'locals' ? 'locals' : scope.kind === 'registers' ? 'registers' : undefined,
            variablesReference: this.#handle(s, {
              scope: scope.kind,
              frameId: args.frameId,
              prefix: '',
              // read again on expansion, so a write made meanwhile shows
              expand: () => s.scopes(args.frameId).find((sc) => sc.kind === scope.kind)?.nodes ?? [],
            }),
            namedVariables: scope.nodes.length,
            expensive: scope.expensive,
          }),
        ),
      };
    });
  }

  #handle(session: Session, target: Omit<HandleTarget, 'revision' | 'epoch' | 'nodes'>): number {
    return this.#handles.create({ ...target, revision: session.revision, epoch: session.epoch, nodes: null });
  }

  /**
   * The nodes behind a reference. Handles are dropped on every stop and resume, and
   * their numbers reissued from the start, so one held across a move is refused only
   * until its number is handed out again; a bumped epoch refuses it outright. A write
   * in between does not invalidate the handle; its nodes are read again.
   */
  #resolveHandle(session: Session, reference: number): HandleTarget {
    const target = this.#handles.get(reference);
    if (!target || target.epoch !== session.epoch) {
      throw new StaleReferenceError('stale variables reference: the machine has moved on; expand again');
    }
    if (target.revision !== session.revision) {
      target.nodes = null;
      target.revision = session.revision;
    }
    target.nodes ??= target.expand();
    return target;
  }

  #variable(session: Session, node: VarNode, target: HandleTarget): DebugProtocol.Variable {
    const expression =
      target.scope === 'machine'
        ? ['frame', 'scanline', 'cycle'].includes(node.name)
          ? node.name
          : null
        : target.prefix === ''
          ? isIdentifier(node.name)
            ? node.name
            : null
          : childExpression(target.prefix, node.name);
    const v: DebugProtocol.Variable = {
      name: node.name,
      value: node.value,
      type: node.type,
      variablesReference: node.children
        ? this.#handle(session, {
            scope: target.scope,
            frameId: target.frameId,
            prefix: expression,
            expand: node.children,
          })
        : 0,
      evaluateName: expression ?? undefined,
    };
    if (node.address !== undefined && regionOf(node.address) !== null) {
      v.memoryReference = `0x${hex8(node.address)}`;
    }
    const writable = !!node.writable || (target.scope === 'registers' && registerIndex(node.name) >= 0);
    if (!writable) {
      v.presentationHint = { attributes: ['readOnly'] };
    }
    return v;
  }

  protected override variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): void {
    this.#inspect(response, (s) => {
      const target = this.#resolveHandle(s, args.variablesReference);
      response.body = { variables: target.nodes!.map((n) => this.#variable(s, n, target)) };
    });
  }

  protected override setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments,
  ): void {
    this.#inspect(
      response,
      (s) => {
        const name = needString(args.name, 'name');
        const value = needString(args.value, 'value');
        const target = this.#resolveHandle(s, args.variablesReference);
        const node = target.nodes!.find((n) => n.name === name);
        if (!node) {
          throw new Error(`no variable '${name}' here`);
        }
        if (node.writable) {
          const written = s.setVariable(node, value);
          response.body = { value: written, type: node.type, variablesReference: 0 };
        } else {
          const index = target.scope === 'registers' ? registerIndex(node.name) : -1;
          if (index < 0) {
            throw new Error(`'${name}' is not writable`);
          }
          s.setRegister(index, this.#number(s, value));
          response.body = { value: `0x${hex8(s.machine.registers[index]!)}`, type: 'u32', variablesReference: 0 };
        }
        this.#emit(new Event('gba-kit/state', this.#stateBody()));
      },
      ERR.setVariable,
    );
  }

  /**
   * A number from the user, as 32 bits: a literal in any base the grammar knows,
   * signed (`-0x10` is 0xfffffff0), or an expression it evaluates (`g_frame + 1`,
   * an enumerator, a register).
   */
  #number(session: Session, text: string): number {
    const t = text.trim();
    if (/^-?(0x[0-9a-f]+|0b[01]+|\d+)$/i.test(t)) {
      const negative = t.startsWith('-');
      const body = negative ? t.slice(1) : t;
      const magnitude = /^0b/i.test(body) ? parseInt(body.slice(2), 2) : Number(body);
      if (magnitude > 0xffffffff) {
        throw new Error(`number ${t} does not fit in 32 bits`);
      }
      return (negative ? -magnitude : magnitude) >>> 0;
    }
    const { node, address } = session.evaluate(t);
    const value = node.scalar?.value ?? address;
    if (value === undefined) {
      throw new Error(`'${text}' is not a number`);
    }
    return value >>> 0;
  }

  /** The session a request needs, or null having already answered that there is none. */
  #requireSession(response: DebugProtocol.Response): Session | null {
    if (!this.#session) {
      this.#fail(response, ERR.noSession, 'no emulator session');
    }
    return this.#session;
  }

  /** Answer an inspection request; errors become error responses, never a dead client. */
  #inspect<R extends DebugProtocol.Response>(
    response: R,
    fill: (session: Session) => void,
    code: number = ERR.request,
  ): void {
    const session = this.#requireSession(response);
    if (session) {
      this.#answer(response, () => fill(session), code);
    }
  }

  #source(localPath: string): DebugProtocol.Source {
    return { name: path.basename(localPath), path: localPath };
  }

  // ─── breakpoints ───────────────────────────────────────────────────

  protected override setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): void {
    this.#inspect(response, (s) => {
      const localPath = need(args.source, 'source').path ?? '';
      const specs = (args.breakpoints ?? []).map((b) => ({
        line: needInteger(b.line, 'line', 1, Number.MAX_SAFE_INTEGER),
        condition: b.condition,
        hitCondition: b.hitCondition,
        logMessage: b.logMessage,
      }));
      this.#breakpoints.source.set(localPath, specs);
      const results = s.setSourceBreakpoints(localPath, specs);
      response.body = {
        breakpoints: results.map((bp, i) => ({
          ...breakpointBody(bp),
          line: bp.line ?? specs[i]!.line,
          source: args.source,
        })),
      };
    });
  }

  protected override setFunctionBreakPointsRequest(
    response: DebugProtocol.SetFunctionBreakpointsResponse,
    args: DebugProtocol.SetFunctionBreakpointsArguments,
  ): void {
    this.#inspect(response, (s) => {
      const specs = (args.breakpoints ?? []).map((b) => ({
        functionName: needString(b.name, 'name'),
        condition: b.condition,
        hitCondition: b.hitCondition,
      }));
      this.#breakpoints.functions = specs;
      const results = s.setFunctionBreakpoints(specs);
      response.body = {
        breakpoints: results.map(breakpointBody),
      };
    });
  }

  protected override setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments,
  ): void {
    this.#inspect(response, (s) => {
      const specs = (args.breakpoints ?? []).map((b) => ({
        address: parseAddress(b.instructionReference, b.offset),
        condition: b.condition,
        hitCondition: b.hitCondition,
      }));
      this.#breakpoints.instructions = specs;
      const results = s.setInstructionBreakpoints(specs);
      response.body = {
        breakpoints: results.map(breakpointBody),
      };
    });
  }

  protected override setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments,
  ): void {
    this.#inspect(response, (s) => {
      const filters = args.filters ?? [];
      const known = new Set<string>(EVENT_BREAKPOINT_KINDS.map((k) => k.kind));
      const kinds = filters.filter((f): f is EventBreakpointKind => known.has(f));
      this.#breakpoints.events = kinds;
      s.setEventBreakpoints(kinds);
      response.body = {
        breakpoints: filters.map((f) => ({
          verified: known.has(f),
          message: known.has(f) ? undefined : `unknown event '${f}'`,
        })),
      };
    });
  }

  protected override breakpointLocationsRequest(
    response: DebugProtocol.BreakpointLocationsResponse,
    args: DebugProtocol.BreakpointLocationsArguments,
  ): void {
    this.#inspect(response, (s) => {
      const localPath = need(args.source, 'source').path ?? '';
      const first = args.line;
      const last = args.endLine ?? first;
      // the file's lines with code, not the range: a client may ask for the whole file
      response.body = {
        breakpoints: s.program
          .codeLines(localPath)
          .filter((line) => line >= first && line <= last)
          .map((line) => ({ line })),
      };
    });
  }

  protected override dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments,
  ): void {
    this.#inspect(response, (s) => {
      let name = needString(args.name, 'name').trim();
      let frameId = args.frameId;
      if (args.variablesReference) {
        const target = this.#handles.get(args.variablesReference);
        const named = target ? childExpression(target.prefix === '' ? null : target.prefix, name) : null;
        if (named) {
          name = named;
        } else if (target?.scope === 'registers') {
          response.body = {
            dataId: null,
            description: `${name} is a register; watch a variable, a symbol or an address instead`,
          };
          return;
        }
        frameId ??= target?.frameId;
      }
      const target = s.dataBreakpointTarget(name, undefined, frameId);
      if (!target) {
        response.body = {
          dataId: null,
          description: `cannot watch '${name}': not a variable, symbol, label or address (a local held in a register has none)`,
        };
        return;
      }
      response.body = {
        dataId: `${target.address}:${target.length}:${target.name}`,
        description: `${target.name} [0x${hex8(target.address)}, ${target.length} byte${target.length === 1 ? '' : 's'}]`,
        accessTypes: ['read', 'write', 'readWrite'],
        // The id bakes in an address that moves on every rebuild.
        canPersist: false,
      };
    });
  }

  protected override setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments,
  ): void {
    this.#inspect(response, (s) => {
      // an id the adapter did not hand out is answered unverified, with why, in its place
      const wanted = (args.breakpoints ?? []).map((b) => dataSpec(b));
      const specs = wanted.filter((w): w is DataSpec => typeof w !== 'string');
      this.#breakpoints.data = specs;
      const results = s.setDataBreakpoints(specs);
      let i = 0;
      response.body = {
        breakpoints: wanted.map((w): DebugProtocol.Breakpoint => {
          if (typeof w === 'string') {
            return { verified: false, message: w };
          }
          const bp = results[i++]!;
          return { id: bp.id, verified: bp.verified, message: bp.message };
        }),
      };
    });
  }

  // ─── evaluate, disassemble, memory, sources ────────────────────────

  protected override evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): void {
    const session = this.#session;
    if (!session) {
      this.#fail(response, ERR.noSession, 'no emulator session');
      return;
    }
    this.#answer(
      response,
      () => {
        // an editor's hover sends whatever is under the mouse, an empty string included
        const expression = typeof args.expression === 'string' ? args.expression.trim() : '';
        // Only what the user typed into the console may write: a hover over `a = b` in
        // the source must read, never store.
        const assignment = args.context === 'repl' ? splitAssignment(expression) : null;
        const { node, address } = assignment
          ? session.assign(assignment.target, assignment.value, args.frameId ?? 0)
          : session.evaluate(expression, args.frameId ?? 0);
        if (assignment) {
          this.#invalidateVariables();
        }
        const named = assignment ? assignment.target : expression;
        // A child is named by appending to its parent's expression, so anything but a
        // plain dotted path is parenthesised first: `p->pos` yields `(p->pos).x`, which
        // reads back as the row it came from.
        const prefix = /^[A-Za-z_][\w.[\]]*$/.test(named) ? named : `(${named})`;
        response.body = {
          result: node.value,
          type: node.type,
          variablesReference: node.children ? this.#handle(session, { prefix, expand: node.children }) : 0,
          memoryReference: address !== undefined ? `0x${hex8(address)}` : undefined,
        };
      },
      ERR.evaluate,
    );
  }

  protected override disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments,
  ): void {
    this.#inspect(response, (s) => {
      const base = parseAddress(args.memoryReference, args.offset);
      const count = Math.trunc(Number(args.instructionCount));
      if (!Number.isFinite(count) || count < 0) {
        throw new Error(`instructionCount must be a non-negative integer, not ${String(args.instructionCount)}`);
      }
      const instructionOffset = args.instructionOffset ?? 0;
      if (!Number.isInteger(instructionOffset)) {
        throw new Error(`instructionOffset must be an integer, not ${String(args.instructionOffset)}`);
      }
      // The instruction set at the base decides how far an instruction offset reaches.
      const mode = s.program.modeAt(base) ?? (base === s.pc ? (s.machine.thumb ? 'thumb' : 'arm') : 'thumb');
      const size = mode === 'arm' ? 4 : 2;
      const start = (base + instructionOffset * size) >>> 0;
      const lines = s.disassemble(start, Math.min(count, MAX_DISASSEMBLE));
      response.body = {
        instructions: lines.map((l): DebugProtocol.DisassembledInstruction => {
          const label = s.labels.at(l.address);
          const ins: DebugProtocol.DisassembledInstruction = {
            address: `0x${hex8(l.address)}`,
            instructionBytes: l.bytes,
            instruction: label?.comment ? `${l.text}    ; ${label.comment}` : l.text,
            symbol: l.label ?? l.symbol,
          };
          if (l.text === '<unmapped>') {
            ins.presentationHint = 'invalid';
          }
          if (l.source) {
            ins.location = this.#source(l.source.path);
            ins.line = l.source.line;
          }
          return ins;
        }),
      };
    });
  }

  protected override readMemoryRequest(
    response: DebugProtocol.ReadMemoryResponse,
    args: DebugProtocol.ReadMemoryArguments,
  ): void {
    this.#inspect(response, (s) => {
      const address = parseAddress(args.memoryReference, args.offset);
      const count = needInteger(args.count, 'count', 0, MAX_READ_MEMORY);
      const { data, readable } = s.readMemory(address, count);
      response.body = {
        address: `0x${hex8(address)}`,
        data: Buffer.from(data.subarray(0, readable)).toString('base64'),
        unreadableBytes: count - readable,
      };
    });
  }

  protected override writeMemoryRequest(
    response: DebugProtocol.WriteMemoryResponse,
    args: DebugProtocol.WriteMemoryArguments,
  ): void {
    this.#inspect(response, (s) => {
      const address = parseAddress(args.memoryReference, args.offset);
      const data = needString(args.data, 'data');
      if (!isBase64(data)) {
        throw new Error("'data' is not base64");
      }
      const bytes = new Uint8Array(Buffer.from(data, 'base64'));
      const bytesWritten = s.writeMemory(address, bytes);
      if (bytesWritten < bytes.length && !args.allowPartial) {
        throw new Error(`only ${bytesWritten} of ${bytes.length} bytes are writable at 0x${hex8(address)}`);
      }
      response.body = { bytesWritten };
      this.#emit(new Event('gba-kit/state', this.#stateBody()));
    });
  }

  protected override loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse): void {
    this.#inspect(response, (s) => {
      response.body = { sources: (s.program.sources?.localFiles ?? []).map((p) => this.#source(p)) };
    });
  }

  // ─── gba-kit custom requests ───────────────────────────────────────

  protected override async customRequest(
    command: string,
    response: DebugProtocol.Response,
    args: unknown,
  ): Promise<void> {
    const session = this.#session;
    if (!session) {
      this.#fail(response, ERR.noSession, 'no emulator session');
      return;
    }
    try {
      const body = await this.#custom(session, command as GbaKitCommand, (args ?? {}) as never, response);
      if (body !== SENT) {
        response.body = body;
        this.sendResponse(response);
      }
    } catch (err) {
      this.#fail(response, ERR.request, `${command}: ${(err as Error).message}`);
    }
  }

  async #custom<C extends GbaKitCommand>(
    s: Session,
    command: C,
    args: NonNullable<GbaKitRequests[C]['args']>,
    response: DebugProtocol.Response,
  ): Promise<GbaKitRequests[C]['body'] | typeof SENT> {
    switch (command) {
      case 'gba-kit/state':
        return this.#stateBody();
      case 'gba-kit/input': {
        const a = args as Args<'gba-kit/input'>;
        s.setButton(needInteger(a.button, 'button', 0, BUTTON_COUNT - 1), Boolean(a.down));
        return { buttons: s.buttons };
      }
      case 'gba-kit/buttons': {
        const a = args as Args<'gba-kit/buttons'>;
        if (!Number.isInteger(a.mask)) {
          throw new Error(`'mask' must be an integer, not ${String(a.mask)}`);
        }
        s.setButtons(a.mask);
        return { buttons: s.buttons };
      }
      case 'gba-kit/stepFrame':
        this.#exec(response, () => s.stepFrame());
        return SENT;
      case 'gba-kit/stepScanline':
        this.#exec(response, () => s.stepScanline());
        return SENT;
      case 'gba-kit/rewind': {
        const a = args as Args<'gba-kit/rewind'>;
        this.#exec(response, () => {
          const rewound = s.rewindFrames(rewindFrameCount(a.frames));
          response.body = { rewound };
          if (!rewound) {
            this.#stayStopped(s, 'nothing earlier to rewind to');
          }
        });
        return SENT;
      }
      case 'gba-kit/rewindToFrame': {
        const a = args as Args<'gba-kit/rewindToFrame'>;
        this.#exec(response, () => {
          const rewound = s.rewindToFrame(Math.max(0, Math.floor(Number(a.frame) || 0)));
          response.body = { rewound };
          if (!rewound) {
            this.#stayStopped(s, 'nothing earlier to rewind to');
          }
        });
        return SENT;
      }
      case 'gba-kit/frame':
        return frameBody(s);
      case 'gba-kit/stream': {
        const a = args as Args<'gba-kit/stream'>;
        const pipe = needString(a.path, 'path');
        if (!pipe) {
          throw new Error("'path' is empty");
        }
        await this.#stream.connect(pipe);
        this.#audioWanted = Boolean(a.audio);
        this.#audioOff?.();
        this.#audioOff = null;
        if (this.#audioWanted) {
          this.#listenAudio(s);
        }
        s.requestFrame();
        return { connected: this.#stream.connected };
      }
      case 'gba-kit/requestFrame':
        s.requestFrame();
        return undefined;
      case 'gba-kit/recordStart':
        // the session's `recording` event becomes the `gba-kit/state` that follows the response
        this.#inspect(response, () => s.startRecording());
        return SENT;
      case 'gba-kit/recordStop': {
        // the take is answered from the session; the file it is also written to is
        // for the next session, so the response does not wait on the disk
        let take: RecordedTake | undefined;
        this.#inspect(response, () => {
          const recording = s.stopRecording();
          take = s.recordings.at(-1);
          response.body = { recording, script: s.recordingAsScript(recording) };
        });
        if (take) {
          await this.#writeRecording(s, take);
        }
        return SENT;
      }
      case 'gba-kit/deleteRecording': {
        const a = args as Args<'gba-kit/deleteRecording'>;
        const id = needInteger(a.id, 'id', 1, Number.MAX_SAFE_INTEGER);
        const take = s.recordings.find((t) => t.id === id);
        if (!take) {
          return { deleted: false };
        }
        s.removeRecording(id);
        await this.#removeFile(s, this.#recordingPath(s, take)).catch(() => {});
        return { deleted: true };
      }
      case 'gba-kit/lastRecording': {
        const last = s.lastRecording;
        return { last: last ? { recording: last, script: s.recordingAsScript(last) } : null };
      }
      case 'gba-kit/recordings':
        return {
          takes: s.recordings.map(takeBody),
        };
      case 'gba-kit/replay': {
        const a = args as Args<'gba-kit/replay'>;
        const recording = need(a.recording, 'recording') as InputRecording;
        if (typeof recording !== 'object' || !Array.isArray(recording.frames)) {
          throw new Error("'recording' is not an input recording");
        }
        const from = a.from === 'here' ? 'here' : 'start';
        const take = a.id === undefined ? undefined : s.recordings.find((t) => t.id === a.id);
        this.#exec(response, () => {
          const replayed = s.replayRecording(recording, from, take?.start);
          response.body = { replayed };
          if (!replayed) {
            this.#stayStopped(s, 'the recording starts before the history kept');
          }
        });
        return SENT;
      }
      case 'gba-kit/saveState': {
        const a = args as Args<'gba-kit/saveState'>;
        return this.#saveState(s, optionalString(a.name, 'name'));
      }
      case 'gba-kit/loadState': {
        const a = args as Args<'gba-kit/loadState'>;
        const text = await this.#readState(s, a);
        this.#exec(response, () => {
          try {
            s.loadState(text);
          } catch (err) {
            // the parser's message quotes the file: say what it is not instead
            throw err instanceof SyntaxError ? new Error('not a gba-kit save state') : err;
          }
        });
        return SENT;
      }
      case 'gba-kit/listStates':
        return { states: await this.#listStates(s) };
      case 'gba-kit/renameState':
        return this.#renameState(s, args as Args<'gba-kit/renameState'>);
      case 'gba-kit/deleteState':
        return { deleted: await this.#deleteState(s, args as Args<'gba-kit/deleteState'>) };
      case 'gba-kit/importSave': {
        const a = args as Args<'gba-kit/importSave'>;
        return this.#importSave(s, base64ToBytes(needString(a.bytes, 'bytes')), optionalString(a.name, 'name'));
      }
      case 'gba-kit/exportSave': {
        const { bytes, declared } = s.exportSaveFile();
        return { bytes: bytesToBase64(bytes), size: bytes.length, declared };
      }
      case 'gba-kit/ppu':
        return ppuBody(s, args as PpuArguments);
      case 'gba-kit/ioRegisters':
        return { registers: s.ioRegisters() };
      case 'gba-kit/trace': {
        const a = args as Args<'gba-kit/trace'>;
        // answered through #inspect so the `gba-kit/state` a toggle causes follows the response
        this.#inspect(response, () => {
          if (a.enabled !== undefined) {
            s.setTracing(Boolean(a.enabled));
          }
          response.body = { enabled: s.tracing, entries: s.trace.last(entryCount(a.count, LOG.traceDefault)) };
        });
        return SENT;
      }
      case 'gba-kit/events': {
        const a = args as Args<'gba-kit/events'>;
        return { entries: s.events.last(entryCount(a.count, LOG.eventsDefault)) };
      }
      case 'gba-kit/labels':
        return { labels: s.labels.all() };
      case 'gba-kit/setLabel': {
        const a = args as Args<'gba-kit/setLabel'>;
        if (!Number.isInteger(a.address) || a.address < 0 || a.address > 0xffffffff) {
          throw new Error(`not an address: ${String(a.address)}`);
        }
        s.labels.set({
          address: a.address,
          label: optionalString(a.label, 'label') ?? '',
          comment: optionalString(a.comment, 'comment'),
          size: a.size === undefined ? undefined : needInteger(a.size, 'size', 1, 0xffffffff),
        });
        await this.#labelsChanged(s);
        return { labels: s.labels.all() };
      }
      case 'gba-kit/importLabels': {
        const a = args as Args<'gba-kit/importLabels'>;
        const imported = s.labels.importSymbols(needString(a.text, 'text'));
        await this.#labelsChanged(s);
        return { imported };
      }
      case 'gba-kit/exportLabels':
        return { text: s.labels.exportSymbols() };
      case 'gba-kit/searchMemory': {
        const a = args as Args<'gba-kit/searchMemory'>;
        return { addresses: s.searchMemory(searchOptions(a)) };
      }
      case 'gba-kit/filterMemory': {
        const a = args as Args<'gba-kit/filterMemory'>;
        const { value, size } = searchOptions({ value: a.value, size: a.size });
        if (!Array.isArray(a.addresses) || a.addresses.some((x) => typeof x !== 'number')) {
          throw new Error("'addresses' must be a list of numbers");
        }
        return { addresses: s.filterMemory(a.addresses, value, size) };
      }
      case 'gba-kit/eventBreakpoints':
        return { kinds: EVENT_BREAKPOINT_KINDS.map((k) => ({ ...k })), enabled: [...s.breakpoints.events] };
      default:
        this.#fail(response, ERR.unknownRequest, `unknown request '${command}'`);
        return SENT;
    }
  }

  async #labelsChanged(session: Session): Promise<void> {
    await session.saveLabels();
    this.#emit(new Event('gba-kit/labels', { count: session.labels.size }));
  }

  #files(session: Session): NonNullable<Session['host']['files']> {
    if (!session.host.files) {
      throw new Error('this host has no file system');
    }
    return session.host.files;
  }

  /** Where the project keeps one kind of thing. The session names the directory; a host without files is not one this adapter runs on. */
  #dirFor(session: Session, kind: 'states' | 'recordings'): string {
    const dir = session.projectFile(kind);
    if (dir === null) {
      throw new Error('this host has no file system');
    }
    return dir;
  }

  /** The `.json` files of one of those directories, newest name first or oldest first. */
  async #jsonIn(session: Session, dir: string, order: 'newest' | 'oldest'): Promise<string[]> {
    const entries = (await this.#files(session).list(dir)).filter((e) => e.endsWith('.json'));
    return entries.sort((a, b) => (order === 'newest' ? b.localeCompare(a) : a.localeCompare(b)));
  }

  /**
   * A take's file, named for when it was taken and where it starts: two takes of the
   * same frame are still two files, and the name says which is which.
   */
  #recordingPath(session: Session, take: RecordedTake): string {
    // to the millisecond: two takes of the same frame, seconds apart, are two files
    const stamp = safeName(take.createdAt) || 'undated';
    return this.#files(session).join(
      this.#dirFor(session, 'recordings'),
      `${stamp}-frame${take.recording.startFrame}.json`,
    );
  }

  async #writeRecording(session: Session, take: RecordedTake): Promise<void> {
    const file = this.#recordingPath(session, take);
    try {
      await this.#files(session).writeText(file, encodeTake(take));
    } catch (err) {
      // the recording is in the session either way: say why it will not be there next time
      this.#log(`gba-kit: cannot write ${file}: ${(err as Error).message}\n`, 'stderr');
    }
  }

  /**
   * Give the session the recordings this project already has, oldest first, so a take
   * made in an earlier session is listed and replayed in this one. A file that is not
   * one of ours, or belongs to another ROM, is passed over. Names begin with the time
   * the take was made, so reading them newest first stops at the number a session
   * lists, however many the project has kept; the rest stay where they are.
   */
  async #loadRecordings(session: Session): Promise<void> {
    const files = this.#files(session);
    const dir = this.#dirFor(session, 'recordings');
    const takes: Array<Omit<RecordedTake, 'id'>> = [];
    for (const entry of await this.#jsonIn(session, dir, 'newest')) {
      if (takes.length === MAX_RECORDINGS) {
        break;
      }
      const text = await files.readText(files.join(dir, entry)).catch(() => null);
      if (text === null) {
        continue;
      }
      try {
        const take = decodeTake(text);
        if (take.recording.romHash === session.romHash) {
          takes.push(take);
        }
      } catch {
        // not a recording of ours; leave it where it is
      }
    }
    for (const take of takes.reverse()) {
      session.addRecording(take);
    }
    if (takes.length > 0) {
      this.#log(`gba-kit: ${takes.length} recording${takes.length === 1 ? '' : 's'} read from ${dir}\n`);
    }
  }

  #statePath(session: Session, name: string): string {
    return this.#files(session).join(this.#dirFor(session, 'states'), `${safeName(name)}.json`);
  }

  async #saveState(session: Session, name?: string): Promise<SavedStateInfo> {
    const stateName = name?.trim() || `frame-${session.frame}`;
    const file = this.#statePath(session, stateName);
    const text = session.saveState(stateName);
    await this.#files(session).writeText(file, text);
    this.#log(`gba-kit: state '${stateName}' saved to ${file}\n`);
    return savedStateInfo(stateName, file, saveStateMeta(text));
  }

  /**
   * A `.sav` as a state file, under a name no state already has: importing the same
   * file twice keeps both rather than writing over the first. Nothing about the
   * session's execution moves, so no client sees a stop it did not cause.
   */
  async #importSave(session: Session, bytes: Uint8Array, name?: string): Promise<SavedStateInfo> {
    const files = this.#files(session);
    const stateName = await freeStateName(
      name?.trim() || 'imported save',
      async (candidate) => (await files.readText(this.#statePath(session, candidate)).catch(() => null)) !== null,
    );
    const file = this.#statePath(session, stateName);
    const text = session.importSaveState(bytes, stateName);
    await files.writeText(file, text);
    this.#log(`gba-kit: ${bytes.length} bytes imported as state '${stateName}' in ${file}\n`);
    return savedStateInfo(stateName, file, saveStateMeta(text));
  }

  /**
   * The file a saved state names, by name or by a path `saveState` / `listStates`
   * gave out. Only the states directory is reached: a state name is the request's
   * whole reach into the file system.
   */
  #stateFile(session: Session, args: { name?: unknown; path?: unknown }): string {
    const dir = path.resolve(this.#dirFor(session, 'states'));
    let file: string;
    if (args.path !== undefined) {
      file = path.resolve(dir, needString(args.path, 'path'));
    } else if (args.name !== undefined) {
      // `#saveState` trims before naming the file; reaching it has to trim the same way
      const name = needString(args.name, 'name').trim();
      if (!name) {
        throw new Error("'name' is empty");
      }
      file = path.resolve(this.#statePath(session, name));
    } else {
      throw new Error('give a state name or path');
    }
    if (!file.startsWith(dir + path.sep)) {
      throw new Error(`state files live under ${dir}`);
    }
    return file;
  }

  /** The text of a saved state; throws when it is not there. */
  async #readState(session: Session, args: { name?: unknown; path?: unknown }): Promise<string> {
    const file = this.#stateFile(session, args);
    const text = await this.#files(session)
      .readText(file)
      .catch(() => null);
    if (text === null) {
      throw new Error(`no such state: ${path.basename(file)}`);
    }
    return text;
  }

  /**
   * Give a saved state another name. The file is named after the state, so it moves
   * with it; a rename onto a name already taken is refused rather than overwriting it.
   */
  async #renameState(session: Session, args: Args<'gba-kit/renameState'>): Promise<SavedStateInfo> {
    const files = this.#files(session);
    const from = this.#stateFile(session, args);
    const to = needString(args.to, 'to').trim();
    if (!to) {
      throw new Error("'to' is empty");
    }
    const target = this.#stateFile(session, { name: to });
    const text = await this.#readState(session, { path: from });
    if (target !== from && (await files.readText(target).catch(() => null)) !== null) {
      throw new Error(`a state named '${to}' is already there`);
    }
    const renamed = renameSaveState(text, to);
    await files.writeText(target, renamed);
    if (target !== from) {
      await this.#removeFile(session, from);
    }
    return savedStateInfo(to, target, saveStateMeta(renamed));
  }

  /** Delete a saved state's file. False when it was already gone. */
  async #deleteState(session: Session, args: Args<'gba-kit/deleteState'>): Promise<boolean> {
    const file = this.#stateFile(session, args);
    if (
      (await this.#files(session)
        .readText(file)
        .catch(() => null)) === null
    ) {
      return false;
    }
    await this.#removeFile(session, file);
    this.#log(`gba-kit: state ${path.basename(file)} deleted\n`);
    return true;
  }

  /** Delete through the host, which need not offer one. */
  async #removeFile(session: Session, file: string): Promise<void> {
    const files = this.#files(session);
    if (!files.remove) {
      throw new Error('this host cannot delete files');
    }
    await files.remove(file);
  }

  async #listStates(session: Session): Promise<SavedStateInfo[]> {
    const files = this.#files(session);
    const dir = this.#dirFor(session, 'states');
    const out: SavedStateInfo[] = [];
    for (const entry of await this.#jsonIn(session, dir, 'oldest')) {
      const file = files.join(dir, entry);
      const meta = await this.#stateMeta(session, file);
      if (meta?.format === 'gba-kit-savestate' && (!meta.romHash || meta.romHash === session.romHash)) {
        out.push(savedStateInfo(meta.name ?? entry.replace(/\.json$/, ''), file, meta));
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * A state file's metadata, from its head alone when the host can read one: the
   * snapshot that follows is most of a megabyte, and the keys precede it (see
   * `encodeSaveState`). A file laid out otherwise is parsed whole. Null when the
   * file is not JSON.
   */
  async #stateMeta(session: Session, file: string): Promise<SaveStateMeta | null> {
    const files = this.#files(session);
    const head = files.readHead ? await files.readHead(file, STATE_HEAD_BYTES) : null;
    const text = head?.includes(',"snapshot":') ? head : await files.readText(file);
    return text ? saveStateMeta(text) : null;
  }
}

/**
 * The data breakpoint a client asks for, from an id `dataBreakpointInfo` gave out
 * (`address:length:name`); the reason it cannot be set when the id is not one, or
 * would watch more than a region.
 */
function dataSpec(b: DebugProtocol.DataBreakpoint): DataSpec | string {
  const m = /^(\d+):(\d+):(.*)$/s.exec(typeof b.dataId === 'string' ? b.dataId : '');
  if (!m) {
    return `not a data breakpoint id: '${String(b.dataId)}' (dataBreakpointInfo gives one)`;
  }
  const address = Number(m[1]);
  const length = Number(m[2]);
  if (length < 1 || length > MAX_WATCH_BYTES) {
    return `cannot watch ${length} bytes (1 to ${MAX_WATCH_BYTES})`;
  }
  if (address > 0xffffffff || regionOf(address) === null || regionOf(address + length - 1) === null) {
    return `no memory at ${m[1]} for ${length} bytes`;
  }
  const access = b.accessType ?? 'write';
  if (!DATA_ACCESS.includes(access as DataAccess)) {
    return `unknown access type '${access}'`;
  }
  return {
    address,
    length,
    name: m[3]!,
    access: access as DataAccess,
    condition: b.condition,
    hitCondition: b.hitCondition,
  };
}

/**
 * A frame's row, with how it was recovered appended when that is worth saying.
 * DAP gives a frame no field for this but its name, and dimming the row alone
 * does not say what about it is uncertain. An inferred row is in question itself,
 * so it carries the caveat; an established one carries only which layer
 * established it, and its caveats belong on the scope whose values they concern.
 */
function frameName(frame: StackFrame): string {
  const suffix = (frame.heuristic ? frame.doubt : null) ?? METHOD_LABELS[frame.method];
  return suffix ? `${frame.name} (${suffix})` : frame.name;
}

/**
 * How a row says it was recovered, or null when it needs no saying. A frame that
 * call-frame information described, or that an exception boundary spelled out, is
 * simply true; one measured from a prologue or taken from a register is a
 * different kind of claim, and a reader deciding whether to trust its variables
 * needs to be told which.
 *
 * Exhaustive over {@link FrameMethod} on purpose: a new layer of the unwinder has
 * to decide here what its rows say, instead of silently arriving unlabelled.
 */
const METHOD_LABELS: Record<FrameMethod, string | null> = {
  live: null,
  cfi: null,
  exception: null,
  prologue: 'from its prologue',
  lr: 'from lr',
  'lr-corroborated': 'from lr, corroborated',
  scan: 'inferred from the stack',
  guess: 'from lr, unverified',
};

/** Marker: the handler already sent the response itself. */
const SENT = Symbol('sent');
