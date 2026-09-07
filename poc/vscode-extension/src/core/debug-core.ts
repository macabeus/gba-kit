/**
 * DebugCore — the IDE-agnostic debugger service.
 *
 * Owns one `Gba`, its `DebugInfo`, a `ScriptingEngine` (via gba-kit's
 * `HeadlessRuntime`, so scripts get the documented API), breakpoints, the paced run
 * loop, the rewind ring, and input recording. It talks in addresses, frames and
 * symbols; it knows nothing about DAP or VS Code. The DAP adapter (`../dap`) and
 * the VS Code layer (`../vscode`) are both clients of this class.
 *
 * Execution model: every stop goes through `DebugHooks.onInstructionPre`, which is
 * the only sound place to stop (a frame-boundary sample would miss everything). A
 * hook that returns 'break' makes `Gba.runFrame` return early; the loop notices
 * `#stopRequest` and emits `stopped`.
 */
import type { DebugHooks } from '@gba-kit/arm-emulator';
import { disassembleArm, disassembleThumb } from '@gba-kit/arm-emulator/disassembler';
import { DebugInfo, ElfFile } from '@gba-kit/debug-info';
import { CYCLES_PER_FRAME, Gba, type GbaButton, type ScriptingEngine } from '@gba-kit/gba-emulator';
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';
import { HeadlessRuntime, NodeScriptingHost } from '@gba-kit/gba-node';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { DwarfContext, type Memory, type VirtualFrame } from './dwarf/context.js';
import type { Die } from './dwarf/parse.js';
import type { VarNode } from './dwarf/types.js';
import { LinkerSymbols } from './linker-symbols.js';
import { InputRecorder, serializeToScript } from './recorder.js';
import { SourceMapper } from './source-map.js';

export type CoreState = 'paused' | 'running' | 'scripting';

export type StopReason =
  | 'entry'
  | 'breakpoint'
  | 'instruction breakpoint'
  | 'data breakpoint'
  | 'step'
  | 'pause'
  | 'rewind'
  | 'script';

export interface StopInfo {
  reason: StopReason;
  address: number;
  description?: string;
  /** ids of the breakpoints that caused the stop, when any */
  breakpointIds?: number[];
}

export interface CoreEvents {
  stopped(info: StopInfo): void;
  continued(): void;
  /** RGBA 240x160, a fresh copy each call. Throttled to ~30 Hz while running. */
  frame(rgba: Uint8Array, frame: number): void;
  output(text: string, category: 'console' | 'stdout' | 'stderr'): void;
  stateChanged(state: CoreState): void;
}

export interface DebugCoreOptions {
  romPath: string;
  elfPath?: string;
  cwd: string;
  sourceMap?: Record<string, string>;
  outputDir: string;
  rewind?: { keyframeInterval?: number; maxKeyframes?: number };
}

export interface SourceBreakpointResult {
  id: number;
  verified: boolean;
  line: number;
  address?: number;
  message?: string;
}

export interface DisassembledLine {
  address: number;
  bytes: string;
  mnemonic: string;
  symbol?: string;
  source?: { path: string; line: number };
}

export interface CallFrame {
  index: number;
  /** pc of the physical frame (frame 0: the live pc; callers: the return address) */
  address: number;
  name: string;
  source?: { path: string; line: number };
  /** true when this frame is an educated guess rather than an unwound frame */
  heuristic: boolean;
  /** an inlined layer of the physical frame below it */
  inlined: boolean;
  /** the DWARF-backed frame this row came from, when the ELF has DWARF scopes */
  virtual?: VirtualFrame;
}

export interface FrameScopes {
  locals: VarNode[];
  globals: VarNode[];
  /** the physical frame's registers (unwound for callers; undefined = unknown) */
  registers: Array<{ name: string; value: number | undefined }>;
}

interface Breakpoint {
  id: number;
  address: number;
  kind: 'source' | 'instruction';
}

interface DataBreakpoint {
  id: number;
  address: number;
  length: number;
  name: string;
  dispose: () => void;
}

const FRAME_MS = 1000 / 59.7275;
const MAX_STEP_FRAMES = 300;
/** Wall-clock budget for a synchronous step; the host must not freeze for seconds. */
const MAX_STEP_MS = 1500;
const BIOS_END = 0x4000;

export class DebugCore {
  readonly gba: Gba;
  readonly debugInfo: DebugInfo | null;
  readonly sources: SourceMapper | null;
  /** DIE-level DWARF (scopes, locals, CFI); null without an ELF or without .debug_info */
  readonly dwarf: DwarfContext | null;
  /** raw .symtab, for the linker-placed globals the library's index drops */
  readonly linkerSymbols: LinkerSymbols | null;
  #framesCache: CallFrame[] | null = null;
  /**
   * Inlined layers of frame 0 hidden from the call stack. Set when a step-over
   * lands on the entry of an inlined call: the user sees the call-site line in the
   * caller (as gdb does), and Step Into reveals one layer without executing.
   */
  #hiddenInline = 0;
  readonly #runtime: HeadlessRuntime;
  readonly #options: DebugCoreOptions;

  #state: CoreState = 'paused';
  #handlers: Partial<CoreEvents>[] = [];
  #timer: NodeJS.Timeout | null = null;
  #frame = 0;
  #lastFrameEmit = 0;

  // ─── stop machinery ────────────────────────────────────────────────
  /** Several breakpoints may share an address (two lines at one PC, source + instruction). */
  #breakpoints = new Map<number, Breakpoint[]>();
  #dataBreakpoints: DataBreakpoint[] = [];
  #nextBreakpointId = 1;
  #stepper: ((address: number) => boolean) | null = null;
  /** The instruction we resume on: its own breakpoint must not fire again immediately. */
  #skipAddress: number | null = null;
  #pendingDataHit: DataBreakpoint | null = null;
  #stopRequest: StopInfo | null = null;
  #pauseRequested = false;

  // ─── rewind ────────────────────────────────────────────────────────
  readonly #keyframeInterval: number;
  readonly #maxKeyframes: number;
  #keyframes: Array<{ frame: number; snap: GbaSnapshot }> = [];
  /** false right after a keyframe was taken and nothing ran since (so it is "now", not history) */
  #dirtySinceKeyframe = true;
  /** breakpoint id -> local path, so a file's breakpoints can be replaced as a set */
  readonly #bpFile = new Map<number, string>();

  // ─── input / recording ─────────────────────────────────────────────
  readonly #heldButtons = new Set<number>();
  readonly #recorder = new InputRecorder();

