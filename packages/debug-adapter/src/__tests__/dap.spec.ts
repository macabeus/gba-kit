/**
 * The adapter driven the way an editor drives it: real DAP messages over streams,
 * against the debug-core fixtures (one C program, built as Thumb -O0 except where a
 * test wants another build of it).
 */
import type { DebugProtocol } from '@vscode/debugprotocol';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type GbaKitRequests, LOG, STREAM, type SavedStateInfo, type StateBody } from '../protocol.js';
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

/** How many bytes a base64 string carries, for asserting a screen's size without decoding it. */
function base64Bytes(text: string): number {
  return Buffer.from(text, 'base64').length;
}

/**
 * What a directory holds once it holds `want` entries. A recording is written after
 * the response that stopped it: this session reads its own recordings from memory,
 * and the file is for the next one.
 */
async function filesIn(dir: string, want: number): Promise<string[]> {
  for (let i = 0; i < 200; i++) {
    const listed = await readdir(dir).catch(() => [] as string[]);
    if (listed.length === want) {
      return listed;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return readdir(dir);
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
    // a launch that fails is the one error the user must be told about, not just the console
    expect(missing.body?.error?.showUser).toBe(true);
    const directory = await client.request('launch', { rom: fixtures });
    expect(directory.message).toMatch(/ROM is not a file/);
    expect((await client.request('launch')).message).toMatch(/"rom" is required/);

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
    const epoch = (await client.body<StateBody>('gba-kit/state')).epoch;
    const restart = await stopped(client, 'restart');
    expect(restart.reason).toBe('restart');
    const state = await client.body<StateBody>('gba-kit/state');
    expect(state.frame).toBe(0);
    expect(state.epoch).toBeGreaterThan(epoch);
    expect((await stopped(client, 'continue', { threadId: 1 })).reason).toBe('breakpoint');
    // hit counts start over with the program
    await client.body('setBreakpoints', { source: { path: MAIN }, breakpoints: [{ line, hitCondition: '== 2' }] });
    expect((await stopped(client, 'continue', { threadId: 1 })).reason).toBe('breakpoint');
    await stopped(client, 'restart');
    expect((await stopped(client, 'continue', { threadId: 1 })).reason).toBe('breakpoint');
    expect((await client.body<StateBody>('gba-kit/state')).frame).toBe(1);
    const terminated = client.event('terminated');
    await client.body('terminate');
    await terminated;
  });

  it('restart reloads a rebuilt ROM and ELF from disk, with the breakpoints carried over', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(dir);
    const rom = join(dir, 'game.gba');
    const elf = join(dir, 'game.elf');
    await Promise.all([copyFile(ROM, rom), copyFile(ELF, elf)]);
    const line = await lineOf(MAIN, 'draw();');
    const client = new DapClient();
    clients.push(client);
    await client.body('initialize', { adapterID: 'gba-kit', pathFormat: 'path' });
    const config = { rom, elf, cwd: fixtures, stopOnEntry: true };
    const launched = client.request('launch', config);
    await client.event('initialized');
    await client.body('setBreakpoints', { source: { path: MAIN }, breakpoints: [{ line }] });
    await client.body('setFunctionBreakpoints', { breakpoints: [{ name: 'add_bonus' }] });
    const info = await client.body<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', {
      name: 'g_bonus_calls',
    });
    await client.body('setDataBreakpoints', { breakpoints: [{ dataId: info.dataId!, accessType: 'write' }] });
    await client.body('configurationDone');
    expect((await launched).success).toBe(true);
    const sessions: unknown[] = [];
    client.adapter.onSession((s) => sessions.push(s));
    const before = (await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', { expression: '&update' }))
      .memoryReference;

    // the "build" rewrote both files: the -O2 program lays its functions out elsewhere
    const rebuilt = await readFile(join(fixtures, 'build', 'thumb-O2.gba'));
    await Promise.all([writeFile(rom, rebuilt), copyFile(join(fixtures, 'build', 'thumb-O2.elf'), elf)]);
    for (const args of [undefined, { arguments: config }]) {
      const restart = await stopped(client, 'restart', args);
      expect(restart.reason).toBe('restart');
      const state = await client.body<StateBody>('gba-kit/state');
      expect(state).toMatchObject({ frame: 0, pc: 0x08000000 });
      const memory = await client.body<DebugProtocol.ReadMemoryResponse['body']>('readMemory', {
        memoryReference: '0x08000000',
        count: 4096,
      });
      expect(Buffer.from(memory.data!, 'base64').equals(rebuilt.subarray(0, 4096))).toBe(true);
      const after = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', { expression: '&update' });
      expect(after.memoryReference).not.toBe(before);
    }
    expect(sessions.length).toBe(3); // the launch's, and one per restart
    // every kind of breakpoint carried over, the data breakpoint to its symbol's new address
    const reasons = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const stop = await stopped(client, 'continue', { threadId: 1 });
      reasons.add(stop.reason);
      if (stop.reason === 'breakpoint') {
        expect((await topFrame(client)).line).toBe(line);
      }
    }
    expect([...reasons]).toEqual(expect.arrayContaining(['breakpoint', 'data breakpoint']));

    // a restart that cannot load says so and leaves the running program alone
    await rm(elf);
    const failed = await client.request('restart');
    expect(failed.success).toBe(false);
    expect(failed.message).toMatch(/cannot restart: ELF not found/);
    expect(failed.body?.error?.showUser).toBe(true);
    expect((await client.body<StateBody>('gba-kit/state')).state).toBe('stopped');
  });

  it('refuses a second launch, and disposes the session on disconnect', async () => {
    const client = await launch();
    const session = client.adapter.session!;
    const dispose = vi.spyOn(session, 'dispose');
    const again = await client.request('launch', { rom: ROM, elf: ELF, cwd: fixtures });
    expect(again.success).toBe(false);
    expect(again.message).toMatch(/already launched/);
    expect(client.events('initialized').length).toBe(1);
    expect(client.events('stopped').length).toBe(1);
    expect(client.adapter.session).toBe(session);
    await client.body('disconnect');
    expect(dispose).toHaveBeenCalledTimes(1);
    clients.splice(clients.indexOf(client), 1);
  });

  it('holds no timer after the launch has been answered', async () => {
    const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const idle = timers();
    await launch();
    // The count is process-wide, so a timer of someone else's may end while the launch
    // runs; what this pins is that the adapter leaves none of its own behind (the
    // configuration wait must be cleared once the launch is answered), so the count
    // may fall but never rise.
    expect(timers()).toBeLessThanOrEqual(idle);
  });

  it('a waiter of the test client sees an event that already arrived, unless told to look later', async () => {
    const client = await launch();
    const entry = await client.event<DebugProtocol.StoppedEvent>('stopped', () => true, 500);
    expect(entry.body.reason).toBe('entry');
    await expect(client.event('stopped', () => true, 200, client.log.length)).rejects.toThrow(/no 'stopped' event/);
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

  it('a data breakpoint with a malformed condition is reported unverified, not as a failed request', async () => {
    const client = await launch();
    const info = await client.body<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', {
      name: 'g_bonus_calls',
    });
    const { breakpoints } = await client.body<DebugProtocol.SetDataBreakpointsResponse['body']>('setDataBreakpoints', {
      breakpoints: [
        { dataId: info.dataId!, accessType: 'write' },
        { dataId: info.dataId!, accessType: 'write', condition: '1 +' },
      ],
    });
    expect(breakpoints[0]).toMatchObject({ verified: true });
    expect(breakpoints[1]).toMatchObject({ verified: false, message: expect.stringMatching(/unexpected end/) });
    expect((await stopped(client, 'continue', { threadId: 1 })).reason).toBe('data breakpoint');
  });

  it('a local can be watched from its frame', async () => {
    const client = await launch({
      breakpoints: [{ path: MAIN, lines: [await lineOf(MAIN, 'move_player(&g_player')] }],
    });
    await stopped(client, 'continue', { threadId: 1 });
    const locals = await scopeRef(client, 'Locals');
    const fromView = await client.body<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', {
      name: 'bonus',
      variablesReference: locals,
    });
    expect(fromView.dataId).toMatch(/^\d+:4:bonus$/);
    expect(fromView.canPersist).toBe(false);
    const fromFrame = await client.body<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', {
      name: 'bonus',
      frameId: 0,
    });
    expect(fromFrame.dataId).toBe(fromView.dataId);
    await client.body('setBreakpoints', { source: { path: MAIN }, breakpoints: [] });
    await client.body('setDataBreakpoints', { breakpoints: [{ dataId: fromFrame.dataId!, accessType: 'write' }] });
    const stop = await stopped(client, 'continue', { threadId: 1 });
    expect(stop.reason).toBe('data breakpoint');
    expect(stop.description).toMatch(/^bonus written/);
  });

  it('refuses a data breakpoint id it did not hand out, in place, and prints a watched word as bits', async () => {
    const line = await lineOf(MAIN, 'draw();');
    const client = await launch({ breakpoints: [{ path: MAIN, lines: [line] }] });
    const { breakpoints } = await client.body<DebugProtocol.SetDataBreakpointsResponse['body']>('setDataBreakpoints', {
      breakpoints: [
        { dataId: 'garbage' },
        { dataId: '' },
        { dataId: '50331648:0:x' },
        { dataId: '50331648:1000000000:x', accessType: 'readWrite' },
        { dataId: '4294967295:4:w' },
        { dataId: '50331648:4:x', accessType: 'bogus' as DebugProtocol.DataBreakpointAccessType },
      ],
    });
    expect(breakpoints.map((b) => b.verified)).toEqual([false, false, false, false, false, false]);
    expect(breakpoints[0]!.message).toMatch(/not a data breakpoint id/);
    expect(breakpoints[2]!.message).toMatch(/cannot watch 0 bytes/);
    expect(breakpoints[3]!.message).toMatch(/cannot watch 1000000000 bytes/);
    expect(breakpoints[4]!.message).toMatch(/no memory at 4294967295/);
    expect(breakpoints[5]!.message).toMatch(/unknown access type 'bogus'/);
    // nothing watches all of memory: the run reaches the source breakpoint
    expect((await stopped(client, 'continue', { threadId: 1 })).reason).toBe('breakpoint');

    // the first ROM word, whose top bit is set, reads as its bits rather than a negative number
    await stopped(client, 'restart');
    const rom = await client.body<DebugProtocol.SetDataBreakpointsResponse['body']>('setDataBreakpoints', {
      breakpoints: [{ dataId: '134217728:4:0x8000000', accessType: 'read' }],
    });
    expect(rom.breakpoints[0]!.verified).toBe(true);
    const stop = await stopped(client, 'continue', { threadId: 1 });
    expect(stop.reason).toBe('data breakpoint');
    expect(stop.description).toMatch(/^0x8000000 read \(0x[0-9a-f]{1,8}, 4 bytes at 0x8000000\)/);
    expect(stop.description).not.toContain('0x-');
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
    // a range far past the file costs the file's lines, not the range's
    const lines = (await readFile(MAIN, 'utf8')).split('\n').length;
    const started = performance.now();
    const whole = await client.body<DebugProtocol.BreakpointLocationsResponse['body']>('breakpointLocations', {
      source: { path: MAIN },
      line: 1,
      endLine: 10_000_000,
    });
    expect(performance.now() - started).toBeLessThan(1000);
    const file = await client.body<DebugProtocol.BreakpointLocationsResponse['body']>('breakpointLocations', {
      source: { path: MAIN },
      line: 1,
      endLine: lines,
    });
    expect(whole).toEqual(file);
    expect(whole.breakpoints.length).toBeGreaterThan(20);
    expect(whole.breakpoints.every((b) => b.line >= 1 && b.line <= lines)).toBe(true);
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

  it('says when a rewind cannot move, instead of stopping in place as if it had', async () => {
    const client = await launch();
    for (const [command, args] of [
      ['gba-kit/rewindToFrame', { frame: 1_000_000_000 }],
      ['gba-kit/rewindToFrame', { frame: -1 }],
      ['gba-kit/rewind', { frames: 1 }],
    ] as const) {
      const at = client.log.length;
      const stop = await client.stopAfter(async () => {
        const r = await client.body<{ rewound: boolean }>(command, args);
        expect(r.rewound).toBe(false);
      });
      expect(stop.body).toMatchObject({ reason: 'step', description: 'nothing earlier to rewind to' });
      expect(client.kinds(at)[0]).toBe(`response:${command}`);
    }
    expect((await client.body<StateBody>('gba-kit/state')).position).toMatchObject({ frame: 0, instruction: 0 });
    // from inside a frame, the start of that frame is a move
    await stopped(client, 'next', { threadId: 1, granularity: 'instruction' });
    const back = await stopped(client, 'gba-kit/rewindToFrame', { frame: 0 });
    expect(back.reason).toBe('rewind');
    expect((await client.body<StateBody>('gba-kit/state')).position).toMatchObject({ frame: 0, instruction: 0 });
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
    // a rewind is at least one frame: 0 does not stop in place as if it had moved
    expect((await stopped(client, 'gba-kit/rewind', { frames: 0 })).reason).toBe('rewind');
    expect((await client.body<StateBody>('gba-kit/state')).frame).toBe(0);
  });
});

