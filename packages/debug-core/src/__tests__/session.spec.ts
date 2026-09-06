/**
 * The session against the owned fixtures: a small game loop built as Thumb -O0,
 * Thumb -O2 and ARM -O0. Everything here goes through the public Session API the
 * way a Debug Adapter would drive it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { type Host, type HostFiles, ManualHost } from '../host.js';
import { Machine } from '../machine.js';
import { Session, type SessionState, type StopInfo } from '../session.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'test-fixtures');
const FRAME_MS = 1000 / 59.7275;

const VARIANTS = ['thumb-O0', 'thumb-O2', 'arm-O0'] as const;

function lineOf(file: string, snippet: string): number {
  const lines = readFileSync(join(fixtures, 'source', file), 'utf8').split('\n');
  const index = lines.findIndex((l) => l.includes(snippet));
  if (index < 0) {
    throw new Error(`no line containing ${snippet} in ${file}`);
  }
  return index + 1;
}

interface Harness {
  session: Session;
  host: ManualHost;
  stops: StopInfo[];
  /** every `output` event, as `[category] text` */
  output: string[];
  /** run until the next stop (or `maxFrames`), returning the stop */
  run(maxFrames?: number): StopInfo | null;
}

function fixture(variant: (typeof VARIANTS)[number]): { rom: Uint8Array; elf: Uint8Array } {
  return {
    rom: new Uint8Array(readFileSync(join(fixtures, 'build', `${variant}.gba`))),
    elf: new Uint8Array(readFileSync(join(fixtures, 'build', `${variant}.elf`))),
  };
}

async function boot(variant: (typeof VARIANTS)[number], host: ManualHost = new ManualHost()): Promise<Harness> {
  const session = await Session.create(host, {
    ...fixture(variant),
    cwd: fixtures,
    exists: (p) => {
      try {
        readFileSync(p);
        return true;
      } catch {
        return false;
      }
    },
    rewind: { keyframeInterval: 4, fullEvery: 3 },
  });
  const stops: StopInfo[] = [];
  const output: string[] = [];
  session.on({
    stopped: (info) => stops.push(info),
    output: (text, category) => output.push(`[${category}] ${text.trim()}`),
  });
  return {
    session,
    host,
    stops,
    output,
    run(maxFrames = 600) {
      const before = stops.length;
      session.continue();
      for (let i = 0; i < maxFrames && stops.length === before; i++) {
        host.tick(FRAME_MS);
      }
      if (stops.length === before) {
        session.pause();
        host.tick(FRAME_MS);
      }
      return stops[stops.length - 1] ?? null;
    },
  };
}

const MAIN = join(fixtures, 'source', 'main.c');
const UTIL = join(fixtures, 'source', 'util.c');
const START = join(fixtures, 'source', 'start.s');
/** the closing brace of wait_vblank: the instruction the CPU sits on while it waits */
const WAIT_RETURN_LINE = lineOf('main.c', '#endif') + 1;
const IRQ_MODE = 0x12;
const SYS_MODE = 0x1f;

/** The line whose code the CPU sits on, halted, after the `swi` (inlined at -O2, so it is the caller's next line). */
function lineAfterSwi(variant: (typeof VARIANTS)[number]): number {
  return variant === 'thumb-O2' ? lineOf('main.c', 'tick();') : WAIT_RETURN_LINE;
}

