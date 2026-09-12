/**
 * Session — the debugger's single point of control over a machine. Every command
 * that moves or mutates it comes through here, in order, on one thread; every
 * observation is valid only for the revision it was taken at, which the session
 * publishes, so a client can tell stale data from fresh. The session knows
 * addresses, frames, symbols and snapshots; it knows nothing about DAP or any
 * editor.
 *
 * Execution: the machine runs frame by frame under a stop predicate that the
 * breakpoints, the current step and the hardware hooks feed. A stop is decided
 * before an instruction runs and charges nothing, so a stopped machine can be
 * inspected, resumed, or replayed exactly.
 */
import { FRAME_METHODS, type FrameMethod, type VarNode } from '@gba-kit/debug-info';
import type { HardwareEvent, WatchpointRead, WatchpointWrite } from '@gba-kit/gba-emulator';
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';

import {
  type Breakpoint,
  type BreakpointSpec,
  BreakpointStore,
  type DataBreakpoint,
  type DataBreakpointSpec,
  type EventBreakpointKind,
  type ResolvedAddresses,
} from './breakpoints.js';
import { checkSaveFile, saveFileSize } from './cartridge-save.js';
import { type PackedSnapshot, packSnapshot, unpackSnapshot } from './delta.js';
import type { CompiledExpr, ExprEnv } from './expression.js';
import type { Host } from './host.js';
import {
  type DisassembledLine,
  type EvaluateResult,
  Inspector,
  type Scope,
  type StackFrame,
  type StackTrace,
} from './inspector.js';
import { type IoRegisterValue, ioRegisterAt, ioSnapshot } from './io.js';
import { LabelStore, type LabelsFile } from './labels.js';
import { Machine, romHash } from './machine.js';
import { type SearchOptions, filterMemory, searchMemory } from './memory-search.js';
import {
  type Screen,
  type SpriteInfo,
  type TilemapSnapshot,
  type TilesSnapshot,
  backgroundsSnapshot,
  paletteSnapshot,
  screenToJson,
  spritesSnapshot,
  thumbnailRgba,
  tilemapSnapshot,
  tilesSnapshot,
} from './ppu.js';
import { Program } from './program.js';
import { BUTTON_COUNT, type InputRecording, type RecordedTake, recordingToScript } from './recorder.js';
import { RewindHistory, type RewindOptions } from './rewind.js';
import { type EventEntry, Ring, type TraceEntry } from './rings.js';
import { decodeSaveState, encodeSaveState } from './snapshot-codec.js';
import type { SourceMapperOptions } from './source-map.js';
import {
  type StepContext,
  type StepOutcome,
  inlineEntriesAt,
  isExceptionMode,
  runToAddress,
  stepInstruction,
  stepInto,
  stepOutOfException,
  stepOutOfInline,
  stepOutTo,
  stepOver,
} from './stepping.js';

export type SessionState = 'stopped' | 'running' | 'replaying' | 'disposed';

export type StopReason =
  | 'entry'
  | 'breakpoint'
  | 'instruction breakpoint'
  | 'function breakpoint'
  | 'data breakpoint'
  | 'event breakpoint'
  | 'step'
  | 'pause'
  | 'rewind'
  | 'restart'
  | 'stall';

export interface StopInfo {
  reason: StopReason;
  address: number;
  description?: string;
  breakpointIds?: number[];
}

export interface SessionEvents {
  state(state: SessionState): void;
  stopped(info: StopInfo): void;
  continued(): void;
  /** an input recording began or ended (a restart or resync ends one too) */
  recording(active: boolean): void;
  /** instruction tracing was turned on or off */
  tracing(on: boolean): void;
  /** a label was set, cleared, imported or loaded: the names disassembly and evaluation use changed */
  labels(): void;
  /** memory, a register or a variable was written: anything a view read of the machine is stale */
  written(): void;
  /** RGBA 240×160, a fresh copy; throttled while running, always on a stop */
  frame(rgba: Uint8Array, frame: number): void;
  /** interleaved stereo samples produced by the last run slice, when a listener wants them */
  audio(samples: Float32Array): void;
  output(text: string, category: 'console' | 'stdout' | 'stderr' | 'log'): void;
}

export interface SessionOptions extends Omit<SourceMapperOptions, 'cwd'> {
  rom: Uint8Array;
  elf?: Uint8Array | null;
  /** the project root relative DWARF paths resolve against */
  cwd: string;
  /** where `.gba-kit/` lives (labels, states); defaults to `cwd` */
  projectDir?: string;
  rewind?: RewindOptions;
  traceCapacity?: number;
  eventCapacity?: number;
  /** milliseconds between frame events while running (default {@link DEFAULT_FRAME_EVENT_INTERVAL_MS}) */
  frameEventInterval?: number;
  /** debug an existing machine instead of booting a new one (see {@link Machine}) */
  machine?: Machine;
}

/** Everything a client needs to know about the machine's position in time. */
export interface Position {
  frame: number;
  /** instructions executed since the frame began (time the CPU spends halted does not count) */
  instruction: number;
  scanline: number;
  cycle: number;
  pc: number;
}

export interface HistoryInfo {
  earliestFrame: number | null;
  keyframes: number;
  bytes: number;
  recording: boolean;
  /** the frame the recording in progress began at; null when none is */
  recordingStart: number | null;
}

const FRAME_MS = 1000 / 59.7275;
/** how often a running session emits a frame, unless the options say otherwise */
export const DEFAULT_FRAME_EVENT_INTERVAL_MS = 33;
/** `#hiddenInline` sentinel: hide the inlined layers that begin at the stop address */
const AUTO_HIDDEN = -1;
/** finished recordings a session keeps; the oldest is dropped past this, so a long session is bounded */
/** how many finished recordings a session lists; the oldest goes when a new one arrives */
export const MAX_RECORDINGS = 20;
const MAX_STEP_FRAMES = 300;
const MAX_STEP_MS = 1500;

/** A place in history a reverse search can land on. */
interface HistoryPosition {
  frame: number;
  instruction: number;
  /** the machine cycle, when the instruction count alone is ambiguous (a stop while the CPU was halted) */
  cycle?: number;
}

/**
 * A reverse search in progress: the data breakpoints whose watchpoint fired and
 * the events matched since the last instruction, to be placed by the scan.
 */
interface ReverseScan {
  pendingData: DataBreakpoint[];
  eventHit: boolean;
}

export class Session {
  readonly host: Host;
  readonly machine: Machine;
  readonly program: Program;
  readonly labels = new LabelStore(() => this.#emit('labels'));
  readonly inspector: Inspector;
  readonly breakpoints = new BreakpointStore();
  readonly history: RewindHistory;
  readonly trace: Ring<TraceEntry>;
  readonly events: Ring<EventEntry>;
  readonly romHash: string;
  readonly options: SessionOptions;

  #state: SessionState = 'stopped';
  #revision = 0;
  #epoch = 0;
  #handlers: Partial<SessionEvents>[] = [];
  #cancelLoop: (() => void) | null = null;
  #lastFrameEmit = -Infinity;
  #audioBuffer = new Float32Array(2 * 1024);

  // ─── stop machinery ────────────────────────────────────────────────
  #skipAddress: number | null = null;
  #stepper: StepOutcome | null = null;
  #pendingStop: StopInfo | null = null;
  #stopRequest: StopInfo | null = null;
  #pauseRequested = false;
  /** true while a command runs the machine or reports its stop: a command issued from a listener meanwhile is refused */
  #busy = false;
  /** inlined layers of frame 0 the views hide; AUTO_HIDDEN until the stop resolves it */
  #hiddenInline = AUTO_HIDDEN;
  #frameCache: StackTrace | null = null;
  #dataDisposers: Array<() => void> = [];
  #tracing = false;
  #hooksInstalled = false;
  #recordEvents = true;
  /** true only while this session runs the machine: another driver's frames are neither watched nor logged */
  #driving = false;
  #scan: ReverseScan | null = null;
  /** the hardware-event sink this session installs; only its own is ever removed from a shared machine */
  readonly #sink = (event: HardwareEvent): void => this.#onHardwareEvent(event);

  // ─── time ──────────────────────────────────────────────────────────
  #instrInFrame = 0;
  #lastFrame = 0;
  #pendingButtons: number | null = null;
  #frameButtons = 0;
  #recordingStart: number | null = null;
  /** what `stopRecording` last returned, for a view that shows recordings no matter who stopped them */
  #lastRecording: InputRecording | null = null;
  /** finished recordings, oldest first, for a view that lists and replays them */
  #recordings: RecordedTake[] = [];
  #nextTakeId = 1;
  /** the screen the recording in progress began on, kept for its take */
  #recordingThumbnail: RecordedTake['thumbnail'] | null = null;
  /** the machine the recording in progress began on, kept for its take */
  #recordingSnapshot: PackedSnapshot | null = null;
  /** the recording being played back, a frame per tick; null when the machine runs on its own input */
  #playback: { frames: number[]; index: number } | null = null;

  /**
   * Prefer {@link Session.create}: it hashes the ROM (to bind save states and
   * recordings to it) and loads the project's labels, which are asynchronous.
   * Building a session directly is for callers that already have both.
   */
  constructor(host: Host, options: SessionOptions, program: Program, romHash: string) {
    this.host = host;
    this.options = options;
    this.machine = options.machine ?? new Machine(options.rom);
    this.program = program;
    this.romHash = romHash;
    this.inspector = new Inspector(this.machine, this.program, this.labels);
    this.history = new RewindHistory(options.rewind);
    this.trace = new Ring<TraceEntry>(options.traceCapacity ?? 20_000);
    this.events = new Ring<EventEntry>(options.eventCapacity ?? 5_000);
    this.machine.onHardwareEvent = this.#sink;
    this.#lastFrame = this.machine.frame;
    this.#anchorHistory();
    this.#resolveHiddenInline();
  }

  /** Start history here: a keyframe at the current frame whatever the keyframe grid says, so step-back works at once. */
  #anchorHistory(): void {
    this.history.clear();
    this.history.push(this.machine.frame, this.machine.snapshot());
  }