describe('inspection', () => {
  it('stack, scopes, variables, nested values with evaluate names, and memory references', async () => {
    const client = await launch({ breakpoints: [{ path: UTIL, lines: [await lineOf(UTIL, 'g_bonus_calls++;')] }] });
    await stopped(client, 'continue', { threadId: 1 });
    const { stackFrames } = await client.body<DebugProtocol.StackTraceResponse['body']>('stackTrace', { threadId: 1 });
    // The frames, then one row saying where the stack ends and why, rather than
    // leaving the reader to guess whether it ran out of program or of information.
    expect(stackFrames.map((f) => f.name)).toEqual([
      'add_bonus',
      'update',
      'main',
      "— the stack ends here: the outermost frame's saved return address reads 0, which is either the root of the stack or a slot the program overwrote",
    ]);
    expect(stackFrames[0]!.source).toEqual({ name: 'util.c', path: UTIL });
    expect(stackFrames.at(-1)).toMatchObject({ presentationHint: 'label', id: -1 });
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
    // a pointer's one row is what it points at, and it evaluates back to the same value
    const counterRef = members.find((m) => m.name === 'counterRef')!;
    const pointee = (await variables(client, counterRef.variablesReference))[0]!;
    expect(pointee.evaluateName).toBe('(*(g_player.counterRef))');
    // Every name the tree hands back reads as the row it came from — the value, not
    // merely a string, since a name that parses differently would still answer.
    for (const row of [player, samples, ...members, ...elements, pointee]) {
      if (row.evaluateName === undefined) {
        continue;
      }
      const back = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
        expression: row.evaluateName,
        frameId: 2,
      });
      expect([row.evaluateName, back.result]).toEqual([row.evaluateName, row.value]);
    }
    const machine = await variables(client, scopes[3]!.variablesReference);
    expect(machine.find((v) => v.name === 'frame')!.evaluateName).toBe('frame');
    expect(machine.find((v) => v.name === 'function')!.evaluateName).toBeUndefined();
  });

  it('a value the console computed hands its rows back as expressions that read the same', async () => {
    const client = await launch({ breakpoints: [{ path: UTIL, lines: [await lineOf(UTIL, 'if (p->pos.x > 100)')] }] });
    await stopped(client, 'continue', { threadId: 1 });
    // A watch on an arrow, a dereference or a cast expands like a variables row, and
    // every row below it names itself in the grammar that produced it.
    for (const expression of ['p->pos', '*p', '(struct Player *)p', '&g_player']) {
      const top = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', { expression, frameId: 0 });
      expect(top.variablesReference).toBeGreaterThan(0);
      for (const row of await variables(client, top.variablesReference)) {
        expect([expression, row.name, row.evaluateName]).not.toEqual([expression, row.name, undefined]);
        const back = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
          expression: row.evaluateName!,
          frameId: 0,
        });
        expect([row.evaluateName, back.result]).toEqual([row.evaluateName, row.value]);
        // and one level deeper, where a dereference that did not parenthesise itself
        // would bind to the pointer instead of to what it points at
        for (const deeper of row.variablesReference ? await variables(client, row.variablesReference) : []) {
          const again = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
            expression: deeper.evaluateName!,
            frameId: 0,
          });
          expect([deeper.evaluateName, again.result]).toEqual([deeper.evaluateName, deeper.value]);
        }
      }
    }
  });

  it('refuses a frame the stack does not have, and an empty expression', async () => {
    const client = await launch({ breakpoints: [{ path: UTIL, lines: [await lineOf(UTIL, 'g_bonus_calls++;')] }] });
    await stopped(client, 'continue', { threadId: 1 });
    const sp = await client.request('evaluate', { expression: 'sp', frameId: 7 });
    expect(sp.success).toBe(false);
    expect(sp.message).toMatch(/no frame 7/);
    const bonus = await client.request('evaluate', { expression: 'bonus', frameId: 7 });
    expect(bonus.message).toMatch(/no frame 7/);
    expect((await client.request('evaluate', { expression: 'sp', frameId: -1 })).success).toBe(false);
    expect((await client.request('evaluate', { frameId: 0 })).message).toMatch(/empty expression/);
    expect((await client.request('scopes', { frameId: 7 })).success).toBe(false);
    expect((await client.request('evaluate', { expression: 'bonus', frameId: 1 })).success).toBe(true);
  });

  it('writes through an assignment typed in the console, and never through a hover', async () => {
    const client = await launch({ breakpoints: [{ path: MAIN, lines: [await lineOf(MAIN, 'draw();')] }] });
    await stopped(client, 'continue', { threadId: 1 });

    const written = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
      expression: 'g_player.pos.x = 42',
      context: 'repl',
    });
    expect(written.result).toBe('42 (0x0000002a)');
    expect(await num(client, 'g_player.pos.x')).toBe(42);
    // an assignment answers with the value as the debugger reads it back: the enumerator, not the 2 that was written
    const struct = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
      expression: 'g_player.mode = 2',
      context: 'repl',
    });
    expect(struct.result).toBe('MODE_DONE (2)');

    // a hover reads the same text; the machine must not move
    const hover = await client.request('evaluate', { expression: 'g_player.pos.x = 7', context: 'hover' });
    expect(hover.success).toBe(false);
    expect(await num(client, 'g_player.pos.x')).toBe(42);

    // a comparison in the console stays a comparison
    const compared = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
      expression: 'g_player.pos.x == 42',
      context: 'repl',
    });
    expect(compared.result.startsWith('1')).toBe(true);
    expect(await num(client, 'g_player.pos.x')).toBe(42);

    // a variable index is a place like any other, in the console and in a hover
    const indexed = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
      expression: 'g_samples[g_frame & 3] = 5',
      context: 'repl',
    });
    expect(indexed.result).toBe('5');
    const readBack = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
      expression: 'g_samples[g_frame & 3]',
      context: 'hover',
    });
    expect(readBack.result).toBe('5');
    expect(readBack.memoryReference).toMatch(/^0x03/);

    // what cannot be written is refused where it was asked, not as a notification
    const refused = await client.request('evaluate', { expression: 'g_player.pos = 1', context: 'repl' });
    expect(refused.success).toBe(false);
    expect(refused.message).toMatch(/cannot write 'g_player.pos'/);
    expect(refused.body?.error?.showUser).toBeFalsy();
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
    const constant = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
      expression: 'MODE_PLAY',
      context: 'watch',
    });
    expect(constant).toMatchObject({ result: 'MODE_PLAY (1)', type: 'enum Mode (constant)' });
    // a member evaluates as the tree shows it
    const y = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
      expression: 'g_player.pos.y',
      context: 'watch',
    });
    expect(y).toMatchObject({ result: '-7', type: 'int' });
    const bad = await client.request('evaluate', { expression: 'g_nope', context: 'repl' });
    expect(bad.success).toBe(false);
    expect(bad.message).toMatch(/g_nope/);
    expect(bad.body?.error?.showUser).toBeFalsy();
  });

  it('answers a failed evaluation where it was asked, never as a notification', async () => {
    const client = await launch({ breakpoints: [{ path: MAIN, lines: [await lineOf(MAIN, 'draw();')] }] });
    await stopped(client, 'continue', { threadId: 1 });
    // an editor's hover sends whatever is under the mouse: a space, a keyword, a type name
    for (const [expression, context, message] of [
      ['', 'hover', /empty expression/],
      [' ', 'hover', /empty expression/],
      ['if', 'hover', /unknown symbol 'if'/],
      ['u16', 'hover', /unknown symbol 'u16'/],
      ['nosuch', 'watch', /unknown symbol 'nosuch'/],
    ] as const) {
      const r = await client.request('evaluate', { expression, context, frameId: 0 });
      expect(r.success).toBe(false);
      expect(r.message).toMatch(message);
      expect(r.body?.error?.showUser).toBeFalsy();
    }
    const registers = await scopeRef(client, 'Registers');
    const empty = await client.request('setVariable', { variablesReference: registers, name: 'r0', value: '' });
    expect(empty.success).toBe(false);
    expect(empty.message).toMatch(/empty expression/);
    expect(empty.body?.error?.showUser).toBeFalsy();
    const unknown = await client.request('gba-kit/nope');
    expect(unknown.success).toBe(false);
    expect(unknown.body?.error?.showUser).toBeFalsy();
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
    expect(set.value).toBe('200 (0x000000c8)');
    // a write does not invalidate the references the view still holds: they read again
    const y = await client.body<DebugProtocol.SetVariableResponse['body']>('setVariable', {
      variablesReference: pos.variablesReference,
      name: 'y',
      value: '7',
    });
    expect(y.value).toBe('7');
    expect((await variables(client, pos.variablesReference)).map((m) => m.value)).toEqual(['200 (0x000000c8)', '7']);
    const registers = await scopeRef(client, 'Registers');
    const r0 = await client.body<DebugProtocol.SetVariableResponse['body']>('setVariable', {
      variablesReference: registers,
      name: 'r0',
      value: 'g_player.pos.x + 1',
    });
    expect(r0.value).toBe('0x000000c9');
    const at = client.log.length;
    const r1 = await client.body<DebugProtocol.SetVariableResponse['body']>('setVariable', {
      variablesReference: registers,
      name: 'r1',
      value: '9',
    });
    expect(r1.value).toBe('0x00000009');
    // the state event follows the response, as after every write
    expect(client.kinds(at)).toEqual(['response:setVariable', 'event:gba-kit/state']);
    for (const [value, shown] of [
      ['-0x10', '0xfffffff0'],
      ['-16', '0xfffffff0'],
      ['0xfffffff0', '0xfffffff0'],
      ['0b101', '0x00000005'],
      ['MODE_PLAY', '0x00000001'],
      ['sp', undefined],
    ] as const) {
      const r2 = await client.body<DebugProtocol.SetVariableResponse['body']>('setVariable', {
        variablesReference: registers,
        name: 'r2',
        value,
      });
      expect(r2.value).toBe(shown ?? (await variables(client, registers)).find((r) => r.name === 'sp')!.value);
    }
    const cpsr = await client.request('setVariable', { variablesReference: registers, name: 'cpsr', value: '0' });
    expect(cpsr.success).toBe(false);
    expect(cpsr.message).toMatch(/not writable/);
    expect(cpsr.body?.error?.id).toBe(1007);
    expect(cpsr.body?.error?.showUser).toBeFalsy();
    // the machine moved: the old reference is stale, and says so by its own code
    await stopped(client, 'next', { threadId: 1 });
    const stale = await client.request('variables', { variablesReference: pos.variablesReference });
    expect(stale.success).toBe(false);
    expect(stale.message).toMatch(/stale/);
    expect(stale.body?.error?.id).toBe(1008);
    expect(stale.body?.error?.showUser).toBeFalsy();
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
    const globals = await scopeRef(client, 'Globals');
    const at = client.log.length;
    const write = await client.body<DebugProtocol.WriteMemoryResponse['body']>('writeMemory', {
      memoryReference: samples.memoryReference,
      offset: 8,
      data: Buffer.from([9, 0, 0, 0]).toString('base64'),
    });
    expect(write.bytesWritten).toBe(4);
    expect(client.kinds(at)).toEqual(['response:writeMemory', 'event:gba-kit/state']);
    expect(await num(client, 'g_samples[2]')).toBe(9);
    // a reference from before the write still reads, and shows it
    const shown = (await variables(client, globals)).find((v) => v.name === 'g_samples')!;
    expect((await variables(client, shown.variablesReference))[2]!.value).toMatch(/^9\b/);
    const edge = await client.body<DebugProtocol.ReadMemoryResponse['body']>('readMemory', {
      memoryReference: '0x00003ffc',
      count: 8,
    }); // the BIOS ends at 0x4000
    expect(edge.unreadableBytes).toBe(4);
    const backwards = await client.body<DebugProtocol.ReadMemoryResponse['body']>('readMemory', {
      memoryReference: '0x03000004',
      offset: -4,
      count: 4,
    }); // a negative offset is the protocol's
    expect(backwards).toMatchObject({ address: '0x03000000', unreadableBytes: 0 });
  });

  it('refuses a memory or disassembly request it cannot answer, by the field at fault', async () => {
    const client = await launch();
    const refuse = async (command: string, args: unknown, message: RegExp): Promise<void> => {
      const r = await client.request(command, args);
      expect(r.success, `${command} ${JSON.stringify(args)}`).toBe(false);
      expect(r.message).toMatch(message);
      expect(r.message).not.toMatch(/Cannot read properties|is not a function|Invalid typed array/);
    };
    await refuse('readMemory', { memoryReference: '0x03000000', count: -4 }, /'count' must be an integer/);
    await refuse('readMemory', { memoryReference: '0x03000000' }, /'count' must be an integer/);
    await refuse('readMemory', { memoryReference: '0x03000000', count: 2.5 }, /'count' must be an integer/);
    await refuse('readMemory', { memoryReference: '0x03000000', count: 1e9 }, /'count' must be an integer/);
    await refuse('readMemory', { memoryReference: '', count: 4 }, /not an address/);
    await refuse('readMemory', { count: 4 }, /not an address/);
    await refuse('readMemory', { memoryReference: '0x1p3', count: 4 }, /not an address/);
    await refuse('readMemory', { memoryReference: '0x03000000', offset: 4294967296, count: 4 }, /out of range/);
    await refuse('writeMemory', { memoryReference: '0x03000000' }, /missing 'data'/);
    await refuse('writeMemory', { memoryReference: '0x03000000', data: '!!!not base64!!!' }, /not base64/);
    await refuse('disassemble', { memoryReference: '0x08000000', instructionCount: -5 }, /instructionCount/);
    await refuse('disassemble', { memoryReference: '0x08000000' }, /instructionCount/);
    // a count no editor asks for is answered in bounds, and the adapter is not busy for minutes
    const started = performance.now();
    const { instructions } = await client.body<DebugProtocol.DisassembleResponse['body']>('disassemble', {
      memoryReference: '0x08000000',
      instructionCount: 10_000_000,
    });
    expect(instructions.length).toBe(4096);
    expect(performance.now() - started).toBeLessThan(5000);
    expect((await client.request('threads')).success).toBe(true);
    const zero = await client.body<DebugProtocol.ReadMemoryResponse['body']>('readMemory', {
      memoryReference: '0x03000000',
      count: 0,
    });
    expect(zero).toMatchObject({ data: '', unreadableBytes: 0 });
  });
});