describe.each(VARIANTS)('Session on %s', (variant) => {
  it('boots stopped at the entry point with the ELF matched to the ROM', async () => {
    const { session } = await boot(variant);
    expect(session.state).toBe('stopped');
    expect(session.pc).toBe(0x08000000);
    expect(session.program.identity?.ok).toBe(true);
    expect(session.program.sources?.toDwarf(MAIN)).toBe('source/main.c');
  });

  it('a source breakpoint resolves, hits once per frame, and the frame shows the line', async () => {
    const h = await boot(variant);
    const line = lineOf('main.c', 'g_keys = ~REG_KEYINPUT');
    const [bp] = h.session.setSourceBreakpoints(MAIN, [{ line }]);
    expect(bp!.verified).toBe(true);
    expect(bp!.line).toBe(line);
    const stop = h.run();
    expect(stop?.reason).toBe('breakpoint');
    expect(stop?.breakpointIds).toEqual([bp!.id]);
    const frames = h.session.callStack();
    expect(frames[0]!.name).toBe('main');
    expect(frames[0]!.source).toEqual({ path: MAIN, line });
    const frameBefore = h.session.frame;
    h.run();
    expect(h.session.frame).toBe(frameBefore + 1);
  });

  it('a breakpoint on a call-site line resolves to the inlined call entry and shows that line', async () => {
    const h = await boot(variant);
    const line = lineOf('main.c', 'tick();');
    const [bp] = h.session.setSourceBreakpoints(MAIN, [{ line }]);
    expect(bp!.verified).toBe(true);
    expect(bp!.line).toBe(line);
    expect(h.run()?.reason).toBe('breakpoint');
    const [top] = h.session.callStack();
    expect(top!.name).toBe('main');
    expect(top!.source).toEqual({ path: MAIN, line });
    h.session.stepInto();
    expect(h.session.callStack()[0]!.name).toBe(
      variant === 'thumb-O0' || variant === 'arm-O0' ? 'tick' : 'tick (inlined)',
    );
  });

  it('a breakpoint in the startup assembly resolves through its DWARF 5 line program', async () => {
    const h = await boot(variant);
    expect(h.session.callStack()[0]!.source).toEqual({ path: START, line: lineOf('start.s', 'b boot') });
    const line = lineOf('start.s', 'ldr r1, =__data_start');
    const [bp] = h.session.setSourceBreakpoints(START, [{ line }]);
    expect(bp).toMatchObject({ verified: true, line });
    expect(h.run()?.reason).toBe('breakpoint');
    expect(h.session.pc).toBe(0x080000c4);
    expect(h.session.callStack()[0]!.source).toEqual({ path: START, line });
  });

  it('a breakpoint on a line without code slides to the next line with code', async () => {
    const h = await boot(variant);
    const comment = lineOf('main.c', '/* The VBlank handler');
    const [bp] = h.session.setSourceBreakpoints(MAIN, [{ line: comment }]);
    expect(bp!.verified).toBe(true);
    expect(bp!.line).toBeGreaterThan(comment);
  });

  it('step over walks the statements of the main loop, one line at a time', async () => {
    const h = await boot(variant);
    const line = lineOf('main.c', 'wait_vblank();');
    h.session.setSourceBreakpoints(MAIN, [{ line }]);
    h.run();
    h.session.setSourceBreakpoints(MAIN, []);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      h.session.stepOver();
      const top = h.session.callStack()[0]!;
      expect(top.name).toBe('main');
      seen.push(top.source!.line);
    }
    const expected = [
      lineOf('main.c', 'tick();'),
      lineOf('main.c', 'g_keys = ~REG_KEYINPUT'),
      lineOf('main.c', 'update();'),
      lineOf('main.c', 'draw();'),
    ];
    expect(seen.slice(0, 4)).toEqual(expected);
    // back around the loop: the `for (;;)` line or wait_vblank again
    expect([lineOf('main.c', 'for (;;)'), line]).toContain(seen[4]);
    if (variant === 'thumb-O2') {
      // wait_vblank and tick are inlined: their lines have no rows, the calls are hidden layers
      expect(h.session.callStack()[0]!.name).toBe('main');
    }
  });

  it('step into enters update(), step out returns to the next statement of main', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'update();') }]);
    h.run();
    h.session.setSourceBreakpoints(MAIN, []);
    h.session.stepInto();
    const inside = h.session.callStack();
    expect(inside[0]!.name.replace(' (inlined)', '')).toBe('update');
    expect(inside.some((f) => f.name === 'main')).toBe(true);
    h.session.stepOut();
    const back = h.session.callStack()[0]!;
    expect(back.name).toBe('main');
    expect(back.source!.line).toBe(lineOf('main.c', 'draw();'));
  });

  it('locals and parameters of a callee read from the frame', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(UTIL, [{ line: lineOf('util.c', 'g_bonus_calls++;') }]);
    const stop = h.run();
    expect(stop?.reason).toBe('breakpoint');
    const frames = h.session.callStack();
    expect(frames[0]!.name).toBe('add_bonus');
    expect(frames.map((f) => f.name.replace(' (inlined)', ''))).toContain('main');
    const locals = h.session.scopes(0).find((s) => s.kind === 'locals')!;
    const byName = Object.fromEntries(locals.nodes.map((n) => [n.name, n]));
    expect(byName.value).toBeDefined();
    expect(byName.bonus).toBeDefined();
    expect(byName.bonus!.value).toBe('2');
    expect(byName.bonus!.type).toContain('(param)');
    if (variant !== 'thumb-O2') {
      // add_bonus(g_frame, 2) at the VBlank of hardware frame N, where g_frame is already N + 1
      expect(byName.result!.value).toBe(String(h.session.frame + 3));
    }
  });

  it('globals unfold: a struct with an enum, a bitfield and a char array', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'draw();') }]);
    h.run();
    const { node } = h.session.evaluate('g_player');
    expect(node.type).toBe('struct Player');
    const members = Object.fromEntries(node.children!().map((m) => [m.name, m]));
    expect(members.mode!.value).toBe('MODE_PLAY (1)');
    expect(members.name!.value).toBe('"Kit"');
    const pos = Object.fromEntries(members.pos!.children!().map((m) => [m.name, m]));
    expect(pos.y!.value).toBe('-7');
    const stats = Object.fromEntries(members.stats!.children!().map((m) => [m.name, m]));
    expect(stats.hp!.value).toBe('9 (4 bits)');
    expect(stats.flags!.value).toBe('165 (8 bits)');
    const counter = members.counterRef!.children!()[0]!;
    expect(counter.name).toBe('*');
    expect(Number(counter.value.split(' ')[0])).toBe(h.session.frame + 1); // VBlanks seen, the current one included
    // a linker-placed global joined to its declaration
    expect(h.session.evaluate('g_linker_placed').node.value).toBe('7');
    // a member path reads exactly as the tree shows it: signed, typed, labelled, expandable
    expect(h.session.evaluate('g_player.pos.y').node).toMatchObject({ value: '-7', type: 'int' });
    expect(h.session.evaluate('g_player.mode').node.value).toBe('MODE_PLAY (1)');
    expect(h.session.evaluate('g_player.name').node.value).toBe('"Kit"');
    expect(h.session.evaluate('g_player.stats.hp').node.value).toBe('9 (4 bits)');
    const posNode = h.session.evaluate('g_player.pos').node;
    expect(posNode.value).toMatch(/^\{x: \d+.*, y: -7\}$/);
    expect(posNode.children).toBeDefined();
    expect(h.session.evaluate('g_player.counterRef').node.children).toBeDefined();
    for (const leaf of [...members.pos!.children!(), ...members.stats!.children!()]) {
      const path = `g_player.${leaf.name === 'x' || leaf.name === 'y' ? 'pos' : 'stats'}.${leaf.name}`;
      expect(h.session.evaluate(path).node.value).toBe(leaf.value);
    }
    expect(() => h.session.evaluate('g_player.nope')).toThrow(/has no member 'nope'/);
    expect(() => h.session.evaluate('g_samples[9]')).toThrow(/out of range/);
    // the expression grammar
    expect(h.session.evaluate('g_samples[1] + 1').node.value).toMatch(/^\d+/);
    expect(h.session.evaluate('{&g_frame} == g_frame').node.value.startsWith('1 ')).toBe(true);
  });

  it('address-of and casts see member paths, and a value is never mistaken for an address', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'draw();') }]);
    h.run();
    const mode = h.session.evaluate('g_player.mode');
    expect(h.session.evaluate('&g_player.mode').node.value).toContain(String(mode.address));
    expect(h.session.evaluate('&g_player.pos.y').address).toBe(h.session.evaluate('g_player.pos.y').address);
    expect(h.session.evaluate('&g_samples[1]').address).toBe(h.session.program.symbolAddress('g_samples')! + 4);
    const cast = h.session.evaluate('(enum Mode)&g_player.mode');
    expect(cast.address).toBe(mode.address);
    expect(cast.node.value).toBe('MODE_PLAY (1)');
    expect(h.session.evaluate('(Point*)&g_player').node.type).toBe('Point');
    expect(h.session.evaluate('(Point)&g_player').node.children!().map((c) => c.value)).toEqual([
      h.session.evaluate('g_player.pos.x').node.value,
      '-7',
    ]);
    expect(h.session.evaluate('s32(&g_player.pos.y)').node.value).toBe('-7 (0xfffffff9)');
    expect(h.session.evaluate('(int)g_player.pos.y').node.value).toBe('-7'); // a cast's operand names a place
    expect(() => h.session.evaluate('(int)(g_player.pos.y)')).toThrow(/not a readable address/);
    expect(() => h.session.evaluate('&g_nope')).toThrow(/unknown symbol/);
  });

  it('enumerators evaluate by name and work in conditions and writes', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'update();') }]);
    h.run();
    expect(h.session.evaluate('MODE_PLAY').node).toMatchObject({
      value: 'MODE_PLAY (1)',
      type: 'enum Mode (constant)',
    });
    expect(h.session.evaluate('MODE_DONE + 1').node.value).toBe('3 (0x3)');
    expect(h.session.evaluate('g_player.mode == MODE_PLAY').node.value).toBe('1 (0x1)');
    expect(h.session.evaluate('g_player.mode == MODE_DONE').node.value).toBe('0 (0x0)');
    expect(() => h.session.evaluate('NOT_AN_ENUMERATOR')).toThrow(/unknown symbol/);
    const mode = h.session.evaluate('g_player').node.children!().find((m) => m.name === 'mode')!;
    expect(mode.writable?.enumerators?.get(2)).toBe('MODE_DONE');
    expect(h.session.setVariable(mode, 'MODE_IDLE')).toBe('MODE_IDLE (0)');
    expect(h.session.evaluate('g_player.mode').node.value).toBe('MODE_IDLE (0)');
    expect(h.session.setVariable(mode, 'MODE_PLAY (1)')).toBe('MODE_PLAY (1)'); // the tree's own text writes back
    expect(() => h.session.setVariable(mode, 'MODE_NOPE')).toThrow(/cannot parse/);
    h.session.setSourceBreakpoints(MAIN, [
      { line: lineOf('main.c', 'draw();'), condition: 'g_player.mode == MODE_DONE' },
    ]);
    expect(h.run(3)?.reason).toBe('pause'); // still MODE_PLAY
    h.session.setVariable(h.session.evaluate('g_player.pos').node.children!().find((m) => m.name === 'x')!, '200');
    expect(h.run()?.reason).toBe('breakpoint'); // move_player saw x > 100
    expect(h.session.evaluate('g_player.mode').node.value).toBe('MODE_DONE (2)');
  });

  it('signed values compare as the program does, in conditions too', async () => {
    const h = await boot(variant);
    const line = lineOf('main.c', 'g_player.stats.hp = 9;');
    h.session.setSourceBreakpoints(MAIN, [{ line, condition: 'g_player.pos.y < 0' }]);
    expect(h.run()?.reason).toBe('breakpoint');
    expect(h.session.callStack()[0]!.source!.line).toBe(line);
    expect(h.session.evaluate('g_player.pos.y').node.value).toBe('-7');
    expect(h.session.evaluate('g_player.pos.y < 0').node.value).toBe('1 (0x1)');
    expect(h.session.evaluate('g_player.pos.x < 0').node.value).toBe('0 (0x0)');
    expect(h.session.evaluate('g_player.pos.y - 1').node.value).toBe('-8 (0xfffffff8)');
    expect(h.session.evaluate('g_frame - 10 < 0').node.value).toBe('0 (0x0)'); // u32 arithmetic stays unsigned
    expect(h.output.filter((o) => o.startsWith('[stderr]'))).toEqual([]);
  });

  it('breakpoint conditions and logpoints see the locals of the function they are in', async () => {
    const h = await boot(variant);
    const line = lineOf('util.c', 'g_bonus_calls++;');
    h.session.setSourceBreakpoints(UTIL, [{ line, condition: 'bonus == 3' }]);
    expect(h.run(20)?.reason).toBe('pause');
    expect(h.output.filter((o) => o.startsWith('[stderr]'))).toEqual([]);
    h.session.restart();
    h.session.setSourceBreakpoints(UTIL, [{ line, condition: 'bonus == 2 && value == 1' }]);
    expect(h.run()?.reason).toBe('breakpoint');
    expect(h.session.callStack()[0]!.name).toBe('add_bonus');
    expect(h.session.evaluate('bonus').node.value).toBe('2');
    expect(h.session.evaluate('value').node.value).toBe('1');
    h.session.setSourceBreakpoints(UTIL, [{ line, logMessage: 'v={value} b={bonus}' }]);
    h.run(3);
    expect(h.output.filter((o) => o.startsWith('[log]'))).toEqual([
      '[log] v=2 (0x2) b=2 (0x2)',
      '[log] v=3 (0x3) b=2 (0x2)',
    ]);
    expect(h.output.filter((o) => o.startsWith('[stderr]'))).toEqual([]);
  });

  it('writes are range-checked, typed, and reach bitfields', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'draw();') }]);
    h.run();
    const keys = h.session.evaluate('g_keys').node;
    expect(() => h.session.setVariable(keys, '70000')).toThrow(/out of range/);
    expect(() => h.session.setVariable(keys, '-1')).toThrow(/out of range/);
    expect(h.session.setVariable(keys, '0b101')).toBe('5');
    expect(h.session.setVariable(keys, '1 << 3')).toBe('8');
    expect(h.session.setVariable(keys, '0xffff')).toBe('65535 (0xffff)');
    expect(h.session.setVariable(keys, 'g_frame + 1')).toBe(String(h.session.frame + 2));
    const stats = h.session.evaluate('g_player.stats').node.children!();
    const hp = stats.find((m) => m.name === 'hp')!;
    expect(hp.writable).toMatchObject({ bitSize: 4, bitOffset: 0, size: 1 });
    expect(h.session.setVariable(hp, '3')).toBe('3 (4 bits)');
    const after = Object.fromEntries(
      h.session.evaluate('g_player.stats').node.children!().map((m) => [m.name, m.value]),
    );
    expect(after).toEqual({ hp: '3 (4 bits)', mp: '3 (4 bits)', flags: '165 (8 bits)' });
    expect(() => h.session.setVariable(hp, '16')).toThrow(/out of range/);
    const y = h.session.evaluate('g_player.pos.y').node;
    expect(h.session.setVariable(y, '-8')).toBe('-8');
    expect(() => h.session.setVariable(y, '-2147483649')).toThrow(/out of range/);
    expect(h.session.setVariable(y, '0xffffffff')).toBe('-1'); // a bit pattern is accepted for a signed target
  });

  it('assigns through a path, the way a console line does', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'update();') }]);
    h.run();
    // a struct member, an array element, and a value that is itself an expression
    expect(h.session.assign('g_player.pos.x', '10').node.value).toBe('10 (0x0000000a)');
    expect(h.session.evaluate('g_player.pos.x').node.value).toBe('10 (0x0000000a)');
    expect(h.session.assign('g_samples[2]', 'g_samples[1] + 1').node.value).toBe('6');
    expect(h.session.assign('g_player.mode', '2').node.value).toBe('MODE_DONE (2)');
    expect(h.session.assign('g_player.stats.hp', '5').node.value).toBe('5 (4 bits)');
    // the machine really holds it: the program reads it back on the next frame
    h.run();
    expect(h.session.evaluate('g_samples[2]').node.value).toBe('6');
    // what cannot be written says so, naming what the user typed
    expect(() => h.session.assign('g_player.pos', '1')).toThrow(/cannot write 'g_player.pos'/);
    expect(() => h.session.assign('g_nope', '1')).toThrow(/g_nope/);
    expect(() => h.session.assign('g_player.stats.hp', '99')).toThrow(/out of range for a 4-bit/);
  });

  it('writing a scalar changes the program', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'update();') }]);
    h.run();
    const before = h.session.evaluate('g_player.pos.x').node;
    const members = h.session.evaluate('g_player').node.children!();
    const x = members.find((m) => m.name === 'pos')!.children!().find((m) => m.name === 'x')!;
    expect(h.session.setVariable(x, '200')).toBe('200 (0x000000c8)');
    expect(h.session.evaluate('g_player.pos.x').node.value).not.toBe(before.value);
    h.run(); // update() → move_player sees x > 100 → MODE_DONE
    const mode = h.session.evaluate('g_player').node.children!().find((m) => m.name === 'mode')!;
    expect(mode.value).toBe('MODE_DONE (2)');
  });

  it('a data breakpoint stops after the write and names the writer', async () => {
    const h = await boot(variant);
    const target = h.session.dataBreakpointTarget('g_bonus_calls')!;
    expect(target.length).toBe(4);
    h.session.setDataBreakpoints([{ ...target, access: 'write' }]);
    // the first write is the startup code clearing .bss (assembly with no function symbols)
    const clear = h.run();
    expect(clear?.reason).toBe('data breakpoint');
    expect(clear?.description).toMatch(/^g_bonus_calls written \(0x0, 4 bytes at 0x3000038\) by _start\+0x/);
    const stop = h.run();
    expect(stop?.reason).toBe('data breakpoint');
    expect(stop?.description).toContain('by add_bonus+0x');
    expect(h.session.evaluate('g_bonus_calls').node.value).toBe('1');
  });

  it('a read data breakpoint stops at the first load, and read/write at either', async () => {
    const h = await boot(variant);
    const target = h.session.dataBreakpointTarget('g_player.pos.x')!;
    expect(target).toMatchObject({ length: 4, name: 'g_player.pos.x' });
    h.session.setDataBreakpoints([{ ...target, access: 'read' }]);
    const stop = h.run();
    expect(stop?.reason).toBe('data breakpoint');
    expect(stop?.description).toMatch(
      /^g_player\.pos\.x read \(0xc, 4 bytes at 0x30000[0-9a-f]{2}\) by move_player\+0x/,
    );
    expect(h.session.callStack()[0]!.name).toBe('move_player');
    h.session.setDataBreakpoints([{ ...target, access: 'readWrite' }]);
    expect(h.run()?.description).toMatch(/^g_player\.pos\.x written \(0x/);
    expect(h.run()?.description).toMatch(/^g_player\.pos\.x read \(0x/);
  });

  it('conditional breakpoints, hit counts and logpoints', async () => {
    const h = await boot(variant);
    const line = lineOf('main.c', 'g_keys = ~REG_KEYINPUT');
    h.session.setSourceBreakpoints(MAIN, [{ line, condition: 'g_frame == 3' }]);
    expect(h.run()?.reason).toBe('breakpoint');
    expect(h.session.evaluate('g_frame').node.value).toBe('3');
    h.session.setSourceBreakpoints(MAIN, [{ line, hitCondition: '% 2' }]);
    h.run();
    const first = Number(h.session.evaluate('g_frame').node.value);
    h.run();
    expect(Number(h.session.evaluate('g_frame').node.value)).toBe(first + 2);
    const logs: string[] = [];
    h.session.on({ output: (t, c) => c === 'log' && logs.push(t.trim()) });
    h.session.setSourceBreakpoints(MAIN, [{ line, logMessage: 'frame {g_frame} keys {g_keys}' }]);
    h.session.setSourceBreakpoints(UTIL, [{ line: lineOf('util.c', 'g_bonus_calls++;'), condition: 'g_frame > 100' }]);
    expect(h.run(3)?.reason).toBe('pause'); // the util.c condition never held
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0]).toMatch(/^frame \d+ \(0x[0-9a-f]+\) keys 0 \(0x0\)$/);
  });

  it('a breakpoint on the instruction after the swi hits once per frame, with the CPU awake', async () => {
    const h = await boot(variant);
    const [bp] = h.session.setSourceBreakpoints(MAIN, [{ line: lineAfterSwi(variant) }]);
    for (let i = 0; i < 4; i++) {
      expect(h.run()?.reason).toBe('breakpoint');
      expect(h.session.machine.halted).toBe(false);
      expect(h.session.frame).toBe(i);
      expect(h.session.evaluate('g_vblank_count').node.value).toBe(String(i + 1));
      expect(bp!.hits).toBe(i + 1);
    }
    h.session.restart();
    h.session.setSourceBreakpoints(MAIN, [{ line: lineAfterSwi(variant), hitCondition: '== 3' }]);
    expect(h.run()?.reason).toBe('breakpoint');
    expect(h.session.frame).toBe(2);
    expect(h.session.evaluate('g_vblank_count').node.value).toBe('3');
  });

  it('a logpoint on the line after the swi logs once per frame', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'tick();'), logMessage: 'tick {g_frame}' }]);
    expect(h.run(3)?.reason).toBe('pause');
    expect(h.output.filter((o) => o.startsWith('[log]'))).toEqual([
      '[log] tick 0 (0x0)',
      '[log] tick 1 (0x1)',
      '[log] tick 2 (0x2)',
    ]);
  });

  it('stepping from the instruction after the swi makes progress, and steps back exactly', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineAfterSwi(variant) }]);
    h.run();
    expect(h.session.machine.halted).toBe(false);
    const at = h.session.position;
    const pcs: number[] = [];
    for (let i = 0; i < 3; i++) {
      h.session.stepInstruction();
      pcs.push(h.session.pc);
      expect(h.stops.at(-1)?.reason).toBe('step');
    }
    expect(pcs[0]).toBeGreaterThan(at.pc);
    expect(pcs[1]).toBeGreaterThan(pcs[0]!);
    expect(pcs[2]).toBeGreaterThan(pcs[1]!);
    expect(h.session.position.instruction).toBe(at.instruction + 3);
    for (let i = 0; i < 3; i++) {
      expect(h.session.stepBack()).toBe(true);
    }
    expect(h.session.position).toEqual(at);
  });

  it('a halt event breakpoint stops asleep; a step from there wakes into the interrupt, a step back lands on the swi', async () => {
    const h = await boot(variant);
    h.session.setEventBreakpoints(['halt']);
    expect(h.run()?.reason).toBe('event breakpoint');
    expect(h.session.machine.halted).toBe(true);
    const halted = h.session.position;
    h.session.stepInstruction();
    expect(h.session.pc).toBe(0x18); // the IRQ vector
    expect(h.session.machine.halted).toBe(false);
    expect(h.session.position.instruction).toBe(halted.instruction);
    expect(h.session.stepBack()).toBe(true);
    expect(h.session.position.instruction).toBe(halted.instruction - 1);
    expect(h.session.disassemble(h.session.pc, 1)[0]!.text).toMatch(/^(swi|svc)/);
    h.session.setEventBreakpoints([]);
    h.session.stepInstruction(); // the swi: the CPU sleeps until the interrupt wakes it at the vector
    expect(h.session.pc).toBe(0x18);
    expect(h.session.machine.gba.armCpu.getMode()).toBe(IRQ_MODE);
    h.session.stepOut(); // out of the exception: back where the swi returned
    expect(h.session.machine.gba.armCpu.getMode()).toBe(SYS_MODE);
    expect(h.session.pc).toBe(halted.pc);
    if (variant !== 'thumb-O2') {
      h.session.stepOver(); // out of wait_vblank (inlined at -O2: the return already is the next line)
    }
    expect(h.session.callStack()[0]!.name).toBe('main');
    expect(h.session.callStack()[0]!.source!.line).toBe(lineOf('main.c', 'tick();'));
  });

  it('step over wait_vblank() runs through the VBlank, not into the sleeping CPU', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'wait_vblank();') }]);
    h.run();
    h.run();
    h.session.setSourceBreakpoints(MAIN, []);
    const frame = h.session.frame;
    const before = Number(h.session.evaluate('g_vblank_count').node.value);
    h.session.stepOver();
    expect(h.session.callStack()[0]!.source!.line).toBe(lineOf('main.c', 'tick();'));
    expect(h.session.machine.halted).toBe(false);
    expect(Number(h.session.evaluate('g_vblank_count').node.value)).toBe(before + 1);
    expect(h.session.frame).toBe(frame + 1);
  });

  it('step into skips the interrupt handler, but a breakpoint inside it still stops', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'wait_vblank();') }]);
    h.run();
    h.session.setSourceBreakpoints(MAIN, []);
    for (let i = 0; i < 4; i++) {
      h.session.stepInto();
      expect(h.session.machine.gba.armCpu.getMode()).toBe(SYS_MODE);
      expect(h.session.callStack().map((f) => f.name)).not.toContain('isr');
    }
    expect(h.session.callStack().some((f) => f.name === 'main')).toBe(true);
    h.session.restart();
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'wait_vblank();') }]);
    h.run();
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'REG_IF = 1;') }]);
    const before = h.stops.length;
    for (let i = 0; i < 4 && !(h.stops.length > before && h.stops.at(-1)?.reason === 'breakpoint'); i++) {
      h.session.stepInto();
    }
    expect(h.stops.at(-1)?.reason).toBe('breakpoint');
    expect(h.session.callStack()[0]!.name).toBe('isr');
  });

  it('step out of the interrupt handler returns to the interrupted code, in the same frame', async () => {
    const h = await boot(variant);
    h.session.setFunctionBreakpoints([{ functionName: 'isr' }]);
    h.run();
    h.session.setFunctionBreakpoints([]);
    expect(h.session.machine.gba.armCpu.getMode()).toBe(IRQ_MODE);
    h.session.stepOut();
    expect(h.session.frame).toBe(0);
    expect(h.session.machine.gba.armCpu.getMode()).toBe(SYS_MODE);
    expect(h.session.pc).toBeGreaterThanOrEqual(0x08000000);
    const names = h.session.callStack().map((f) => f.name);
    expect(names).toContain('main');
    if (variant !== 'thumb-O2') {
      expect(names[0]).toBe('wait_vblank');
      h.session.stepOut();
      expect(h.session.frame).toBe(0);
      expect(h.session.callStack()[0]!.name).toBe('main');
    }
  });

  it('step over on the last statement of the handler returns to the interrupted code, not the next interrupt', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'BIOS_IF |= 1;') }]);
    h.run();
    h.session.setSourceBreakpoints(MAIN, []);
    if (variant !== 'thumb-O2') {
      h.session.stepOver();
      expect(h.session.callStack()[0]!).toMatchObject({
        name: 'isr',
        source: { line: lineOf('main.c', 'BIOS_IF |= 1;') + 1 },
      });
    }
    const frame = h.session.frame;
    h.session.stepOver();
    expect(h.stops.at(-1)?.reason).toBe('step');
    expect(h.session.frame).toBe(frame);
    expect(h.session.machine.gba.armCpu.getMode()).toBe(SYS_MODE);
    const top = h.session.callStack()[0]!;
    expect(top.name).not.toBe('isr');
    expect(top.source!.path).toBe(MAIN);
    expect(top.source!.line).toBe(variant === 'thumb-O2' ? lineOf('main.c', 'tick();') : WAIT_RETURN_LINE);
  });

  it('step out with no caller frame says so instead of running to a stale lr', async () => {
    const h = await boot(variant);
    const line = lineOf('main.c', 'update();');
    h.session.setSourceBreakpoints(MAIN, [{ line }]);
    h.run();
    const frame = h.session.frame;
    h.session.stepOut();
    expect(h.stops.at(-1)?.description).toMatch(/no caller/);
    expect(h.session.frame).toBe(frame);
    expect(h.session.callStack()[0]!).toMatchObject({ name: 'main', source: { line } });
    expect(h.output.at(-1)).toMatch(/^\[console\] step out: no caller/);
  });

  it('hit counts start over on restart', async () => {
    const h = await boot(variant);
    const [bp] = h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'update();'), hitCondition: '== 2' }]);
    expect(h.run()?.reason).toBe('breakpoint');
    expect(bp!.hits).toBe(2);
    h.session.restart();
    expect(bp!.hits).toBe(0);
    expect(h.run()?.reason).toBe('breakpoint');
    expect(bp!.hits).toBe(2);
    expect(h.session.frame).toBe(1);
  });

  it('reverse continue honours conditions and hit conditions', async () => {
    const h = await boot(variant);
    const line = lineOf('main.c', 'update();');
    h.session.setSourceBreakpoints(MAIN, [{ line, condition: 'g_frame == 3' }]);
    h.run();
    expect(h.session.evaluate('g_frame').node.value).toBe('3');
    h.session.setSourceBreakpoints(MAIN, [{ line, condition: 'g_frame == 1' }]);
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.stops.at(-1)?.reason).toBe('breakpoint');
    expect(h.session.evaluate('g_frame').node.value).toBe('1');
    expect(h.session.callStack()[0]!.source!.line).toBe(line);
    h.session.setSourceBreakpoints(MAIN, [{ line, condition: 'g_frame == 99' }]);
    h.run(6);
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.stops.at(-1)?.reason).toBe('rewind');
    expect(h.session.frame).toBe(h.session.historyInfo().earliestFrame);
    // hit counts: the forward run stopped on the second visit; reverse lands there, then never on the first
    h.session.restart();
    const [bp] = h.session.setSourceBreakpoints(MAIN, [{ line, hitCondition: '== 2' }]);
    h.run();
    expect(bp!.hits).toBe(2);
    const at = h.session.position;
    h.session.stepInstruction();
    h.session.stepInstruction();
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.stops.at(-1)?.reason).toBe('breakpoint');
    expect(h.session.position).toEqual(at);
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.stops.at(-1)?.reason).toBe('rewind');
    expect(h.session.frame).toBe(0);
    h.session.setSourceBreakpoints(MAIN, [{ line, hitCondition: '== 1000' }]);
    h.run(6);
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.stops.at(-1)?.reason).toBe('rewind');
  });

  it('reverse continue judges each condition in the scope of its own breakpoint', async () => {
    const h = await boot(variant);
    // Locals of two different functions, both visited every frame. Sharing one
    // expression environment across the frame leaves the second condition without
    // its locals, and a condition that cannot be evaluated counts as a hit, so the
    // scan would report a breakpoint the forward run never reached.
    const bonusLine = lineOf('util.c', 'g_bonus_calls++;');
    const moveLine = lineOf('util.c', 'p->pos.x += dx;');
    h.session.setSourceBreakpoints(UTIL, [
      { line: bonusLine, condition: 'value == 1000' },
      { line: moveLine, condition: 'dx == 1000' },
    ]);
    expect(h.run(6)?.reason).toBe('pause'); // neither condition can hold
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.stops.at(-1)?.reason).toBe('rewind');
  });

  it('reverse continue lands on the previous data breakpoint hit', async () => {
    const h = await boot(variant);
    const target = h.session.dataBreakpointTarget('g_bonus_calls')!;
    h.session.setDataBreakpoints([{ ...target, access: 'write' }]);
    for (let i = 0; i < 4; i++) {
      expect(h.run()?.reason).toBe('data breakpoint');
    }
    const at = h.session.position;
    expect(h.session.evaluate('g_bonus_calls').node.value).toBe('3');
    h.session.stepInstruction();
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.stops.at(-1)?.reason).toBe('breakpoint');
    expect(h.session.position).toEqual(at);
    expect(h.session.evaluate('g_bonus_calls').node.value).toBe('3');
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.session.frame).toBe(at.frame - 1);
    expect(h.session.evaluate('g_bonus_calls').node.value).toBe('2');
  });

  it('reverse continue lands on the previous event breakpoint hit', async () => {
    const h = await boot(variant);
    h.session.setEventBreakpoints(['vblank']);
    for (let i = 0; i < 3; i++) {
      expect(h.run()?.reason).toBe('event breakpoint');
    }
    const at = h.session.position;
    h.session.stepInstruction();
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.session.position).toEqual(at);
    expect(h.session.machine.scanline).toBe(160);
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.session.frame).toBe(at.frame - 1);
    expect(h.session.machine.scanline).toBe(160);
  });

  it('a data breakpoint whose condition does not compile is unverified; the others still watch', async () => {
    const h = await boot(variant);
    const target = h.session.dataBreakpointTarget('g_bonus_calls')!;
    const results = h.session.setDataBreakpoints([
      { ...target, access: 'write' },
      { ...target, access: 'write', condition: '1 +' },
    ]);
    expect(results.map((r) => r.verified)).toEqual([true, false]);
    expect(results[1]!.message).toMatch(/unexpected end/);
    expect(h.session.breakpoints.data.length).toBe(2);
    expect(h.run()?.reason).toBe('data breakpoint');
    expect(h.stops.at(-1)?.breakpointIds).toEqual([results[0]!.id]);
    // a condition that fails to evaluate stops, and says why
    h.session.setDataBreakpoints([{ ...target, access: 'write', condition: 'no_such_symbol == 1' }]);
    expect(h.run()?.reason).toBe('data breakpoint');
    expect(h.output.at(-1)).toMatch(/^\[stderr\] data breakpoint \d+ condition 'no_such_symbol == 1': unknown symbol/);
  });

  it('a listener that throws never takes the session down', async () => {
    const h = await boot(variant);
    h.session.on({
      output: () => {
        throw new Error('boom');
      },
    });
    h.session.setFunctionBreakpoints([{ functionName: 'main', condition: 'gNope' }]);
    expect(h.run()?.reason).toBe('function breakpoint'); // a broken condition reports (to a broken listener) and stops
    expect(h.session.state).toBe('stopped');
    h.session.runToAddress(0x0bfffffe); // gives up, saying so on the output channel
    expect(h.stops.at(-1)?.description).toMatch(/gave up$/);
    expect(h.session.state).toBe('stopped');
    const seen: string[] = [];
    h.session.on({
      stopped: () => {
        throw new Error('stop boom');
      },
      output: (t, c) => seen.push(`[${c}] ${t.trim()}`),
    });
    h.session.stepInstruction();
    expect(seen).toEqual(["[stderr] listener for 'stopped' threw: stop boom"]);
    expect(h.stops.at(-1)?.reason).toBe('step'); // the other stopped listener still ran
  });

  it('restart and resync while running emit the state transition', async () => {
    const h = await boot(variant);
    const states: SessionState[] = [];
    h.session.on({ state: (s) => states.push(s) });
    h.session.continue();
    h.host.tick(50);
    h.session.restart();
    expect(h.session.state).toBe('stopped');
    expect(states).toEqual(['running', 'stopped']);
    expect(h.stops.at(-1)?.reason).toBe('restart');
    states.length = 0;
    h.session.continue();
    h.host.tick(50);
    h.session.resync();
    expect(states).toEqual(['running', 'stopped']);
    expect(h.stops.at(-1)?.reason).toBe('restart');
    h.session.continue();
    h.host.tick(FRAME_MS);
    expect(h.stops.at(-1)?.reason).toBe('restart'); // no pause left behind by the resync
  });

  it('a synchronous step runs as `running`: a pause lands between its frames, a command from a listener is refused', async () => {
    const h = await boot(variant);
    h.run(2);
    const states: SessionState[] = [];
    h.session.on({ state: (s) => states.push(s), continued: () => h.session.pause() });
    const frame = h.session.frame;
    h.session.runToAddress(0x08000000);
    expect(states).toEqual(['running', 'stopped']);
    expect(h.stops.at(-1)?.reason).toBe('pause');
    expect(h.session.frame).toBeLessThanOrEqual(frame + 1);
    let refused: string | null = null;
    const off = h.session.on({
      frame: () => {
        try {
          h.session.stepInstruction();
        } catch (err) {
          refused = (err as Error).message;
        }
      },
    });
    const before = h.stops.length;
    h.session.stepInstruction();
    off();
    expect(refused).toMatch(/from inside a session event/);
    expect(h.stops.length).toBe(before + 1);
    expect(h.stops.at(-1)?.address).toBe(h.session.pc);
  });

  it('a step that gives up says which budget ran out', async () => {
    const h = await boot(variant);
    h.session.runToAddress(0x0bfffffe);
    expect(h.output.at(-1)).toMatch(/^\[console\] run to 0xbfffffe did not complete within 300 frames/);
    expect(h.stops.at(-1)?.description).toBe('run to 0xbfffffe gave up');
    const slow = new ManualHost();
    let clock = 0;
    const slowHost: Host = { interval: (fn, ms) => slow.interval(fn, ms), now: () => (clock += 1000) };
    const s = await Session.create(slowHost, { ...fixture(variant), cwd: fixtures, exists: () => true });
    const output: string[] = [];
    s.on({ output: (t) => output.push(t.trim()) });
    s.runToAddress(0x0bfffffe);
    expect(output.at(-1)).toMatch(/did not complete within 1\.5 s \(\d frames\)/);
  });

  it('a recording whose start frame is ahead of the machine is not replayed', async () => {
    const h = await boot(variant);
    h.session.startRecording();
    h.run(3);
    const rec = h.session.stopRecording();
    const frame = h.session.frame;
    const before = h.stops.length;
    expect(h.session.replayRecording({ ...rec, startFrame: frame + 37, frames: [1, 1] })).toBe(false);
    expect(h.session.frame).toBe(frame);
    expect(h.session.state).toBe('stopped');
    expect(h.stops.length).toBe(before);
  });

  it('a function breakpoint arms an inlined-only function at its inlined entries', async () => {
    const h = await boot(variant);
    const [bp] = h.session.setFunctionBreakpoints([{ functionName: 'tick' }]);
    expect(bp!.verified).toBe(true);
    if (variant === 'thumb-O2') {
      const [byLine] = h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'tick();') }]);
      expect(bp!.addresses).toEqual(byLine!.addresses);
      h.session.setSourceBreakpoints(MAIN, []);
    }
    expect(h.run()?.reason).toBe('function breakpoint');
    expect(h.session.callStack()[0]!.name).toBe(variant === 'thumb-O2' ? 'tick (inlined)' : 'tick');
    expect(h.session.setFunctionBreakpoints([{ functionName: 'no_such_fn' }])[0]!.message).toBe(
      "no symbol 'no_such_fn'",
    );
  });

  it('refuses a frame index the stack does not have', async () => {
    const h = await boot(variant);
    expect(() => h.session.evaluate('sp', 99)).toThrow(/no frame 99/);
    expect(() => h.session.evaluate('sp', 1.5)).toThrow(/no frame/);
    expect(() => h.session.evaluate('4294967296')).toThrow(/32 bits/);
  });

  it('an event breakpoint on VBlank stops inside the frame', async () => {
    const h = await boot(variant);
    h.session.setEventBreakpoints(['vblank']);
    const stop = h.run();
    expect(stop?.reason).toBe('event breakpoint');
    expect(stop?.description).toBe('VBlank');
    expect(h.session.machine.scanline).toBe(160);
  });

  it('step back is exact: instructions, frames and registers come back as they were', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'update();') }]);
    for (let i = 0; i < 6; i++) {
      h.run();
    }
    const at = h.session.position;
    const regs = Array.from(h.session.machine.registers);
    const snap = h.session.machine.snapshot();
    h.session.stepInstruction();
    h.session.stepInstruction();
    h.session.stepInstruction();
    expect(h.session.position.instruction).toBe(at.instruction + 3);
    expect(h.session.stepBack()).toBe(true);
    expect(h.session.stepBack()).toBe(true);
    expect(h.session.stepBack()).toBe(true);
    expect(h.session.position).toEqual(at);
    expect(Array.from(h.session.machine.registers)).toEqual(regs);
    expect(h.session.machine.snapshot()).toEqual(snap);
  });

  it('step back across a frame boundary lands on the last instruction of the previous frame', async () => {
    const h = await boot(variant);
    h.run(3); // a pause lands on a frame boundary
    h.session.setSourceBreakpoints(MAIN, []);
    expect(h.session.position.instruction).toBe(0);
    const frame = h.session.frame;
    expect(h.session.stepBack()).toBe(true);
    expect(h.session.frame).toBe(frame - 1);
    expect(h.session.position.instruction).toBeGreaterThan(0);
    h.session.stepInstruction();
    expect(h.session.frame).toBe(frame);
    expect(h.session.position.instruction).toBe(0);
  });

  it('rewinding and re-running reproduces the same machine', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'draw();') }]);
    for (let i = 0; i < 9; i++) {
      h.run();
    }
    const snap = h.session.machine.snapshot();
    const frame = h.session.frame;
    // from inside a frame, the first frame back is the start of this one
    expect(h.session.rewindFrames(5)).toBe(true);
    expect(h.session.frame).toBe(frame - 4);
    expect(h.stops[h.stops.length - 1]?.reason).toBe('rewind');
    for (let i = 0; i < 5; i++) {
      h.run();
    }
    expect(h.session.frame).toBe(frame);
    expect(h.session.machine.snapshot()).toEqual(snap);
  });

  it('reverse continue lands on the previous breakpoint hit', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'draw();') }]);
    for (let i = 0; i < 4; i++) {
      h.run();
    }
    const frame = h.session.frame;
    h.session.stepInstruction();
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.session.frame).toBe(frame);
    expect(h.session.callStack()[0]!.source!.line).toBe(lineOf('main.c', 'draw();'));
    expect(h.session.reverseContinue()).toBe(true);
    expect(h.session.frame).toBe(frame - 1);
  });

  it('a rewind that cannot move says so, instead of stopping in place as if it had', async () => {
    const h = await boot(variant);
    const stops = h.stops.length;
    expect(h.session.rewindFrames(1)).toBe(false);
    expect(h.session.rewindToFrame(10_000)).toBe(false);
    expect(h.session.rewindToFrame(-1)).toBe(false);
    expect(h.stops.length).toBe(stops);
    // from inside a frame, the start of that frame is a move
    h.session.stepInstruction();
    expect(h.session.position.instruction).toBe(1);
    expect(h.session.rewindToFrame(h.session.frame)).toBe(true);
    expect(h.session.position).toMatchObject({ frame: 0, instruction: 0 });
    expect(h.stops[h.stops.length - 1]?.reason).toBe('rewind');
  });

  it('a button mask sets every button at once: now at a frame boundary, at the next frame otherwise', async () => {
    const h = await boot(variant);
    h.session.setButtons(0b1000000011);
    expect(h.session.buttons).toBe(0b1000000011);
    expect(h.session.machine.buttons).toBe(0b1000000011);
    h.session.setButtons(0b110); // clears what the first mask set
    expect(h.session.machine.buttons).toBe(0b110);
    h.session.stepScanline();
    h.session.setButtons(0b1 | (1 << 12)); // only the ten buttons the GBA has
    expect(h.session.buttons).toBe(0b1);
    expect(h.session.machine.buttons).toBe(0b110); // pending: the input log stays exact per frame
    h.session.stepFrame();
    expect(h.session.machine.buttons).toBe(0b1);
  });

  it('input is latched per frame, recorded, and replayed to the same state', async () => {
    const h = await boot(variant);
    h.session.startRecording();
    h.session.setButton(0, true); // A
    h.run(2);
    h.session.setButton(0, false);
    h.run(2);
    const recording = h.session.stopRecording();
    expect(recording.frames.filter((m) => m === 1).length).toBe(2);
    expect(h.session.recordingAsScript(recording)).toContain("press('a', { hold: 2 })");
    const keys = Number(h.session.evaluate('g_keys').node.value.split(' ')[0]);
    expect(keys).toBe(0);
    const end = h.session.machine.snapshot();
    h.session.restart();
    expect(h.session.replayRecording(recording)).toBe(true);
    expect(h.session.machine.snapshot()).toEqual(end);
  });

  it('a recording begins and ends as an event, knows its start frame, and the last one is kept', async () => {
    const h = await boot(variant);
    const flips: boolean[] = [];
    h.session.on({ recording: (active) => flips.push(active) });
    h.run(2);
    const start = h.session.frame;
    expect(h.session.lastRecording).toBeNull();
    h.session.startRecording();
    expect(flips).toEqual([true]);
    expect(h.session.recordingStart).toBe(start);
    expect(h.session.historyInfo()).toMatchObject({ recording: true, recordingStart: start });
    h.session.startRecording(); // already recording: the flag did not flip
    expect(flips).toEqual([true]);
    h.run(2);
    const recording = h.session.stopRecording();
    expect(flips).toEqual([true, false]);
    expect(h.session.recordingStart).toBeNull();
    expect(h.session.historyInfo()).toMatchObject({ recording: false, recordingStart: null });
    expect(h.session.lastRecording).toBe(recording);
    h.session.startRecording();
    h.session.restart(); // a restart ends the recording in progress
    expect(flips).toEqual([true, false, true, false]);
    expect(h.session.recording).toBe(false);
    expect(h.session.lastRecording).toBe(recording); // kept: a recording from frame 0 is replayed after a restart
  });

  it('keeps each recording with the screen it began on, and replays it from there or from here', async () => {
    const h = await boot(variant);
    h.run(2);
    h.session.startRecording();
    h.session.setButton(0, true); // A
    h.run(2);
    h.session.setButton(0, false);
    h.run(2);
    h.session.stopRecording();
    const takes = h.session.recordings;
    expect(takes.length).toBe(1);
    const take = takes[0]!;
    expect(take.script).toContain("press('a'");
    // the screen where it began, halved in each axis and opaque
    expect(take.thumbnail).toMatchObject({ width: 120, height: 80 });
    expect(take.thumbnail.rgba.length).toBe(120 * 80 * 4);
    expect(take.thumbnail.rgba[3]).toBe(255);

    // from where it was recorded: the machine goes back there and ends where it ended
    const after = h.session.machine.snapshot();
    const end = h.session.frame;
    h.run(3);
    expect(h.session.replayRecording(take.recording, 'start')).toBe(true);
    expect(h.session.frame).toBe(end);
    expect(h.session.machine.snapshot()).toEqual(after);

    // from here: the same buttons, pressed from wherever the machine is now
    const before = h.session.frame;
    expect(h.session.replayRecording(take.recording, 'here')).toBe(true);
    expect(h.session.frame).toBe(before + take.recording.frames.length);

    // a second recording is kept beside the first, newest last
    h.session.startRecording();
    h.run(1);
    h.session.stopRecording();
    expect(h.session.recordings.map((t) => t.id)).toEqual([take.id, take.id + 1]);
  });

  it('save states round-trip and are bound to the ROM', async () => {
    const h = await boot(variant);
    h.run(5);
    const text = h.session.saveState('five');
    const frame = h.session.frame;
    h.run(3);
    h.session.loadState(text);
    expect(h.session.frame).toBe(frame);
    expect(() => h.session.loadState(text.replace(/"romHash":"[0-9a-f-]+"/, '"romHash":"nope"'))).toThrow(
      /different ROM/,
    );
  });
});