  static async create(host: Host, options: SessionOptions): Promise<Session> {
    const program = new Program(options.elf ?? null, options.rom, {
      cwd: options.cwd,
      sourceMap: options.sourceMap,
      exists: options.exists,
      caseInsensitive: options.caseInsensitive,
    });
    const hash = await romHash(options.rom);
    const session = new Session(host, options, program, hash);
    await session.#loadLabels();
    return session;
  }

  // ─── events ────────────────────────────────────────────────────────

  on(handler: Partial<SessionEvents>): () => void {
    this.#handlers.push(handler);
    return () => {
      this.#handlers = this.#handlers.filter((h) => h !== handler);
    };
  }

  #emit<K extends keyof SessionEvents>(event: K, ...args: Parameters<SessionEvents[K]>): void {
    for (const h of this.#handlers) {
      try {
        (h[event] as ((...a: Parameters<SessionEvents[K]>) => void) | undefined)?.(...args);
      } catch (err) {
        // A listener must never take the machine down, and reporting its failure must
        // not re-enter it: an output listener's own failure is dropped.
        if (event !== 'output') {
          this.#emit('output', `listener for '${event}' threw: ${(err as Error).message}\n`, 'stderr');
        }
      }
    }
  }

  get state(): SessionState {
    return this.#state;
  }

  /** Bumps on every stop, resume, rewind and mutation: an observation is valid for one revision. */
  get revision(): number {
    return this.#revision;
  }

  /** Bumps on a restart, a resync or a state load: breakpoints survive, everything else is new. */
  get epoch(): number {
    return this.#epoch;
  }

  get pc(): number {
    return this.machine.pc;
  }

  get frame(): number {
    return this.machine.frame;
  }

  get position(): Position {
    return {
      frame: this.machine.frame,
      instruction: this.#instrInFrame,
      scanline: this.machine.scanline,
      cycle: this.machine.cycle,
      pc: this.machine.pc,
    };
  }

  #setState(state: SessionState): void {
    if (this.#state !== state) {
      this.#state = state;
      this.#emit('state', state);
    }
  }

  #requireStopped(what: string): void {
    if (this.#state !== 'stopped') {
      throw new Error(`cannot ${what} while ${this.#state}`);
    }
    if (this.#busy) {
      throw new Error(`cannot ${what} from inside a session event`);
    }
  }

  #requireLive(what: string): void {
    if (this.#state === 'disposed') {
      throw new Error(`cannot ${what} a disposed session`);
    }
  }

  // ─── the stop predicate ────────────────────────────────────────────

  readonly #predicate = (): boolean => {
    if (this.machine.halted) {
      // Nothing executes while the CPU sleeps: the machine polls once per scheduler
      // skip, not once per instruction. Neither a step, a breakpoint nor the
      // instruction counter moves; only a stop an event already asked for lands here.
      if (this.#pendingStop) {
        this.#stopRequest = this.#pendingStop;
        this.#pendingStop = null;
        return true;
      }
      return false;
    }
    const pc = this.machine.pc;
    this.#instrInFrame++;
    if (this.#skipAddress !== null) {
      const skip = this.#skipAddress === (pc & ~1);
      this.#skipAddress = null;
      if (skip) {
        return false;
      }
    }
    if (this.#pendingStop) {
      this.#stopRequest = this.#pendingStop;
      this.#pendingStop = null;
      this.#instrInFrame--;
      return true;
    }
    if (this.#stepper && this.#stepper.predicate(pc)) {
      this.#hiddenInline = this.#stepper.hidden() ?? AUTO_HIDDEN;
      this.#stepper = null;
      this.#stopRequest = { reason: 'step', address: pc };
      this.#instrInFrame--;
      return true;
    }
    if (this.breakpoints.hasInstructionBreakpoints) {
      const bps = this.breakpoints.at(pc & ~1);
      if (bps) {
        const hit = this.#evaluateBreakpoints(bps, pc);
        if (hit) {
          // A breakpoint on the function's own name means the user wants to see it,
          // inlined or not; a line or address breakpoint shows the line as written.
          this.#hiddenInline = hit.reason === 'function breakpoint' ? 0 : AUTO_HIDDEN;
          this.#stopRequest = hit;
          this.#instrInFrame--;
          return true;
        }
      }
    }
    return false;
  };

  #evaluateBreakpoints(bps: Breakpoint[], pc: number): StopInfo | null {
    let env: ExprEnv | null = null;
    const envOf = (): ExprEnv => (env ??= this.inspector.liveEnv());
    const ids: number[] = [];
    let kind: StopReason = 'breakpoint';
    for (const bp of bps) {
      if (bp.condition && !this.#conditionHolds(bp.condition, `breakpoint ${bp.id}`, bp.conditionText, envOf(), true)) {
        continue;
      }
      bp.hits++;
      if (bp.hitCondition && !bp.hitCondition(bp.hits)) {
        continue;
      }
      if (bp.logMessage) {
        this.#emit('output', bp.logMessage(envOf()) + '\n', 'log');
        continue;
      }
      ids.push(bp.id);
      if (bp.kind === 'instruction') {
        kind = 'instruction breakpoint';
      } else if (bp.kind === 'function') {
        kind = 'function breakpoint';
      }
    }
    return ids.length > 0 ? { reason: kind, address: pc, breakpointIds: ids } : null;
  }

  /** Whether a breakpoint's condition holds. One that fails to evaluate holds — a broken condition must not silently skip the stop — and `report` prints the failure. */
  #conditionHolds(
    condition: CompiledExpr,
    who: string,
    text: string | undefined,
    env: ExprEnv,
    report: boolean,
  ): boolean {
    try {
      return condition(env) !== 0;
    } catch (err) {
      if (report) {
        this.#emit('output', `${who} condition '${text}': ${(err as Error).message}\n`, 'stderr');
      }
      return true;
    }
  }

  #onHardwareEvent(event: HardwareEvent): void {
    if (!this.#driving) {
      return; // another driver's frame: not ours to log or stop on
    }
    if (this.#state === 'replaying') {
      if (this.#scan && this.breakpoints.eventKindOf(event)) {
        this.#scan.eventHit = true;
      }
      return;
    }
    if (this.#recordEvents) {
      this.events.push({
        event,
        pc: this.machine.pc,
        frame: this.machine.frame,
        scanline: this.machine.scanline,
        cycle: this.machine.cycle,
      });
    }
    const kind = this.breakpoints.eventKindOf(event);
    if (kind && !this.#pendingStop) {
      this.#pendingStop = { reason: 'event breakpoint', address: this.machine.pc, description: describeEvent(event) };
    }
  }

  // ─── run loop ──────────────────────────────────────────────────────

  /** Run `fn` as this session's own driving of the machine: its hooks see what happens inside. */
  #drive<T>(fn: () => T): T {
    const was = this.#driving;
    this.#driving = true;
    try {
      return fn();
    } finally {
      this.#driving = was;
    }
  }

  /** One frame (or the rest of the current one). Returns the stop, if any. */
  #runOneFrame(): StopInfo | null {
    this.#beginFrameIfNew();
    const outcome = this.#drive(() => this.machine.runFrame(this.#predicate));
    const stop = this.#stopRequest;
    this.#stopRequest = null;
    this.#afterRun();
    if (stop) {
      return stop;
    }
    if (outcome === 'stalled' || outcome === 'halted') {
      return {
        reason: 'stall',
        address: this.machine.pc,
        description: outcome === 'halted' ? 'the CPU halted' : 'the CPU is halted and nothing will wake it',
      };
    }
    return null;
  }

  /**
   * Press the playback's buttons for this frame, over any input the user is holding.
   * False once the recording runs out, having stopped the session at its end.
   */
  #pressPlayback(): boolean {
    const playback = this.#playback!;
    if (playback.index >= playback.frames.length) {
      const description = `replayed ${playback.frames.length} frames`;
      this.#stop({ reason: 'step', address: this.machine.pc, description });
      return false;
    }
    const mask = playback.frames[playback.index++]!;
    this.#pendingButtons = null;
    this.machine.setButtons(mask);
    this.#frameButtons = mask;
    return true;
  }

  /** Latch queued input at a frame boundary, so replay can reproduce it. */
  #beginFrameIfNew(): void {
    if (this.#instrInFrame === 0 && this.#pendingButtons !== null) {
      this.machine.setButtons(this.#pendingButtons);
      this.#pendingButtons = null;
    }
    this.#frameButtons = this.machine.buttons;
  }

  /** After any run: account for completed frames (input log, keyframes), and audio. */
  #afterRun(): void {
    const now = this.machine.frame;
    while (this.#lastFrame < now) {
      if (this.#state !== 'replaying') {
        this.history.recordInput(this.#lastFrame, this.#frameButtons);
      }
      this.#lastFrame++;
      this.#instrInFrame = 0;
      if (this.#state !== 'replaying') {
        this.#pushKeyframeIfDue();
      }
      if (this.#pendingButtons !== null) {
        this.machine.setButtons(this.#pendingButtons);
        this.#pendingButtons = null;
        this.#frameButtons = this.machine.buttons;
      }
    }
    if (this.#handlers.some((h) => h.audio)) {
      const n = this.machine.readAudio(this.#audioBuffer);
      if (n > 0) {
        this.#emit('audio', this.#audioBuffer.slice(0, n * 2));
      }
    }
  }

  #pushKeyframeIfDue(): void {
    if (this.#instrInFrame === 0 && this.history.isKeyframe(this.machine.frame)) {
      this.history.push(this.machine.frame, this.machine.snapshot());
    }
  }

  #tick = (): void => {
    if (this.#state !== 'running') {
      return;
    }
    if (this.#pauseRequested) {
      this.#pauseRequested = false;
      this.#stop({ reason: 'pause', address: this.machine.pc });
      return;
    }
    if (this.#playback && !this.#pressPlayback()) {
      return;
    }
    const stop = this.#runOneFrame();
    this.#emitFrame(false);
    if (stop) {
      this.#stop(stop);
    }
  };

  #stop(info: StopInfo): void {
    this.#playback = null;
    if (this.#cancelLoop) {
      this.#cancelLoop();
      this.#cancelLoop = null;
    }
    this.#stepper = null;
    this.#resolveHiddenInline();
    this.#frameCache = null;
    this.#revision++;
    const was = this.#busy;
    this.#busy = true;
    try {
      this.#setState('stopped');
      this.#emitFrame(true);
      this.#emit('stopped', info);
    } finally {
      this.#busy = was;
    }
  }

  /** A stop that left the hidden-layer count to be decided hides the inlined calls that begin at the pc. */
  #resolveHiddenInline(): void {
    if (this.#hiddenInline === AUTO_HIDDEN) {
      this.#hiddenInline = inlineEntriesAt(this.program, this.machine.pc);
    }
  }

  #emitFrame(force: boolean): void {
    const now = this.host.now();
    if (!force && now - this.#lastFrameEmit < (this.options.frameEventInterval ?? DEFAULT_FRAME_EVENT_INTERVAL_MS)) {
      return;
    }
    this.#lastFrameEmit = now;
    this.#emit('frame', this.machine.framebufferRgba(), this.machine.frame);
  }

  /** Emit the current framebuffer now (a screen view just opened). */
  requestFrame(): void {
    this.#emitFrame(true);
  }

  /** Arm a resume: forget stale stops from an aborted frame, skip our own breakpoint once. */
  #armResume(): void {
    this.#stopRequest = null;
    this.#pendingStop = null;
    this.#skipAddress = this.machine.pc & ~1;
    this.#hiddenInline = AUTO_HIDDEN;
    this.#frameCache = null;
    this.#revision++;
  }

  continue(): void {
    this.#requireStopped('continue');
    this.#runPaced();
  }

  /**
   * The machine is about to run, however briefly: forget the last stop, say so, and
   * let anything watching read the new state.
   */
  #beginRun(): void {
    this.#armResume();
    this.#setState('running');
    this.#emit('continued');
  }

  /** Run a frame per tick of the host's clock, until something stops it. */
  #runPaced(): void {
    this.#pauseRequested = false;
    this.#beginRun();
    this.#cancelLoop = this.host.interval(this.#tick, FRAME_MS);
  }

  /** Stop at the next opportunity: the next frame of a run, or between the frames of a long step. */
  pause(): void {
    if (this.#state === 'running') {
      this.#pauseRequested = true;
    }
  }

  /**
   * Run synchronously until the step's predicate accepts an instruction (bounded in
   * frames and time). The session is `running` meanwhile: a command issued from a
   * listener is refused, and a pause lands between two frames.
   */
  #runStep(step: StepOutcome, label: string): void {
    this.#requireStopped(label);
    this.#stepper = step;
    this.#pauseRequested = false;
    this.#busy = true;
    try {
      this.#beginRun();
      const started = this.host.now();
      let frames = 0;
      for (; frames < MAX_STEP_FRAMES && this.host.now() - started < MAX_STEP_MS; frames++) {
        const stop = this.#runOneFrame();
        if (stop) {
          this.#stop(stop);
          return;
        }
        if (this.#pauseRequested) {
          this.#pauseRequested = false;
          this.#stop({ reason: 'pause', address: this.machine.pc });
          return;
        }
      }
      this.#stepper = null;
      const timedOut = this.host.now() - started >= MAX_STEP_MS;
      const budget = timedOut ? `${MAX_STEP_MS / 1000} s (${frames} frames)` : `${frames} frames`;
      this.#emit('output', `${label} did not complete within ${budget}; stopped where it was\n`, 'console');
      this.#stop({ reason: 'step', address: this.machine.pc, description: `${label} gave up` });
    } finally {
      this.#busy = false;
    }
  }

  /** A step that cannot be taken from here: say why, without moving. */
  #refuseStep(label: string, why: string): void {
    this.#emit('output', `${label}: ${why}\n`, 'console');
    this.#emit('stopped', { reason: 'step', address: this.machine.pc, description: why });
  }

  #stepContext(): StepContext {
    const top = this.#frames()[0];
    const visible =
      top?.virtual && 'file' in top.virtual.location
        ? { file: top.virtual.location.file, line: top.virtual.location.line }
        : null;
    return { machine: this.machine, program: this.program, hiddenInline: this.#hiddenInline, visibleLine: visible };
  }

  stepInstruction(): void {
    this.#runStep(stepInstruction(), 'step instruction');
  }

  stepInto(): void {
    this.#requireStopped('step');
    if (this.#hiddenInline > 0) {
      // Entering an inlined call executes nothing: reveal the next layer.
      this.#hiddenInline--;
      this.#frameCache = null;
      this.#revision++;
      this.#emit('stopped', { reason: 'step', address: this.machine.pc, description: 'entered inlined call' });
      return;
    }
    this.#runStep(stepInto(this.#stepContext()), 'step into');
  }

  stepOver(): void {
    this.#runStep(stepOver(this.#stepContext()), 'step over');
  }

  /**
   * Step out: run to the caller's next instruction, where the caller and the stack
   * pointer it will have are both established — that pair is what keeps the run
   * from stopping at a recursive call of the same address. A handler whose caller
   * is the BIOS boundary has no such address to run to and is left by its mode
   * changing back instead. Failing all of that, lr is trusted only where it points
   * at program code outside this function, since once the function has made a call
   * lr is that call's return.
   */
  stepOut(): void {
    this.#requireStopped('step out');
    const frames = this.#frames();
    const top = frames[0];
    if (top?.inlined) {
      this.#runStep(stepOutOfInline(this.#stepContext()), 'step out');
      return;
    }
    const caller =
      frames.find((f) => f.index > 0 && f.virtual && f.virtual.physical !== top?.virtual?.physical) ?? frames[1];
    const callerSp = caller?.virtual?.physical.regs[13];
    if (caller && callerSp !== undefined && canRunToCaller(caller.method)) {
      this.#runStep(stepOutTo(this.#stepContext(), caller.address, callerSp), 'step out');
      return;
    }
    if (isExceptionMode(this.machine.gba.armCpu.getMode())) {
      this.#runStep(stepOutOfException(this.#stepContext()), 'step out');
      return;
    }
    const lr = (this.machine.registers[14]! & ~1) >>> 0;
    const fn = this.program.functionRange(this.machine.pc);
    if (fn && lr >= fn.lo && lr < fn.hi) {
      this.#refuseStep(
        'step out',
        'the caller is unknown: nothing above this frame was established, and lr is the return of a call this function made',
      );
      return;
    }
    if (!this.program.isExecutableCode(lr)) {
      this.#refuseStep(
        'step out',
        'the caller is unknown: nothing above this frame was established, and lr does not point at program code',
      );
      return;
    }
    this.#runStep(stepOutTo(this.#stepContext(), lr, undefined), 'step out');
  }

  runToAddress(address: number): void {
    this.#runStep(runToAddress(address), `run to 0x${address.toString(16)}`);
  }

  /** Run to the end of the current hardware frame (a breakpoint inside it still stops). */
  stepFrame(): void {
    this.#requireStopped('step frame');
    this.#beginRun();
    const stop = this.#runOneFrame();
    this.#stop(stop ?? { reason: 'step', address: this.machine.pc, description: 'frame' });
  }

  stepScanline(): void {
    this.#requireStopped('step scanline');
    this.#beginRun();
    this.#beginFrameIfNew();
    const outcome = this.#drive(() => this.machine.runScanline(this.#predicate));
    const stop = this.#stopRequest;
    this.#stopRequest = null;
    this.#afterRun();
    this.#stop(
      stop ?? { reason: 'step', address: this.machine.pc, description: outcome === 'done' ? 'scanline' : outcome },
    );
  }

  /** Reload the ROM and boot again. Breakpoints survive (their hit counts start over); history, trace and events do not. */
  restart(): void {
    this.#requireLive('restart');
    this.machine.boot();
    this.#epoch++;
    this.#instrInFrame = 0;
    this.#lastFrame = 0;
    this.#pendingButtons = null;
    this.#setRecordingStart(null);
    this.#pauseRequested = false;
    this.#hiddenInline = AUTO_HIDDEN;
    this.#stopRequest = null;
    this.#pendingStop = null;
    this.breakpoints.resetHits();
    this.history.clear();
    this.trace.clear();
    this.events.clear();
    this.#pushKeyframeIfDue();
    this.#stop({ reason: 'restart', address: this.machine.pc });
  }

  // ─── breakpoints ───────────────────────────────────────────────────

  setSourceBreakpoints(path: string, specs: Array<Omit<BreakpointSpec, 'kind' | 'path'>>): Breakpoint[] {
    return this.breakpoints.replace(
      path,
      specs.map((s) => ({ ...s, kind: 'source', path })),
      (spec) => this.#resolve(spec),
      (addresses) => this.inspector.hintsAt(addresses[0]),
    );
  }

  setInstructionBreakpoints(specs: Array<Omit<BreakpointSpec, 'kind'>>): Breakpoint[] {
    return this.breakpoints.replace(
      'instruction',
      specs.map((s) => ({ ...s, kind: 'instruction' })),
      (spec) => this.#resolve(spec),
      (addresses) => this.inspector.hintsAt(addresses[0]),
    );
  }

  setFunctionBreakpoints(specs: Array<Omit<BreakpointSpec, 'kind'>>): Breakpoint[] {
    return this.breakpoints.replace(
      'function',
      specs.map((s) => ({ ...s, kind: 'function' })),
      (spec) => this.#resolve(spec),
      (addresses) => this.inspector.hintsAt(addresses[0]),
    );
  }

  #resolve(spec: BreakpointSpec): ResolvedAddresses {
    switch (spec.kind) {
      case 'instruction':
        return spec.address === undefined
          ? { addresses: [], message: 'no address' }
          : { addresses: [(spec.address & ~1) >>> 0] };
      case 'function': {
        // The symbol's entry, plus every place the function is entered inlined: an
        // optimizer may have emitted no symbol for it at all.
        const name = spec.functionName ?? '';
        const symbol = this.program.symbolAddress(name) ?? this.labels.byName(name)?.address ?? null;
        const addresses = new Set(this.program.inlinedEntries(name));
        if (symbol !== null) {
          addresses.add((symbol & ~1) >>> 0);
        }
        return addresses.size === 0
          ? { addresses: [], message: `no symbol '${name}'` }
          : { addresses: [...addresses].sort((a, b) => a - b) };
      }
      default: {
        if (!this.program.hasSymbols) {
          return { addresses: [], message: 'no ELF loaded (set "elf" in the launch configuration)' };
        }
        if (!spec.path || spec.line === undefined) {
          return { addresses: [], message: 'no file/line' };
        }
        const hit = this.program.lineToAddresses(spec.path, spec.line);
        if (!hit) {
          const known = this.program.sources?.toDwarf(spec.path);
          return {
            addresses: [],
            message: known ? 'no code for this line' : 'this file is not in the ELF line table (check cwd / sourceMap)',
          };
        }
        return { addresses: hit.addresses, line: hit.line };
      }
    }
  }

  /**
   * What a data breakpoint on `name` would watch: storage named from frame
   * `frameIndex` (`g_samples[i]`, `p->pos.x`, a local's stack slot included), a
   * DWARF-typed global path, a symbol (whole extent), a hex address (`size` bytes,
   * default 4), or a label. Null when nothing by that name has an address (a
   * register-held local).
   */
  dataBreakpointTarget(
    name: string,
    size?: number,
    frameIndex?: number,
  ): { address: number; length: number; name: string } | null {
    const di = this.program.debugInfo;
    const trimmed = name.trim();
    if (/^0x[0-9a-f]+$/i.test(trimmed)) {
      const address = parseInt(trimmed, 16);
      // a literal wider than the bus would wrap onto some other address: nothing to watch
      return address <= 0xffffffff ? { address, length: size ?? 4, name: trimmed } : null;
    }
    if (frameIndex !== undefined && this.#state === 'stopped') {
      try {
        const scalar = this.inspector.variableTarget(trimmed, this.#frames(), frameIndex);
        if (scalar) {
          return { address: scalar.address, length: size ?? scalar.length, name: trimmed };
        }
      } catch {
        // it names no typed storage here: the symbol table may still know the name
      }
    }
    if (di) {
      const loc = di.resolveVariable(trimmed);
      if (loc) {
        return { address: loc.address, length: size ?? loc.size, name: trimmed };
      }
    }
    const address = this.program.symbolAddress(trimmed) ?? this.labels.byName(trimmed)?.address ?? null;
    if (address === null) {
      return null;
    }
    const extent = di?.symbolExtent(trimmed)?.size ?? this.labels.byName(trimmed)?.size;
    return { address, length: size ?? extent ?? 4, name: trimmed };
  }

  /**
   * Replace the data breakpoints. One whose condition does not compile is returned
   * unverified and watches nothing.
   *
   * A watched address can be written from anywhere, so a condition has no one place
   * it belongs to; it is compiled where the user typed it — the stopped frame — which
   * is the frame whose names they had in front of them. A condition naming a local
   * then answers while that frame is live and says the name is unknown once it is
   * not, which is what a name out of scope is.
   */
  setDataBreakpoints(specs: DataBreakpointSpec[]): DataBreakpoint[] {
    const list = this.breakpoints.replaceData(
      specs,
      this.inspector.hintsAt(this.#state === 'stopped' ? this.machine.pc : undefined),
    );
    this.#installWatchpoints();
    return list;
  }

  /** Put the bus watchpoints of the verified data breakpoints in place (replacing any installed). */
  #installWatchpoints(): void {
    for (const d of this.#dataDisposers) {
      d();
    }
    const bus = this.machine.gba.bus;
    this.#dataDisposers = this.breakpoints.data.flatMap((bp) => {
      const disposers: Array<() => void> = [];
      if (!bp.verified) {
        return disposers;
      }
      if (bp.access !== 'read') {
        disposers.push(
          bus.addWriteWatchpoint(bp.address, bp.length, (info) => this.#onDataAccess(bp, 'written', info)),
        );
      }
      if (bp.access !== 'write') {
        disposers.push(bus.addReadWatchpoint(bp.address, bp.length, (info) => this.#onDataAccess(bp, 'read', info)));
      }
      return disposers;
    });
  }

  /** A watched range was accessed: stop before the next instruction, unless the breakpoint's condition or hit count says otherwise. */
  #onDataAccess(bp: DataBreakpoint, verb: 'written' | 'read', info: WatchpointWrite | WatchpointRead): void {
    if (!this.#driving) {
      return; // another driver's access
    }
    if (this.#scan) {
      // A reverse search: the hit is placed by the scan, at the next instruction.
      if (
        !bp.compiledCondition ||
        this.#conditionHolds(
          bp.compiledCondition,
          `data breakpoint ${bp.id}`,
          bp.condition,
          this.inspector.liveEnv(),
          false,
        )
      ) {
        this.#scan.pendingData.push(bp);
      }
      return;
    }
    if (this.#state === 'replaying' || this.#pendingStop) {
      return;
    }
    if (
      bp.compiledCondition &&
      !this.#conditionHolds(
        bp.compiledCondition,
        `data breakpoint ${bp.id}`,
        bp.condition,
        this.inspector.liveEnv(),
        true,
      )
    ) {
      return;
    }
    bp.hits++;
    if (bp.compiledHit && !bp.compiledHit(bp.hits)) {
      return;
    }
    const by =
      info.dmaChannel >= 0
        ? `DMA${info.dmaChannel} started at ${this.program.symbolName(info.dmaOrigin?.instructionAddress ?? 0)}`
        : this.program.symbolName(this.machine.pc);
    this.#pendingStop = {
      reason: 'data breakpoint',
      address: this.machine.pc,
      // the bus hands a 32-bit value over as a signed int: print its bits, not its sign
      description: `${bp.name} ${verb} (0x${(info.value >>> 0).toString(16)}, ${info.size} bytes at 0x${info.address.toString(16)}) by ${by}`,
      breakpointIds: [bp.id],
    };
  }

  setEventBreakpoints(kinds: EventBreakpointKind[]): void {
    this.breakpoints.setEvents(kinds);
  }

  // ─── inspection ────────────────────────────────────────────────────

  #frames(): StackFrame[] {
    return this.#stack().frames;
  }

  #stack(): StackTrace {
    this.#frameCache ??= this.inspector.callStack(this.#hiddenInline);
    return this.#frameCache;
  }

  /**
   * The call stack and why it ends where it does. The reason is shown rather than
   * implied: a stack that stops because nothing could be established looks exactly
   * like one that stops because it is over.
   */
  stack(): StackTrace {
    return this.#stack();
  }

  /** The frames alone, for a caller that has no use for why the walk ended. */
  callStack(): StackFrame[] {
    return this.#frames();
  }

  scopes(frameIndex: number): Scope[] {
    const frames = this.#frames();
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frames.length) {
      throw new Error(`no frame ${frameIndex} (the stack has ${frames.length})`);
    }
    return this.inspector.scopes(frames[frameIndex]);
  }

  evaluate(expression: string, frameIndex = 0): EvaluateResult {
    return this.inspector.evaluate(expression, this.#frames(), frameIndex);
  }

  /**
   * Write through a path, the way a console line like `g_player.pos.x = 10` reads: the
   * target is resolved exactly as any other expression is, so locals, globals, members
   * and subscripts all name a place, and the value is an expression too. Returns the
   * target read back, so a caller reports what the machine now holds rather than what
   * was asked for.
   */
  assign(target: string, value: string, frameIndex = 0): EvaluateResult {
    const found = this.evaluate(target, frameIndex);
    if (!found.node.writable) {
      throw new Error(`cannot write '${target}': ${found.node.type} is not a scalar the debugger can set`);
    }
    this.setVariable(found.node, value);
    return this.evaluate(target, frameIndex);
  }

  /** Write a scalar the variables view showed as writable; returns how it now reads there. */
  setVariable(node: VarNode, text: string): string {
    if (!node.writable) {
      throw new Error(`'${node.name}' is not a writable scalar`);
    }
    const shown = this.inspector.setScalar(node.writable, text);
    this.#noteWrite();
    return shown;
  }

  disassemble(address: number, count: number, mode?: 'arm' | 'thumb'): DisassembledLine[] {
    return this.inspector.disassemble(address, count, mode);
  }

  readMemory(address: number, count: number): { data: Uint8Array; readable: number } {
    return this.machine.peekPartial(address, count);
  }

  writeMemory(address: number, bytes: Uint8Array): number {
    const n = this.machine.poke(address, bytes);
    if (n > 0) {
      this.#noteWrite();
    }
    return n;
  }

  /** Write a register of the live frame. */
  setRegister(index: number, value: number): void {
    this.#requireStopped('write a register');
    if (index < 0 || index > 15) {
      throw new Error('no such register');
    }
    this.machine.registers[index] = value >>> 0;
    this.#noteWrite();
  }

  /**
   * A write reached the machine: the revision an observation was taken at moves on,
   * the cached frames go, and listeners hear of it, so a view that shows the
   * machine's contents re-reads them without waiting for the next stop.
   */
  #noteWrite(): void {
    this.#revision++;
    this.#frameCache = null;
    this.#emit('written');
  }

  // ─── input ─────────────────────────────────────────────────────────

  /** Press or release a button. Applied at the next frame boundary so the input log stays exact. */
  setButton(button: number, down: boolean): void {
    if (button < 0 || button >= BUTTON_COUNT) {
      return;
    }
    const current = this.#pendingButtons ?? this.machine.buttons;
    this.#holdButtons(down ? current | (1 << button) : current & ~(1 << button));
  }

  /** Set every button at once from a mask (bits 0–9, `BUTTON_NAMES` order); applied like `setButton`. */
  setButtons(mask: number): void {
    this.#holdButtons(mask & ((1 << BUTTON_COUNT) - 1));
  }

  /**
   * What is held from now on. It reaches the machine at once only between frames,
   * where the input log records it; mid-frame it waits for the boundary, so replaying
   * the log presses what was pressed, when it was pressed.
   */
  #holdButtons(next: number): void {
    if (this.#state === 'stopped' && this.#instrInFrame === 0) {
      this.machine.setButtons(next);
      this.#pendingButtons = null;
    } else {
      this.#pendingButtons = next;
    }
  }

  get buttons(): number {
    return this.#pendingButtons ?? this.machine.buttons;
  }

  // ─── rewind ────────────────────────────────────────────────────────

  historyInfo(): HistoryInfo {
    return {
      earliestFrame: this.history.earliestFrame,
      keyframes: this.history.keyframeCount,
      bytes: this.history.bytes,
      recording: this.#recordingStart !== null,
      recordingStart: this.#recordingStart,
    };
  }

  /**
   * Put the machine exactly at (`frame`, `instruction`): restore the nearest earlier
   * keyframe and replay the input log through the machine. Returns false when the
   * history does not reach that far.
   */
  #replayTo(frame: number, instruction: number, cycle?: number): boolean {
    const key = this.history.keyframeAtOrBefore(frame);
    if (!key) {
      return false;
    }
    this.#replaying(() => {
      this.machine.restore(key.snapshot);
      this.#lastFrame = key.frame;
      this.#instrInFrame = 0;
      this.#pendingButtons = null;
      for (let f = key.frame; f < frame; f++) {
        this.machine.setButtons(this.history.inputAt(f));
        this.#frameButtons = this.machine.buttons;
        this.machine.runFrame();
        this.#lastFrame = f + 1;
      }
      this.machine.setButtons(this.history.inputAt(frame));
      this.#frameButtons = this.machine.buttons;
      this.#instrInFrame = 0;
      if (instruction > 0 || cycle !== undefined) {
        // Count what the live predicate counts: executed instructions, not the polls
        // made while the CPU is halted; a stop is taken at the first poll after them
        // (or, when a cycle is given, at the first poll at or past it: the polls of
        // one halt all share an instruction count).
        let count = 0;
        const outcome = this.machine.runFrame(() => {
          if (count >= instruction) {
            return cycle === undefined || this.machine.cycle >= cycle;
          }
          if (!this.machine.halted) {
            count++;
          }
          return false;
        });
        this.#instrInFrame = outcome === 'stopped' ? instruction : 0;
        if (outcome !== 'stopped') {
          this.#lastFrame = this.machine.frame;
        }
      }
    });
    return true;
  }

  /**
   * Run `fn` with the machine in replay: the hardware sink off, the state
   * `replaying` (so nothing is recorded or stops), both restored afterwards.
   */
  #replaying<T>(fn: () => T): T {
    const previous = this.#state;
    this.#state = 'replaying';
    this.machine.onHardwareEvent = null;
    try {
      return this.#drive(fn);
    } finally {
      this.machine.onHardwareEvent = this.#sink;
      this.#state = previous;
    }
  }

  /** How many instructions frame `frame` executes, by replaying it. */
  #instructionsIn(frame: number): number | null {
    if (!this.#replayTo(frame, 0)) {
      return null;
    }
    let count = 0;
    this.#replaying(() => {
      this.machine.runFrame(() => {
        if (!this.machine.halted) {
          count++;
        }
        return false;
      });
    });
    return count;
  }

  #finishRewind(reason: StopReason, description: string): void {
    this.history.truncateAfter(this.machine.frame);
    this.#pushKeyframeIfDue();
    this.#stopRequest = null;
    this.#pendingStop = null;
    this.#hiddenInline = AUTO_HIDDEN;
    this.#stop({ reason, address: this.machine.pc, description });
  }

  /**
   * Go back to the start of `frame` (or as far as history reaches). False when the
   * position cannot move: no history, or already at the start of the target frame
   * (from inside a frame, its own start is a move).
   */
  rewindToFrame(frame: number): boolean {
    this.#requireStopped('rewind');
    const earliest = this.history.earliestFrame;
    if (earliest === null) {
      return false;
    }
    const target = Math.max(earliest, Math.min(frame, this.machine.frame));
    if (target === this.machine.frame && this.#instrInFrame === 0) {
      return false;
    }
    if (!this.#replayTo(target, 0)) {
      return false;
    }
    this.#finishRewind('rewind', `rewound to frame ${target}`);
    return true;
  }

  rewindFrames(count: number): boolean {
    const target = this.#instrInFrame > 0 ? this.machine.frame - (count - 1) : this.machine.frame - count;
    return this.rewindToFrame(Math.max(0, target));
  }

  /** Exactly one instruction back. */
  stepBack(): boolean {
    this.#requireStopped('step back');
    let frame = this.machine.frame;
    let instruction = this.#instrInFrame - 1;
    if (instruction < 0) {
      if (frame === 0 || (this.history.earliestFrame ?? Infinity) > frame - 1) {
        return false;
      }
      const count = this.#instructionsIn(frame - 1);
      if (count === null) {
        return false;
      }
      frame -= 1;
      instruction = Math.max(0, count - 1);
    }
    if (!this.#replayTo(frame, instruction)) {
      return false;
    }
    this.#finishRewind('rewind', `stepped back to frame ${frame}, instruction ${instruction}`);
    return true;
  }

  /**
   * Run backwards to the most recent breakpoint hit before now: keyframes are
   * replayed forward with every breakpoint armed — instruction, source, function,
   * data and event breakpoints, their conditions and hit counts — and the last hit
   * before the current position wins. Logpoints are silent in reverse. Without a
   * hit, lands on the earliest frame in history.
   */
  reverseContinue(): boolean {
    this.#requireStopped('reverse continue');
    const nowFrame = this.machine.frame;
    const nowInstr = this.#instrInFrame;
    const earliest = this.history.earliestFrame;
    if (earliest === null || (nowFrame === earliest && nowInstr === 0)) {
      return false;
    }
    const visitsAfter = new Map<Breakpoint | DataBreakpoint, number>();
    let searchFrom = this.history.keyframeAtOrBefore(nowFrame)?.frame ?? earliest;
    for (;;) {
      const hit = this.#lastHitBetween(searchFrom, nowFrame, nowInstr, visitsAfter);
      if (hit) {
        this.#replayTo(hit.frame, hit.instruction, hit.cycle);
        this.#finishRewind('breakpoint', `reverse-continued to a breakpoint at frame ${hit.frame}`);
        return true;
      }
      if (searchFrom <= earliest) {
        break;
      }
      const prev = this.history.keyframeAtOrBefore(searchFrom - 1);
      if (!prev || prev.frame >= searchFrom) {
        break;
      }
      searchFrom = prev.frame;
    }
    this.#replayTo(earliest, 0);
    this.#finishRewind('rewind', `no earlier breakpoint hit in history; at frame ${earliest}`);
    return true;
  }

  /**
   * The last (frame, instruction) in [`from`, now) where a breakpoint would stop,
   * evaluated as the forward run evaluates it. A hit count is reconstructed: the
   * k-th of a breakpoint's V visits in the window saw `hits - after - V + k`,
   * `after` being its visits between the window and now (`visitsAfter`, which
   * this call extends with the window's own).
   */
  #lastHitBetween(
    from: number,
    nowFrame: number,
    nowInstr: number,
    visitsAfter: Map<Breakpoint | DataBreakpoint, number>,
  ): HistoryPosition | null {
    if (!this.#replayTo(from, 0)) {
      return null;
    }
    let last: HistoryPosition | null = null;
    // Visits of the breakpoints that have a hit condition, oldest first. The one at
    // the current position (if the forward run stopped on it) counts toward the
    // breakpoint's tally without being a place to land.
    const visits = new Map<Breakpoint | DataBreakpoint, Array<{ at: HistoryPosition; landable: boolean }>>();
    const visited = (bp: Breakpoint | DataBreakpoint, at: HistoryPosition, landable: boolean): void => {
      if (hitTestOf(bp)) {
        const list = visits.get(bp);
        if (list) {
          list.push({ at, landable });
        } else {
          visits.set(bp, [{ at, landable }]);
        }
      } else if (landable) {
        last = at;
      }
    };
    const scan: ReverseScan = { pendingData: [], eventHit: false };
    this.#scan = scan;
    try {
      this.#replaying(() => {
        this.machine.onHardwareEvent = this.#sink;
        for (let f = from; f <= nowFrame; f++) {
          this.machine.setButtons(this.history.inputAt(f));
          let count = 0;
          const limit = f === nowFrame ? nowInstr : Infinity;
          const instructionBreakpointsHere = (landable: boolean): void => {
            const bps = this.breakpoints.at(this.machine.pc & ~1);
            if (!bps) {
              return;
            }
            // Built once per address, because several breakpoints can share one, and
            // never reused beyond it: `liveEnv` binds the scope of the pc it was made
            // at, so a condition judged in a stale scope would not find its locals and
            // would count as a hit (a condition that cannot be evaluated holds).
            let env: ExprEnv | null = null;
            for (const bp of bps) {
              if (!bp.verified || bp.logMessage) {
                continue;
              }
              if (bp.condition) {
                env ??= this.inspector.liveEnv();
                if (!this.#conditionHolds(bp.condition, `breakpoint ${bp.id}`, bp.conditionText, env, false)) {
                  continue;
                }
              }
              visited(bp, { frame: f, instruction: count }, landable);
            }
          };
          this.machine.runFrame(() => {
            const now = count >= limit;
            if (scan.pendingData.length > 0 || scan.eventHit) {
              // A watchpoint or event fired since the last poll: the forward run stops at this one.
              const at = { frame: f, instruction: count, cycle: this.machine.cycle };
              for (const bp of scan.pendingData) {
                visited(bp, at, !now);
              }
              scan.pendingData.length = 0;
              if (scan.eventHit) {
                scan.eventHit = false;
                if (!now) {
                  last = at;
                }
              }
            }
            if (now) {
              if (!this.machine.halted) {
                instructionBreakpointsHere(false);
              }
              return true;
            }
            if (this.machine.halted) {
              return false;
            }
            instructionBreakpointsHere(true);
            count++;
            return false;
          });
        }
      });
    } finally {
      this.#scan = null;
    }
    for (const [bp, list] of visits) {
      const after = visitsAfter.get(bp) ?? 0;
      const test = hitTestOf(bp)!;
      for (let k = list.length; k >= 1; k--) {
        const { at, landable } = list[k - 1]!;
        const hits = bp.hits - after - list.length + k;
        if (landable && hits >= 1 && test(hits)) {
          if (!last || at.frame > last.frame || (at.frame === last.frame && at.instruction > last.instruction)) {
            last = at;
          }
          break;
        }
      }
      visitsAfter.set(bp, after + list.length);
    }
    return last;
  }

  // ─── recording ─────────────────────────────────────────────────────

  /**
   * Record the buttons held on every frame from this one, until `stopRecording`.
   * The screen and the machine are kept as they are now: the screen to show the take
   * by, the machine so a session that never ran these frames can still replay it from
   * here (packed, so it costs tens of kilobytes rather than half a megabyte).
   */
  startRecording(): void {
    this.#recordingThumbnail = this.screen();
    this.#recordingSnapshot = packSnapshot(this.machine.snapshot());
    this.#setRecordingStart(this.machine.frame);
  }

  /** The last {@link MAX_RECORDINGS} finished recordings, oldest first, each with the screen it began on. */
  get recordings(): readonly RecordedTake[] {
    return this.#recordings;
  }

  /** Whether a recording is being played back right now. */
  get replaying(): boolean {
    return this.#playback !== null;
  }

  get recording(): boolean {
    return this.#recordingStart !== null;
  }

  /**
   * A path under the project's `.gba-kit/`, where everything this session keeps
   * beside the ROM lives: its labels, its save states, its recordings. Null when the
   * host has no file system.
   */
  projectFile(...parts: string[]): string | null {
    const files = this.host.files;
    return files ? files.join(this.options.projectDir ?? this.options.cwd, '.gba-kit', ...parts) : null;
  }

  /** The frame the recording in progress began at; null when none is. */
  get recordingStart(): number | null {
    return this.#recordingStart;
  }

  /** What `stopRecording` last returned; null until a recording has been stopped. Survives a restart: one from frame 0 replays after it. */
  get lastRecording(): InputRecording | null {
    return this.#lastRecording;
  }

  /** The buttons held on every frame since `startRecording`, bound to this ROM. */
  stopRecording(): InputRecording {
    const start = this.#recordingStart ?? this.machine.frame;
    this.#setRecordingStart(null);
    const frames: number[] = [];
    for (let f = start; f < this.machine.frame; f++) {
      frames.push(this.history.inputAt(f));
    }
    const recording: InputRecording = {
      format: 'gba-kit-input',
      version: 1,
      romHash: this.romHash,
      startFrame: start,
      frames,
    };
    this.#lastRecording = recording;
    this.addRecording({
      recording,
      script: recordingToScript(recording),
      thumbnail: this.#recordingThumbnail ?? this.screen(),
      createdAt: new Date().toISOString(),
      start: this.#recordingSnapshot ?? undefined,
    });
    this.#recordingThumbnail = null;
    this.#recordingSnapshot = null;
    return recording;
  }

  /**
   * Keep a take this session did not make: one read back from a file. Returns it with
   * the id it was given. The oldest goes once there are more than
   * {@link MAX_RECORDINGS}, so a project with a long history lists its newest.
   */
  addRecording(take: Omit<RecordedTake, 'id'>): RecordedTake {
    const kept: RecordedTake = { id: this.#nextTakeId++, ...take };
    this.#recordings.push(kept);
    if (this.#recordings.length > MAX_RECORDINGS) {
      this.#recordings.shift();
    }
    return kept;
  }

  /** Forget a take. False when this session has no take with that id. */
  removeRecording(id: number): boolean {
    const at = this.#recordings.findIndex((t) => t.id === id);
    if (at < 0) {
      return false;
    }
    this.#recordings.splice(at, 1);
    return true;
  }

  /** Every way a recording begins or ends goes through here, so listeners hear of each flip exactly once. */
  #setRecordingStart(frame: number | null): void {
    const was = this.#recordingStart !== null;
    this.#recordingStart = frame;
    if (was !== (frame !== null)) {
      this.#emit('recording', frame !== null);
    }
  }

  recordingAsScript(recording: InputRecording): string {
    return recordingToScript(recording);
  }

  /**
   * Play a recording back at the speed it was made, pressing its buttons a frame at a
   * time, and stop at its end. Returns whether the playback started: false when `from`
   * is `'start'` and the frame the recording was made at cannot be reached. A
   * breakpoint, a stall or a pause during the playback ends it where it hit.
   */
  replayRecording(recording: InputRecording, from: 'start' | 'here' = 'start', start?: PackedSnapshot): boolean {
    this.#requireStopped('replay');
    if (recording.romHash !== this.romHash) {
      throw new Error('this recording was made with a different ROM');
    }
    // `start` puts the machine back where the recording was made and presses the same
    // buttons there, reproducing it; `here` presses them from wherever the machine is
    // now, which is how a recorded move is used somewhere else.
    if (from === 'start') {
      if (recording.startFrame === 0 && (this.history.earliestFrame ?? 0) > 0) {
        this.restart();
      } else if (recording.startFrame > this.machine.frame || !this.#replayTo(recording.startFrame, 0)) {
        // rewinding could not reach it: this session never ran those frames. The take's
        // own start state can still put the machine there, which is how a recording
        // outlives the session that made it.
        if (!start) {
          return false;
        }
        this.#restoreSnapshot(unpackSnapshot(start));
      }
    }
    this.history.truncateAfter(this.machine.frame);
    this.#playback = { frames: [...recording.frames], index: 0 };
    this.#runPaced();
    return true;
  }

  // ─── save states ───────────────────────────────────────────────────

  /** The screen as it is now, reduced: what a save state or a recording is shown by. */
  screen(): Screen {
    return thumbnailRgba(this.machine.framebufferRgba());
  }

  /** The machine as a save state, with the screen it was saved on for a view that lists states. */
  saveState(name?: string): string {
    return encodeSaveState(this.machine.snapshot(), {
      romHash: this.romHash,
      name,
      frame: this.machine.frame,
      thumbnail: screenToJson(this.screen()),
    });
  }

  /**
   * A `.sav` as a save state: a power-on machine of this ROM with the file already in
   * its cartridge, at frame 0. Loading it and continuing boots the ROM and the game
   * finds the save — the convention VBA-M's `Import battery file` and mGBA's `Load
   * alternate save game` follow, and what makes the result independent of wherever
   * this session happens to be stopped.
   *
   * The machine being debugged is never touched: the snapshot is built on a machine of
   * its own, so no history, hit count, revision or reported state moves. Nothing is
   * written here either — the state goes wherever the caller keeps its states.
   */
  importSaveState(bytes: Uint8Array, name: string): string {
    const fresh = new Machine(this.machine.rom);
    checkSaveFile(fresh.gba.bus.save, bytes.length);
    fresh.gba.bus.writeBackup(bytes);
    return encodeSaveState(fresh.snapshot(), {
      romHash: this.romHash,
      name,
      frame: fresh.frame,
      thumbnail: screenToJson(thumbnailRgba(fresh.framebufferRgba())),
    });
  }

  /** The machine's cartridge backup memory as a `.sav`, the size its declared save type gives it. */
  exportSaveFile(): Uint8Array {
    const bus = this.machine.gba.bus;
    // `saveFileSize` has thrown already unless the cartridge declares a save, so there is one to read
    const size = saveFileSize(bus.save, bus.eepromAddrBits);
    return bus.readBackup()!.subarray(0, size);
  }

  loadState(text: string): void {
    this.#requireStopped('load a state');
    const { snapshot, meta } = decodeSaveState(text);
    if (meta.romHash && meta.romHash !== this.romHash) {
      throw new Error('this save state belongs to a different ROM');
    }
    this.#loadSnapshot(snapshot, `loaded state${meta.name ? ` '${meta.name}'` : ''}`);
  }

  #loadSnapshot(snapshot: GbaSnapshot, description: string): void {
    this.#restoreSnapshot(snapshot);
    this.#stop({ reason: 'restart', address: this.machine.pc, description });
  }

  /** Put the machine in a state it did not reach by running: history starts again from there. */
  #restoreSnapshot(snapshot: GbaSnapshot): void {
    this.machine.restore(snapshot);
    this.#epoch++;
    this.#lastFrame = this.machine.frame;
    this.#instrInFrame = 0;
    this.#pendingButtons = null;
    this.#anchorHistory();
    this.#stopRequest = null;
    this.#pendingStop = null;
    this.#hiddenInline = AUTO_HIDDEN;
  }

  /**
   * Hand the machine to another driver while stopped: the session's hooks come off
   * (its watchpoints, hardware-event sink and trace hook), so the other driver's
   * frames cost nothing and record nothing. {@link resync} puts them back.
   */
  detach(): void {
    this.#requireStopped('detach');
    for (const d of this.#dataDisposers) {
      d();
    }
    this.#dataDisposers = [];
    if (this.machine.onHardwareEvent === this.#sink) {
      this.machine.onHardwareEvent = null;
    }
    if (this.#hooksInstalled) {
      this.machine.gba.armCpu.setDebugHooks(undefined);
      this.#hooksInstalled = false;
    }
  }

  /**
   * Someone else drove the machine (a play mode, a state loaded outside the
   * session): forget the history, trace, events and hit counts that no longer
   * describe it, start counting from here, and put the hooks back.
   */
  resync(description = 'the machine changed outside the debugger'): void {
    this.#requireLive('resync');
    if (this.#cancelLoop) {
      this.#cancelLoop();
      this.#cancelLoop = null;
    }
    this.#pauseRequested = false;
    this.#lastFrame = this.machine.frame;
    this.#instrInFrame = 0;
    this.#pendingButtons = null;
    this.#setRecordingStart(null);
    this.#anchorHistory();
    this.#stopRequest = null;
    this.#pendingStop = null;
    this.#hiddenInline = AUTO_HIDDEN;
    this.#epoch++;
    this.breakpoints.resetHits();
    this.trace.clear();
    this.events.clear();
    this.machine.onHardwareEvent = this.#sink;
    this.setTracing(this.#tracing);
    this.#installWatchpoints();
    this.#stop({ reason: 'restart', address: this.machine.pc, description });
  }

  // ─── views ─────────────────────────────────────────────────────────

  palette(): { bg: number[]; obj: number[] } {
    return paletteSnapshot(this.machine);
  }

  tiles(charBase: number, bpp: 4 | 8, count: number): TilesSnapshot {
    return tilesSnapshot(this.machine, charBase, bpp, count);
  }

  backgrounds(): ReturnType<typeof backgroundsSnapshot> {
    return backgroundsSnapshot(this.machine);
  }

  tilemap(index: number): TilemapSnapshot | null {
    return tilemapSnapshot(this.machine, index);
  }

  sprites(): SpriteInfo[] {
    return spritesSnapshot(this.machine);
  }

  ioRegisters(): IoRegisterValue[] {
    return ioSnapshot(this.machine);
  }

  searchMemory(options: SearchOptions): number[] {
    return searchMemory(this.machine, options);
  }

  filterMemory(candidates: number[], value: number, size: 1 | 2 | 4): number[] {
    return filterMemory(this.machine, candidates, value, size);
  }

  // ─── trace ─────────────────────────────────────────────────────────

  get tracing(): boolean {
    return this.#tracing;
  }

  /** Turn instruction tracing on or off; listeners hear of a change, not of a resync putting the hooks back. */
  setTracing(on: boolean): void {
    const changed = this.#tracing !== on;
    this.#tracing = on;
    if (changed) {
      this.#emit('tracing', on);
    }
    const cpu = this.machine.gba.armCpu;
    if (!on) {
      if (this.#hooksInstalled) {
        cpu.setDebugHooks(undefined);
        this.#hooksInstalled = false;
      }
      return;
    }
    this.#hooksInstalled = true;
    cpu.setDebugHooks({
      onInstructionPost: (address, instruction) => {
        if (!this.#driving || this.#state === 'replaying') {
          return;
        }
        const r = cpu.registers;
        this.trace.push({
          pc: address,
          thumb: cpu.getT(),
          opcode: instruction,
          r0: r[0]!,
          r1: r[1]!,
          r2: r[2]!,
          r3: r[3]!,
          frame: this.machine.frame,
          scanline: this.machine.scanline,
          cycle: this.machine.cycle,
        });
      },
    });
  }

  /** Whether hardware events are appended to the event log (breakpoints on them work regardless). */
  setEventLogging(on: boolean): void {
    this.#recordEvents = on;
  }

  // ─── labels ────────────────────────────────────────────────────────

  #labelsPath(): string | null {
    return this.projectFile('labels.json');
  }

  async #loadLabels(): Promise<void> {
    const path = this.#labelsPath();
    if (!path || !this.host.files) {
      return;
    }
    const text = await this.host.files.readText(path);
    if (text) {
      try {
        this.labels.loadFile(JSON.parse(text) as LabelsFile);
      } catch (err) {
        this.#emit('output', `could not read ${path}: ${(err as Error).message}\n`, 'stderr');
      }
    }
  }

  async saveLabels(): Promise<string | null> {
    const path = this.#labelsPath();
    if (!path || !this.host.files) {
      return null;
    }
    await this.host.files.writeText(path, JSON.stringify(this.labels.toFile(this.romHash), null, 2) + '\n');
    this.labels.markSaved();
    return path;
  }

  /** Release the machine for good: only this session's own hooks are removed from it. */
  dispose(): void {
    if (this.#state === 'disposed') {
      return;
    }
    if (this.#cancelLoop) {
      this.#cancelLoop();
      this.#cancelLoop = null;
    }
    for (const d of this.#dataDisposers) {
      d();
    }
    this.#dataDisposers = [];
    if (this.machine.onHardwareEvent === this.#sink) {
      this.machine.onHardwareEvent = null;
    }
    if (this.#hooksInstalled) {
      this.machine.gba.armCpu.setDebugHooks(undefined);
      this.#hooksInstalled = false;
    }
    this.#handlers = [];
    this.#state = 'disposed';
  }
}

