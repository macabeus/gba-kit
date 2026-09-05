/**
 * The adapter driven the way an editor drives it: real DAP messages over streams,
 * against the debug-core fixtures (one C program built as Thumb -O0).
 */
import type { DebugProtocol } from '@vscode/debugprotocol';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { type Server, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { GbaKitRequests, StateBody } from '../protocol.js';
import { StreamReader } from '../stream.js';
import { DapClient } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', '..', 'debug-core', 'test-fixtures');
const ROM = join(fixtures, 'build', 'thumb-O0.gba');
const ELF = join(fixtures, 'build', 'thumb-O0.elf');
const MAIN = join(fixtures, 'source', 'main.c');
const UTIL = join(fixtures, 'source', 'util.c');

async function lineOf(file: string, snippet: string): Promise<number> {
  const lines = (await readFile(file, 'utf8')).split('\n');
  const index = lines.findIndex((l) => l.includes(snippet));
  if (index < 0) {
    throw new Error(`no line containing ${snippet}`);
  }
  return index + 1;
}

const clients: DapClient[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) {
    await c.request('disconnect');
  }
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

interface LaunchOptions {
  stopOnEntry?: boolean;
  breakpoints?: Array<{ path: string; lines: Array<number | DebugProtocol.SourceBreakpoint> }>;
  projectDir?: string;
  elf?: string | null;
  extra?: Record<string, unknown>;
}

/** initialize → launch → (breakpoints) → configurationDone, the way every client does it. */
async function launch(options: LaunchOptions = {}): Promise<DapClient> {
  const client = new DapClient();
  clients.push(client);
  await client.body('initialize', {
    clientID: 'test',
    adapterID: 'gba-kit',
    pathFormat: 'path',
    linesStartAt1: true,
    columnsStartAt1: true,
  });
  const launched = client.request('launch', {
    rom: ROM,
    elf: options.elf === undefined ? ELF : options.elf,
    cwd: fixtures,
    stopOnEntry: options.stopOnEntry,
    projectDir: options.projectDir,
    ...options.extra,
  });
  // a launch that fails answers before (instead of) `initialized`
  await Promise.race([
    client.event('initialized'),
    launched.then((r) => {
      if (!r.success) {
        throw new Error(r.message);
      }
    }),
  ]);
  for (const bp of options.breakpoints ?? []) {
    await client.body('setBreakpoints', {
      source: { path: bp.path },
      breakpoints: bp.lines.map((l) => (typeof l === 'number' ? { line: l } : l)),
    });
  }
  await client.body('configurationDone');
  const response = await launched;
  if (!response.success) {
    throw new Error(response.message);
  }
  return client;
}

async function stopped(
  client: DapClient,
  command: string,
  args?: unknown,
): Promise<DebugProtocol.StoppedEvent['body']> {
  const event = await client.stopAfter(() => client.body(command, args));
  return event.body;
}

/** The number an evaluation printed (`12 (0xc)` → 12). */
async function num(client: DapClient, expression: string): Promise<number> {
  const { result } = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', { expression });
  return parseInt(result, 10);
}

async function topFrame(client: DapClient): Promise<DebugProtocol.StackFrame> {
  const { stackFrames } = await client.body<DebugProtocol.StackTraceResponse['body']>('stackTrace', { threadId: 1 });
  return stackFrames[0]!;
}

async function variables(client: DapClient, reference: number): Promise<DebugProtocol.Variable[]> {
  return (await client.body<DebugProtocol.VariablesResponse['body']>('variables', { variablesReference: reference }))
    .variables;
}

async function scopeRef(client: DapClient, name: string, frameId = 0): Promise<number> {
  const { scopes } = await client.body<DebugProtocol.ScopesResponse['body']>('scopes', { frameId });
  const scope = scopes.find((s) => s.name.startsWith(name));
  if (!scope) {
    throw new Error(`no scope ${name} in ${scopes.map((s) => s.name).join(', ')}`);
  }
  return scope.variablesReference;
}

describe('lifecycle', () => {
  it('advertises honest capabilities', async () => {
    const client = new DapClient();
    clients.push(client);
    const caps = await client.body<DebugProtocol.Capabilities>('initialize', {
      adapterID: 'gba-kit',
      pathFormat: 'path',
    });
    expect(caps.supportsStepBack).toBe(true);
    expect(caps.supportsLogPoints).toBe(true);
    expect(caps.supportsDataBreakpoints).toBe(true);
    expect(caps.supportsGotoTargetsRequest).toBe(false);
    expect(caps.exceptionBreakpointFilters!.map((f) => f.filter)).toEqual([
      'vblank',
      'hblank',
      'irq',
      'irq-enter',
      'dma',
      'halt',
      'mmio-write',
    ]);
  });

  it('sends initialized before the launch response, applies early breakpoints, and stops on entry', async () => {
    const line = await lineOf(MAIN, 'g_keys = ~REG_KEYINPUT');
    const client = await launch({ breakpoints: [{ path: MAIN, lines: [line] }] });
    const kinds = client.kinds();
    expect(kinds.indexOf('event:initialized')).toBeLessThan(kinds.indexOf('response:launch'));
    expect(kinds.indexOf('response:launch')).toBeLessThan(kinds.indexOf('event:stopped'));
    const entry = client.events<DebugProtocol.StoppedEvent>('stopped')[0]!;
    expect(entry.body.reason).toBe('entry');
    expect(client.output()).toMatch(/loaded thumb-O0\.gba \+ thumb-O0\.elf; \d+ source files found on disk/);
    const state = client.events<DebugProtocol.Event>('gba-kit/state')[0]!.body as StateBody;
    expect(state).toMatchObject({ state: 'stopped', frame: 0, pc: 0x08000000 });
    // the early breakpoint is armed: the first continue hits it
    const stop = await stopped(client, 'continue', { threadId: 1 });
    expect(stop.reason).toBe('breakpoint');
    expect((await topFrame(client)).line).toBe(line);
  });

  it('runs straight away without stopOnEntry', async () => {
    const line = await lineOf(MAIN, 'draw();');
    const client = await launch({ stopOnEntry: false, breakpoints: [{ path: MAIN, lines: [line] }] });
    const stop = await client.event<DebugProtocol.StoppedEvent>('stopped');
    expect(stop.body.reason).toBe('breakpoint');
    expect(client.events('stopped').length).toBe(1);
  });

  it('refuses a missing ROM and an ELF from another build, unless told otherwise', async () => {
    const client = new DapClient();
    clients.push(client);
    await client.body('initialize', { adapterID: 'gba-kit', pathFormat: 'path' });
    const missing = await client.request('launch', { rom: join(fixtures, 'nope.gba') });
    expect(missing.success).toBe(false);
    expect(missing.message).toMatch(/ROM not found/);

    const wrong = await client.request('launch', {
      rom: ROM,
      elf: join(fixtures, 'build', 'arm-O0.elf'),
      cwd: fixtures,
    });
    expect(wrong.success).toBe(false);
    expect(wrong.message).toMatch(/arm-O0\.elf does not match thumb-O0\.gba/);
    expect(wrong.message).toMatch(/allowElfMismatch/);

    await expect(
      launch({ elf: join(fixtures, 'build', 'arm-O0.elf'), extra: { allowElfMismatch: true } }),
    ).resolves.toBeDefined();
    const forced = clients[clients.length - 1]!;
    expect(forced.output()).toMatch(/does not match .*continuing because allowElfMismatch/);
  });

  it('debugs a ROM without an ELF at the address level', async () => {
    const client = await launch({ elf: null });
    expect(client.output()).toMatch(/without an ELF/);
    const frame = await topFrame(client);
    expect(frame.source).toBeUndefined();
    expect(frame.instructionPointerReference).toBe('0x08000000');
    const bps = await client.body<DebugProtocol.SetBreakpointsResponse['body']>('setBreakpoints', {
      source: { path: MAIN },
      breakpoints: [{ line: 10 }],
    });
    expect(bps.breakpoints[0]!.verified).toBe(false);
    expect(bps.breakpoints[0]!.message).toMatch(/no ELF/);
  });

  it('restarts to the entry point keeping breakpoints, and terminates', async () => {
    const line = await lineOf(MAIN, 'draw();');
    const client = await launch({ breakpoints: [{ path: MAIN, lines: [line] }] });
    await stopped(client, 'continue', { threadId: 1 });
    const restart = await stopped(client, 'restart');
    expect(restart.reason).toBe('restart');
    expect((await client.body<StateBody>('gba-kit/state')).frame).toBe(0);
    expect((await stopped(client, 'continue', { threadId: 1 })).reason).toBe('breakpoint');
    const terminated = client.event('terminated');
    await client.body('terminate');
    await terminated;
  });
});

describe('breakpoints', () => {
  it('reports the line a breakpoint slid to, its address, and unverified ones with a reason', async () => {
    const comment = await lineOf(MAIN, '/* The VBlank handler');
    const client = await launch();
    const { breakpoints } = await client.body<DebugProtocol.SetBreakpointsResponse['body']>('setBreakpoints', {
      source: { path: MAIN },
      breakpoints: [{ line: comment }, { line: 2 }, { line: 5, condition: 'g_frame ==' }],
    });
    expect(breakpoints[0]).toMatchObject({ verified: true, instructionReference: expect.stringMatching(/^0x08/) });
    expect(breakpoints[0]!.line).toBeGreaterThan(comment);
    expect(breakpoints[1]!.verified).toBe(false);
    expect(breakpoints[2]!.verified).toBe(false);
    expect(breakpoints[2]!.message).toMatch(/unexpected end/);
  });

  it('conditions, hit counts and logpoints', async () => {
    const line = await lineOf(MAIN, 'g_keys = ~REG_KEYINPUT');
    const client = await launch({ breakpoints: [{ path: MAIN, lines: [{ line, condition: 'g_frame == 4' }] }] });
    await stopped(client, 'continue', { threadId: 1 });
    expect(await num(client, 'g_frame')).toBe(4);
    await client.body('setBreakpoints', {
      source: { path: MAIN },
      breakpoints: [
        { line, logMessage: 'frame {g_frame}' },
        { line: line + 1, hitCondition: '2' },
      ],
    });
    // resumed from the g_keys line of frame 4: update() hits once there, then again in frame 5
    const stop = await stopped(client, 'continue', { threadId: 1 });
    expect(stop.reason).toBe('breakpoint');
    expect(await num(client, 'g_frame')).toBe(5);
    expect(client.output()).toContain('frame 5 (0x5)\n');
    expect(client.output()).not.toContain('frame 4 (0x4)');
  });

  it('function and instruction breakpoints', async () => {
    const client = await launch();
    const fn = await client.body<DebugProtocol.SetFunctionBreakpointsResponse['body']>('setFunctionBreakpoints', {
      breakpoints: [{ name: 'add_bonus' }, { name: 'nope' }],
    });
    expect(fn.breakpoints[0]!.verified).toBe(true);
    expect(fn.breakpoints[1]).toMatchObject({ verified: false, message: expect.stringMatching(/no symbol/) });
    const stop = await stopped(client, 'continue', { threadId: 1 });
    expect(stop.reason).toBe('function breakpoint');
    expect((await topFrame(client)).name).toBe('add_bonus');
    await client.body('setFunctionBreakpoints', { breakpoints: [] });
    const { instructions } = await client.body<DebugProtocol.DisassembleResponse['body']>('disassemble', {
      memoryReference: fn.breakpoints[0]!.instructionReference,
      instructionCount: 3,
    });
    const ins = await client.body<DebugProtocol.SetInstructionBreakpointsResponse['body']>(
      'setInstructionBreakpoints',
      {
        breakpoints: [{ instructionReference: instructions[2]!.address }],
      },
    );
    expect(ins.breakpoints[0]).toMatchObject({ verified: true, instructionReference: instructions[2]!.address });
    const hit = await stopped(client, 'continue', { threadId: 1 });
    expect(hit.reason).toBe('instruction breakpoint');
    expect((await topFrame(client)).instructionPointerReference).toBe(instructions[2]!.address);
  });

  it('data breakpoints from a name and from a nested variable', async () => {
    const client = await launch({ breakpoints: [{ path: MAIN, lines: [await lineOf(MAIN, 'wait_vblank();')] }] });
    await stopped(client, 'continue', { threadId: 1 });
    await client.body('setBreakpoints', { source: { path: MAIN }, breakpoints: [] });
    const info = await client.body<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', {
      name: 'g_bonus_calls',
    });
    expect(info.dataId).toMatch(/^\d+:4:g_bonus_calls$/);
    expect(info.accessTypes).toEqual(['read', 'write', 'readWrite']);
    expect(info.canPersist).toBe(false);
    const nope = await client.body<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', {
      name: 'not_a_thing',
    });
    expect(nope.dataId).toBeNull();

    // the nested member through its container's variablesReference, as the Variables view does
    const globals = await variables(client, await scopeRef(client, 'Globals'));
    const player = globals.find((v) => v.name === 'g_player')!;
    const pos = (await variables(client, player.variablesReference)).find((v) => v.name === 'pos')!;
    const nested = await client.body<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', {
      name: 'x',
      variablesReference: pos.variablesReference,
    });
    expect(nested.dataId).toMatch(/^\d+:4:g_player\.pos\.x$/);
    const registers = await scopeRef(client, 'Registers');
    const reg = await client.body<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', {
      name: 'r0',
      variablesReference: registers,
    });
    expect(reg.dataId).toBeNull();

    await client.body('setDataBreakpoints', { breakpoints: [{ dataId: nested.dataId, accessType: 'read' }] });
    const stop = await stopped(client, 'continue', { threadId: 1 });
    expect(stop.reason).toBe('data breakpoint');
    expect(stop.description).toMatch(/^g_player\.pos\.x read .* by move_player/);
  });

  it('hardware events are exception filters', async () => {
    const client = await launch();
    const set = await client.body<DebugProtocol.SetExceptionBreakpointsResponse['body']>('setExceptionBreakpoints', {
      filters: ['vblank', 'bogus'],
    });
    expect(set.breakpoints).toEqual([{ verified: true }, { verified: false, message: "unknown event 'bogus'" }]);
    const stop = await stopped(client, 'continue', { threadId: 1 });
    expect(stop).toMatchObject({ reason: 'event breakpoint', description: 'VBlank' });
    const kinds = await client.body<GbaKitRequests['gba-kit/eventBreakpoints']['body']>('gba-kit/eventBreakpoints');
    expect(kinds.enabled).toEqual(['vblank']);
    expect(kinds.kinds.length).toBe(7);
  });

  it('lists the lines that can take a breakpoint', async () => {
    const client = await launch();
    const from = await lineOf(MAIN, 'int main(void)');
    const { breakpoints } = await client.body<DebugProtocol.BreakpointLocationsResponse['body']>(
      'breakpointLocations',
      {
        source: { path: MAIN },
        line: from,
        endLine: from + 3,
      },
    );
    expect(breakpoints.map((b) => b.line)).toEqual([from, from + 1, from + 2, from + 3]);
    const { sources } = await client.body<DebugProtocol.LoadedSourcesResponse['body']>('loadedSources');
    expect(sources.map((s) => s.path)).toEqual(expect.arrayContaining([MAIN, UTIL]));
  });
});