  private constructor(
    options: DebugCoreOptions,
    gba: Gba,
    runtime: HeadlessRuntime,
    debugInfo: DebugInfo | null,
    dwarf: DwarfContext | null,
    linkerSymbols: LinkerSymbols | null,
  ) {
    this.#options = options;
    this.gba = gba;
    this.#runtime = runtime;
    this.debugInfo = debugInfo;
    this.dwarf = dwarf;
    this.linkerSymbols = linkerSymbols;
    this.sources = debugInfo ? new SourceMapper(debugInfo, { cwd: options.cwd, sourceMap: options.sourceMap }) : null;
    this.#keyframeInterval = Math.max(1, options.rewind?.keyframeInterval ?? 10);
    this.#maxKeyframes = Math.max(1, options.rewind?.maxKeyframes ?? 180);
    gba.armCpu.setDebugHooks(this.#hooks);
    this.#pushKeyframe(); // frame 0: rewinding can always reach the boot state
  }

  static async create(options: DebugCoreOptions): Promise<DebugCore> {
    const gba = new Gba();
    gba.loadRom(new Uint8Array(await fsp.readFile(options.romPath)));

    // Post-BIOS boot state, identical to HeadlessRuntime.create / EmulatorBridge.loadRom.
    const cpu = gba.armCpu;
    cpu.switchMode(0x12);
    cpu.registers[13] = 0x03007fa0;
    cpu.switchMode(0x13);
    cpu.registers[13] = 0x03007fe0;
    cpu.switchMode(0x1f);
    cpu.registers[13] = 0x03007f00;
    cpu.cpsr = 0x1f;
    cpu.registers[15] = 0x08000000;

    await fsp.mkdir(options.outputDir, { recursive: true });
    let core!: DebugCore;
    const host = new NodeScriptingHost(options.outputDir, (msg) => core.#emit('output', msg + '\n', 'stdout'));
    const runtime = new HeadlessRuntime(gba, host, options.outputDir);

    let debugInfo: DebugInfo | null = null;
    let dwarf: DwarfContext | null = null;
    let linkerSymbols: LinkerSymbols | null = null;
    if (options.elfPath) {
      const elfBytes = new Uint8Array(await fsp.readFile(options.elfPath));
      debugInfo = DebugInfo.fromElf(elfBytes);
      runtime.engine.setDebugInfo(debugInfo);
      try {
        dwarf = DwarfContext.fromElf(elfBytes);
        linkerSymbols = new LinkerSymbols(ElfFile.parse(elfBytes));
      } catch (err) {
        console.error('gba-kit: DWARF scope parsing failed, locals disabled', err);
      }
    }

    core = new DebugCore(options, gba, runtime, debugInfo, dwarf, linkerSymbols);
    return core;
  }

  // ─── events ────────────────────────────────────────────────────────

  on(handler: Partial<CoreEvents>): () => void {
    this.#handlers.push(handler);
    return () => {
      this.#handlers = this.#handlers.filter((h) => h !== handler);
    };
  }

  #emit<K extends keyof CoreEvents>(event: K, ...args: Parameters<CoreEvents[K]>): void {
    for (const h of this.#handlers) {
      try {
        (h[event] as ((...a: Parameters<CoreEvents[K]>) => void) | undefined)?.(...args);
      } catch (err) {
        // A listener must never take the emulator down.
        console.error(`gba-kit core listener for '${event}' threw`, err);
      }
    }
  }

  get state(): CoreState {
    return this.#state;
  }

  get frame(): number {
    return this.#frame;
  }

  get engine(): ScriptingEngine {
    return this.#runtime.engine;
  }

  get pc(): number {
    return this.gba.armCpu.registers[15]!;
  }

  get thumb(): boolean {
    return this.gba.armCpu.getT();
  }

  #setState(state: CoreState): void {
    if (this.#state !== state) {
      this.#state = state;
      this.#emit('stateChanged', state);
    }
  }

  // ─── the hook: the single place execution can stop ─────────────────