describe('Session views and tools (thumb-O0)', () => {
  it('lists the lines of a file a breakpoint arms without sliding, inlined call sites included', async () => {
    const h = await boot('thumb-O2');
    const lines = h.session.program.codeLines(MAIN);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(lines).toContain(lineOf('main.c', 'tick();')); // an inlined call: the line has no rows of its own
    expect(lines).toContain(lineOf('main.c', 'draw();'));
    expect(lines).not.toContain(lineOf('main.c', '/* The VBlank handler'));
    const last = Math.max(...lines);
    for (let line = 1; line <= last + 5; line++) {
      expect(h.session.program.hasCodeAt(MAIN, line), `line ${line}`).toBe(lines.includes(line));
    }
    expect(h.session.program.codeLines(join(fixtures, 'source', 'nowhere.c'))).toEqual([]);
  });

  it('describes a watched word whose top bit is set by its bits, and watches nothing past the bus', async () => {
    const h = await boot('thumb-O0');
    expect(h.session.dataBreakpointTarget('0x1ffffffff')).toBeNull();
    const target = h.session.dataBreakpointTarget('0x8000000')!;
    expect(target).toMatchObject({ address: 0x08000000, length: 4 });
    h.session.setDataBreakpoints([{ ...target, access: 'read' }]);
    const stop = h.run();
    expect(stop?.reason).toBe('data breakpoint');
    expect(stop?.description).toMatch(/^0x8000000 read \(0x[0-9a-f]{8}, 4 bytes at 0x8000000\) by /);
    expect(stop?.description).not.toContain('0x-');
  });

  it('memory search finds a global by value and narrows it', async () => {
    const h = await boot('thumb-O0');
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'draw();') }]);
    for (let i = 0; i < 7; i++) {
      h.run();
    }
    const address = h.session.program.symbolAddress('g_frame')!;
    const value = Number(h.session.evaluate('g_frame').node.value);
    let found = h.session.searchMemory({ value, size: 4, region: 'iwram' });
    expect(found).toContain(address);
    const candidates = found.length;
    h.run();
    found = h.session.filterMemory(found, value + 1, 4);
    expect(found).toContain(address);
    expect(found.length).toBeLessThan(candidates);
    // the frame counter and the VBlank counter move together; a value that does not, drops out
    expect(found).not.toContain(h.session.program.symbolAddress('g_samples'));
  });

  it('labels name addresses in disassembly and evaluation, and import symbol files', async () => {
    const h = await boot('thumb-O0');
    const address = h.session.program.symbolAddress('add_bonus')!;
    h.session.labels.set({ address, label: 'AddBonus', comment: 'adds the per-frame bonus' });
    expect(h.session.disassemble(address, 1)[0]!.label).toBe('AddBonus');
    expect(h.session.evaluate('&AddBonus').node.value).toContain(address.toString());
    const n = h.session.labels.importSymbols('03000010 gMystery\nsome junk line\ngOther = 0x03000020;\n');
    expect(n).toBe(2);
    expect(h.session.labels.byName('gOther')?.address).toBe(0x03000020);
    expect(h.session.labels.exportSymbols()).toContain('03000010 gMystery');
    const cast = h.session.evaluate('(u16)&gMystery');
    expect(cast.node.type).toBe('u16');
    expect(cast.address).toBe(0x03000010);
    expect(cast.node.value).toBe('0');
  });

  it('every label edit is one labels event, however many lines an import brings', async () => {
    const h = await boot('thumb-O0');
    const labels = vi.fn();
    h.session.on({ labels });
    const address = h.session.program.symbolAddress('add_bonus')!;
    h.session.labels.set({ address, label: 'AddBonus' });
    expect(labels).toHaveBeenCalledTimes(1);
    expect(h.session.labels.importSymbols('03000010 gMystery\ngOther = 0x03000020;\n')).toBe(2);
    expect(labels).toHaveBeenCalledTimes(2);
    h.session.labels.loadFile({ format: 'gba-kit-labels', version: 1, labels: [{ address: 0x03000030, label: 'a' }] });
    expect(labels).toHaveBeenCalledTimes(3);
    h.session.labels.remove(address);
    expect(labels).toHaveBeenCalledTimes(4);
    expect(h.session.disassemble(address, 1)[0]!.label).toBeUndefined();
  });

  it('labels persist under the project directory of whatever files the host offers', async () => {
    const store = new Map<string, string>();
    const files: HostFiles = {
      readText: async (path) => store.get(path) ?? null,
      writeText: async (path, text) => void store.set(path, text),
      readBytes: async () => null,
      writeBytes: async () => {},
      list: async () => [],
      join: (...parts) => parts.join('/'),
    };
    const host = new ManualHost(files);
    const options = { ...fixture('thumb-O0'), cwd: fixtures, exists: () => true };
    const first = await Session.create(host, { ...options, projectDir: '/roms/a' });
    const address = first.program.symbolAddress('add_bonus')!;
    first.labels.set({ address, label: 'AddBonus' });
    expect(first.labels.dirty).toBe(true);
    expect(await first.saveLabels()).toBe('/roms/a/.gba-kit/labels.json');
    expect(first.labels.dirty).toBe(false);
    expect(JSON.parse(store.get('/roms/a/.gba-kit/labels.json')!).romHash).toBe(first.romHash);

    const again = await Session.create(host, { ...options, projectDir: '/roms/a' });
    expect(again.labels.at(address)?.label).toBe('AddBonus');
    expect(again.labels.dirty).toBe(false);
    const other = await Session.create(host, { ...options, projectDir: '/roms/b' });
    expect(other.labels.size).toBe(0);
  });

  it('an ELF built for another ROM is reported as a mismatch, not adopted quietly', async () => {
    const mismatched = await Session.create(new ManualHost(), {
      rom: fixture('thumb-O2').rom,
      elf: fixture('thumb-O0').elf,
      cwd: fixtures,
      exists: () => true,
    });
    expect(mismatched.program.hasSymbols).toBe(true);
    expect(mismatched.program.identity).toEqual({
      ok: false,
      reason: expect.stringContaining('extends past the end of the ROM'),
      section: '.text',
    });
    const matched = await boot('thumb-O0');
    expect(matched.session.program.identity).toEqual({ ok: true, comparedBytes: expect.any(Number) });
  });

  it('functions evaluate as code, and a function pointer names its target', async () => {
    const h = await boot('thumb-O0');
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'draw();') }]);
    h.run();
    const main = h.session.evaluate('main');
    expect(main.node).toMatchObject({
      type: 'function',
      value: expect.stringMatching(/^main @ 0x08000[0-9a-f]{3} \(\d+ bytes of code\)$/),
    });
    expect(main.address).toBe(h.session.program.symbolAddress('main'));
    const handler = h.session.evaluate('(u32)0x03007ffc').node; // IRQ_HANDLER holds isr
    expect(handler.value).toMatch(/^\d+ \(0x08000114\)$/);
  });

  it('writes and reads 64-bit scalars at full precision', async () => {
    const h = await boot('thumb-O0');
    const target = { address: 0x03000100, size: 8, kind: 'int' as const };
    expect(h.session.inspector.setScalar(target, '0x1122334455667788')).toBe(
      '1234605616436508552 (0x1122334455667788)',
    );
    expect(Array.from(h.session.readMemory(0x03000100, 8).data)).toEqual([
      0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
    ]);
    expect(h.session.inspector.setScalar(target, '-1')).toBe('-1 (0xffffffffffffffff)');
    expect(Array.from(h.session.readMemory(0x03000100, 8).data)).toEqual(new Array(8).fill(0xff));
    expect(() => h.session.inspector.setScalar(target, '0x10000000000000000')).toThrow(/out of range/);
    expect(h.session.inspector.setScalar({ ...target, kind: 'uint' }, '4294967296')).toBe(
      '4294967296 (0x0000000100000000)',
    );
  });

  it('a data breakpoint can watch a local by name from its frame', async () => {
    const h = await boot('thumb-O0');
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'move_player(&g_player') }]);
    h.run();
    const bonus = h.session.dataBreakpointTarget('bonus', undefined, 0)!;
    expect(bonus).toMatchObject({ length: 4, name: 'bonus' });
    expect(bonus.address).toBe(h.session.evaluate('bonus').address);
    expect(h.session.dataBreakpointTarget('bonus')).toBeNull(); // without a frame it is not a global
    h.session.setSourceBreakpoints(MAIN, []);
    h.session.setDataBreakpoints([{ ...bonus, access: 'write' }]);
    expect(h.run()?.description).toMatch(/^bonus written \(0x2, 4 bytes/);
  });

  it('without an ELF the disassembly follows the CPU mode at the stop', async () => {
    const { rom } = fixture('arm-O0');
    const s = await Session.create(new ManualHost(), { rom, elf: null, cwd: '/', exists: () => true });
    expect(s.machine.thumb).toBe(false);
    const [entry] = s.disassemble(s.pc, 1);
    expect(entry).toMatchObject({ size: 4, text: expect.stringMatching(/^b 0x080000c0/) });
    while (s.pc !== 0x080000ec) {
      s.stepInstruction();
    }
    expect(s.machine.thumb).toBe(false);
    expect(s.disassemble(s.pc, 1)[0]).toMatchObject({
      size: 4,
      text: expect.stringMatching(/^strcc r3, \[r1\], #0x4/),
    });
    const thumb = await Session.create(new ManualHost(), {
      rom: fixture('thumb-O0').rom,
      elf: null,
      cwd: '/',
      exists: () => true,
    });
    thumb.runToAddress(0x08000240); // main, Thumb
    expect(thumb.pc).toBe(0x08000240);
    expect(thumb.machine.thumb).toBe(true);
    expect(thumb.disassemble(thumb.pc, 1)[0]!.size).toBe(2);
  });

  it('disassembles the entry with symbols and source, in the right instruction set', async () => {
    const h = await boot('thumb-O0');
    const main = h.session.program.symbolAddress('main')!;
    const lines = h.session.disassemble(main, 4);
    expect(lines[0]!.symbol).toBe('main');
    expect(lines[0]!.source?.path).toBe(MAIN);
    expect(lines.every((l) => l.size === 2)).toBe(true); // Thumb
    const entry = h.session.disassemble(0x08000000, 1)[0]!;
    expect(entry.size).toBe(4); // the cartridge header branch is ARM
    expect(entry.text.startsWith('b ')).toBe(true);
  });

  it('decodes the display registers, palette and sprites', async () => {
    const h = await boot('thumb-O0');
    h.run(2);
    const dispcnt = h.session.ioRegisters().find((r) => r.name === 'DISPCNT')!;
    expect(dispcnt.value).toBe(0x0403);
    expect(dispcnt.decoded.find((f) => f.name === 'mode')!.value).toBe(3);
    expect(dispcnt.decoded.find((f) => f.name === 'bg2')!.value).toBe(1);
    expect(h.session.palette().bg.length).toBe(256);
    expect(h.session.sprites().length).toBe(128);
    expect(h.session.backgrounds().mode).toBe(3);
    expect(h.session.tiles(0, 4, 2).pixels.length).toBe(128);
  });

  it('the trace ring records executed instructions, the event log records hardware', async () => {
    const h = await boot('thumb-O0');
    h.session.setTracing(true);
    h.session.stepInstruction();
    h.session.stepInstruction();
    expect(h.session.trace.size).toBe(2);
    expect(h.session.trace.last(1)[0]!.pc).toBeGreaterThanOrEqual(0x08000000);
    h.run(2);
    const kinds = new Set(h.session.events.slice(0, 10_000).map((e) => e.event.kind));
    expect(kinds.has('vblank')).toBe(true);
    expect(kinds.has('irq-request')).toBe(true);
    expect(kinds.has('mmio-write')).toBe(true);
  });

  it('turning tracing on or off is an event; a resync putting the hooks back is not', async () => {
    const h = await boot('thumb-O0');
    const changes: boolean[] = [];
    h.session.on({ tracing: (on) => changes.push(on) });
    h.session.setTracing(true);
    h.session.setTracing(true);
    expect(changes).toEqual([true]);
    h.session.resync();
    expect(changes).toEqual([true]);
    expect(h.session.tracing).toBe(true);
    h.session.setTracing(false);
    expect(changes).toEqual([true, false]);
  });

  it('reads audio from the machine only while a listener wants it', async () => {
    const h = await boot('thumb-O0');
    const read = vi.spyOn(h.session.machine, 'readAudio');
    const runFrames = (n: number): void => {
      h.session.continue();
      for (let i = 0; i < n; i++) {
        h.host.tick(FRAME_MS);
      }
      h.session.pause();
      h.host.tick(FRAME_MS);
    };
    runFrames(3);
    expect(read).not.toHaveBeenCalled();

    const chunks: number[] = [];
    const off = h.session.on({ audio: (samples) => chunks.push(samples.length) });
    runFrames(3);
    expect(read).toHaveBeenCalled();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((n) => n > 0 && n % 2 === 0)).toBe(true);

    off();
    read.mockClear();
    runFrames(3);
    expect(read).not.toHaveBeenCalled();
  });

  it('wraps an existing machine and resyncs after someone else drove it', async () => {
    const rom = new Uint8Array(readFileSync(join(fixtures, 'build', 'thumb-O0.gba')));
    const elf = new Uint8Array(readFileSync(join(fixtures, 'build', 'thumb-O0.elf')));
    const outside = new Machine(rom);
    outside.runFrame();
    outside.runFrame();
    const host = new ManualHost();
    const session = await Session.create(host, { rom, elf, cwd: fixtures, exists: () => true, machine: outside });
    expect(session.machine).toBe(outside);
    expect(session.frame).toBe(2); // adopted as it was, not rebooted
    session.stepFrame();
    expect(session.frame).toBe(3);
    expect(session.stepBack()).toBe(true);
    // the other driver moves the machine behind the session's back
    outside.runFrame();
    outside.runFrame();
    outside.runFrame();
    const stops: StopInfo[] = [];
    session.on({ stopped: (i) => stops.push(i) });
    const epoch = session.epoch;
    session.resync();
    expect(stops[0]?.reason).toBe('restart');
    expect(session.epoch).toBe(epoch + 1);
    expect(session.frame).toBe(outside.frame);
    expect(session.historyInfo().earliestFrame).toBe(outside.frame);
    expect(session.stepBack()).toBe(false); // no history before the resync
    session.stepFrame();
    expect(session.frame).toBe(outside.frame);
    expect(session.stepBack()).toBe(true);
  });

  it('hooks stay quiet while another driver runs the shared machine, and come back on resync', async () => {
    const { rom, elf } = fixture('thumb-O0');
    const outside = new Machine(rom);
    const session = await Session.create(new ManualHost(), {
      rom,
      elf,
      cwd: fixtures,
      exists: () => true,
      machine: outside,
    });
    const target = session.dataBreakpointTarget('g_frame')!;
    const [bp] = session.setDataBreakpoints([{ ...target, access: 'write', hitCondition: '== 3' }]);
    session.setTracing(true);
    session.stepFrame();
    expect(outside.gba.bus.hasWatchpoints()).toBe(true);
    const hits = bp!.hits;
    const events = session.events.size;
    const trace = session.trace.size;
    expect(hits).toBeGreaterThan(0);
    expect(events).toBeGreaterThan(0);
    outside.runFrame();
    outside.runFrame();
    expect(bp!.hits).toBe(hits);
    expect(session.events.size).toBe(events);
    expect(session.trace.size).toBe(trace);
    expect(session.state).toBe('stopped');
    session.detach();
    expect(outside.gba.onHardwareEvent).toBeNull();
    expect(outside.gba.bus.hasWatchpoints()).toBe(false);
    outside.runFrame();
    session.resync();
    expect(outside.gba.onHardwareEvent).not.toBeNull();
    expect(outside.gba.bus.hasWatchpoints()).toBe(true);
    expect(session.events.size).toBe(0);
    expect(session.trace.size).toBe(0);
    const stops: StopInfo[] = [];
    session.on({ stopped: (s) => stops.push(s) });
    const resumed = session.frame;
    session.stepFrame();
    session.stepFrame();
    session.stepFrame();
    expect(stops.at(-1)?.reason).toBe('data breakpoint'); // the third write since the resync, not the first
    expect(session.frame).toBe(resumed + 2);
    expect(session.events.size).toBeGreaterThan(0);
    expect(session.trace.size).toBeGreaterThan(0);
  });

  it('disposing one session leaves a sibling on the same machine intact, and dispose is terminal', async () => {
    const { rom, elf } = fixture('thumb-O0');
    const outside = new Machine(rom);
    const options = { rom, elf, cwd: fixtures, exists: () => true, machine: outside };
    const a = await Session.create(new ManualHost(), options);
    const b = await Session.create(new ManualHost(), options);
    b.setTracing(true);
    a.dispose();
    expect(outside.gba.onHardwareEvent).not.toBeNull();
    b.stepFrame();
    expect(b.events.size).toBeGreaterThan(0);
    expect(b.trace.size).toBeGreaterThan(0);
    expect(() => a.resync()).toThrow(/disposed/);
    expect(() => a.restart()).toThrow(/disposed/);
    expect(a.state).toBe('disposed');
    a.dispose(); // idempotent
    b.dispose();
    expect(outside.gba.onHardwareEvent).toBeNull();
  });

  it('a session adopting a machine stopped at an inlined call shows the call site, like any stop', async () => {
    const h = await boot('thumb-O2');
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'wait_vblank();') }]);
    h.run();
    const first = h.session.callStack().map((f) => f.name);
    expect(first).toEqual(['main']);
    const second = await Session.create(new ManualHost(), {
      ...fixture('thumb-O2'),
      cwd: fixtures,
      exists: () => true,
      machine: h.session.machine,
    });
    expect(second.callStack().map((f) => f.name)).toEqual(first);
    second.stepInto();
    expect(second.callStack()[0]!.name).toBe('wait_vblank (inlined)');
  });

  it('restart boots again with breakpoints kept and history cleared', async () => {
    const h = await boot('thumb-O0');
    const line = lineOf('main.c', 'draw();');
    h.session.setSourceBreakpoints(MAIN, [{ line }]);
    h.run();
    const epoch = h.session.epoch;
    h.session.restart();
    expect(h.session.epoch).toBe(epoch + 1);
    expect(h.session.pc).toBe(0x08000000);
    expect(h.session.frame).toBe(0);
    expect(h.run()?.reason).toBe('breakpoint');
  });
});