describe('stepping', () => {
  it('answers a step before reporting its stop, and walks statements', async () => {
    const line = await lineOf(MAIN, 'wait_vblank();');
    const client = await launch({ breakpoints: [{ path: MAIN, lines: [line] }] });
    await stopped(client, 'continue', { threadId: 1 });
    await client.body('setBreakpoints', { source: { path: MAIN }, breakpoints: [] });
    const at = client.log.length;
    const stop = await stopped(client, 'next', { threadId: 1 });
    expect(stop.reason).toBe('step');
    expect(client.kinds(at)).toEqual([
      'response:next',
      'event:continued',
      'event:gba-kit/state',
      'event:stopped',
      'event:gba-kit/state',
    ]);
    expect((await topFrame(client)).line).toBe(await lineOf(MAIN, 'tick();'));
    await stopped(client, 'next', { threadId: 1 });
    await stopped(client, 'next', { threadId: 1 });
    expect((await topFrame(client)).line).toBe(await lineOf(MAIN, 'update();'));
    await stopped(client, 'stepIn', { threadId: 1 });
    expect((await topFrame(client)).name).toBe('update');
    await stopped(client, 'stepOut', { threadId: 1 });
    const back = await topFrame(client);
    expect(back.name).toBe('main');
    expect(back.line).toBe(await lineOf(MAIN, 'draw();'));
    const before = (await client.body<StateBody>('gba-kit/state')).position;
    await stopped(client, 'next', { threadId: 1, granularity: 'instruction' });
    expect((await client.body<StateBody>('gba-kit/state')).position.instruction).toBe(before.instruction + 1);
  });

  it('steps back exactly and reverse-continues to the previous hit', async () => {
    const line = await lineOf(MAIN, 'draw();');
    const client = await launch({ breakpoints: [{ path: MAIN, lines: [line] }] });
    for (let i = 0; i < 3; i++) {
      await stopped(client, 'continue', { threadId: 1 });
    }
    const at = (await client.body<StateBody>('gba-kit/state')).position;
    await stopped(client, 'next', { threadId: 1, granularity: 'instruction' });
    const back = await stopped(client, 'stepBack', { threadId: 1 });
    expect(back.reason).toBe('rewind');
    expect((await client.body<StateBody>('gba-kit/state')).position).toEqual(at);
    const reverse = await stopped(client, 'reverseContinue', { threadId: 1 });
    expect(reverse.reason).toBe('breakpoint');
    expect((await client.body<StateBody>('gba-kit/state')).frame).toBe(at.frame - 1);
    expect((await topFrame(client)).line).toBe(line);
  });

  it('stays stopped, and says so, when there is nothing to step back to', async () => {
    const client = await launch();
    const stop = await stopped(client, 'stepBack', { threadId: 1 });
    expect(stop).toMatchObject({ reason: 'step', description: 'no earlier history' });
  });

  it('refuses to step while running, and pauses', async () => {
    const client = await launch();
    await client.body('continue', { threadId: 1 });
    const next = await client.request('next', { threadId: 1 });
    expect(next.success).toBe(false);
    expect(next.message).toMatch(/while the machine is running/);
    const stop = await stopped(client, 'pause', { threadId: 1 });
    expect(stop.reason).toBe('pause');
  });

  it('frames and scanlines as units of time, and rewind by frames', async () => {
    const client = await launch();
    const frame = await stopped(client, 'gba-kit/stepFrame');
    expect(frame).toMatchObject({ reason: 'step', description: 'frame' });
    expect((await client.body<StateBody>('gba-kit/state')).frame).toBe(1);
    await stopped(client, 'gba-kit/stepScanline');
    expect((await client.body<StateBody>('gba-kit/state')).position.scanline).toBe(1);
    await stopped(client, 'gba-kit/stepFrame');
    await stopped(client, 'gba-kit/stepFrame');
    const rewound = await stopped(client, 'gba-kit/rewind', { frames: 2 });
    expect(rewound.reason).toBe('rewind');
    expect((await client.body<StateBody>('gba-kit/state')).frame).toBe(1);
  });
});

