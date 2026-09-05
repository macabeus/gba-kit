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
  type DataAccess,
  EVENT_BREAKPOINT_KINDS,
  type EventBreakpointKind,
  type InputRecording,
  REGISTER_NAMES,
  type Scope,
  Session,
  type StopInfo,
  type VarNode,
  hex8,
  regionOf,
} from '@gba-kit/debug-core';
import { createNodeHost, fileExists } from '@gba-kit/debug-core/node';
import { DebugSession, Event, Handles, InitializedEvent, OutputEvent, TerminatedEvent } from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { GbaKitCommand, GbaKitRequests, PpuArguments, PpuBody, SavedStateInfo, StateBody } from './protocol.js';
import { FrameStream } from './stream.js';

export interface LaunchArguments extends DebugProtocol.LaunchRequestArguments {
  /** the `.gba` ROM */
  rom: string;
  /** the ELF the ROM was made from, built with `-g`; defaults to the ROM's sibling `.elf` when one exists (null: none) */
  elf?: string | null;
  /** the project root relative DWARF paths resolve against (default: the ROM's directory) */
  cwd?: string;
  /** where `.gba-kit/` lives: labels and save states (default: `cwd`) */
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
  /** the machine revision and epoch the values belong to; older handles are stale */
  revision: number;
  epoch: number;
  scope?: Scope['kind'];
  /** expression naming the container, when its children can be named (`g_player.pos`) */
  prefix: string | null;
  expand: () => VarNode[];
  nodes: VarNode[] | null;
}

const THREAD_ID = 1;
const AUDIO_SAMPLE_RATE = 32768;
const CONFIGURATION_TIMEOUT_MS = 5000;
const ERR = {
  launch: 1000,
  noSession: 1001,
  state: 1002,
  evaluate: 1003,
  unknownRequest: 1004,
  request: 1005,
  setVariable: 1007,
  stale: 1008,
} as const;

/** A stop reason the protocol names, or one of ours (clients show `description`). */
function dapReason(info: StopInfo): string {
  return info.reason;
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_]\w*$/.test(name);
}

/** `parent.child`, `parent[3]`; null when the child cannot be named in the expression grammar. */
function childExpression(prefix: string | null, name: string): string | null {
  if (prefix === null) {
    return null;
  }
  if (name.startsWith('[')) {
    return prefix + name;
  }
  if (isIdentifier(name)) {
    return `${prefix}.${name}`;
  }
  return null;
}

function parseAddress(reference: string, offset = 0): number {
  const base = reference.startsWith('0x') || reference.startsWith('0X') ? parseInt(reference, 16) : Number(reference);
  if (!Number.isFinite(base)) {
    throw new Error(`not an address: ${reference}`);
  }
  return (base + offset) >>> 0;
}

/** r0–r15 by name; -1 for anything else (cpsr is not written directly). */
function registerIndex(name: string): number {
  const i = (REGISTER_NAMES as readonly string[]).indexOf(name);
  return i >= 0 && i <= 15 ? i : -1;
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'state';
}

export class GbaDebugSession extends DebugSession {
  #session: Session | null = null;
  #sessionReady: Array<(session: Session) => void> = [];
  #configurationDone: (() => void) | null = null;
  #stopOnEntry = true;
  readonly #handles = new Handles<HandleTarget>();
  readonly #stream = new FrameStream();
  #audioOff: (() => void) | null = null;
  /** while set, session events queue here so a response can go out first */
  #deferred: DebugProtocol.Event[] | null = null;

  constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  /** The core session, once `launch` has created it (for an in-process host that wants the frames directly). */
  get session(): Session | null {
    return this.#session;
  }