describe('a stack the ELF has no call-frame information for', () => {
  // thumb-O0 with .debug_frame removed — the shape a decomp ELF has. Same ROM, so
  // only what the unwinder has to work with changes.
  const NO_CFI = join(fixtures, 'build', 'thumb-O0-nocfi.elf');

  it('unwinds past the two frames an lr guess gives, saying how each frame was recovered', async () => {
    const client = await launch({
      elf: NO_CFI,
      breakpoints: [{ path: UTIL, lines: [await lineOf(UTIL, 'return result;')] }],
    });
    await stopped(client, 'continue', { threadId: 1 });
    const { stackFrames, totalFrames } = await client.body<DebugProtocol.StackTraceResponse['body']>('stackTrace', {
      threadId: 1,
    });
    expect(stackFrames.map((f) => f.name)).toEqual([
      'add_bonus',
      'update (from its prologue)',
      'main (from its prologue)',
      expect.stringContaining('the stack ends here'),
    ]);
    expect(totalFrames).toBe(4);
    expect(stackFrames.at(-1)).toMatchObject({ presentationHint: 'label', id: -1 });
    // A measured frame is not a guess, so it is not dimmed.
    expect(stackFrames.slice(0, 3).every((f) => f.presentationHint === 'normal')).toBe(true);
  });

  it('answers scopes, variables and evaluate for a frame that is not the top one', async () => {
    const client = await launch({
      elf: NO_CFI,
      breakpoints: [{ path: UTIL, lines: [await lineOf(UTIL, 'return result;')] }],
    });
    await stopped(client, 'continue', { threadId: 1 });
    const { scopes } = await client.body<DebugProtocol.ScopesResponse['body']>('scopes', { frameId: 1 });
    const locals = await variables(client, scopes[0]!.variablesReference);
    expect(locals.map((v) => v.name)).toEqual(['bonus', 'total']);
    expect(locals[0]!.value).toBe('2');
    const { result } = await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', {
      expression: 'bonus',
      frameId: 1,
    });
    expect(result).toContain('2');
    // and the registers of that frame, not the machine's
    const registers = await variables(client, scopes.find((s) => s.name === 'Registers')!.variablesReference);
    expect(registers.find((v) => v.name === 'r0')!.value).toBe('<not recovered in this frame>');
    expect(registers.find((v) => v.name === 'sp')!.value).not.toBe('<not recovered in this frame>');
  });

  it('unwinds an interrupt handler deep enough that frame 3 is real, and names the boundary', async () => {
    const client = await launch({ elf: NO_CFI });
    await client.body('setFunctionBreakpoints', { breakpoints: [{ name: 'isr' }] });
    await stopped(client, 'continue', { threadId: 1 });
    const { stackFrames } = await client.body<DebugProtocol.StackTraceResponse['body']>('stackTrace', { threadId: 1 });
    expect(stackFrames.map((f) => f.name).slice(0, 4)).toEqual([
      'isr',
      '<BIOS stub +0x90>',
      'wait_vblank',
      'main (from its prologue)',
    ]);
    expect(stackFrames[1]!.source).toBeUndefined();
    const { scopes } = await client.body<DebugProtocol.ScopesResponse['body']>('scopes', { frameId: 3 });
    expect(scopes.map((s) => s.name)).toContain('Registers');
    // The interrupted frame says which of its registers the handler may be holding.
    const interrupted = await client.body<DebugProtocol.ScopesResponse['body']>('scopes', { frameId: 2 });
    expect(interrupted.scopes[0]!.name).toMatch(/^Locals — r4–r11 were not recovered across the interrupt/);
  });
});