describe('inspection', () => {
  it('stack, scopes, variables, nested values with evaluate names, and memory references', async () => {
    const client = await launch({ breakpoints: [{ path: UTIL, lines: [await lineOf(UTIL, 'g_bonus_calls++;')] }] });
    await stopped(client, 'continue', { threadId: 1 });
    const { stackFrames } = await client.body<DebugProtocol.StackTraceResponse['body']>('stackTrace', { threadId: 1 });
    expect(stackFrames.map((f) => f.name)).toEqual(['add_bonus', 'update', 'main']);
    expect(stackFrames[0]!.source).toEqual({ name: 'util.c', path: UTIL });
    const { scopes } = await client.body<DebugProtocol.ScopesResponse['body']>('scopes', { frameId: 0 });
    expect(scopes.map((s) => s.name)).toEqual(['Locals', 'Globals (this file)', 'Registers', 'Machine']);
    expect(scopes[0]!.presentationHint).toBe('locals');

    const locals = await variables(client, scopes[0]!.variablesReference);
    expect(locals.map((v) => v.name)).toEqual(['value', 'bonus', 'result']);
    expect(locals[1]).toMatchObject({
      value: '2',
      evaluateName: 'bonus',
      memoryReference: expect.stringMatching(/^0x03/),
    });

    const registers = await variables(client, scopes[2]!.variablesReference);
    expect(registers.find((r) => r.name === 'sp')!.memoryReference).toMatch(/^0x03/);
    expect(registers.find((r) => r.name === 'cpsr')!.presentationHint).toEqual({ attributes: ['readOnly'] });

    // globals of main.c, from main's frame
    const mainGlobals = await variables(client, await scopeRef(client, 'Globals', 2));
    const player = mainGlobals.find((v) => v.name === 'g_player')!;
    expect(player.type).toBe('struct Player');
    expect(player.evaluateName).toBe('g_player');
    const members = await variables(client, player.variablesReference);
    const pos = members.find((m) => m.name === 'pos')!;
    expect(pos.evaluateName).toBe('g_player.pos');
    const x = (await variables(client, pos.variablesReference)).find((m) => m.name === 'x')!;
    expect(x).toMatchObject({ evaluateName: 'g_player.pos.x', value: expect.stringMatching(/^\d+ \(0x/) });
    const samples = mainGlobals.find((v) => v.name === 'g_samples')!;
    const elements = await variables(client, samples.variablesReference);
    expect(elements[1]!.evaluateName).toBe('g_samples[1]');
    const machine = await variables(client, scopes[3]!.variablesReference);
    expect(machine.find((v) => v.name === 'frame')!.evaluateName).toBe('frame');
    expect(machine.find((v) => v.name === 'function')!.evaluateName).toBeUndefined();
  });

  it('evaluates for hover, watch and the console, and expands results', async () => {
    const client = await launch({ breakpoints: [{ path: MAIN, lines: [await lineOf(MAIN, 'draw();')] }] });
    await stopped(client, 'continue', { threadId: 1 });
    const hover = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
      expression: 'g_player',
      context: 'hover',
      frameId: 0,
    });
    expect(hover.type).toBe('struct Player');
    expect(hover.memoryReference).toMatch(/^0x03/);
    const members = await variables(client, hover.variablesReference);
    expect(members.find((m) => m.name === 'mode')!.value).toBe('MODE_PLAY (1)');
    const watch = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
      expression: 'g_frame * 2 + 1',
      context: 'watch',
    });
    expect(watch.result).toBe('3 (0x3)');
    const bad = await client.request('evaluate', { expression: 'g_nope', context: 'repl' });
    expect(bad.success).toBe(false);
    expect(bad.message).toMatch(/g_nope/);
  });

  it('writes variables and registers', async () => {
    const client = await launch({ breakpoints: [{ path: MAIN, lines: [await lineOf(MAIN, 'update();')] }] });
    await stopped(client, 'continue', { threadId: 1 });
    const player = (await variables(client, await scopeRef(client, 'Globals'))).find((v) => v.name === 'g_player')!;
    const pos = (await variables(client, player.variablesReference)).find((m) => m.name === 'pos')!;
    const set = await client.body<DebugProtocol.SetVariableResponse['body']>('setVariable', {
      variablesReference: pos.variablesReference,
      name: 'x',
      value: '0xc8',
    });
    expect(set.value).toBe('200 (0xc8)');
    const registers = await scopeRef(client, 'Registers');
    const r0 = await client.body<DebugProtocol.SetVariableResponse['body']>('setVariable', {
      variablesReference: registers,
      name: 'r0',
      value: 'g_player.pos.x + 1',
    });
    expect(r0.value).toBe('0x000000c9');
    const cpsr = await client.request('setVariable', { variablesReference: registers, name: 'cpsr', value: '0' });
    expect(cpsr.success).toBe(false);
    // the machine moved: the old reference is stale
    await stopped(client, 'next', { threadId: 1 });
    const stale = await client.request('variables', { variablesReference: pos.variablesReference });
    expect(stale.success).toBe(false);
    expect(stale.message).toMatch(/stale/);
  });

  it('disassembles with symbols, labels and source, and reads and writes memory', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const client = await launch({ projectDir }); // labels persist there, not in the fixtures
    await stopped(client, 'gba-kit/stepFrame'); // the startup code has copied .data by now
    const main = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', { expression: '&main' });
    const { instructions } = await client.body<DebugProtocol.DisassembleResponse['body']>('disassemble', {
      memoryReference: main.memoryReference,
      instructionOffset: -2,
      instructionCount: 5,
    });
    expect(instructions.length).toBe(5);
    expect(instructions[2]).toMatchObject({
      address: main.memoryReference,
      symbol: 'main',
      line: await lineOf(MAIN, 'int main(void)'),
    });
    expect(instructions[2]!.location!.path).toBe(MAIN);
    expect(instructions[2]!.instructionBytes).toMatch(/^[0-9a-f]{2} [0-9a-f]{2}$/);

    await client.body('gba-kit/setLabel', {
      address: parseInt(instructions[3]!.address, 16),
      label: 'AfterPush',
      comment: 'frame pointer',
    });
    const again = await client.body<DebugProtocol.DisassembleResponse['body']>('disassemble', {
      memoryReference: instructions[3]!.address,
      instructionCount: 1,
    });
    expect(again.instructions[0]).toMatchObject({
      symbol: 'AfterPush',
      instruction: expect.stringContaining('; frame pointer'),
    });

    const unmapped = await client.body<DebugProtocol.DisassembleResponse['body']>('disassemble', {
      memoryReference: '0x04000000',
      instructionCount: 1,
    });
    expect(unmapped.instructions[0]!.presentationHint).toBe('invalid');

    const samples = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', { expression: '&g_samples' });
    const mem = await client.body<DebugProtocol.ReadMemoryResponse['body']>('readMemory', {
      memoryReference: samples.memoryReference,
      offset: 8,
      count: 8,
    });
    expect(Array.from(Buffer.from(mem.data!, 'base64'))).toEqual([8, 0, 0, 0, 13, 0, 0, 0]); // g_samples[2], [3]: untouched by the first frame
    const write = await client.body<DebugProtocol.WriteMemoryResponse['body']>('writeMemory', {
      memoryReference: samples.memoryReference,
      offset: 8,
      data: Buffer.from([9, 0, 0, 0]).toString('base64'),
    });
    expect(write.bytesWritten).toBe(4);
    expect(await num(client, 'g_samples[2]')).toBe(9);
    const edge = await client.body<DebugProtocol.ReadMemoryResponse['body']>('readMemory', {
      memoryReference: '0x00003ffc',
      count: 8,
    }); // the BIOS ends at 0x4000
    expect(edge.unreadableBytes).toBe(4);
  });
});