  onSession(cb: (session: Session) => void): void {
    if (this.#session) {
      cb(this.#session);
    } else {
      this.#sessionReady.push(cb);
    }
  }

  // ─── lifecycle ─────────────────────────────────────────────────────

  protected override initializeRequest(response: DebugProtocol.InitializeResponse): void {
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
    try {
      const session = await this.#createSession(args);
      this.#session = session;
      this.#stopOnEntry = args.stopOnEntry ?? true;
      this.#wire(session);
      for (const cb of this.#sessionReady) {
        cb(session);
      }
      this.#sessionReady = [];

      // Breakpoints arrive between `initialized` and `configurationDone`; the session
      // exists now, so they apply directly. The launch response waits for them, so
      // the first run already honors them.
      this.sendEvent(new InitializedEvent());
      await new Promise<void>((resolve) => {
        this.#configurationDone = resolve;
        setTimeout(resolve, CONFIGURATION_TIMEOUT_MS);
      });
      this.#configurationDone = null;

      this.sendResponse(response);
      if (this.#stopOnEntry) {
        this.#sendStopped({ reason: 'entry', address: session.pc, description: 'at the entry point' });
        session.requestFrame();
      } else {
        session.continue();
      }
    } catch (err) {
      this.sendErrorResponse(response, ERR.launch, `gba-kit: ${(err as Error).message}`);
    }
  }

  async #createSession(args: LaunchArguments): Promise<Session> {
    if (!args.rom) {
      throw new Error('"rom" is required in the launch configuration');
    }
    if (!fileExists(args.rom)) {
      throw new Error(`ROM not found: ${args.rom}`);
    }
    const cwd = args.cwd ?? path.dirname(args.rom);
    let elfPath: string | undefined;
    if (args.elf === null) {
      elfPath = undefined; // explicitly none
    } else if (args.elf) {
      elfPath = args.elf;
      if (!fileExists(elfPath)) {
        throw new Error(`ELF not found: ${elfPath}`);
      }
    } else {
      const sibling = args.rom.replace(/\.gba$/i, '') + '.elf';
      if (fileExists(sibling)) {
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
    return session;
  }

  #wire(session: Session): void {
    session.on({
      stopped: (info) => this.#sendStopped(info),
      continued: () => {
        this.#handles.reset();
        this.#emit(new Event('continued', { threadId: THREAD_ID, allThreadsContinued: true }));
        this.#emit(new Event('gba-kit/state', this.#stateBody()));
      },
      output: (text, category) => this.#emit(new OutputEvent(text, category === 'log' ? 'console' : category)),
      frame: (rgba, frame) => this.#stream.sendFrame(rgba, frame),
    });
  }

  #sendStopped(info: StopInfo): void {
    this.#handles.reset();
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
      epoch: s.epoch,
      history: s.historyInfo(),
      recording: s.recording,
      tracing: s.tracing,
    };
  }

  #require(): Session {
    if (!this.#session) {
      throw new Error('no emulator session');
    }
    return this.#session;
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
      try {
        if (session.labels.dirty) {
          await session.saveLabels();
        }
      } catch (err) {
        this.#log(`gba-kit: could not save labels: ${(err as Error).message}\n`, 'stderr');
      }
      session.dispose();
    }
  }

  protected override restartRequest(response: DebugProtocol.RestartResponse): void {
    this.#exec(response, (s) => {
      s.restart();
      if (!this.#stopOnEntry) {
        setImmediate(() => s.state === 'stopped' && s.continue());
      }
    });
  }

  // ─── execution control ─────────────────────────────────────────────

  /**
   * Run an action that moves the machine. The events it raises (`continued`, a
   * synchronous step's `stopped`) are held until the response has gone out: the
   * protocol, and VS Code's bookkeeping, expect response → stopped.
   */
  #exec(response: DebugProtocol.Response, action: (session: Session) => void, requireStopped = true): void {
    const session = this.#session;
    if (!session) {
      this.sendErrorResponse(response, ERR.noSession, 'no emulator session');
      return;
    }
    if (requireStopped && session.state !== 'stopped') {
      this.sendErrorResponse(response, ERR.state, `cannot ${response.command} while the machine is ${session.state}`);
      return;
    }
    this.#deferred = [];
    try {
      action(session);
    } catch (err) {
      this.#deferred = null;
      this.sendErrorResponse(response, ERR.request, `${response.command}: ${(err as Error).message}`);
      return;
    }
    const events = this.#deferred;
    this.#deferred = null;
    this.sendResponse(response);
    for (const e of events) {
      this.sendEvent(e);
    }
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
      const all = s.callStack();
      const start = args.startFrame ?? 0;
      const frames = (args.levels ? all.slice(start, start + args.levels) : all.slice(start)).map(
        (f): DebugProtocol.StackFrame => ({
          id: f.index,
          name: f.name,
          source: f.source ? this.#source(f.source.path) : undefined,
          line: f.source?.line ?? 0,
          column: f.source ? 1 : 0,
          instructionPointerReference: `0x${hex8(f.address)}`,
          presentationHint: f.heuristic ? 'subtle' : 'normal',
        }),
      );
      response.body = { stackFrames: frames, totalFrames: all.length };
    });
  }

  protected override scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    this.#inspect(response, (s) => {
      response.body = {
        scopes: s.scopes(args.frameId).map(
          (scope): DebugProtocol.Scope => ({
            name: scope.name,
            presentationHint: scope.kind === 'locals' ? 'locals' : scope.kind === 'registers' ? 'registers' : undefined,
            variablesReference: this.#handle(s, { scope: scope.kind, prefix: '', expand: () => scope.nodes }),
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

  /** The nodes behind a reference, refusing one from before the machine last moved. */
  #resolveHandle(session: Session, reference: number): HandleTarget {
    const target = this.#handles.get(reference);
    if (!target || target.revision !== session.revision || target.epoch !== session.epoch) {
      throw new Error('stale variables reference: the machine has moved on; expand again');
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
        ? this.#handle(session, { scope: target.scope, prefix: expression, expand: node.children })
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
      let nodes = target.nodes!;
      if (args.filter === 'indexed' || args.start !== undefined || args.count !== undefined) {
        nodes = nodes.slice(args.start ?? 0, args.count !== undefined ? (args.start ?? 0) + args.count : undefined);
      }
      response.body = { variables: nodes.map((n) => this.#variable(s, n, target)) };
    });
  }

  protected override setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments,
  ): void {
    this.#inspect(response, (s) => {
      const target = this.#resolveHandle(s, args.variablesReference);
      const node = target.nodes!.find((n) => n.name === args.name);
      if (!node) {
        throw new Error(`no variable '${args.name}' here`);
      }
      if (node.writable) {
        const value = s.setVariable(node, args.value);
        response.body = { value, type: node.type, variablesReference: 0 };
        return;
      }
      const index = target.scope === 'registers' ? registerIndex(node.name) : -1;
      if (index < 0) {
        throw new Error(`'${args.name}' is not writable`);
      }
      s.setRegister(index, this.#number(s, args.value));
      response.body = { value: `0x${hex8(s.machine.registers[index]!)}`, type: 'u32', variablesReference: 0 };
      this.#emit(new Event('gba-kit/state', this.#stateBody()));
    });
  }

  /** A number from the user: a literal, or any expression the grammar evaluates. */
  #number(session: Session, text: string): number {
    const t = text.trim();
    if (/^-?(0x[0-9a-f]+|\d+)$/i.test(t)) {
      return Number(t) >>> 0;
    }
    const value = session.evaluate(t).node.value;
    const m = /^-?\d+/.exec(value);
    if (!m) {
      throw new Error(`'${text}' is not a number`);
    }
    return Number(m[0]) >>> 0;
  }

  /** Answer an inspection request; errors become error responses, never a dead client. */
  #inspect<R extends DebugProtocol.Response>(response: R, fill: (session: Session) => void): void {
    const session = this.#session;
    if (!session) {
      this.sendErrorResponse(response, ERR.noSession, 'no emulator session');
      return;
    }
    try {
      fill(session);
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, ERR.request, (err as Error).message);
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
      const localPath = args.source.path ?? '';
      const specs = (args.breakpoints ?? []).map((b) => ({
        line: b.line,
        condition: b.condition,
        hitCondition: b.hitCondition,
        logMessage: b.logMessage,
      }));
      const results = s.setSourceBreakpoints(localPath, specs);
      response.body = {
        breakpoints: results.map((bp, i) => ({
          id: bp.id,
          verified: bp.verified,
          message: bp.message,
          line: bp.line ?? specs[i]!.line,
          source: args.source,
          instructionReference: bp.addresses[0] !== undefined ? `0x${hex8(bp.addresses[0])}` : undefined,
        })),
      };
    });
  }

  protected override setFunctionBreakPointsRequest(
    response: DebugProtocol.SetFunctionBreakpointsResponse,
    args: DebugProtocol.SetFunctionBreakpointsArguments,
  ): void {
    this.#inspect(response, (s) => {
      const results = s.setFunctionBreakpoints(
        args.breakpoints.map((b) => ({ functionName: b.name, condition: b.condition, hitCondition: b.hitCondition })),
      );
      response.body = {
        breakpoints: results.map((bp) => ({
          id: bp.id,
          verified: bp.verified,
          message: bp.message,
          instructionReference: bp.addresses[0] !== undefined ? `0x${hex8(bp.addresses[0])}` : undefined,
        })),
      };
    });
  }

  protected override setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments,
  ): void {
    this.#inspect(response, (s) => {
      const results = s.setInstructionBreakpoints(
        args.breakpoints.map((b) => ({
          address: parseAddress(b.instructionReference, b.offset),
          condition: b.condition,
          hitCondition: b.hitCondition,
        })),
      );
      response.body = {
        breakpoints: results.map((bp) => ({
          id: bp.id,
          verified: bp.verified,
          message: bp.message,
          instructionReference: bp.addresses[0] !== undefined ? `0x${hex8(bp.addresses[0])}` : undefined,
        })),
      };
    });
  }

  protected override setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments,
  ): void {
    this.#inspect(response, (s) => {
      const known = new Set<string>(EVENT_BREAKPOINT_KINDS.map((k) => k.kind));
      const kinds = args.filters.filter((f): f is EventBreakpointKind => known.has(f));
      s.setEventBreakpoints(kinds);
      response.body = {
        breakpoints: args.filters.map((f) => ({
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
      const localPath = args.source.path ?? '';
      const breakpoints: DebugProtocol.BreakpointLocation[] = [];
      for (let line = args.line; line <= (args.endLine ?? args.line); line++) {
        if (s.program.hasCodeAt(localPath, line)) {
          breakpoints.push({ line });
        }
      }
      response.body = { breakpoints };
    });
  }

  protected override dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments,
  ): void {
    this.#inspect(response, (s) => {
      let name = args.name.trim();
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
      }
      const target = s.dataBreakpointTarget(name);
      if (!target) {
        response.body = {
          dataId: null,
          description: `cannot watch '${name}': not a variable, symbol, label or address`,
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
      const specs = args.breakpoints.map((b) => {
        const [address, length, ...rest] = b.dataId.split(':');
        return {
          address: Number(address),
          length: Number(length),
          name: rest.join(':'),
          access: (b.accessType ?? 'write') as DataAccess,
          condition: b.condition,
          hitCondition: b.hitCondition,
        };
      });
      const results = s.setDataBreakpoints(specs);
      response.body = { breakpoints: results.map((bp) => ({ id: bp.id, verified: true })) };
    });
  }

  // ─── evaluate, disassemble, memory, sources ────────────────────────

  protected override evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): void {
    const session = this.#session;
    if (!session) {
      this.sendErrorResponse(response, ERR.noSession, 'no emulator session');
      return;
    }
    try {
      const { node, address } = session.evaluate(args.expression, args.frameId ?? 0);
      const prefix =
        isIdentifier(args.expression.trim()) || /^[A-Za-z_][\w.[\]]*$/.test(args.expression.trim())
          ? args.expression.trim()
          : null;
      response.body = {
        result: node.value,
        type: node.type,
        variablesReference: node.children ? this.#handle(session, { prefix, expand: node.children }) : 0,
        memoryReference: address !== undefined ? `0x${hex8(address)}` : undefined,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, ERR.evaluate, (err as Error).message);
    }
  }

  protected override disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments,
  ): void {
    this.#inspect(response, (s) => {
      const base = parseAddress(args.memoryReference, args.offset);
      // The instruction set at the base decides how far an instruction offset reaches.
      const mode = s.program.modeAt(base) ?? (base === s.pc ? (s.machine.thumb ? 'thumb' : 'arm') : 'thumb');
      const size = mode === 'arm' ? 4 : 2;
      const start = (base + (args.instructionOffset ?? 0) * size) >>> 0;
      const lines = s.disassemble(start, args.instructionCount);
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
      const { data, readable } = s.readMemory(address, args.count);
      response.body = {
        address: `0x${hex8(address)}`,
        data: Buffer.from(data.subarray(0, readable)).toString('base64'),
        unreadableBytes: args.count - readable,
      };
    });
  }

  protected override writeMemoryRequest(
    response: DebugProtocol.WriteMemoryResponse,
    args: DebugProtocol.WriteMemoryArguments,
  ): void {
    this.#inspect(response, (s) => {
      const address = parseAddress(args.memoryReference, args.offset);
      const bytes = new Uint8Array(Buffer.from(args.data, 'base64'));
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
      this.sendErrorResponse(response, ERR.noSession, 'no emulator session');
      return;
    }
    try {
      const body = await this.#custom(session, command as GbaKitCommand, (args ?? {}) as never, response);
      if (body !== SENT) {
        response.body = body;
        this.sendResponse(response);
      }
    } catch (err) {
      this.sendErrorResponse(response, ERR.request, `${command}: ${(err as Error).message}`);
    }
  }

  async #custom<C extends GbaKitCommand>(
    s: Session,
    command: C,
    args: NonNullable<GbaKitRequests[C]['args']>,
    response: DebugProtocol.Response,
  ): Promise<GbaKitRequests[C]['body'] | typeof SENT> {
    type Args<K extends GbaKitCommand> = NonNullable<GbaKitRequests[K]['args']>;
    switch (command) {
      case 'gba-kit/state':
        return this.#stateBody();
      case 'gba-kit/input': {
        const a = args as Args<'gba-kit/input'>;
        s.setButton(Number(a.button), Boolean(a.down));
        return { buttons: s.buttons };
      }
      case 'gba-kit/buttons': {
        const a = args as Args<'gba-kit/buttons'>;
        for (let b = 0; b < 10; b++) {
          s.setButton(b, ((a.mask >>> b) & 1) === 1);
        }
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
          const rewound = s.rewindFrames(Math.max(1, Math.floor(Number(a.frames) || 1)));
          response.body = { rewound };
          if (!rewound) {
            this.#stayStopped(s, 'no earlier history');
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
            this.#stayStopped(s, 'no earlier history');
          }
        });
        return SENT;
      }
      case 'gba-kit/frame': {
        const rgba = s.machine.framebufferRgba();
        return { width: 240, height: 160, frame: s.frame, rgba: Buffer.from(rgba).toString('base64') };
      }
      case 'gba-kit/stream': {
        const a = args as Args<'gba-kit/stream'>;
        await this.#stream.connect(String(a.path));
        this.#audioOff?.();
        this.#audioOff = a.audio
          ? s.on({ audio: (samples) => this.#stream.sendAudio(samples, AUDIO_SAMPLE_RATE) })
          : null;
        s.requestFrame();
        return { connected: this.#stream.connected };
      }
      case 'gba-kit/requestFrame':
        s.requestFrame();
        return undefined;
      case 'gba-kit/recordStart':
        s.startRecording();
        this.#emit(new Event('gba-kit/state', this.#stateBody()));
        return undefined;
      case 'gba-kit/recordStop': {
        const recording = s.stopRecording();
        this.#emit(new Event('gba-kit/state', this.#stateBody()));
        return { recording, script: s.recordingAsScript(recording) };
      }
      case 'gba-kit/replay': {
        const a = args as Args<'gba-kit/replay'>;
        this.#exec(response, () => {
          const replayed = s.replayRecording(a.recording as InputRecording);
          response.body = { replayed };
          if (!replayed) {
            this.#stayStopped(s, 'the recording starts before the history kept');
          }
        });
        return SENT;
      }
      case 'gba-kit/saveState': {
        const a = args as Args<'gba-kit/saveState'>;
        return this.#saveState(s, a.name);
      }
      case 'gba-kit/loadState': {
        const a = args as Args<'gba-kit/loadState'>;
        const file = a.path ?? (a.name ? this.#statePath(s, a.name) : null);
        if (!file) {
          throw new Error('give a state name or path');
        }
        const text = await this.#files(s).readText(file);
        if (text === null) {
          throw new Error(`no such state: ${file}`);
        }
        this.#exec(response, () => s.loadState(text));
        return SENT;
      }
      case 'gba-kit/listStates':
        return { states: await this.#listStates(s) };
      case 'gba-kit/ppu':
        return this.#ppu(s, args as PpuArguments);
      case 'gba-kit/ioRegisters':
        return { registers: s.ioRegisters() };
      case 'gba-kit/trace': {
        const a = args as Args<'gba-kit/trace'>;
        if (a.enabled !== undefined) {
          s.setTracing(Boolean(a.enabled));
        }
        return { enabled: s.tracing, entries: s.trace.last(Math.min(Number(a.count) || 200, 20_000)) };
      }
      case 'gba-kit/events': {
        const a = args as Args<'gba-kit/events'>;
        return { entries: s.events.last(Math.min(Number(a.count) || 500, 20_000)) };
      }
      case 'gba-kit/labels':
        return { labels: s.labels.all() };
      case 'gba-kit/setLabel': {
        const a = args as Args<'gba-kit/setLabel'>;
        s.labels.set({ address: Number(a.address) >>> 0, label: a.label ?? '', comment: a.comment, size: a.size });
        await this.#labelsChanged(s);
        return { labels: s.labels.all() };
      }
      case 'gba-kit/importLabels': {
        const a = args as Args<'gba-kit/importLabels'>;
        const imported = s.labels.importSymbols(String(a.text));
        await this.#labelsChanged(s);
        return { imported };
      }
      case 'gba-kit/exportLabels':
        return { text: s.labels.exportSymbols() };
      case 'gba-kit/searchMemory': {
        const a = args as Args<'gba-kit/searchMemory'>;
        return { addresses: s.searchMemory(a) };
      }
      case 'gba-kit/filterMemory': {
        const a = args as Args<'gba-kit/filterMemory'>;
        return { addresses: s.filterMemory(a.addresses, a.value, a.size) };
      }
      case 'gba-kit/eventBreakpoints':
        return { kinds: EVENT_BREAKPOINT_KINDS.map((k) => ({ ...k })), enabled: [...s.breakpoints.events] };
      default:
        this.sendErrorResponse(response, ERR.unknownRequest, `unknown request '${command}'`);
        return SENT;
    }
  }

  async #labelsChanged(session: Session): Promise<void> {
    await session.saveLabels();
    this.#emit(new Event('gba-kit/labels', { count: session.labels.size }));
  }

  #ppu(s: Session, args: PpuArguments): PpuBody {
    switch (args.kind) {
      case 'palette':
        return { kind: 'palette', ...s.palette() };
      case 'tiles': {
        const t = s.tiles(
          Number(args.charBase) >>> 0,
          args.bpp === 8 ? 8 : 4,
          Math.min(Math.max(1, Number(args.count) || 512), 2048),
        );
        return {
          kind: 'tiles',
          charBase: t.charBase,
          bpp: t.bpp,
          count: t.count,
          pixels: Buffer.from(t.pixels).toString('base64'),
        };
      }
      case 'tilemap':
        return { kind: 'tilemap', tilemap: s.tilemap(Number(args.index)) };
      case 'sprites':
        return { kind: 'sprites', sprites: s.sprites() };
      case 'backgrounds':
        return { kind: 'backgrounds', ...s.backgrounds() };
      default:
        throw new Error(`unknown ppu view '${(args as { kind: string }).kind}'`);
    }
  }

  #files(session: Session): NonNullable<Session['host']['files']> {
    if (!session.host.files) {
      throw new Error('this host has no file system');
    }
    return session.host.files;
  }

  #statesDir(session: Session): string {
    const files = this.#files(session);
    return files.join(session.options.projectDir ?? session.options.cwd, '.gba-kit', 'states');
  }

  #statePath(session: Session, name: string): string {
    return this.#files(session).join(this.#statesDir(session), `${safeName(name)}.json`);
  }

  async #saveState(session: Session, name?: string): Promise<SavedStateInfo> {
    const stateName = name?.trim() || `frame-${session.frame}`;
    const file = this.#statePath(session, stateName);
    await this.#files(session).writeText(file, session.saveState(stateName));
    this.#log(`gba-kit: state '${stateName}' saved to ${file}\n`);
    return { name: stateName, path: file, frame: session.frame, createdAt: new Date().toISOString() };
  }

  async #listStates(session: Session): Promise<SavedStateInfo[]> {
    const files = this.#files(session);
    const dir = this.#statesDir(session);
    const out: SavedStateInfo[] = [];
    for (const entry of await files.list(dir)) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const file = files.join(dir, entry);
      const text = await files.readText(file);
      if (!text) {
        continue;
      }
      try {
        const meta = JSON.parse(text) as {
          format?: string;
          name?: string;
          frame?: number;
          createdAt?: string;
          romHash?: string;
        };
        if (meta.format === 'gba-kit-savestate' && (!meta.romHash || meta.romHash === session.romHash)) {
          out.push({
            name: meta.name ?? entry.replace(/\.json$/, ''),
            path: file,
            frame: meta.frame ?? 0,
            createdAt: meta.createdAt ?? '',
          });
        }
      } catch {
        // not a state file
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/** Marker: the handler already sent the response itself. */
const SENT = Symbol('sent');