describe('emulator requests', () => {
  it('input, PPU views, I/O registers, memory search, trace and events', async () => {
    const client = await launch();
    expect((await client.body<{ buttons: number }>('gba-kit/input', { button: 0, down: true })).buttons).toBe(1);
    expect((await client.body<{ buttons: number }>('gba-kit/buttons', { mask: 0b110 })).buttons).toBe(0b110);
    expect((await client.body<{ buttons: number }>('gba-kit/buttons', { mask: 0b1000000011 })).buttons).toBe(
      0b1000000011,
    );
    expect((await client.body<{ buttons: number }>('gba-kit/buttons', { mask: 0b110 })).buttons).toBe(0b110);
    let at = client.log.length;
    const toggled = await client.body<GbaKitRequests['gba-kit/trace']['body']>('gba-kit/trace', {
      enabled: true,
      count: 0,
    });
    expect(toggled).toEqual({ enabled: true, entries: [] }); // an explicit 0: the flag alone
    expect(client.kinds(at)).toEqual(['response:gba-kit/trace', 'event:gba-kit/state']);
    expect((client.events('gba-kit/state').at(-1)!.body as StateBody).tracing).toBe(true);
    at = client.log.length;
    await client.body('gba-kit/trace', { enabled: true });
    expect(client.kinds(at)).toEqual(['response:gba-kit/trace']); // already on: nothing changed
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
    // `&g_keys` is a pointer: a hex address, as the variables tree spells one
    const gKeys = Number(
      (await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', { expression: '&g_keys' })).result,
    );
    expect(found.addresses).toContain(gKeys);
    const trace = await client.body<GbaKitRequests['gba-kit/trace']['body']>('gba-kit/trace', { count: 5 });
    expect(trace.enabled).toBe(true);
    expect(trace.entries.length).toBe(5);
    expect(trace.entries[4]!.pc).toBeGreaterThanOrEqual(0x08000000);
    const events = await client.body<GbaKitRequests['gba-kit/events']['body']>('gba-kit/events', { count: 1000 });
    expect(events.entries.some((e) => e.event.kind === 'vblank')).toBe(true);
    expect(
      (await client.body<GbaKitRequests['gba-kit/events']['body']>('gba-kit/events', { count: 0 })).entries,
    ).toEqual([]);
    expect(
      (await client.body<GbaKitRequests['gba-kit/trace']['body']>('gba-kit/trace', { count: 1e9 })).entries.length,
    ).toBeLessThanOrEqual(LOG.max);
    const frame = await client.body<GbaKitRequests['gba-kit/frame']['body']>('gba-kit/frame');
    expect(frame).toMatchObject({ width: STREAM.width, height: STREAM.height });
    expect(Buffer.from(frame.rgba, 'base64').length).toBe(STREAM.width * STREAM.height * 4);
    const unknown = await client.request('gba-kit/nope');
    expect(unknown.success).toBe(false);
    expect(unknown.message).toMatch(/unknown request 'gba-kit\/nope'/);
  });

  it('refuses a malformed request by the field at fault, changing nothing', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const client = await launch({ projectDir });
    const cases: Array<[string, unknown, RegExp]> = [
      ['setBreakpoints', {}, /missing 'source'/],
      ['setBreakpoints', { source: { path: MAIN }, breakpoints: [{}] }, /'line' must be an integer/],
      ['setFunctionBreakpoints', { breakpoints: [{}] }, /missing 'name'/],
      ['setInstructionBreakpoints', { breakpoints: [{}] }, /not an address: undefined/],
      ['dataBreakpointInfo', {}, /missing 'name'/],
      ['dataBreakpointInfo', { name: 42 }, /'name' must be a string/],
      ['evaluate', { frameId: 0 }, /empty expression/],
      ['setVariable', { variablesReference: 1, value: '1' }, /missing 'name'/],
      ['gba-kit/setLabel', { address: 'abc', label: 'x' }, /not an address: abc/],
      ['gba-kit/setLabel', { address: 0x03000000, label: 42 }, /'label' must be a string/],
      ['gba-kit/setLabel', {}, /not an address: undefined/],
      ['gba-kit/setLabel', { address: 0x03000000, label: 'x', size: 0 }, /'size' must be an integer/],
      ['gba-kit/importLabels', {}, /missing 'text'/],
      ['gba-kit/importLabels', { text: 42 }, /'text' must be a string/],
      ['gba-kit/searchMemory', { value: 0, size: 3 }, /'size' must be 1, 2 or 4/],
      ['gba-kit/searchMemory', { value: 'x', size: 4 }, /'value' must be a number/],
      ['gba-kit/searchMemory', { value: 0, size: 4, region: 'vram' }, /unknown region 'vram'/],
      ['gba-kit/filterMemory', {}, /'value' must be a number/],
      ['gba-kit/filterMemory', { value: 0, size: 4, addresses: 'x' }, /'addresses' must be a list/],
      ['gba-kit/input', { button: 99, down: true }, /'button' must be an integer from 0 to 9/],
      ['gba-kit/buttons', {}, /'mask' must be an integer/],
      ['gba-kit/saveState', { name: 42 }, /'name' must be a string/],
      ['gba-kit/replay', {}, /missing 'recording'/],
      ['gba-kit/replay', { recording: { romHash: 'x' } }, /not an input recording/],
      ['gba-kit/stream', {}, /missing 'path'/],
      ['gba-kit/stream', { path: '' }, /'path' is empty/],
      ['gba-kit/loadState', {}, /give a state name or path/],
      ['gba-kit/loadState', { name: '' }, /'name' is empty/],
      ['gba-kit/importSave', {}, /missing 'bytes'/],
      ['gba-kit/importSave', { bytes: 7 }, /'bytes' must be a string/],
      ['gba-kit/importSave', { bytes: 'AAAA', name: 42 }, /'name' must be a string/],
    ];
    for (const [command, args, message] of cases) {
      const r = await client.request(command, args);
      expect(r.success, `${command} ${JSON.stringify(args)}`).toBe(false);
      expect(r.message, command).toMatch(message);
      expect(r.message).not.toMatch(/Cannot read properties|is not a function|is not iterable|Received/);
      expect(r.body?.error?.showUser).toBeFalsy();
    }
    // a missing list of breakpoints clears them, as the protocol's empty list does
    expect((await client.request('setExceptionBreakpoints', {})).success).toBe(true);
    expect((await client.request('setFunctionBreakpoints', {})).success).toBe(true);
    expect((await client.body<{ labels: unknown[] }>('gba-kit/labels')).labels).toEqual([]);
    await expect(readFile(join(projectDir, '.gba-kit', 'labels.json'))).rejects.toThrow();
    expect((await client.body<{ buttons: number }>('gba-kit/state')) as unknown).toMatchObject({ frame: 0 });
  });

  it('reads only the states directory for a load, and lists states without reading their snapshots', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const client = await launch({ projectDir });
    const statesDir = join(projectDir, '.gba-kit', 'states');
    await mkdir(statesDir, { recursive: true });
    await writeFile(join(projectDir, 'outside.txt'), 'SECRET_TOKEN=abc123');
    await writeFile(join(statesDir, 'junk.json'), 'not json');
    await writeFile(join(statesDir, 'other.json'), JSON.stringify({ format: 'something-else', name: 'x' }));
    for (const [args, message] of [
      [{ path: '/etc/hosts' }, /state files live under/],
      [{ path: join(projectDir, 'outside.txt') }, /state files live under/],
      [{ path: '../outside.txt' }, /state files live under/],
      [{ path: tmpdir() }, /state files live under/],
      [{ path: statesDir }, /state files live under/],
      [{ name: '../../outside' }, /no such state/],
      [{ name: 'junk' }, /^gba-kit\/loadState: not a gba-kit save state$/],
      [{ name: 'other' }, /^gba-kit\/loadState: not a gba-kit save state$/],
    ] as const) {
      const r = await client.request('gba-kit/loadState', args);
      expect(r.success, JSON.stringify(args)).toBe(false);
      expect(r.message).toMatch(message);
      expect(r.message).not.toMatch(/SECRET|Host|EISDIR|Unexpected token/);
    }
    await stopped(client, 'gba-kit/stepFrame');
    const saved = await client.body<GbaKitRequests['gba-kit/saveState']['body']>('gba-kit/saveState', { name: 'one' });
    await stopped(client, 'gba-kit/stepFrame');
    const files = client.adapter.session!.host.files!;
    const readText = vi.spyOn(files, 'readText');
    const readHead = vi.spyOn(files, 'readHead');
    const { states } = await client.body<GbaKitRequests['gba-kit/listStates']['body']>('gba-kit/listStates');
    expect(states.map((s) => ({ name: s.name, frame: s.frame, path: s.path }))).toEqual([
      { name: 'one', frame: 1, path: saved.path },
    ]);
    expect(readHead).toHaveBeenCalledWith(saved.path, expect.any(Number));
    // only the files not laid out as save states are read whole
    expect(readText.mock.calls.map((c) => c[0])).not.toContain(saved.path);
    expect((await stopped(client, 'gba-kit/loadState', { path: saved.path })).reason).toBe('restart');
    expect((await client.body<StateBody>('gba-kit/state')).frame).toBe(1);

    // the screen it was saved on comes back with it, small enough to read from the head
    expect(saved.width).toBe(120);
    expect(saved.height).toBe(80);
    expect(base64Bytes(saved.thumbnail!)).toBe(120 * 80 * 4);
    expect(states[0]!.thumbnail).toBe(saved.thumbnail);
  });

  /**
   * A `.sav` is imported against a ROM that declares a save type, which the fixture
   * does not: the string is appended past the code, where `loadRom`'s scan finds it
   * and nothing executes it. The scan reads word-aligned strings, so the padding is
   * what puts it where a build would have — the fixture's own length says nothing.
   */
  function romDeclaring(base: Buffer, id: string): Buffer {
    return Buffer.concat([base, Buffer.alloc(-base.length & 3), Buffer.from(`${id}\0`)]);
  }

  it('imports a .sav as a state of its own, numbering rather than writing over one', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const base = await readFile(ROM);
    const rom = join(projectDir, 'eeprom.gba');
    await writeFile(rom, romDeclaring(base, 'EEPROM_V121'));
    const client = await launch({ projectDir, stopOnEntry: true, extra: { rom }, elf: null });
    await client.event('stopped');

    const sav = Buffer.alloc(512).map((_, i) => (i * 11 + 5) & 0xff);
    const args = { bytes: sav.toString('base64'), name: 'Klonoa - Empire of Dreams (USA)' };
    const before = await client.body<StateBody>('gba-kit/state');

    const first = await client.body<SavedStateInfo>('gba-kit/importSave', args);
    expect(first.name).toBe('Klonoa - Empire of Dreams (USA)');
    expect(first.path).toBe(join(projectDir, '.gba-kit', 'states', 'Klonoa_-_Empire_of_Dreams_USA_.json'));
    expect(first.frame).toBe(0);
    expect(base64Bytes(first.thumbnail!)).toBe(120 * 80 * 4);

    // nothing about the machine being debugged moved, and no state event said otherwise
    const after = await client.body<StateBody>('gba-kit/state');
    expect({ revision: after.revision, epoch: after.epoch, frame: after.frame }).toEqual({
      revision: before.revision,
      epoch: before.epoch,
      frame: before.frame,
    });

    const held = await readFile(first.path, 'utf8');
    const second = await client.body<SavedStateInfo>('gba-kit/importSave', args);
    expect(second.name).toBe('Klonoa - Empire of Dreams (USA) (2)');
    expect(second.path).not.toBe(first.path);
    expect(await readFile(first.path, 'utf8')).toBe(held);

    const { states } = await client.body<{ states: SavedStateInfo[] }>('gba-kit/listStates');
    expect(states.map((s) => s.name).sort()).toEqual([
      'Klonoa - Empire of Dreams (USA)',
      'Klonoa - Empire of Dreams (USA) (2)',
    ]);

    // a name longer than a file name can hold numbers all the same: it is the repeat, not
    // the start of the name, that tells the two files apart
    const long = { bytes: args.bytes, name: 'K'.repeat(120) };
    const firstLong = await client.body<SavedStateInfo>('gba-kit/importSave', long);
    const secondLong = await client.body<SavedStateInfo>('gba-kit/importSave', long);
    expect(secondLong.name).toBe(`${'K'.repeat(120)} (2)`);
    expect(secondLong.path).not.toBe(firstLong.path);
    expect(basename(firstLong.path).length).toBeLessThanOrEqual(basename(secondLong.path).length);

    // it loads like any other state, and the machine then holds the file
    expect((await stopped(client, 'gba-kit/loadState', { path: first.path })).reason).toBe('restart');
    expect((await client.body<StateBody>('gba-kit/state')).frame).toBe(0);
    const exported = await client.body<GbaKitRequests['gba-kit/exportSave']['body']>('gba-kit/exportSave');
    expect(base64Bytes(exported.bytes)).toBe(512);
    expect(Buffer.from(exported.bytes, 'base64').equals(sav)).toBe(true);
  });

  it('refuses a .sav the cartridge cannot account for, saying what it saw', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const base = await readFile(ROM);
    const rom = join(projectDir, 'eeprom.gba');
    await writeFile(rom, romDeclaring(base, 'EEPROM_V121'));
    const client = await launch({ projectDir, stopOnEntry: true, extra: { rom }, elf: null });
    await client.event('stopped');

    const wrong = await client.request('gba-kit/importSave', { bytes: Buffer.alloc(32768).toString('base64') });
    expect(wrong.success).toBe(false);
    expect(wrong.message).toMatch(
      /this ROM declares EEPROM_V121, whose save is 512 or 8192 bytes; this file is 32768 bytes/,
    );
    expect(wrong.body?.error?.showUser).toBeFalsy();

    // and nothing was written for it
    await expect(readdir(join(projectDir, '.gba-kit', 'states'))).rejects.toThrow();

    // an EEPROM nothing has addressed yet has no size to export, rather than a guessed one
    const early = await client.request('gba-kit/exportSave');
    expect(early.success).toBe(false);
    expect(early.message).toMatch(/4 Kbit or 64 Kbit/);
  });

  it('renames and deletes save states, and refuses a name already taken', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const client = await launch({ projectDir, stopOnEntry: true });
    const dir = join(projectDir, '.gba-kit', 'states');
    await client.event('stopped');
    const one = await client.body<SavedStateInfo>('gba-kit/saveState', { name: 'one' });
    await stopped(client, 'gba-kit/stepFrame');
    const two = await client.body<SavedStateInfo>('gba-kit/saveState', { name: 'two' });

    const renamed = await client.body<SavedStateInfo>('gba-kit/renameState', { path: one.path, to: 'the start' });
    expect(renamed).toMatchObject({ name: 'the start', frame: 0, thumbnail: one.thumbnail });
    expect(renamed.path).toBe(join(dir, 'the_start.json'));
    expect(await readdir(dir)).toEqual(['the_start.json', 'two.json'].sort());
    // the name inside the file moved with it: the listing reads it back, not the file name
    const listed = await client.body<{ states: SavedStateInfo[] }>('gba-kit/listStates');
    expect(listed.states.map((s) => s.name).sort()).toEqual(['the start', 'two']);
    // and it still loads
    expect((await stopped(client, 'gba-kit/loadState', { path: renamed.path })).reason).toBe('restart');
    expect((await client.body<StateBody>('gba-kit/state')).frame).toBe(0);

    const clash = await client.request('gba-kit/renameState', { path: two.path, to: 'the start' });
    expect(clash.success).toBe(false);
    expect(clash.message).toMatch(/already there/);
    expect(await readdir(dir)).toEqual(['the_start.json', 'two.json'].sort());

    expect(await client.body('gba-kit/deleteState', { path: two.path })).toEqual({ deleted: true });
    expect(await readdir(dir)).toEqual(['the_start.json']);
    // deleting what is not there says so instead of failing
    expect(await client.body('gba-kit/deleteState', { path: two.path })).toEqual({ deleted: false });
    expect((await client.body<{ states: SavedStateInfo[] }>('gba-kit/listStates')).states.length).toBe(1);
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
    // `&` on a label is a pointer to it, and reads as the address it is
    expect(
      (await client.body<DebugProtocol.EvaluateResponse['body']>('evaluate', { expression: '&gMystery' })).result,
    ).toBe('0x03000100');
    const info = await client.body<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', {
      name: 'gMystery',
    });
    expect(info.dataId).toBe('50331904:2:gMystery');
  });

  it('save states and input recordings round-trip', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const client = await launch({ projectDir });
    expect(await client.body('gba-kit/lastRecording')).toEqual({ last: null });
    let at = client.log.length;
    await client.body('gba-kit/recordStart');
    expect(client.kinds(at)).toEqual(['response:gba-kit/recordStart', 'event:gba-kit/state']);
    expect((client.events('gba-kit/state').at(-1)!.body as StateBody).recording).toBe(true);
    expect((client.events('gba-kit/state').at(-1)!.body as StateBody).history.recordingStart).toBe(0);
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
    at = client.log.length;
    const rec = await client.body<GbaKitRequests['gba-kit/recordStop']['body']>('gba-kit/recordStop');
    expect(client.kinds(at)).toEqual(['response:gba-kit/recordStop', 'event:gba-kit/state']);
    expect((client.events('gba-kit/state').at(-1)!.body as StateBody).recording).toBe(false);
    expect((client.events('gba-kit/state').at(-1)!.body as StateBody).history.recordingStart).toBeNull();
    expect(rec.recording.frames).toEqual([1, 1, 0]);
    expect(await client.body('gba-kit/lastRecording')).toEqual({ last: rec });
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

  it('keeps recordings under the project, lists them in the next session, and deletes one', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const dir = join(projectDir, '.gba-kit', 'recordings');
    const first = await launch({ projectDir });
    // recorded well into the run, so replaying it from there needs more than a rewind
    await stopped(first, 'gba-kit/stepFrame');
    await stopped(first, 'gba-kit/stepFrame');
    await first.body('gba-kit/recordStart');
    await first.body('gba-kit/input', { button: 0, down: true });
    await stopped(first, 'gba-kit/stepFrame');
    await stopped(first, 'gba-kit/stepFrame');
    await first.body('gba-kit/recordStop');
    expect((await filesIn(dir, 1)).length).toBe(1);

    // a session opened on the same project lists what the last one recorded
    const next = await launch({ projectDir });
    const { takes } = await next.body<GbaKitRequests['gba-kit/recordings']['body']>('gba-kit/recordings');
    expect(takes.length).toBe(1);
    const take = takes[0]!;
    expect(take.recording.frames).toEqual([1, 1]);
    expect(take.script).toContain("press('a', { hold: 2 })");
    expect(take.createdAt).not.toBe('');
    expect(base64Bytes(take.thumbnail)).toBe(take.width * take.height * 4);
    // it replays there from where it was recorded, a frame this session never ran
    expect(take.recording.startFrame).toBe(2);
    expect((await next.body<StateBody>('gba-kit/state')).frame).toBe(0);
    // the recording alone cannot say how to get there: only the take this session kept can
    const lost = await next.request('gba-kit/replay', { recording: take.recording, from: 'start' });
    expect(lost.body).toEqual({ replayed: false });
    expect((await next.body<StateBody>('gba-kit/state')).frame).toBe(0);
    const back = await stopped(next, 'gba-kit/replay', { id: take.id, recording: take.recording, from: 'start' });
    expect(back.description).toMatch(/replayed 2 frames/);
    expect((await next.body<StateBody>('gba-kit/state')).frame).toBe(4);

    expect(await next.body('gba-kit/deleteRecording', { id: take.id })).toEqual({ deleted: true });
    expect(await filesIn(dir, 0)).toEqual([]);
    expect((await next.body<GbaKitRequests['gba-kit/recordings']['body']>('gba-kit/recordings')).takes).toEqual([]);
    expect(await next.body('gba-kit/deleteRecording', { id: take.id })).toEqual({ deleted: false });
  });

  it('lists the newest recordings a project kept, and leaves the older files alone', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const dir = join(projectDir, '.gba-kit', 'recordings');
    const first = await launch({ projectDir });
    await first.body('gba-kit/recordStart');
    await stopped(first, 'gba-kit/stepFrame');
    await first.body('gba-kit/recordStop');
    const [name] = await filesIn(dir, 1);

    // 24 more of the same ROM, a day apart, named the way the adapter names them
    const written = JSON.parse(await readFile(join(dir, name!), 'utf8')) as Record<string, unknown>;
    for (let i = 0; i < 24; i++) {
      const at = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
      const file = { ...written, createdAt: at, recording: { ...(written.recording as object), startFrame: i } };
      await writeFile(join(dir, `${at.replace(/[^\w.-]+/g, '_')}-frame${i}.json`), JSON.stringify(file));
    }

    const next = await launch({ projectDir });
    const { takes } = await next.body<GbaKitRequests['gba-kit/recordings']['body']>('gba-kit/recordings');
    // the twenty newest, oldest of them first: the 19 latest days, then the one just recorded
    expect(takes.length).toBe(20);
    expect(takes[0]!.recording.startFrame).toBe(5);
    expect(takes.at(-1)!.createdAt).toBe(written.createdAt);
    expect((await readdir(dir)).length).toBe(25);
  });

  it('passes over a recordings file that is not one, or belongs to another ROM', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(projectDir);
    const dir = join(projectDir, '.gba-kit', 'recordings');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'notes.txt'), 'not json');
    await writeFile(join(dir, 'junk.json'), '{"format":"something else"}');
    await writeFile(
      join(dir, 'other-rom.json'),
      JSON.stringify({
        format: 'gba-kit-recording',
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        thumbnail: { width: 1, height: 1, rgba: 'AAAAAA==' },
        recording: { format: 'gba-kit-input', version: 1, romHash: 'another', startFrame: 0, frames: [0] },
      }),
    );
    const client = await launch({ projectDir });
    expect((await client.body<GbaKitRequests['gba-kit/recordings']['body']>('gba-kit/recordings')).takes).toEqual([]);
  });

  it('streams frames to a pipe the client owns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
    tempDirs.push(dir);
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\gba-kit-test-${process.pid}` : join(dir, 'frames.sock');
    const frames: Array<{ frame: number; width: number; height: number; rgba: Uint8Array }> = [];
    // what each connection carried: the adapter connects anew for every `gba-kit/stream`
    const connections: Array<{ frames: number[]; audio: number }> = [];
    const sockets: Socket[] = [];
    const server: Server = createServer((socket) => {
      sockets.push(socket);
      const seen = { frames: [] as number[], audio: 0 };
      connections.push(seen);
      const reader = new StreamReader(
        (f) => {
          frames.push(f);
          seen.frames.push(f.frame);
        },
        () => seen.audio++,
      );
      socket.on('data', (chunk: Buffer) => reader.push(chunk));
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    const until = async (ok: () => boolean): Promise<void> => {
      for (let i = 0; i < 400 && !ok(); i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(ok()).toBe(true);
    };
    try {
      const client = await launch();
      expect((await client.body<{ connected: boolean }>('gba-kit/stream', { path: pipe })).connected).toBe(true);
      await stopped(client, 'gba-kit/stepFrame');
      await until(() => frames.some((f) => f.frame === 1));
      expect(frames[0]!.frame).toBe(0); // connecting sends the screen as it is
      const last = frames[frames.length - 1]!;
      expect(last).toMatchObject({ width: 240, height: 160, frame: 1 });
      expect(last.rgba.length).toBe(240 * 160 * 4);

      // audio only when asked for: a run's audio goes out before its frame, so the next frame proves none came
      await stopped(client, 'gba-kit/stepFrame');
      await until(() => connections[0]!.frames.includes(2));
      expect(connections[0]!.audio).toBe(0);
      expect((await client.body<{ connected: boolean }>('gba-kit/stream', { path: pipe, audio: true })).connected).toBe(
        true,
      );
      await stopped(client, 'gba-kit/stepFrame');
      await until(() => connections[1]!.audio > 0);
      expect(
        (await client.body<{ connected: boolean }>('gba-kit/stream', { path: pipe, audio: false })).connected,
      ).toBe(true);
      await stopped(client, 'gba-kit/stepFrame');
      await stopped(client, 'gba-kit/stepFrame');
      await until(() => connections[2]!.frames.includes(5));
      expect(connections[2]!.audio).toBe(0);
      expect(connections.length).toBe(3);

      const missing = await client.request('gba-kit/stream', { path: join(dir, 'nope.sock') });
      expect(missing.success).toBe(false);
    } finally {
      // the adapter keeps its end open until it disconnects, which happens after this
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('is the executable `npx @gba-kit/debug-adapter` picks', async () => {
    // npm runs the bin named after the (unscoped) package when there are several
    const pkg = JSON.parse(await readFile(join(here, '..', '..', 'package.json'), 'utf8')) as {
      name: string;
      bin: Record<string, string>;
    };
    expect(pkg.bin[pkg.name.replace(/^@[^/]+\//, '')]).toBe('dist/cli.js');
    expect(pkg.bin['gba-kit-screen']).toBe('dist/screen.js');
  });
});