describe('emulator requests', () => {
  it('input, PPU views, I/O registers, memory search, trace and events', async () => {
    const client = await launch();
    expect((await client.body<{ buttons: number }>('gba-kit/input', { button: 0, down: true })).buttons).toBe(1);
    expect((await client.body<{ buttons: number }>('gba-kit/buttons', { mask: 0b110 })).buttons).toBe(0b110);
    await client.body('gba-kit/trace', { enabled: true });
    await stopped(client, 'gba-kit/stepFrame');
    await stopped(client, 'gba-kit/stepFrame');
    const palette = await client.body<GbaKitRequests['gba-kit/ppu']['body']>('gba-kit/ppu', { kind: 'palette' });
    expect(palette.kind === 'palette' && palette.bg.length).toBe(256);
    const tiles = await client.body<GbaKitRequests['gba-kit/ppu']['body']>('gba-kit/ppu', {
      kind: 'tiles',
      charBase: 0,
      bpp: 4,
      count: 2,
    });
    expect(tiles.kind === 'tiles' && Buffer.from(tiles.pixels, 'base64').length).toBe(128);
    const bgs = await client.body<GbaKitRequests['gba-kit/ppu']['body']>('gba-kit/ppu', { kind: 'backgrounds' });
    expect(bgs.kind === 'backgrounds' && bgs.mode).toBe(3);
    const sprites = await client.body<GbaKitRequests['gba-kit/ppu']['body']>('gba-kit/ppu', { kind: 'sprites' });
    expect(sprites.kind === 'sprites' && sprites.sprites.length).toBe(128);
    const io = await client.body<GbaKitRequests['gba-kit/ioRegisters']['body']>('gba-kit/ioRegisters');
    expect(io.registers.find((r) => r.name === 'DISPCNT')!.value).toBe(0x0403);
    expect(await num(client, 'g_keys')).toBe(6);
    const found = await client.body<{ addresses: number[] }>('gba-kit/searchMemory', {
      value: 6,
      size: 2,
      region: 'iwram',
    });
    const gKeys = parseInt(
      (await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', { expression: '&g_keys' })).result,
      10,
    );
    expect(found.addresses).toContain(gKeys);
    const trace = await client.body<GbaKitRequests['gba-kit/trace']['body']>('gba-kit/trace', { count: 5 });
    expect(trace.enabled).toBe(true);
    expect(trace.entries.length).toBe(5);
    expect(trace.entries[4]!.pc).toBeGreaterThanOrEqual(0x08000000);
    const events = await client.body<GbaKitRequests['gba-kit/events']['body']>('gba-kit/events', { count: 1000 });
    expect(events.entries.some((e) => e.event.kind === 'vblank')).toBe(true);
    const frame = await client.body<GbaKitRequests['gba-kit/frame']['body']>('gba-kit/frame');
    expect(Buffer.from(frame.rgba, 'base64').length).toBe(240 * 160 * 4);
    const unknown = await client.request('gba-kit/nope');
    expect(unknown.success).toBe(false);
  });

  it('labels persist under the project directory and import symbol files', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const client = await launch({ projectDir });
    const changed = client.event('gba-kit/labels');
    await client.body('gba-kit/setLabel', { address: 0x03000100, label: 'gMystery', size: 2 });
    await changed;
    expect(
      (await client.body<{ imported: number }>('gba-kit/importLabels', { text: '03000200 gOther\n' })).imported,
    ).toBe(1);
    const file = JSON.parse(await readFile(join(projectDir, '.gba-kit', 'labels.json'), 'utf8')) as {
      labels: Array<{ label: string }>;
    };
    expect(file.labels.map((l) => l.label).sort()).toEqual(['gMystery', 'gOther']);
    expect((await client.body<{ text: string }>('gba-kit/exportLabels')).text).toContain('03000200 gOther');
    expect(
      (await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', { expression: '&gMystery' })).result,
    ).toContain('50331904');
    const info = await client.body<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', {
      name: 'gMystery',
    });
    expect(info.dataId).toBe('50331904:2:gMystery');
  });

  it('save states and input recordings round-trip', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const client = await launch({ projectDir });
    await client.body('gba-kit/recordStart');
    await client.body('gba-kit/input', { button: 0, down: true });
    await stopped(client, 'gba-kit/stepFrame');
    await stopped(client, 'gba-kit/stepFrame');
    await client.body('gba-kit/input', { button: 0, down: false });
    await stopped(client, 'gba-kit/stepFrame');
    const saved = await client.body<GbaKitRequests['gba-kit/saveState']['body']>('gba-kit/saveState', {
      name: 'three frames',
    });
    expect(saved).toMatchObject({
      name: 'three frames',
      frame: 3,
      path: join(projectDir, '.gba-kit', 'states', 'three_frames.json'),
    });
    const rec = await client.body<GbaKitRequests['gba-kit/recordStop']['body']>('gba-kit/recordStop');
    expect(rec.recording.frames).toEqual([1, 1, 0]);
    expect(rec.script).toContain("press('a', { hold: 2 })");
    const keysAfter = await num(client, 'g_keys');

    await stopped(client, 'gba-kit/stepFrame');
    const replay = await stopped(client, 'gba-kit/replay', { recording: rec.recording });
    expect(replay.description).toMatch(/replayed 3 frames/);
    expect((await client.body<StateBody>('gba-kit/state')).frame).toBe(3);
    expect(await num(client, 'g_keys')).toBe(keysAfter);

    await stopped(client, 'gba-kit/stepFrame');
    const { states } = await client.body<GbaKitRequests['gba-kit/listStates']['body']>('gba-kit/listStates');
    expect(states.map((s) => s.name)).toEqual(['three frames']);
    const loaded = await stopped(client, 'gba-kit/loadState', { name: 'three frames' });
    expect(loaded.reason).toBe('restart');
    expect((await client.body<StateBody>('gba-kit/state')).frame).toBe(3);
    expect(await num(client, 'g_keys')).toBe(keysAfter);
  });

  it('streams frames to a pipe the client owns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(dir);
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\gba-kit-test-${process.pid}` : join(dir, 'frames.sock');
    const frames: Array<{ frame: number; width: number; height: number; rgba: Uint8Array }> = [];
    const server: Server = createServer((socket) => {
      const reader = new StreamReader((f) => frames.push(f));
      socket.on('data', (chunk: Buffer) => reader.push(chunk));
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      const client = await launch();
      expect((await client.body<{ connected: boolean }>('gba-kit/stream', { path: pipe })).connected).toBe(true);
      await stopped(client, 'gba-kit/stepFrame');
      await new Promise((r) => setTimeout(r, 50));
      expect(frames.length).toBeGreaterThanOrEqual(2);
      const last = frames[frames.length - 1]!;
      expect(last).toMatchObject({ width: 240, height: 160, frame: 1 });
      expect(last.rgba.length).toBe(240 * 160 * 4);
      const missing = await client.request('gba-kit/stream', { path: join(dir, 'nope.sock') });
      expect(missing.success).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