  readonly #hooks: DebugHooks = {
    onInstructionPre: (address) => {
      if (this.#skipAddress !== null) {
        const skip = this.#skipAddress === address;
        this.#skipAddress = null;
        if (skip) {
          return 'continue';
        }
      }
      if (this.#pendingDataHit) {
        const hit = this.#pendingDataHit;
        this.#pendingDataHit = null;
        this.#stopRequest = {
          reason: 'data breakpoint',
          address,
          description: `write to ${hit.name} (0x${hit.address.toString(16)})`,
          breakpointIds: [hit.id],
        };
        return 'break';
      }
      if (this.#stepper && this.#stepper(address)) {
        this.#stepper = null;
        this.#stopRequest = { reason: 'step', address };
        return 'break';
      }
      const bps = this.#breakpoints.get(address);
      if (bps && bps.length > 0) {
        this.#stepper = null;
        this.#stopRequest = {
          reason: bps.some((b) => b.kind === 'source') ? 'breakpoint' : 'instruction breakpoint',
          address,
          breakpointIds: bps.map((b) => b.id),
        };
        return 'break';
      }
      return 'continue';
    },
  };

  // ─── run loop ──────────────────────────────────────────────────────

  /** Run one emulated frame. Returns the stop that happened inside it, if any. */
  #runOneFrame(): StopInfo | null {
    this.#dirtySinceKeyframe = true;
    this.gba.runFrame();
    const stop = this.#stopRequest;
    this.#stopRequest = null;
    this.#syncFrames();
    return stop;
  }

  /**
   * Frames are derived from emulated time, not from "runFrame returned without a
   * stop": a breakpoint that fires every frame would otherwise freeze the counter,
   * the recorder and the rewind ring. (Timing drifts by one cycle per stop — a
   * gba-kit issue noted in the plan — which this integer division tolerates.)
   */
  #syncFrames(): void {
    const now = Math.floor(this.gba.scheduler.currentCycle / CYCLES_PER_FRAME);
    while (this.#frame < now) {
      this.#frame++;
      this.#recorder.onFrame();
      this.#dirtySinceKeyframe = true;
      if (this.#frame % this.#keyframeInterval === 0) {
        this.#pushKeyframe();
      }
    }
  }

  /** Arm a resume: forget stale stops from an aborted frame, skip our own breakpoint once. */
  #armResume(): void {
    this.#stopRequest = null;
    this.#pendingDataHit = null;
    this.#skipAddress = this.pc & ~1;
    this.#hiddenInline = 0;
    this.#framesCache = null;
  }

  #tick = (): void => {
    if (this.#state !== 'running') {
      return;
    }
    if (this.#pauseRequested) {
      this.#pauseRequested = false;
      this.#stop({ reason: 'pause', address: this.pc });
      return;
    }
    const stop = this.#runOneFrame();
    this.#emitFrame(false);
    if (stop) {
      this.#stop(stop);
    }
  };

  #stop(info: StopInfo): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#framesCache = null;
    this.#stepper = null;
    this.#setState('paused');
    this.#emitFrame(true);
    this.#emit('stopped', info);
  }

  #emitFrame(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.#lastFrameEmit < 33) {
      return;
    }
    this.#lastFrameEmit = now;
    const fb = this.gba.ppu.getFramebuffer();
    // ABGR little-endian words are R,G,B,A bytes in memory order — already RGBA.
    const rgba = new Uint8Array(fb.buffer, fb.byteOffset, fb.byteLength).slice();
    this.#emit('frame', rgba, this.#frame);
  }

  /** Emit the current framebuffer now (e.g. when a screen view opens). */
  requestFrame(): void {
    this.#emitFrame(true);
  }

  #requirePaused(what: string): void {
    if (this.#state !== 'paused') {
      throw new Error(`cannot ${what} while ${this.#state}`);
    }
  }

  continue(): void {
    this.#requirePaused('continue');
    this.#framesCache = null;
    this.#armResume();
    this.#pauseRequested = false;
    this.#setState('running');
    this.#emit('continued');
    this.#timer = setInterval(this.#tick, FRAME_MS);
  }

  pause(): void {
    if (this.#state === 'running') {
      this.#pauseRequested = true;
    }
  }

  /**
   * Run synchronously until `predicate` accepts an instruction (or the budget runs
   * out). The first hook call is the instruction we are sitting on; it is skipped.
   */
  #runUntil(predicate: (address: number) => boolean, reasonIfTimeout: string): void {
    this.#requirePaused('step');
    this.#armResume();
    this.#stepper = predicate;
    this.#emit('continued');
    const started = Date.now();
    let frames = 0;
    for (; frames < MAX_STEP_FRAMES && Date.now() - started < MAX_STEP_MS; frames++) {
      const stop = this.#runOneFrame();
      if (stop) {
        this.#stop(stop);
        return;
      }
    }
    this.#stepper = null;
    this.#emit('output', `${reasonIfTimeout} did not complete within ${frames} frames; stopping anyway\n`, 'console');
    this.#stop({ reason: 'step', address: this.pc });
  }

  stepInstruction(): void {
    this.#runUntil(() => true, 'step instruction');
  }

  /**
   * Step to the start of a different source line, entering calls. Stops only at
   * `is_stmt` row starts (what gdb does); code without line info is run through.
   */
  stepLine(): void {
    this.#requirePaused('step');
    if (this.#hiddenInline > 0) {
      // Stepping "into" an inlined call executes nothing: it reveals the next layer.
      this.#hiddenInline--;
      this.#framesCache = null;
      this.#emit('stopped', { reason: 'step', address: this.pc, description: 'entered inlined call' });
      return;
    }
    const start = this.sources?.lineAt(this.pc) ?? null;
    if (!start || !this.sources) {
      this.stepInstruction();
      return;
    }
    const sources = this.sources;
    this.#runUntil((address) => {
      const row = sources.rowAt(address);
      return !!row && row.isStmt && (row.file !== start.file || row.line !== start.line);
    }, 'step');
  }

  /**
   * Step to the next source line of *this* function, treating calls — real ones
   * (`bl`, detected by the stack and the return address) and inlined ones (the
   * DWARF inline chain) — as single statements. Returning to the caller counts
   * as reaching its next line.
   */
  stepOver(): void {
    const sources = this.sources;
    const start = sources?.lineAt(this.pc) ?? null;
    const cpu = this.gba.armCpu;
    const startSp = cpu.registers[13]!;
    const startMode = cpu.getMode();
    if (!start || !sources) {
      // No line info: step one instruction, but run through a call as a unit.
      const fnRange = this.#functionRange(this.pc);
      this.#runUntil(
        (address) =>
          cpu.getMode() === startMode &&
          cpu.registers[13]! >= startSp &&
          (!fnRange || (address >= fnRange.lo && address < fnRange.hi) || cpu.registers[13]! > startSp),
        'step over',
      );
      return;
    }
    const fullChain = this.#inlineChain(this.pc);
    // The statement we are on is the one the *visible* frame shows: with hidden
    // inlined layers that is the call-site line in the caller.
    const hidden = Math.min(this.#hiddenInline, fullChain?.length ?? 0);
    const visibleChain = fullChain ? fullChain.slice(0, fullChain.length - hidden) : null;
    const enteredHidden = fullChain && hidden > 0 ? fullChain[visibleChain!.length]! : null;
    const visibleFrame = this.callStack()[0];
    const startLine =
      hidden > 0 && visibleFrame?.virtual && 'file' in visibleFrame.virtual.location
        ? { file: visibleFrame.virtual.location.file, line: visibleFrame.virtual.location.line }
        : start;
    this.#stepOverStatements(visibleChain, enteredHidden, startLine, 'step over');
  }

  /**
   * Run to the next statement of the inline layer `visibleChain`, skipping the
   * inlined body `enteredHidden` (already entered) and stopping at the entry of any
   * other inlined call (hiding it). Shared by step-over and step-out-of-inline.
   */
  #stepOverStatements(
    visibleChain: Die[] | null,
    enteredHidden: Die | null,
    startLine: { file: string; line: number },
    label: string,
  ): void {
    const sources = this.sources!;
    const cpu = this.gba.armCpu;
    const startSp = cpu.registers[13]!;
    const startMode = cpu.getMode();
    const fnRange = this.#functionRange(this.pc);
    const inFn = (a: number): boolean => !!fnRange && a >= fnRange.lo && a < fnRange.hi;
    this.#runUntil((address) => {
      // Only statement rows can be stops, so everything else is decided cheaply.
      const row = sources.rowAt(address);
      if (!row || !row.isStmt) {
        return false;
      }
      if (cpu.getMode() !== startMode) {
        return false; // interrupt handler
      }
      const sp = cpu.registers[13]!;
      if (fnRange && !inFn(address)) {
        // Our own prologue/epilogue moves SP inside the function; SP only means
        // "deeper frame" once we are outside it (gdb uses CFA-based frame ids here).
        if (sp < startSp) {
          return false; // inside a callee that has pushed its frame
        }
        const lr = (cpu.registers[14]! & ~1) >>> 0;
        if (sp === startSp && inFn(lr)) {
          return false; // a callee before its prologue (or a leaf that never pushes)
        }
        // Returned to the caller (or tail-called away): stop at its next statement.
        this.#hiddenInline = 0;
        return true;
      }
      if (!fnRange && sp < startSp) {
        return false;
      }
      const sameLine = row.file === startLine.file && row.line === startLine.line;
      if (!visibleChain) {
        return !sameLine;
      }
      const chain = this.#inlineChain(address) ?? [];
      if (isPrefix(chain, visibleChain)) {
        // Back at our own inline depth (or shallower): a new statement of ours.
        if (sameLine) {
          return false;
        }
        this.#hiddenInline = 0;
        return true;
      }
      if (isPrefix(visibleChain, chain)) {
        const entered = chain[visibleChain.length]!;
        if (entered === enteredHidden) {
          return false; // still inside the inlined call we are stepping over
        }
        // The entry of another inlined call: stop and show it as its call-site line.
        this.#hiddenInline = chain.length - visibleChain.length;
        return true;
      }
      return false; // a sibling inline body reached by a jump: not a statement of ours
    }, label);
  }

  #functionRange(pc: number): { lo: number; hi: number } | null {
    const fn = this.debugInfo?.pcToFunction(pc);
    if (fn) {
      return { lo: fn.address, hi: fn.end };
    }
    const die = this.dwarf?.functionAt(pc);
    if (die && this.dwarf) {
      const r = this.dwarf.ranges(die);
      if (r.length) {
        return { lo: r[0]![0], hi: r[r.length - 1]![1] };
      }
    }
    return null;
  }

  /** Inlined-subroutine DIEs containing pc, outermost first; null without DWARF scopes. */
  #inlineChain(pc: number): Die[] | null {
    if (!this.dwarf) {
      return null;
    }
    const fn = this.dwarf.functionAt(pc);
    return fn ? this.dwarf.inlineChain(fn, pc) : [];
  }

  /** Run until the current function returns to its caller (LR-based; a CFI unwinder would be exact). */
  stepOut(): void {
    const cpu = this.gba.armCpu;
    const frames = this.callStack();
    const top = frames[0];
    if (top?.inlined && this.sources) {
      // Leaving an inlined body: it is a step-over from its caller's point of view.
      const fullChain = this.#inlineChain(this.pc) ?? [];
      const depth = Math.max(1, fullChain.length - this.#hiddenInline);
      const visibleChain = fullChain.slice(0, depth - 1);
      const leaving = fullChain[depth - 1] ?? null;
      const callerFrame = frames[1];
      const startLine =
        callerFrame?.virtual && 'file' in callerFrame.virtual.location
          ? { file: callerFrame.virtual.location.file, line: callerFrame.virtual.location.line }
          : (this.sources.lineAt(this.pc) ?? { file: '', line: 0 });
      this.#stepOverStatements(visibleChain, leaving, startLine, 'step out');
      return;
    }
    const caller = frames.find(
      (f) => f.index > 0 && !f.inlined && f.virtual?.physical !== frames[0]?.virtual?.physical,
    );
    const target = caller && !caller.heuristic ? (caller.address & ~1) >>> 0 : (cpu.registers[14]! & ~1) >>> 0;
    const startSp = cpu.registers[13]!;
    const startMode = cpu.getMode();
    this.#runUntil(
      (address) => address === target && cpu.getMode() === startMode && cpu.registers[13]! >= startSp,
      'step out',
    );
  }

  runToAddress(address: number): void {
    const target = (address & ~1) >>> 0;
    this.#runUntil((a) => a === target, `run to 0x${target.toString(16)}`);
  }

  /** Advance exactly one emulated frame (a video frame, not an instruction). */
  stepFrame(): void {
    this.#requirePaused('step frame');
    this.#armResume();
    this.#emit('continued');
    const stop = this.#runOneFrame();
    this.#stop(stop ?? { reason: 'step', address: this.pc, description: 'frame' });
  }

  #lineDiffers(address: number, start: { file: string; line: number }): boolean {
    const here = address < 0x02000000 ? null : this.debugInfo!.pcToSource(address);
    if (!here) {
      return false; // asm glue / BIOS stub — keep going until we are back on a C line
    }
    return here.file !== start.file || here.line !== start.line;
  }

  // ─── rewind ────────────────────────────────────────────────────────

  #pushKeyframe(): void {
    this.#keyframes.push({ frame: this.#frame, snap: this.gba.serialize() });
    this.#dirtySinceKeyframe = false;
    if (this.#keyframes.length > this.#maxKeyframes) {
      this.#keyframes.shift();
    }
  }

  get rewindDepth(): number {
    return this.#keyframes.length;
  }

  /** Go back `keyframes` keyframes (default 1). Returns false when there is no history. */
  rewind(keyframes = 1): boolean {
    this.#requirePaused('rewind');
    if (!this.#dirtySinceKeyframe) {
      this.#keyframes.pop(); // the newest keyframe is the present, not history
    }
    let target: { frame: number; snap: GbaSnapshot } | undefined;
    for (let i = 0; i < keyframes; i++) {
      const k = this.#keyframes.pop();
      if (!k) {
        break;
      }
      target = k;
    }
    if (!target) {
      return false;
    }
    this.gba.deserialize(target.snap);
    this.#frame = target.frame;
    this.#stopRequest = null;
    this.#pendingDataHit = null;
    // The keyframe we landed on stays in the ring, so the next step back goes one further.
    this.#keyframes.push(target);
    this.#dirtySinceKeyframe = false;
    this.#stop({ reason: 'rewind', address: this.pc, description: `rewound to frame ${target.frame}` });
    return true;
  }

  // ─── breakpoints ───────────────────────────────────────────────────

  /**
   * Replace every source breakpoint in `localPath`. Lines without code slide forward
   * to the next line that has some, like gdb.
   */
  setSourceBreakpoints(localPath: string, lines: number[]): SourceBreakpointResult[] {
    const dwarfFile = this.sources?.toDwarf(localPath) ?? null;
    const key = canonical(localPath);
    this.#removeBreakpoints((bp) => bp.kind === 'source' && this.#bpFile.get(bp.id) === key);
    return lines.map((line) => {
      const id = this.#nextBreakpointId++;
      if (!dwarfFile) {
        return {
          id,
          verified: false,
          line,
          message: this.debugInfo ? 'file not found in the ELF line table' : 'no ELF loaded (set "elf" in launch.json)',
        };
      }
      const hit = this.sources!.lineToAddress(dwarfFile, line);
      if (!hit) {
        return { id, verified: false, line, message: 'no code for this line' };
      }
      this.#addBreakpoint({ id, address: hit.address, kind: 'source' });
      this.#bpFile.set(id, key);
      return { id, verified: true, line: hit.line, address: hit.address };
    });
  }

  setInstructionBreakpoints(addresses: number[]): Array<{ id: number; address: number }> {
    this.#removeBreakpoints((bp) => bp.kind === 'instruction');
    return addresses.map((a) => {
      const address = (a & ~1) >>> 0;
      const id = this.#nextBreakpointId++;
      this.#addBreakpoint({ id, address, kind: 'instruction' });
      return { id, address };
    });
  }

  #addBreakpoint(bp: Breakpoint): void {
    const list = this.#breakpoints.get(bp.address) ?? [];
    list.push(bp);
    this.#breakpoints.set(bp.address, list);
  }

  #removeBreakpoints(match: (bp: Breakpoint) => boolean): void {
    for (const [addr, list] of this.#breakpoints) {
      const kept = list.filter((bp) => {
        if (match(bp)) {
          this.#bpFile.delete(bp.id);
          return false;
        }
        return true;
      });
      if (kept.length === 0) {
        this.#breakpoints.delete(addr);
      } else {
        this.#breakpoints.set(addr, kept);
      }
    }
  }

  setDataBreakpoints(specs: Array<{ address: number; length: number; name: string }>): number[] {
    for (const d of this.#dataBreakpoints) {
      d.dispose();
    }
    this.#dataBreakpoints = specs.map((spec) => {
      const id = this.#nextBreakpointId++;
      return this.#armDataBreakpoint(id, spec);
    });
    return this.#dataBreakpoints.map((d) => d.id);
  }

  #armDataBreakpoint(id: number, spec: { address: number; length: number; name: string }): DataBreakpoint {
    {
      const entry: DataBreakpoint = { id, ...spec, dispose: () => {} };
      entry.dispose = this.gba.bus.addWriteWatchpoint(spec.address, spec.length, () => {
        // Fires mid-instruction; the hook turns it into a stop before the next one.
        this.#pendingDataHit = entry;
      });
      return entry;
    }
  }

  // ─── inspection ────────────────────────────────────────────────────

  registers(): Array<{ name: string; value: number }> {
    const cpu = this.gba.armCpu;
    const names = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'sp', 'lr', 'pc'];
    const regs = names.map((name, i) => ({ name, value: cpu.registers[i]! }));
    regs.push({ name: 'cpsr', value: cpu.cpsr >>> 0 });
    return regs;
  }

  cpsrDescription(): string {
    const cpu = this.gba.armCpu;
    const flags = [cpu.getN() ? 'N' : '-', cpu.getZ() ? 'Z' : '-', cpu.getC() ? 'C' : '-', cpu.getV() ? 'V' : '-'].join(
      '',
    );
    const modes: Record<number, string> = {
      0x10: 'usr',
      0x11: 'fiq',
      0x12: 'irq',
      0x13: 'svc',
      0x17: 'abt',
      0x1b: 'und',
      0x1f: 'sys',
    };
    return `${flags} ${cpu.getT() ? 'Thumb' : 'ARM'} ${modes[cpu.getMode()] ?? 'mode?'}${cpu.irqDisabled() ? ' I' : ''}`;
  }

  /** Bytes at `address`; `unreadable` counts trailing bytes outside the memory map. */
  readMemory(address: number, count: number): { data: Uint8Array; unreadable: number } {
    const out = new Uint8Array(count);
    let readable = 0;
    for (let i = 0; i < count; i++) {
      const a = (address + i) >>> 0;
      if (!isMapped(a)) {
        break;
      }
      out[i] = this.gba.bus.read8(a);
      readable++;
    }
    return { data: out.subarray(0, readable), unreadable: count - readable };
  }

  /**
   * Debugger pokes go to the backing arrays, not through the bus: the bus is
   * hardware-faithful (byte writes to OAM are dropped, to VRAM duplicated) and a hex
   * editor expects the byte it typed. MMIO goes through the bus so side effects fire.
   * ROM and BIOS are refused; the count tells the client how far it got.
   */
  writeMemory(address: number, data: Uint8Array): number {
    const bus = this.gba.bus;
    let written = 0;
    for (let i = 0; i < data.length; i++) {
      const a = (address + i) >>> 0;
      const byte = data[i]!;
      switch (a >>> 24) {
        case 0x02:
          bus.ewram[a & 0x3ffff] = byte;
          break;
        case 0x03:
          bus.iwram[a & 0x7fff] = byte;
          break;
        case 0x04:
          bus.write8(a, byte);
          break;
        case 0x05:
          bus.palette[a & 0x3ff] = byte;
          break;
        case 0x06: {
          let off = a & 0x1ffff;
          if (off >= 0x18000) {
            off -= 0x8000; // 0x06018000-0x0601ffff mirrors 0x06010000
          }
          bus.vram[off] = byte;
          break;
        }
        case 0x07:
          bus.oam[a & 0x3ff] = byte;
          break;
        case 0x0e:
          bus.sram[a & 0xffff] = byte;
          break;
        default:
          return written; // BIOS, ROM, unmapped
      }
      written++;
    }
    return written;
  }

  disassemble(address: number, count: number, thumb = this.thumb): DisassembledLine[] {
    const size = thumb ? 2 : 4;
    const lines: DisassembledLine[] = [];
    let addr = (thumb ? address & ~1 : address & ~3) >>> 0;
    let lastLineKey = '';
    for (let i = 0; i < count; i++, addr = (addr + size) >>> 0) {
      if (!isMapped(addr)) {
        lines.push({ address: addr, bytes: '', mnemonic: '<unmapped>' });
        continue;
      }
      const word = thumb ? this.gba.bus.read16(addr) : this.gba.bus.read32(addr);
      const mnemonic = thumb ? disassembleThumb(word, addr) : disassembleArm(word, addr);
      const bytes = thumb
        ? `${hex2(word & 0xff)} ${hex2(word >> 8)}`
        : `${hex2(word & 0xff)} ${hex2((word >> 8) & 0xff)} ${hex2((word >> 16) & 0xff)} ${hex2(word >>> 24)}`;
      const line: DisassembledLine = { address: addr, bytes, mnemonic };
      const sym =
        addr < BIOS_END ? { name: 'bios_stub', offset: addr, exact: true } : this.debugInfo?.addressToSymbol(addr);
      if (sym) {
        line.symbol = sym.offset === 0 ? sym.name : `${sym.name}+0x${sym.offset.toString(16)}`;
      }
      const src = this.sources?.pcToLocal(addr);
      if (src) {
        const key = `${src.path}:${src.line}`;
        if (key !== lastLineKey) {
          line.source = { path: src.path, line: src.line };
          lastLineKey = key;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  readonly #memory: Memory = {
    read: (address, size) => {
      if (size <= 0 || size > 0x10000) {
        return null;
      }
      const { data, unreadable } = this.readMemory(address, size);
      return unreadable > 0 ? null : data;
    },
  };

  /**
   * Call stack. With DWARF CFI every frame is unwound and inlined calls appear as
   * their own rows; without it, frame 0 plus an LR guess (as before).
   */
  callStack(): CallFrame[] {
    if (this.#framesCache) {
      return this.#framesCache;
    }
    const cpu = this.gba.armCpu;
    const frames: CallFrame[] = [];
    if (this.dwarf && this.debugInfo && this.sources) {
      // Unwind only into code we can name: past main sits crt0, whose return address
      // resolves to a far-away symbol by gap inference and is not a frame worth showing.
      const isCode = (a: number): boolean => {
        if (!isMapped(a) || a < 0x02000000) {
          return false;
        }
        if (this.dwarf!.functionAt(a)) {
          return true;
        }
        const fn = this.debugInfo!.pcToFunction(a);
        return !!fn && (fn.exact || a - fn.address < 0x1000);
      };
      const physical = this.dwarf.physicalFrames(this.pc, cpu.registers, this.#memory, isCode);
      let virtual = this.dwarf.virtualFrames(physical, this.debugInfo.lines.rows, (pc) => this.#symbolName(pc));
      if (this.#hiddenInline > 0) {
        let drop = 0;
        while (drop < this.#hiddenInline && virtual[drop]?.inlined && virtual[drop]?.physical === physical[0]) {
          drop++;
        }
        virtual = virtual.slice(drop);
      }
      virtual.forEach((vf, i) => {
        let source: CallFrame['source'];
        if ('pc' in vf.location) {
          const src = this.sources!.pcToLocal(vf.physical.lookupPc);
          source = src ? { path: src.path, line: src.line } : undefined;
        } else {
          const local = this.sources!.toLocal(vf.location.file);
          source = local ? { path: local, line: vf.location.line } : undefined;
        }
        frames.push({
          index: i,
          address: vf.physical.pc,
          name: vf.inlined ? `${vf.name} (inlined)` : vf.name,
          source,
          heuristic: !vf.physical.exact,
          inlined: vf.inlined,
          virtual: vf,
        });
      });
    } else {
      frames.push(this.#frameAt(0, this.pc, false));
      const lr = (cpu.registers[14]! & ~1) >>> 0;
      if (lr !== this.pc && this.debugInfo?.pcToFunction(lr)) {
        const f = this.#frameAt(1, lr, true);
        f.name += ' (from lr, unverified)';
        frames.push(f);
      }
    }
    this.#framesCache = frames;
    return frames;
  }

  #symbolName(address: number): string {
    if (address < BIOS_END) {
      return `<BIOS IRQ/SWI stub +0x${address.toString(16)}>`;
    }
    const fn = this.debugInfo?.pcToFunction(address);
    const sym = fn ? null : this.debugInfo?.addressToSymbol(address);
    return fn?.name ?? (sym ? `${sym.name}+0x${sym.offset.toString(16)}` : `0x${hex8(address)}`);
  }

  #frameAt(index: number, address: number, heuristic: boolean): CallFrame {
    const src = this.sources?.pcToLocal(address);
    return {
      index,
      address,
      name: this.#symbolName(address),
      heuristic,
      inlined: false,
      source: src ? { path: src.path, line: src.line } : undefined,
    };
  }

  /** Locals, file globals and registers of a call-stack row. */
  scopes(frameIndex: number): FrameScopes {
    const frame = this.callStack()[frameIndex];
    const cpu = this.gba.armCpu;
    const regNames = [
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
      'r6',
      'r7',
      'r8',
      'r9',
      'r10',
      'r11',
      'r12',
      'sp',
      'lr',
      'pc',
    ];
    if (!frame?.virtual || !this.dwarf) {
      return { locals: [], globals: [], registers: regNames.map((name, i) => ({ name, value: cpu.registers[i] })) };
    }
    const vf = frame.virtual;
    const dwarf = this.dwarf;
    const locals: VarNode[] = [];
    if (vf.scope) {
      for (const v of dwarf.scopeVariables(vf.scope, vf.physical.lookupPc)) {
        locals.push(dwarf.variableNode(v, vf.physical, this.#memory));
      }
    }
    const unit = vf.scope ? vf.scope.unit : dwarf.unitContaining(vf.physical.lookupPc);
    const globals: VarNode[] = unit
      ? dwarf.globals(unit).map((g) => dwarf.variableNode(g, vf.physical, this.#memory))
      : [];
    globals.sort((a, b) => a.name.localeCompare(b.name));
    return { locals, globals, registers: regNames.map((name, i) => ({ name, value: vf.physical.regs[i] })) };
  }

  /** A local or file-global by name in the frame's scope chain (innermost inlined layer outward). */
  variableInFrame(name: string, frameIndex: number): VarNode | null {
    const frames = this.callStack();
    const frame = frames[frameIndex];
    if (!frame?.virtual || !this.dwarf) {
      return null;
    }
    const physical = frame.virtual.physical;
    for (let i = frameIndex; i < frames.length; i++) {
      const vf = frames[i]!.virtual;
      if (!vf || vf.physical !== physical) {
        break;
      }
      if (vf.scope) {
        for (const v of this.dwarf.scopeVariables(vf.scope, physical.lookupPc)) {
          if (this.dwarf.name(v) === name) {
            return this.dwarf.variableNode(v, physical, this.#memory);
          }
        }
      }
    }
    const unit = frame.virtual.scope?.unit ?? this.dwarf.unitContaining(physical.lookupPc);
    const g = unit ? this.dwarf.globals(unit).find((d) => this.dwarf!.name(d) === name) : undefined;
    return g ? this.dwarf.variableNode(g, physical, this.#memory) : null;
  }

  /** Write a scalar back. `text` is decimal, hex, true/false or a single quoted char. */
  setScalar(target: { address: number; size: number }, text: string): void {
    const t = text.trim();
    let v: number;
    if (t === 'true') {
      v = 1;
    } else if (t === 'false') {
      v = 0;
    } else if (/^'.'$/.test(t)) {
      v = t.charCodeAt(1);
    } else if (/^-?(0x[0-9a-f]+|\d+)$/i.test(t)) {
      v = Number(t);
    } else {
      throw new Error(`cannot parse '${text}' as a number`);
    }
    const bytes = new Uint8Array(target.size);
    for (let i = 0; i < target.size; i++) {
      bytes[i] = (v >>> (i * 8)) & 0xff;
    }
    if (this.writeMemory(target.address, bytes) !== target.size) {
      throw new Error(`address 0x${hex8(target.address)} is not writable`);
    }
  }

  /**
   * Evaluate a watch/hover expression without JavaScript: a register, a hex address,
   * or a `symbol.field[3]` path resolved through DWARF (`readVariable`). Returns null
   * when the expression is none of those, so the caller can fall back to the REPL.
   */
  evaluateSimple(
    expression: string,
    frameIndex = 0,
  ): { value: string; address?: number; type?: string; node?: VarNode } | null {
    const expr = expression.trim();
    const fromNode = (node: VarNode): { value: string; address?: number; type?: string; node: VarNode } => ({
      value: node.value,
      address: node.address,
      type: node.type,
      node,
    });
    // 1. A local, parameter or file global of the selected frame.
    if (/^[A-Za-z_]\w*$/.test(expr)) {
      const node = this.variableInFrame(expr, frameIndex);
      if (node) {
        return fromNode(node);
      }
    }
    // 2. A cast: `(Card*)0x0300243c`, `(struct PlayerState)gUnk_03005220`, `(u16)0x04000006`.
    const cast = /^\(\s*((?:struct|union|enum)\s+)?([A-Za-z_]\w*)\s*(\*?)\s*\)\s*(.+)$/.exec(expr);
    if (cast && this.dwarf) {
      const typeDie = this.dwarf.typeByName(`${cast[1] ?? ''}${cast[2]}`);
      const target = this.#addressOf(cast[4]!.trim());
      if (typeDie && target !== null) {
        return fromNode(this.dwarf.castNode(expr, typeDie, target, this.#memory));
      }
      if (!typeDie) {
        return { value: `unknown type '${cast[1] ?? ''}${cast[2]}' (the ELF has no DWARF for it)` };
      }
    }
    // 3. A DWARF-typed global from any compilation unit: unfolds as its struct. A
    //    declaration without storage (decomp: `extern` in a header, storage in asm)
    //    gets its address from the symbol table and its shape from the declaration.
    if (/^[A-Za-z_]\w*$/.test(expr) && this.dwarf) {
      const die = this.dwarf.globalByName(expr);
      if (die) {
        return fromNode(
          this.dwarf.variableNode(die, this.dwarf.liveFrame(this.pc, this.gba.armCpu.registers), this.#memory),
        );
      }
      const decl = this.dwarf.declarationByName(expr);
      const address = this.#symbolAddress(expr);
      const typeDie = decl ? this.dwarf.index.typeOf(decl) : undefined;
      if (decl && typeDie && address !== null) {
        const node = this.dwarf.castNode(expr, typeDie, address, this.#memory);
        node.type = `${node.type} (declared in a header, placed by the linker)`;
        return fromNode(node);
      }
    }
    // 4. Registers.
    const reg = this.registers().find((r) => r.name === expr.toLowerCase());
    if (reg) {
      const extra = reg.name === 'cpsr' ? ` (${this.cpsrDescription()})` : '';
      return {
        value: `0x${hex8(reg.value)}${extra}`,
        address: isMapped(reg.value) ? reg.value : undefined,
        type: 'u32',
      };
    }
    // 5. A bare address: the word there, unfoldable as raw memory.
    const num = /^(0x[0-9a-f]+|\d+)$/i.exec(expr);
    if (num) {
      const address = Number(expr) >>> 0;
      if (!isMapped(address)) {
        return { value: `0x${hex8(address)} (unmapped)` };
      }
      return fromNode(this.#rawNode(expr, address, 64, `0x${hex8(address)}`));
    }
    // 6. `symbol.field[3]` paths through gba-kit's own resolver (bitfields decoded).
    if (/^[A-Za-z_]\w*(\.\w+|\[\d+\])+$/.test(expr) && this.debugInfo) {
      try {
        const v = this.engine.readVariable(expr);
        const loc = this.debugInfo.resolveVariable(expr);
        return {
          value: `${v} (0x${v.toString(16)})`,
          address: loc?.address,
          type: loc ? `${loc.size}-byte${loc.bitWidth ? ` bitfield:${loc.bitWidth}` : ''}` : undefined,
        };
      } catch (err) {
        return { value: `cannot resolve: ${(err as Error).message}` };
      }
    }
    // 7. A symbol the ELF names but does not type (a decomp's `gUnk_*`): raw memory.
    if (/^[A-Za-z_]\w*$/.test(expr) && this.debugInfo) {
      const address = this.#symbolAddress(expr);
      if (address !== null) {
        const extent =
          this.debugInfo.symbolExtent(expr) ??
          (() => {
            const raw = this.linkerSymbols?.definedGlobal(expr);
            return raw && raw.size > 0 ? { size: raw.size, source: 'st_size' as const } : null;
          })();
        const size = extent?.size ?? 4;
        return fromNode(
          this.#rawNode(
            expr,
            address,
            size,
            `${expr} @ 0x${hex8(address)} (${size} bytes${extent ? `, ${extent.source}` : ''}, no DWARF type — try (StructName*)${expr})`,
          ),
        );
      }
    }
    return null;
  }

  /** The address an expression names: a hex number, a symbol, or `&symbol`. */
  #addressOf(text: string): number | null {
    const t = text.replace(/^&/, '').trim();
    if (/^(0x[0-9a-f]+|\d+)$/i.test(t)) {
      return Number(t) >>> 0;
    }
    const reg = this.registers().find((r) => r.name === t.toLowerCase());
    if (reg) {
      return reg.value >>> 0;
    }
    return this.#symbolAddress(t);
  }

  /**
   * A global's address: the library's index first (FUNC/OBJECT and ABS linker
   * globals), then the raw symbol table for section-placed linker globals, with the
   * binding rules that keep a file-static from impersonating an extern.
   */
  #symbolAddress(name: string): number | null {
    const known = this.debugInfo?.symbolToAddress(name);
    if (known !== null && known !== undefined) {
      return known;
    }
    return this.linkerSymbols?.definedGlobal(name)?.address ?? null;
  }

  /**
   * Untyped memory as a tree: 32-bit words at their offsets (a decomp researcher's
   * first read: pointers and counters), then halfwords and a byte dump.
   */
  #rawNode(name: string, address: number, size: number, summary: string): VarNode {
    const read = (): Uint8Array => this.readMemory(address, size).data;
    const word = (d: Uint8Array, off: number, width: number): number => {
      let v = 0;
      for (let i = width - 1; i >= 0; i--) {
        v = v * 256 + (d[off + i] ?? 0);
      }
      return v >>> 0;
    };
    const views = (width: number, label: string): VarNode => ({
      name: label,
      value: `${Math.floor(size / width)} × ${width * 8}-bit`,
      type: `u${width * 8}[${Math.floor(size / width)}]`,
      address,
      children: () => {
        const d = read();
        const out: VarNode[] = [];
        for (let off = 0; off + width <= d.length && out.length < 512; off += width) {
          const v = word(d, off, width);
          out.push({
            name: `+0x${off.toString(16).padStart(2, '0')}`,
            value: `0x${v.toString(16).padStart(width * 2, '0')} (${v})`,
            type: `u${width * 8}`,
            address: address + off,
            writable: { address: address + off, size: width, kind: 'uint' },
          });
        }
        return out;
      },
    });
    return {
      name,
      value: summary,
      type: 'untyped memory',
      address,
      children: () => {
        const d = read();
        const words: VarNode[] = [];
        for (let off = 0; off + 4 <= d.length && words.length < 256; off += 4) {
          const v = word(d, off, 4);
          const sym = isMapped(v) && v >= 0x02000000 ? this.debugInfo?.addressToSymbol(v) : null;
          words.push({
            name: `+0x${off.toString(16).padStart(2, '0')}`,
            value: `0x${hex8(v)} (${v})${sym && sym.offset < 0x1000 ? `  → ${sym.name}${sym.offset ? `+0x${sym.offset.toString(16)}` : ''}` : ''}`,
            type: 'u32',
            address: address + off,
            writable: { address: address + off, size: 4, kind: 'uint' },
          });
        }
        const bytes: VarNode = {
          name: 'bytes',
          value: `${d.length} bytes`,
          type: `u8[${d.length}]`,
          address,
          children: () => {
            const rows: VarNode[] = [];
            for (let off = 0; off < d.length; off += 16) {
              const slice = Array.from(d.subarray(off, off + 16));
              rows.push({
                name: `+0x${off.toString(16).padStart(2, '0')}`,
                value: slice.map((b) => b.toString(16).padStart(2, '0')).join(' '),
                type: 'u8[16]',
                address: address + off,
              });
            }
            return rows;
          },
        };
        return [...words, views(2, 'halfwords'), views(1, 'bytes as u8'), bytes];
      },
    };
  }

  // ─── input ─────────────────────────────────────────────────────────

  setButton(bit: number, down: boolean): void {
    if (bit < 0 || bit > 9) {
      return;
    }
    if (down) {
      this.#heldButtons.add(bit);
      this.gba.input.press(bit as GbaButton);
    } else {
      this.#heldButtons.delete(bit);
      this.gba.input.release(bit as GbaButton);
    }
    this.#recorder.onButton(bit, down);
  }

  // ─── scripts ───────────────────────────────────────────────────────

  /**
   * Run a script in gba-kit's sandboxed dialect. Breakpoints are suspended while it
   * runs: the engine loops frames synchronously and cannot yield to a stop. Making it
   * yield is a planned change to `ScriptingEngine`, not to this layer.
   */
  async runScript(code: string, name = '<script>', options: { quiet?: boolean } = {}): Promise<void> {
    this.#requirePaused('run a script');
    // Suspend every kind of breakpoint: a 'break' inside the engine's frame loop
    // truncates that frame and the engine still counts it as a whole one.
    const savedBreakpoints = this.#breakpoints;
    const savedData = this.#dataBreakpoints.map((d) => ({
      id: d.id,
      address: d.address,
      length: d.length,
      name: d.name,
    }));
    for (const d of this.#dataBreakpoints) {
      d.dispose();
    }
    this.#dataBreakpoints = [];
    this.#breakpoints = new Map();
    this.#stopRequest = null;
    this.#pendingDataHit = null;
    const frameAtStart = this.#frame;
    this.#setState('scripting');
    if (!options.quiet) {
      this.#emit('continued');
    }
    const frameTicker = setInterval(() => this.#emitFrame(false), 100);
    // Frames a script runs still count and still produce rewind keyframes. A script
    // that installs its own onFrame() replaces this — a limitation of the PoC.
    this.engine.onFrame(() => this.#syncFrames());
    try {
      await this.#runtime.executeScript(code, name);
      if (!options.quiet) {
        this.#emit('output', `script ${name} finished at frame ${this.#frame}\n`, 'console');
      }
    } catch (err) {
      this.#emit('output', `script ${name} failed: ${(err as Error).message}\n`, 'stderr');
      if (options.quiet) {
        throw err;
      }
    } finally {
      clearInterval(frameTicker);
      this.engine.onFrame(null);
      this.#syncFrames();
      this.#breakpoints = savedBreakpoints;
      this.#dataBreakpoints = savedData.map((spec) => this.#armDataBreakpoint(spec.id, spec));
      this.#setState('paused');
      const advanced = this.#frame !== frameAtStart;
      if (advanced || !options.quiet) {
        this.#emitFrame(true);
        this.#emit('stopped', { reason: 'script', address: this.pc, description: `script ${name} ended` });
      }
    }
  }

  get recording(): boolean {
    return this.#recorder.recording;
  }

  startRecording(): void {
    this.#recorder.start(this.#heldButtons);
  }

  stopRecording(): string {
    return serializeToScript(this.#recorder.stop());
  }

  async saveState(filePath: string): Promise<void> {
    const { serializeSnapshot } = await import('@gba-kit/gba-node');
    await fsp.writeFile(filePath, JSON.stringify(serializeSnapshot(this.gba.serialize())));
  }

  dispose(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
    }
    for (const d of this.#dataBreakpoints) {
      d.dispose();
    }
    this.gba.armCpu.setDebugHooks(undefined);
    this.#handlers = [];
  }

  get options(): DebugCoreOptions {
    return this.#options;
  }

  static romExists(p: string): boolean {
    return fs.existsSync(p);
  }
}

function isPrefix<T>(prefix: T[], full: T[]): boolean {
  if (prefix.length > full.length) {
    return false;
  }
  return prefix.every((p, i) => p === full[i]);
}

export function isMapped(address: number): boolean {
  const region = address >>> 24;
  if (region === 0x00) {
    return address < BIOS_END; // the HLE BIOS stub the IRQ/SWI path really executes
  }
  switch (region) {
    case 0x02:
    case 0x03:
    case 0x04:
    case 0x05:
    case 0x06:
    case 0x07:
    case 0x08:
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x0e:
      return true;
    default:
      return false;
  }
}

export function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

function hex2(n: number): string {
  return (n & 0xff).toString(16).padStart(2, '0');
}

function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}
