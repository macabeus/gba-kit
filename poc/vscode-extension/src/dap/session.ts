/**
 * GbaDebugSession — the Debug Adapter Protocol face of `DebugCore`.
 *
 * Everything an IDE with a DAP client can do (VS Code, Neovim's nvim-dap, Emacs
 * dap-mode, Zed, JetBrains) it gets from this file: breakpoints, stepping,
 * registers, call stack, hover/watch evaluation, disassembly, memory, data
 * breakpoints, step-back. Emulator-only operations (input, frame stepping, rewind,
 * scripts, recording) are `gba-kit/*` custom requests and events, so a client that
 * knows them can add a screen and a gamepad, and one that does not still has a
 * complete debugger.
 *
 * No VS Code imports here — this file can run as a standalone process
 * (`adapter-cli.ts`) for any other editor.
 */
import {
  ContinuedEvent,
  DebugSession,
  Event,
  Handles,
  InitializedEvent,
  OutputEvent,
  Scope,
  Source,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
} from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import path from 'node:path';

import { DebugCore, type DebugCoreOptions, hex8, isMapped } from '../core/debug-core.js';
import type { VarNode } from '../core/dwarf/types.js';

type HandleTarget =
  | { kind: 'registers'; frameIndex: number }
  | { kind: 'gba' }
  | { kind: 'nodes'; nodes: VarNode[] }
  | { kind: 'lazy'; node: VarNode };

const THREAD_ID = 1;

export interface LaunchArguments extends DebugProtocol.LaunchRequestArguments {
  rom: string;
  elf?: string;
  cwd?: string;
  sourceMap?: Record<string, string>;
  stopOnEntry?: boolean;
  outputDir?: string;
  rewind?: { keyframeInterval?: number; maxKeyframes?: number };
}

export class GbaDebugSession extends DebugSession {
  #core: DebugCore | null = null;
  #coreReady: Array<(core: DebugCore) => void> = [];
  #configurationDone: (() => void) | null = null;
  readonly #handles = new Handles<HandleTarget>();

  constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  /** The core, once `launch` has created it. Used by the in-process VS Code layer for the frame stream. */
  onCore(cb: (core: DebugCore) => void): void {
    if (this.#core) {
      cb(this.#core);
    } else {
      this.#coreReady.push(cb);
    }
  }

  get core(): DebugCore | null {
    return this.#core;
  }

  // ─── lifecycle ─────────────────────────────────────────────────────

  protected override initializeRequest(response: DebugProtocol.InitializeResponse): void {
    response.body = {
      supportsConfigurationDoneRequest: true,
      supportsSteppingGranularity: true,
      supportsStepBack: true,
      supportsEvaluateForHovers: true,
      supportsDisassembleRequest: true,
      supportsInstructionBreakpoints: true,
      supportsReadMemoryRequest: true,
      supportsWriteMemoryRequest: true,
      supportsDataBreakpoints: true,
      supportsTerminateRequest: true,
      supportsGotoTargetsRequest: false,
      supportsRestartRequest: false,
      supportsSetVariable: true,
      supportsValueFormattingOptions: false,
      supportsConditionalBreakpoints: false,
      supportsLogPoints: false,
      exceptionBreakpointFilters: [],
    };
    this.sendResponse(response);
  }

  protected override async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArguments): Promise<void> {
    try {
      const cwd = args.cwd ?? path.dirname(args.rom);
      const options: DebugCoreOptions = {
        romPath: args.rom,
        elfPath: args.elf,
        cwd,
        sourceMap: args.sourceMap,
        outputDir: args.outputDir ?? path.join(cwd, '.gba-kit'),
        rewind: args.rewind,
      };
      if (!DebugCore.romExists(options.romPath)) {
        throw new Error(`ROM not found: ${options.romPath}`);
      }
      const core = await DebugCore.create(options);
      this.#core = core;
      this.#wireCore(core);
      for (const cb of this.#coreReady) {
        cb(core);
      }
      this.#coreReady = [];

      const di = core.debugInfo;
      this.#log(
        `gba-kit: loaded ${path.basename(args.rom)}` +
          (di
            ? ` + ${path.basename(args.elf!)} (line info: ${di.hasLineInfo}, types: ${di.hasTypeInfo})`
            : ' (no ELF: address-level only)') +
          '\n',
      );
      if (core.sources) {
        const files = core.sources.dwarfFiles;
        const resolved = files.filter((f) => core.sources!.toLocal(f)).length;
        this.#log(`gba-kit: ${resolved}/${files.length} source files from the ELF found on disk\n`);
      }

      // Breakpoints arrive between `initialized` and `configurationDone`; the core
      // exists now, so they can be applied directly.
      this.sendEvent(new InitializedEvent());
      await new Promise<void>((resolve) => {
        this.#configurationDone = resolve;
        setTimeout(resolve, 2000);
      });

      this.sendResponse(response);
      if (args.stopOnEntry ?? true) {
        this.sendEvent(new StoppedEvent('entry', THREAD_ID));
        core.requestFrame();
      } else {
        core.continue();
      }
    } catch (err) {
      this.sendErrorResponse(response, 1000, `gba-kit: ${(err as Error).message}`);
    }
  }

  protected override configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): void {
    this.#configurationDone?.();
    this.#configurationDone = null;
    this.sendResponse(response);
  }

  protected override disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
    this.#core?.dispose();
    this.#core = null;
    this.sendResponse(response);
  }

  protected override terminateRequest(response: DebugProtocol.TerminateResponse): void {
    this.#core?.dispose();
    this.#core = null;
    this.sendResponse(response);
    this.sendEvent(new TerminatedEvent());
  }

  #wireCore(core: DebugCore): void {
    core.on({
      stopped: (info) => {
        const ev = new StoppedEvent(info.reason, THREAD_ID, info.description);
        const body = ev.body as DebugProtocol.StoppedEvent['body'];
        body.allThreadsStopped = true;
        if (info.breakpointIds) {
          body.hitBreakpointIds = info.breakpointIds;
        }
        if (info.description) {
          body.description = info.description;
        }
        this.sendEvent(ev);
        this.sendEvent(new Event('gba-kit/state', { state: 'paused', frame: core.frame, pc: core.pc }));
      },
      continued: () => {
        this.sendEvent(new ContinuedEvent(THREAD_ID, true));
        this.sendEvent(new Event('gba-kit/state', { state: core.state, frame: core.frame, pc: core.pc }));
      },
      output: (text, category) => this.sendEvent(new OutputEvent(text, category)),
      stateChanged: (state) => this.sendEvent(new Event('gba-kit/state', { state, frame: core.frame, pc: core.pc })),
    });
  }

  #log(text: string): void {
    this.sendEvent(new OutputEvent(text, 'console'));
  }

  #requireCore(): DebugCore {
    if (!this.#core) {
      throw new Error('no emulator session');
    }
    return this.#core;
  }

  // ─── threads / stack / scopes / variables ──────────────────────────

  protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(THREAD_ID, 'ARM7TDMI')] };
    this.sendResponse(response);
  }

  protected override stackTraceRequest(response: DebugProtocol.StackTraceResponse): void {
    const core = this.#requireCore();
    this.#handles.reset();
    const frames = core.callStack().map((f) => {
      const frame = new StackFrame(
        f.index,
        f.name,
        f.source ? new Source(path.basename(f.source.path), f.source.path) : undefined,
        f.source?.line ?? 0,
        0,
      );
      frame.instructionPointerReference = `0x${hex8(f.address)}`;
      if (f.heuristic || f.inlined) {
        frame.presentationHint = 'subtle';
      }
      return frame;
    });
    response.body = { stackFrames: frames, totalFrames: frames.length };
    this.sendResponse(response);
  }

  protected override scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    const core = this.#requireCore();
    const frameScopes = core.scopes(args.frameId);
    const scopes: DebugProtocol.Scope[] = [];
    const frame = core.callStack()[args.frameId];
    if (frame?.virtual) {
      scopes.push({
        name: 'Locals',
        variablesReference: this.#handles.create({ kind: 'nodes', nodes: frameScopes.locals }),
        expensive: false,
        presentationHint: 'locals',
        namedVariables: frameScopes.locals.length,
      });
      scopes.push({
        name: 'Globals (this file)',
        variablesReference: this.#handles.create({ kind: 'nodes', nodes: frameScopes.globals }),
        expensive: true,
        namedVariables: frameScopes.globals.length,
      });
    }
    scopes.push(
      {
        name: 'Registers',
        variablesReference: this.#handles.create({ kind: 'registers', frameIndex: args.frameId }),
        expensive: false,
        presentationHint: 'registers',
      },
      new Scope('GBA', this.#handles.create({ kind: 'gba' }), true),
    );
    response.body = { scopes };
    this.sendResponse(response);
  }

  #nodeToVariable(node: VarNode): DebugProtocol.Variable {
    const v: DebugProtocol.Variable = {
      name: node.name,
      value: node.value,
      type: node.type,
      variablesReference: node.children ? this.#handles.create({ kind: 'lazy', node }) : 0,
      evaluateName: /^[A-Za-z_]\w*$/.test(node.name) ? node.name : undefined,
    };
    if (node.address !== undefined && isMapped(node.address)) {
      v.memoryReference = `0x${hex8(node.address)}`;
    }
    if (!node.writable) {
      v.presentationHint = { attributes: ['readOnly'] };
    }
    return v;
  }

  protected override variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): void {
    const core = this.#requireCore();
    const target = this.#handles.get(args.variablesReference);
    let variables: DebugProtocol.Variable[] = [];
    if (!target) {
      response.body = { variables };
      this.sendResponse(response);
      return;
    }
    if (target.kind === 'nodes') {
      variables = target.nodes.map((n) => this.#nodeToVariable(n));
    } else if (target.kind === 'lazy') {
      const nodes = target.node.children?.() ?? [];
      // Cache the expansion so setVariable can find the children by name later.
      (target as { kind: string; nodes?: VarNode[] }).nodes = nodes;
      variables = nodes.map((n) => this.#nodeToVariable(n));
    } else if (target.kind === 'registers') {
      const regs =
        target.frameIndex === 0
          ? core.registers().map((r) => ({ name: r.name, value: r.value as number | undefined }))
          : core.scopes(target.frameIndex).registers;
      variables = regs.map((r) => {
        const v: DebugProtocol.Variable = {
          name: r.name,
          value: r.value === undefined ? '<not recovered>' : `0x${hex8(r.value)}`,
          type: 'u32',
          variablesReference: 0,
        };
        if (r.name === 'cpsr') {
          v.value += `  ${core.cpsrDescription()}`;
        } else if (r.value !== undefined && isMapped(r.value)) {
          v.memoryReference = `0x${hex8(r.value)}`;
        }
        return v;
      });
    } else if (target.kind === 'gba') {
      const gba = core.gba;
      const fn = core.debugInfo?.pcToFunction(core.pc);
      variables = [
        { name: 'frame', value: String(core.frame), variablesReference: 0 },
        { name: 'function', value: fn ? fn.name : '?', variablesReference: 0 },
        { name: 'halted', value: String(gba.interrupts.halted), variablesReference: 0 },
        { name: 'IE', value: `0x${gba.interrupts.ie.toString(16).padStart(4, '0')}`, variablesReference: 0 },
        { name: 'IF', value: `0x${gba.interrupts.if_.toString(16).padStart(4, '0')}`, variablesReference: 0 },
        {
          name: 'VCOUNT',
          value: String(gba.bus.read8(0x04000006)),
          variablesReference: 0,
          memoryReference: '0x04000006',
        },
        {
          name: 'DISPCNT',
          value: `0x${gba.bus.read16(0x04000000).toString(16).padStart(4, '0')}`,
          variablesReference: 0,
          memoryReference: '0x04000000',
        },
        { name: 'rewind keyframes', value: String(core.rewindDepth), variablesReference: 0 },
      ];
    }
    response.body = { variables };
    this.sendResponse(response);
  }

  protected override setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments,
  ): void {
    const core = this.#requireCore();
    const target = this.#handles.get(args.variablesReference) as (HandleTarget & { nodes?: VarNode[] }) | undefined;
    const nodes = target && 'nodes' in target ? target.nodes : undefined;
    const node = nodes?.find((n) => n.name === args.name);
    if (!node?.writable) {
      this.sendErrorResponse(response, 1007, `'${args.name}' is not a writable scalar`);
      return;
    }
    try {
      core.setScalar(node.writable, args.value);
      const { data } = core.readMemory(node.writable.address, node.writable.size);
      let v = 0;
      for (let i = data.length - 1; i >= 0; i--) {
        v = v * 256 + data[i]!;
      }
      response.body = { value: `${v} (0x${v.toString(16)})`, type: node.type, variablesReference: 0 };
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1008, (err as Error).message);
    }
  }

  // ─── execution control ─────────────────────────────────────────────

  /**
   * Respond first, act on the next tick. Steps are synchronous in the core, so their
   * `stopped` would otherwise precede the response; DAP (and VS Code's simulated
   * `continued`) expect response → stopped.
   */
  #exec(response: DebugProtocol.Response, action: () => void): void {
    const core = this.#core;
    if (!core) {
      this.sendErrorResponse(response, 1001, 'no emulator session');
      return;
    }
    if (core.state !== 'paused' && response.command !== 'pause') {
      this.sendErrorResponse(response, 1001, `cannot ${response.command} while ${core.state}`);
      return;
    }
    this.sendResponse(response);
    setImmediate(() => {
      try {
        action();
      } catch (err) {
        this.#log(`gba-kit: ${response.command} failed: ${(err as Error).message}\n`);
      }
    });
  }

  protected override continueRequest(response: DebugProtocol.ContinueResponse): void {
    this.#exec(response, () => this.#requireCore().continue());
  }

  protected override pauseRequest(response: DebugProtocol.PauseResponse): void {
    this.#exec(response, () => this.#requireCore().pause());
  }

  protected override nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    this.#exec(response, () => {
      const core = this.#requireCore();
      args.granularity === 'instruction' ? core.stepInstruction() : core.stepOver();
    });
  }

  protected override stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    this.#exec(response, () => {
      const core = this.#requireCore();
      args.granularity === 'instruction' ? core.stepInstruction() : core.stepLine();
    });
  }

  protected override stepOutRequest(response: DebugProtocol.StepOutResponse): void {
    this.#exec(response, () => this.#requireCore().stepOut());
  }

  protected override stepBackRequest(response: DebugProtocol.StepBackResponse): void {
    this.#exec(response, () => {
      if (!this.#requireCore().rewind(1)) {
        this.#log('gba-kit: no rewind history yet\n');
        this.sendEvent(new StoppedEvent('step', THREAD_ID));
      }
    });
  }

  protected override reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse): void {
    this.#exec(response, () => {
      const core = this.#requireCore();
      // One second of history per reverse-continue (the ring keeps ~30 s by default).
      const perSecond = Math.ceil(60 / (core.options.rewind?.keyframeInterval ?? 10));
      if (!core.rewind(perSecond)) {
        this.#log('gba-kit: no rewind history yet\n');
        this.sendEvent(new StoppedEvent('step', THREAD_ID));
      }
    });
  }

  // ─── breakpoints ───────────────────────────────────────────────────

  protected override setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): void {
    const core = this.#requireCore();
    const localPath = args.source.path ?? '';
    const lines = (args.breakpoints ?? []).map((b) => b.line);
    const results = core.setSourceBreakpoints(localPath, lines);
    response.body = {
      breakpoints: results.map((r) => ({
        id: r.id,
        verified: r.verified,
        line: r.line,
        message: r.message,
        instructionReference: r.address !== undefined ? `0x${hex8(r.address)}` : undefined,
        source: args.source,
      })),
    };
    this.sendResponse(response);
  }

  protected override setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments,
  ): void {
    const core = this.#requireCore();
    const addresses = args.breakpoints.map((b) => (parseInt(b.instructionReference, 16) + (b.offset ?? 0)) >>> 0);
    const results = core.setInstructionBreakpoints(addresses);
    response.body = {
      breakpoints: results.map((r) => ({ id: r.id, verified: true, instructionReference: `0x${hex8(r.address)}` })),
    };
    this.sendResponse(response);
  }

  protected override dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments,
  ): void {
    const core = this.#requireCore();
    const di = core.debugInfo;
    const name = args.name.trim();
    let address: number | null = null;
    let length = 1;
    const isRegister = /^(r\d+|sp|lr|pc|cpsr)$/i.test(name);
    if (isRegister) {
      response.body = { dataId: null, description: `${name} is a register; watch a symbol or a hex address instead` };
      this.sendResponse(response);
      return;
    }
    if (/^0x[0-9a-f]+$/i.test(name)) {
      address = parseInt(name, 16) >>> 0;
      length = 4;
    } else if (di) {
      const loc = di.resolveVariable(name);
      if (loc) {
        address = loc.address;
        length = loc.size;
      } else {
        address = di.symbolToAddress(name);
        length = di.symbolExtent(name)?.size ?? 4;
      }
    }
    response.body =
      address === null
        ? { dataId: null, description: `cannot watch '${name}'` }
        : {
            dataId: `${address}:${length}:${name}`,
            description: `write to ${name} [0x${hex8(address)}, ${length} bytes]`,
            accessTypes: ['write'],
            // The id bakes in an address that moves on every rebuild.
            canPersist: false,
          };
    this.sendResponse(response);
  }

  protected override setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments,
  ): void {
    const core = this.#requireCore();
    const specs = args.breakpoints.map((b) => {
      const [addr, len, ...rest] = b.dataId.split(':');
      return { address: Number(addr), length: Number(len), name: rest.join(':') };
    });
    const ids = core.setDataBreakpoints(specs);
    response.body = { breakpoints: ids.map((id) => ({ id, verified: true })) };
    this.sendResponse(response);
  }

  // ─── evaluate / disassemble / memory ───────────────────────────────

  protected override async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): Promise<void> {
    const core = this.#requireCore();
    const simple = core.evaluateSimple(args.expression, args.frameId ?? 0);
    if (simple) {
      response.body = {
        result: simple.value,
        type: simple.type,
        variablesReference: simple.node?.children ? this.#handles.create({ kind: 'lazy', node: simple.node }) : 0,
        memoryReference: simple.address !== undefined ? `0x${hex8(simple.address)}` : undefined,
      };
      this.sendResponse(response);
      return;
    }
    if (args.context === 'repl') {
      // The debug console is the scripting API: `await press('a')`, `readOAM()[0]`, ...
      if (core.state !== 'paused') {
        this.sendErrorResponse(response, 1002, `cannot run script while ${core.state}`);
        return;
      }
      const lines: string[] = [];
      const off = core.on({ output: (t, c) => c !== 'console' && lines.push(t.trimEnd()) });
      // Expression first (`readOAM()[0]`, `await press('a')`); a statement list
      // (`for (...) {...}`) falls back to plain script mode. Objects are printed as JSON.
      const expr = args.expression.trim().replace(/;\s*$/, '');
      const fmt = `(v) => v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v, (_k, x) => x instanceof Uint8Array ? Array.from(x) : x) : String(v)`;
      const code = `{ const __fmt = ${fmt}; let __v; try { __v = await (async () => (${expr}))(); } catch (e) { if (!(e instanceof SyntaxError)) throw e; __v = await (async () => { ${args.expression} })(); } const __s = __fmt(__v); if (__s !== '') console.log(__s); }`;
      try {
        await core.runScript(code, '<repl>', { quiet: true });
        response.body = { result: lines.join('\n') || '(no output)', variablesReference: 0 };
        this.sendResponse(response);
      } catch (err) {
        this.sendErrorResponse(response, 1006, (err as Error).message);
      } finally {
        off();
      }
      return;
    }
    this.sendErrorResponse(
      response,
      1003,
      `cannot evaluate '${args.expression}' (try a register, a hex address, or a symbol path)`,
    );
  }

  protected override disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments,
  ): void {
    const core = this.#requireCore();
    const base = (parseInt(args.memoryReference, 16) + (args.offset ?? 0)) >>> 0;
    // Thumb unless the reference is the ARM-mode PC. GBA game code is Thumb almost everywhere.
    const thumb = base === core.pc ? core.thumb : true;
    const size = thumb ? 2 : 4;
    const start = (base + (args.instructionOffset ?? 0) * size) >>> 0;
    const lines = core.disassemble(start, args.instructionCount, thumb);
    response.body = {
      instructions: lines.map((l) => {
        const ins: DebugProtocol.DisassembledInstruction = {
          address: `0x${hex8(l.address)}`,
          instructionBytes: l.bytes,
          instruction: l.mnemonic,
          symbol: l.symbol,
        };
        if (l.mnemonic === '<unmapped>') {
          ins.presentationHint = 'invalid';
        }
        if (l.source) {
          ins.location = new Source(path.basename(l.source.path), l.source.path);
          ins.line = l.source.line;
        }
        return ins;
      }),
    };
    this.sendResponse(response);
  }

  protected override readMemoryRequest(
    response: DebugProtocol.ReadMemoryResponse,
    args: DebugProtocol.ReadMemoryArguments,
  ): void {
    const core = this.#requireCore();
    const address = (parseInt(args.memoryReference, 16) + (args.offset ?? 0)) >>> 0;
    const { data, unreadable } = core.readMemory(address, args.count);
    response.body = {
      address: `0x${hex8(address)}`,
      data: Buffer.from(data).toString('base64'),
      unreadableBytes: unreadable,
    };
    this.sendResponse(response);
  }

  protected override writeMemoryRequest(
    response: DebugProtocol.WriteMemoryResponse,
    args: DebugProtocol.WriteMemoryArguments,
  ): void {
    const core = this.#requireCore();
    const address = (parseInt(args.memoryReference, 16) + (args.offset ?? 0)) >>> 0;
    const bytesWritten = core.writeMemory(address, new Uint8Array(Buffer.from(args.data, 'base64')));
    response.body = { bytesWritten };
    this.sendResponse(response);
  }

  // ─── gba-kit custom requests ───────────────────────────────────────

  protected override async customRequest(
    command: string,
    response: DebugProtocol.Response,
    args: Record<string, unknown> | undefined,
  ): Promise<void> {
    const core = this.#requireCore();
    try {
      switch (command) {
        case 'gba-kit/input':
          core.setButton(Number(args?.button), Boolean(args?.down));
          break;
        case 'gba-kit/stepFrame':
          this.#exec(response, () => core.stepFrame());
          return;
        case 'gba-kit/rewind':
          this.#exec(response, () => {
            if (!core.rewind(Number(args?.keyframes ?? 1))) {
              this.#log('gba-kit: no rewind history yet\n');
            }
          });
          return;
        case 'gba-kit/state':
          response.body = { state: core.state, frame: core.frame, pc: core.pc, recording: core.recording };
          break;
        case 'gba-kit/runScript':
          await core.runScript(String(args?.code ?? ''), String(args?.name ?? '<script>'));
          break;
        case 'gba-kit/recordStart':
          core.startRecording();
          this.#log('gba-kit: recording inputs\n');
          break;
        case 'gba-kit/recordStop':
          response.body = { script: core.stopRecording() };
          break;
        case 'gba-kit/saveState': {
          const file = String(args?.path);
          await core.saveState(file);
          this.#log(`gba-kit: state saved to ${file}\n`);
          break;
        }
        case 'gba-kit/requestFrame':
          core.requestFrame();
          break;
        default:
          this.sendErrorResponse(response, 1004, `unknown request ${command}`);
          return;
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1005, (err as Error).message);
    }
  }
}