/**
 * Whether a step-out can run to a caller this method produced: the address has to
 * be a place execution will really arrive at, which is the method's own answer in
 * {@link FRAME_METHODS} rather than a list kept here.
 */
function canRunToCaller(method: FrameMethod): boolean {
  return FRAME_METHODS[method].runnable;
}

/** The hit-count test of a breakpoint of either kind, if it has one. */
function hitTestOf(bp: Breakpoint | DataBreakpoint): ((hits: number) => boolean) | undefined {
  return 'access' in bp ? bp.compiledHit : bp.hitCondition;
}

function describeEvent(event: HardwareEvent): string {
  switch (event.kind) {
    case 'irq-request':
      return `interrupt requested (flag 0x${event.flag.toString(16)})`;
    case 'irq-enter':
      return 'interrupt taken';
    case 'dma':
      return `DMA${event.channel}: 0x${event.info.source.toString(16)} → 0x${event.info.destination.toString(16)}, ${event.info.count} × ${event.info.wordSize} bytes`;
    case 'mmio-write': {
      const register = ioRegisterAt(event.address);
      const where = `0x${event.address.toString(16)}`;
      return `I/O write ${register ? `${register.name} (${where})` : where} = 0x${event.value.toString(16)}`;
    }
    case 'vblank':
      return 'VBlank';
    case 'hblank':
      return `HBlank on scanline ${event.scanline}`;
    case 'halt':
      return 'CPU halted';
  }
}
