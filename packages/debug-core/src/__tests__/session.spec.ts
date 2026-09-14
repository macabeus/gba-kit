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
import { decodeSaveState, encodeTypedArrays } from '../snapshot-codec.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'test-fixtures');
const FRAME_MS = 1000 / 59.7275;

const VARIANTS = ['thumb-O0', 'thumb-O2', 'arm-O0'] as const;
/**
 * thumb-O0 with `.debug_frame` removed — the shape an agbcc decomp ELF has, where
 * the unwinder must measure prologues instead of reading call-frame information.
 * The code is untouched, so it pairs with thumb-O0's ROM and only the unwinder's
 * inputs change.
 */
const NO_CFI = 'thumb-O0-nocfi';
type Variant = (typeof VARIANTS)[number] | typeof NO_CFI;

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
  /** tick until a run already under way stops (or `maxFrames`), returning the stop */
  finish(maxFrames?: number): StopInfo | null;
}

function fixture(variant: Variant): { rom: Uint8Array; elf: Uint8Array } {
  return {
    rom: new Uint8Array(readFileSync(join(fixtures, 'build', `${variant === NO_CFI ? 'thumb-O0' : variant}.gba`))),
    elf: new Uint8Array(readFileSync(join(fixtures, 'build', `${variant}.elf`))),
  };
}

async function boot(variant: Variant, host: ManualHost = new ManualHost()): Promise<Harness> {
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
    finish(maxFrames = 600) {
      const before = stops.length;
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
/** The instructions that undo a frame, as the disassembler spells them. */
const TEARDOWN = /^(pop|ldm|add\s+sp|bx)\b/;
const SYS_MODE = 0x1f;

/** The line whose code the CPU sits on, halted, after the `swi` (inlined at -O2, so it is the caller's next line). */
function lineAfterSwi(variant: Variant): number {
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
    // `&x` is a pointer to x: its own hex word, with x itself as its one child
    const reference = h.session.evaluate('&g_player.mode');
    expect(reference.node.scalar!.value).toBe(mode.address);
    expect(reference.address).toBe(mode.address);
    expect(reference.node.type).toBe('enum Mode *');
    expect(reference.node.children!()[0]!.value).toBe(mode.node.value);
    expect(h.session.evaluate('&g_player.pos.y').address).toBe(h.session.evaluate('g_player.pos.y').address);
    expect(h.session.evaluate('&g_samples[1]').address).toBe(h.session.program.symbolAddress('g_samples')! + 4);
    const cast = h.session.evaluate('(enum Mode)&g_player.mode');
    expect(cast.address).toBe(mode.address);
    expect(cast.node.value).toBe('MODE_PLAY (1)');
    // (T *)x is the pointer, (T)x is the T at x
    const pointerCast = h.session.evaluate('(Point *)&g_player');
    expect(pointerCast.node.type).toBe('Point *');
    expect(pointerCast.node.children!()).toHaveLength(1);
    expect(h.session.evaluate('(Point)&g_player').node.children!().map((c) => c.value)).toEqual([
      h.session.evaluate('g_player.pos.x').node.value,
      '-7',
    ]);
    expect(h.session.evaluate('((struct Player *)&g_player)->pos.y').node.value).toBe('-7');
    expect(h.session.evaluate('(*(Point *)&g_player).y').node.value).toBe('-7');
    expect(h.session.evaluate('s32(&g_player.pos.y)').node.value).toBe('-7 (0xfffffff9)');
    expect(h.session.evaluate('(int)g_player.pos.y').node.value).toBe('-7'); // a cast's operand names a place
    expect(h.session.evaluate('(int)(g_player.pos.y)').node.value).toBe('-7'); // parentheses name the same place
    // an arithmetic result is a number, not a place: -7 is no address to reinterpret
    expect(() => h.session.evaluate('(int)(g_player.pos.y + 0)')).toThrow(/not a readable address/);
    expect(() => h.session.evaluate('(Nope *)&g_player')).toThrow(/unknown type 'Nope'/);
    expect(() => h.session.evaluate('&g_nope')).toThrow(/unknown symbol/);
  });

  it('a variable index reads the element the same constant index reads', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'g_samples[g_frame & 3] = total;') }]);
    expect(h.run()?.reason).toBe('breakpoint');
    const i = h.session.evaluate('g_frame & 3').node.scalar!.value;
    const dynamic = h.session.evaluate('g_samples[g_frame & 3]');
    expect(dynamic.node.value).toBe(h.session.evaluate(`g_samples[${i}]`).node.value);
    // and lands on the element the variables tree shows at that index
    const elements = h.session.evaluate('g_samples').node.children!();
    expect(dynamic.node.value).toBe(elements[i]!.value);
    expect(dynamic.address).toBe(elements[i]!.address);
    expect(h.session.evaluate('g_samples[g_frame & 3] == g_samples[g_frame & 3]').node.value).toBe('1 (0x1)');
    expect(h.session.assign('g_samples[g_frame & 3]', '7').node.value).toBe('7');
    expect(h.session.evaluate(`g_samples[${i}]`).node.value).toBe('7');
  });

  it('a computed array reads as the array, not as the address that is its word', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'g_samples[g_frame & 3] = total;') }]);
    expect(h.run()?.reason).toBe('breakpoint');
    // a ternary is the one expression with a type that names no storage: both arms
    // are one type, but which arm ran is not knowable until it runs, so all that is
    // left is the word — and an array's word is its own address
    const direct = h.session.evaluate('g_samples');
    const chosen = h.session.evaluate('1 ? g_samples : g_samples');
    expect(chosen.node.value).toBe(direct.node.value);
    expect(chosen.address).toBe(direct.address);
    expect(h.session.evaluate('g_frame ? g_player.name : g_player.name').node.value).toBe(
      h.session.evaluate('g_player.name').node.value,
    );
  });

  it('a pointer parameter reads through ->, * and the members below them', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(UTIL, [{ line: lineOf('util.c', 'if (p->pos.x > 100)') }]);
    expect(h.run()?.reason).toBe('breakpoint');
    expect(h.session.callStack()[0]!.name).toBe('move_player');
    expect(h.session.evaluate('p->pos.y').node.value).toBe('-7');
    expect(h.session.evaluate('(*p).pos.y').node.value).toBe('-7');
    expect(h.session.evaluate('p->pos.x').node.value).toBe(h.session.evaluate('g_player.pos.x').node.value);
    expect(h.session.evaluate('p->mode').node.value).toBe('MODE_PLAY (1)');
    expect(h.session.evaluate('p->stats.hp').node.value).toBe('9 (4 bits)');
    expect(h.session.evaluate('p->name[1]').node.value).toBe(h.session.evaluate('g_player.name[1]').node.value);
    expect(h.session.evaluate('p->pos.y < 0').node.value).toBe('1 (0x1)');
    // the pointee is the whole struct, as the variables tree shows it
    const pointee = h.session.evaluate('*p');
    expect(pointee.node.type).toBe('struct Player');
    expect(pointee.address).toBe(h.session.evaluate('g_player').address);
    expect(pointee.node.children!().map((m) => m.name)).toEqual(
      h.session.evaluate('g_player').node.children!().map((m) => m.name),
    );
    // a pointer member, dereferenced: `->` binds tighter than `*`, as in C
    expect(h.session.evaluate('*p->counterRef').node.value).toBe(h.session.evaluate('g_vblank_count').node.value);
    expect(h.session.evaluate('&p->pos.y').address).toBe(h.session.evaluate('&g_player.pos.y').address);
    // a memory reference means one thing: where the value lives, for a value that
    // lives somewhere — so parenthesising the name cannot change what it points the
    // memory view at, whichever build keeps `p` in a register
    expect(h.session.evaluate('(p)').address).toBe(h.session.evaluate('p').address);
    expect(h.session.evaluate('(p)').node.value).toBe(h.session.evaluate('p').node.value);
    expect(() => h.session.evaluate('p->nope')).toThrow(/has no member 'nope'/);
    expect(() => h.session.evaluate('*g_frame')).toThrow(/not a pointer/);
    expect(() => h.session.evaluate('*0x03000000')).toThrow(/not a typed pointer/);
  });

  it('pointer arithmetic steps by the element the ELF describes', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'draw();') }]);
    h.run();
    const word = (expr: string): number => h.session.evaluate(expr).node.scalar!.value;
    expect(word('&g_samples[1]') - word('&g_samples[0]')).toBe(4);
    expect(word('g_samples + 1')).toBe(word('&g_samples[1]'));
    // one pointer minus another counts elements, and reads as the int count it is
    expect(h.session.evaluate('&g_samples[3] - &g_samples[0]').node).toMatchObject({ value: '3', type: 'int' });
    expect(() => h.session.evaluate('&g_samples[1] - g_player.counterRef')).toThrow(/they point at different types/);
    expect(h.session.evaluate('*(g_samples + 2)').node.value).toBe(h.session.evaluate('g_samples[2]').node.value);
    // one whole struct on, measured against the ELF rather than written down here:
    // the step is constant, and covers every member the tree shows
    const step = word('&g_player + 1') - word('&g_player');
    expect(word('&g_player + 2') - word('&g_player + 1')).toBe(step);
    const last = h.session.evaluate('g_player').node.children!().at(-1)!;
    expect(step).toBeGreaterThanOrEqual(last.address! + 4 - word('&g_player'));
    // a pointer in anything that is not pointer arithmetic keeps its raw word
    expect(h.session.evaluate('g_frame + 1').node.value).toBe(
      `${h.session.frame + 2} (0x${(h.session.frame + 2).toString(16)})`,
    );
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

  it('writes reach through a pointer, and a condition, a logpoint and a data breakpoint read through one', async () => {
    const h = await boot(variant);
    const line = lineOf('util.c', 'if (p->pos.x > 100)');
    h.session.setSourceBreakpoints(UTIL, [{ line, condition: 'p->pos.x > 100' }]);
    expect(h.run(5)?.reason).toBe('pause'); // x starts at 12 and climbs by at most one a frame
    expect(h.output.filter((o) => o.startsWith('[stderr]'))).toEqual([]);
    h.session.setSourceBreakpoints(UTIL, [{ line, logMessage: 'x={p->pos.x} mode={p->mode}' }]);
    h.run(2);
    const logs = h.output.filter((o) => o.startsWith('[log]'));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => /^\[log\] x=\d+ \(0x[0-9a-f]+\) mode=1 \(0x1\)$/.test(l))).toBe(true);
    // the same condition, once the value it names holds
    h.session.assign('g_player.pos.x', '200');
    h.session.setSourceBreakpoints(UTIL, [{ line, condition: 'p->pos.x > 100' }]);
    expect(h.run()?.reason).toBe('breakpoint');
    expect(h.session.callStack()[0]!.name).toBe('move_player');
    // writes through the pointer land in the struct the caller owns
    expect(h.session.assign('p->pos.x', '10').node.value).toBe('10 (0x0000000a)');
    expect(h.session.evaluate('g_player.pos.x').node.value).toBe('10 (0x0000000a)');
    expect(h.session.assign('p->stats.hp', '5').node.value).toBe('5 (4 bits)');
    expect(h.session.evaluate('g_player.stats.hp').node.value).toBe('5 (4 bits)');
    expect(() => h.session.assign('*p', '1')).toThrow(/cannot write '\*p'/);
    // and a data breakpoint watches the four bytes the member occupies
    const target = h.session.dataBreakpointTarget('p->pos.x', undefined, 0)!;
    expect(target.address).toBe(h.session.evaluate('&p->pos.x').address);
    expect(target.length).toBe(4);
    expect(h.session.dataBreakpointTarget('p->stats.hp', undefined, 0)!.length).toBe(1);
    // a dereference is a place too, on either side of the `=`
    expect(h.session.assign('*p->counterRef', '77').node.value).toBe(h.session.evaluate('g_vblank_count').node.value);
    expect(h.session.dataBreakpointTarget('g_samples[g_frame & 3]', undefined, 0)!.address).toBe(
      h.session.evaluate('&g_samples[g_frame & 3]').address,
    );
    // and a data breakpoint's condition is compiled where the user typed it, so it
    // reads the names of the frame they were looking at, not only the globals
    h.session.setSourceBreakpoints(UTIL, []);
    const watched = h.session.dataBreakpointTarget('g_player.pos.x', 4, 0)!;
    const [data] = h.session.setDataBreakpoints([{ ...watched, access: 'write', condition: 'p->pos.x > 0' }]);
    expect(data!.verified).toBe(true);
    expect(h.run(60)?.reason).toBe('data breakpoint');
    expect(h.output.filter((o) => o.startsWith('[stderr]'))).toEqual([]);
  });

  it('every write is an event carrying the fresh revision, and a refused write is not', async () => {
    const h = await boot(variant);
    const revisions: number[] = [];
    h.session.on({ written: () => revisions.push(h.session.revision) });
    const members = h.session.evaluate('g_player').node.children!();
    const x = members.find((m) => m.name === 'pos')!.children!().find((m) => m.name === 'x')!;
    h.session.setVariable(x, '7');
    expect(revisions).toEqual([h.session.revision]);
    const address = h.session.evaluate('&g_frame').address!;
    expect(h.session.writeMemory(address, new Uint8Array([1, 0, 0, 0]))).toBe(4);
    h.session.setRegister(0, 1);
    expect(revisions).toEqual([revisions[0], revisions[0]! + 1, revisions[0]! + 2]);
    // the BIOS takes no writes: nothing changed, so nothing is announced
    expect(h.session.writeMemory(0, new Uint8Array([1]))).toBe(0);
    expect(revisions).toHaveLength(3);
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

  it('step out with no caller frame says why instead of running to a stale lr', async () => {
    const h = await boot(variant);
    const line = lineOf('main.c', 'update();');
    h.session.setSourceBreakpoints(MAIN, [{ line }]);
    h.run();
    const frame = h.session.frame;
    h.session.stepOut();
    // Two ways for there to be nothing to run to, and the reason says which: lr is
    // the return of a call main made (-O0), or main never made one and lr is still
    // the 0 a reset left behind (-O2, where everything main calls is inlined).
    expect(h.stops.at(-1)?.description).toMatch(
      variant === 'thumb-O2' ? /lr does not point at program code/ : /lr is the return of a call this function made/,
    );
    expect(h.session.frame).toBe(frame);
    expect(h.session.callStack()[0]!).toMatchObject({ name: 'main', source: { line } });
    expect(h.output.at(-1)).toMatch(/^\[console\] step out: the caller is unknown/);
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

  it('a replay plays back a frame at a time, over held input, and can be paused part-way', async () => {
    const h = await boot(variant);
    h.session.startRecording();
    h.session.setButton(0, true); // A
    h.run(2);
    h.session.setButton(0, false);
    h.run(2);
    const recording = h.session.stopRecording();
    const frames: number[] = [];
    h.session.on({ frame: () => frames.push(h.session.frame) });

    // a button the user is still holding does not reach the machine during the playback
    h.session.setButton(1, true); // B
    const start = h.session.frame;
    expect(h.session.replayRecording(recording, 'here')).toBe(true);
    expect(h.session.state).toBe('running');
    expect(h.session.frame).toBe(start); // the playback is paced, not run in the call

    h.host.tick(FRAME_MS);
    expect(h.session.frame).toBe(start + 1);
    expect(h.session.machine.buttons).toBe(recording.frames[0]);
    h.host.tick(FRAME_MS);
    expect(h.session.frame).toBe(start + 2);
    expect(frames.length).toBeGreaterThan(0); // the screen is painted as it plays

    h.session.pause();
    expect(h.finish()).toMatchObject({ reason: 'pause' });
    expect(h.session.frame).toBeLessThan(start + recording.frames.length);
  });

  it('a breakpoint hit during a replay stops it there', async () => {
    const h = await boot(variant);
    h.session.startRecording();
    h.run(4);
    const recording = h.session.stopRecording();
    const [bp] = h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'tick();') }]);
    expect(bp!.verified).toBe(true);
    expect(h.session.replayRecording(recording, 'here')).toBe(true);
    expect(h.finish()).toMatchObject({ reason: 'breakpoint' });
    expect(h.session.state).toBe('stopped');
  });

  it('replays from where it was recorded even after the history holding that frame is gone', async () => {
    const h = await boot(variant);
    h.run(2);
    h.session.startRecording();
    h.session.setButton(0, true); // A
    h.run(2);
    h.session.setButton(0, false);
    h.run(2);
    h.session.stopRecording();
    const take = h.session.recordings[0]!;
    expect(take.start).toBeDefined();
    const end = h.session.machine.snapshot();
    const endFrame = h.session.frame;

    // a machine that never ran those frames: the recording's own start state is the way back
    h.session.restart();
    expect(h.session.frame).toBe(0);
    expect(h.session.replayRecording(take.recording, 'start')).toBe(false);
    expect(h.session.frame).toBe(0); // a refused replay leaves the machine alone
    expect(h.session.replayRecording(take.recording, 'start', take.start)).toBe(true);
    expect(h.session.frame).toBe(take.recording.startFrame);
    h.finish();
    expect(h.session.frame).toBe(endFrame);
    expect(h.session.machine.snapshot()).toEqual(end);
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

  it('an event breakpoint on an I/O write names the register the write landed in', async () => {
    const h = await boot(variant);
    h.session.setEventBreakpoints(['mmio-write']);
    const stop = h.run();
    expect(stop?.reason).toBe('event breakpoint');
    expect(stop?.description).toMatch(/^I\/O write [A-Z][A-Z0-9_]* \(0x[0-9a-f]+\) = 0x[0-9a-f]+$/);
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
    expect(h.finish()).toMatchObject({ description: `replayed ${recording.frames.length} frames` });
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
    h.finish();
    expect(h.session.frame).toBe(end);
    expect(h.session.machine.snapshot()).toEqual(after);

    // from here: the same buttons, pressed from wherever the machine is now
    const before = h.session.frame;
    expect(h.session.replayRecording(take.recording, 'here')).toBe(true);
    h.finish();
    expect(h.session.frame).toBe(before + take.recording.frames.length);

    // a second recording is kept beside the first, newest last
    h.session.startRecording();
    h.run(1);
    h.session.stopRecording();
    expect(h.session.recordings.map((t) => t.id)).toEqual([take.id, take.id + 1]);
  });

  it('loading a state starts a new epoch: the machine is not the one the client last saw', async () => {
    const h = await boot(variant);
    const text = h.session.saveState('here');
    h.run(3);
    const epoch = h.session.epoch;
    h.session.loadState(text);
    expect(h.session.epoch).toBe(epoch + 1);
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

describe('Session views and tools', () => {
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
    // `&` on a label is a pointer to it, and reads as the address it is
    expect(h.session.evaluate('&AddBonus').node.value).toBe(`0x${address.toString(16).padStart(8, '0')}`);
    // A label has no type, and the cast its summary names is the one that reads it:
    // `(T)x` is the T at x's address, where `(T *)x` would be the word held there.
    const mode = h.session.evaluate('&g_player.mode').node.scalar!.value;
    h.session.labels.set({ address: mode, label: 'gMystery', size: 4 });
    expect(h.session.evaluate('gMystery').node.value).toContain('no type — try (StructName)gMystery');
    expect(h.session.evaluate('(enum Mode)gMystery').node.value).toBe(h.session.evaluate('g_player.mode').node.value);
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

describe('unwinding past the end of the call-frame information', () => {
  it('bounds the hand-written entry point from its symbol, so the bottom frame can be measured at all', async () => {
    const h = await boot('thumb-O0');
    // `_start` is NOTYPE with no size, the shape every hand-written entry point has:
    // nothing in the ELF types it a function, so only the extent inferred from the
    // next symbol bounds it — and with no bounds, nothing about the frame at the
    // bottom of every stack can be measured or even named by the same ELF that
    // names the address.
    const range = h.session.program.functionRange(0x08000000);
    expect(range).toMatchObject({ name: '_start', lo: 0x08000000, exact: false });
    expect(range!.hi).toBeGreaterThan(0x08000000);
    expect(h.session.program.symbolName(0x08000000)).toBe('_start');
  });

  it('measures the chain from the prologues when the ELF has no .debug_frame at all', async () => {
    const h = await boot(NO_CFI);
    // The ROM is thumb-O0's, so the ELF still matches it: only the unwinder's inputs differ.
    expect(h.session.program.identity?.ok).toBe(true);
    expect(h.session.program.debugInfo!.scopes.frames.size).toBe(0);
    h.session.setSourceBreakpoints(UTIL, [{ line: lineOf('util.c', 'return result;') }]);
    expect(h.run()?.reason).toBe('breakpoint');
    const frames = h.session.callStack();
    // Three measured frames, rather than the innermost one and a guess from lr.
    expect(frames.map((f) => f.name)).toEqual(['add_bonus', 'update', 'main']);
    expect(frames.map((f) => f.method)).toEqual(['live', 'prologue', 'prologue']);
    expect(frames.every((f) => !f.heuristic)).toBe(true);
    expect(h.session.stack().end).toMatch(/saved return address reads 0/);
  });

  it('gives every frame of that chain its own variables, selected by index', async () => {
    const h = await boot(NO_CFI);
    h.session.setSourceBreakpoints(UTIL, [{ line: lineOf('util.c', 'return result;') }]);
    h.run();
    // A local of the caller, read through its own recovered stack pointer — which
    // without call-frame information is what a frame base has to resolve against.
    const caller = h.session.scopes(1).find((s) => s.kind === 'locals')!;
    expect(caller.nodes.find((n) => n.name === 'bonus')?.value).toBe('2');
    expect(caller.doubt).toBeNull();
    expect(h.session.evaluate('bonus', 1).node.value).toBe('2');
    expect(h.session.evaluate('value', 0).node.value).toBe(String(Number(h.session.evaluate('g_frame', 0).node.value)));
    // and the innermost frame's own names still win at index 0
    expect(
      h.session
        .scopes(0)
        .find((s) => s.kind === 'locals')!
        .nodes.map((n) => n.name),
    ).toEqual(['value', 'bonus', 'result']);
  });

  it("reports a caller's scratch registers as unrecovered rather than showing the callee's", async () => {
    const h = await boot(NO_CFI);
    h.session.setSourceBreakpoints(UTIL, [{ line: lineOf('util.c', 'return result;') }]);
    h.run();
    const inner = h.session.callStack()[0]!.virtual!.physical;
    const caller = h.session.callStack()[1]!.virtual!.physical;
    // r0-r3 and r12 belong to the callee under the ABI; the caller's are gone, and
    // showing the callee's would be a plausible value that is simply false.
    const byName = Object.fromEntries(
      h.session
        .scopes(1)
        .find((s) => s.kind === 'registers')!
        .nodes.map((n) => [n.name, n.value]),
    );
    for (const name of ['r0', 'r1', 'r2', 'r3', 'r12']) {
      expect(byName[name]).toBe('<not recovered in this frame>');
    }
    // The caller's stack pointer is the callee's frame address, which is the fact
    // the whole chain is built on.
    expect(caller.regs[13]).toBe(inner.cfa);
    expect(caller.regs[13]).toBeGreaterThan(inner.regs[13]!);
  });

  it('unwinds an interrupt handler into the code it interrupted, on the stack that code was using', async () => {
    const h = await boot(NO_CFI);
    h.session.setFunctionBreakpoints([{ functionName: 'isr' }]);
    h.run();
    expect(h.session.machine.gba.armCpu.getMode()).toBe(IRQ_MODE);
    const frames = h.session.callStack();
    expect(frames.map((f) => f.name)).toEqual(['isr', '<BIOS stub +0x90>', 'wait_vblank', 'main']);
    expect(frames.map((f) => f.method)).toEqual(['live', 'exception', 'exception', 'prologue']);
    // The dispatcher is not a function of this program, whatever the symbol table
    // and a discarded DIE would like to claim about the BIOS region.
    expect(frames[1]!.source).toBeNull();
    // An interrupted pc is the next instruction, not a return address: looked up as
    // a return address it would land on the `swi` and report the line before this.
    expect(frames[2]!.virtual!.physical.lookupPc).toBe(frames[2]!.address);
    expect(frames[2]!.source).toEqual({ path: MAIN, line: WAIT_RETURN_LINE });
    expect(frames[2]!.doubt).toMatch(/r4–r11 were not recovered across the interrupt/);
    // The interrupted code's own stack, not the handler's.
    const irqSp = h.session.machine.registers[13]!;
    expect(frames[2]!.virtual!.physical.regs[13]!).toBeLessThan(irqSp);
    expect(frames[3]!.source).toEqual({ path: MAIN, line: lineOf('main.c', 'wait_vblank();') });
  });

  it('steps out into a measured caller, and refuses from one that rests on lr', async () => {
    const h = await boot(NO_CFI);
    h.session.setSourceBreakpoints(UTIL, [{ line: lineOf('util.c', 'return result;') }]);
    h.run();
    h.session.setSourceBreakpoints(UTIL, []);
    h.session.stepOut();
    expect(h.session.callStack()[0]!.name).toBe('update');
    // At main there is no caller to find: start.s reaches it with `bx r0`, so the
    // saved return address is the 0 a reset leaves behind.
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'update();') }]);
    h.run();
    h.session.stepOut();
    expect(h.stops.at(-1)?.description).toMatch(/the caller is unknown/);
    expect(h.session.callStack()).toHaveLength(1);
    expect(h.session.stack().end).toMatch(/saved return address reads 0/);
  });

  it('reports the same depth and the same frames after stepping an instruction and back', async () => {
    const h = await boot(NO_CFI);
    h.session.setSourceBreakpoints(UTIL, [{ line: lineOf('util.c', 'return result;') }]);
    h.run();
    const before = h.session.callStack().map((f) => `${f.name} ${f.method} ${f.address}`);
    h.session.stepInstruction();
    h.session.stepBack();
    expect(h.session.callStack().map((f) => `${f.name} ${f.method} ${f.address}`)).toEqual(before);
  });
});

describe.each(VARIANTS)('the call stack on %s', (variant) => {
  it('unwinds the interrupt handler through the BIOS stub into the interrupted code', async () => {
    const h = await boot(variant);
    h.session.setFunctionBreakpoints([{ functionName: 'isr' }]);
    h.run();
    const frames = h.session.callStack();
    // The handler's return address is a BIOS address, so the chain continues only
    // by crossing the boundary it names.
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames[0]!.name).toBe('isr');
    expect(frames[1]!.name).toBe('<BIOS stub +0x90>');
    expect(frames[1]!.source).toBeNull();
    expect(frames.map((f) => f.name)).toContain('main');
    // Every frame of it answers for its own variables rather than throwing.
    for (let i = 0; i < frames.length; i++) {
      expect(() => h.session.scopes(i)).not.toThrow();
    }
  });

  it('names the same caller at every instruction of a return, where the table stops describing the frame', async () => {
    // gcc's `.debug_frame` is synchronous: its rows track the prologue and stop, so
    // from the first teardown instruction onward the CFA it gives is a whole frame
    // too high and the slot it reads for the return address has been popped. What
    // the epilogue has left to run is the measurement that holds there.
    const h = await boot(variant);
    h.session.setSourceBreakpoints(UTIL, [{ line: lineOf('util.c', 'return result;') }]);
    expect(h.run()?.reason).toBe('breakpoint');
    h.session.setSourceBreakpoints(UTIL, []);
    const chain = h.session.callStack().map((f) => f.name);
    expect(chain[0]).toBe('add_bonus');
    expect(chain.length).toBeGreaterThanOrEqual(3);
    let teardowns = 0;
    for (let step = 0; step < 24 && h.session.program.functionRange(h.session.pc)?.name === 'add_bonus'; step++) {
      expect(h.session.callStack().map((f) => f.name)).toEqual(chain);
      if (TEARDOWN.test(h.session.disassemble(h.session.pc, 1)[0]!.text)) {
        teardowns++;
      }
      h.session.stepInstruction();
    }
    // The walk has to have passed through the teardown for that to mean anything.
    expect(teardowns).toBeGreaterThan(0);
  });

  it('says why the stack ends where it does', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'update();') }]);
    h.run();
    expect(h.session.callStack().map((f) => f.name)).toEqual(['main']);
    expect(h.session.stack().end).toMatch(/saved return address reads 0/);
  });
});

/**
 * Importing a `.sav` as a state, on ROMs that declare a save. The fixture declares
 * none, so each test appends the SDK string a build would have embedded — `loadRom`
 * only scans the bytes it is handed, and the string sits past the code.
 */
describe('a .sav as a save state', () => {
  /** The fixture ROM with `id` appended, word-aligned the way a build leaves it. */
  function romDeclaring(id: string): Uint8Array {
    const base = fixture('thumb-O0').rom;
    const at = (base.length + 3) & ~3;
    const rom = new Uint8Array(at + id.length + 4);
    rom.set(base);
    for (let i = 0; i < id.length; i++) {
      rom[at + i] = id.charCodeAt(i);
    }
    return rom;
  }

  async function sessionFor(id: string): Promise<Session> {
    return Session.create(new ManualHost(), {
      rom: romDeclaring(id),
      elf: fixture('thumb-O0').elf,
      cwd: fixtures,
      exists: () => true,
    });
  }

  function savOf(length: number): Uint8Array {
    return Uint8Array.from({ length }, (_, i) => (i * 11 + 5) & 0xff);
  }

  it('declares what was appended, and the appendix changes nothing about the run', async () => {
    const plain = await boot('thumb-O0');
    plain.run(20);
    const declared = await sessionFor('EEPROM_V121');
    expect(declared.machine.gba.bus.save).toEqual({ type: 'eeprom', id: 'EEPROM_V121' });
    for (let i = 0; i < 20; i++) {
      declared.machine.runFrame();
    }
    expect(declared.pc).toBe(plain.session.pc);
  });

  it('is a power-on machine with the save installed, at frame 0', async () => {
    const session = await sessionFor('EEPROM_V121');
    const sav = savOf(512);
    const { snapshot, meta } = decodeSaveState(session.importSaveState(sav, 'Klonoa'));
    expect(meta.frame).toBe(0);
    expect(meta.name).toBe('Klonoa');
    expect(meta.romHash).toBe(session.romHash);
    expect(snapshot.cpu.registers[15]).toBe(0x08000000);
    expect(snapshot.bus.eeprom.data.subarray(0, 512)).toEqual(sav);
    // the cartridge settles the address width from its own first read, so nothing has yet
    expect(snapshot.bus.eeprom.addrBits).toBe(0);
    expect(snapshot.bus.eeprom.installedBytes).toBe(512);
  });

  it('leaves the machine being debugged exactly as it was', async () => {
    const session = await sessionFor('EEPROM_V121');
    for (let i = 0; i < 12; i++) {
      session.machine.runFrame();
    }
    session.resync();
    const before = JSON.stringify(encodeTypedArrays(session.machine.snapshot()));
    const seen: string[] = [];
    session.on({ stopped: () => seen.push('stopped'), continued: () => seen.push('continued') });
    const was = {
      revision: session.revision,
      epoch: session.epoch,
      state: session.state,
      frame: session.frame,
      history: JSON.stringify(session.historyInfo()),
    };

    session.importSaveState(savOf(512), 'x');

    expect(JSON.stringify(encodeTypedArrays(session.machine.snapshot()))).toBe(before);
    expect({
      revision: session.revision,
      epoch: session.epoch,
      state: session.state,
      frame: session.frame,
      history: JSON.stringify(session.historyInfo()),
    }).toEqual(was);
    expect(seen).toEqual([]);
  });

  it('loads into a machine whose cartridge holds the file', async () => {
    const session = await sessionFor('EEPROM_V121');
    const sav = savOf(512);
    session.loadState(session.importSaveState(sav, 'Klonoa'));
    expect(session.frame).toBe(0);
    expect(session.machine.gba.bus.readBackup()!.subarray(0, 512)).toEqual(sav);
    expect(session.exportSaveFile()).toEqual(sav);
  });

  it('puts an SRAM file in the SRAM window, at the size the declaration gives', async () => {
    const session = await sessionFor('SRAM_V113');
    const sav = savOf(32768);
    session.loadState(session.importSaveState(sav, 'x'));
    expect(session.machine.gba.bus.sram.subarray(0, 32768)).toEqual(sav);
    expect(session.exportSaveFile()).toEqual(sav);
  });

  it('refuses a file the cartridge cannot account for, and touches nothing doing it', async () => {
    const session = await sessionFor('EEPROM_V121');
    const before = JSON.stringify(encodeTypedArrays(session.machine.snapshot()));
    expect(() => session.importSaveState(savOf(32768), 'x')).toThrow(
      'this ROM declares EEPROM_V121, whose save is 512 or 8192 bytes; this file is 32768 bytes',
    );
    expect(JSON.stringify(encodeTypedArrays(session.machine.snapshot()))).toBe(before);
  });

  it('has no size for an EEPROM cartridge nothing has addressed yet', async () => {
    const session = await sessionFor('EEPROM_V121');
    expect(() => session.exportSaveFile()).toThrow(/4 Kbit or 64 Kbit/);
  });

  it('exports 8192 bytes of a 64 Kbit EEPROM', async () => {
    const session = await sessionFor('EEPROM_V121');
    const sav = savOf(8192);
    session.loadState(session.importSaveState(sav, 'x'));
    expect(session.exportSaveFile()).toEqual(sav);
  });

  it.each(['FLASH_V126', 'FLASH512_V130', 'FLASH1M_V103'])(
    'refuses a %s cartridge in both directions, since no game could read the save back',
    async (id) => {
      const session = await sessionFor(id);
      expect(() => session.importSaveState(savOf(65536), 'x')).toThrow(/emulates no flash chip/);
      expect(() => session.exportSaveFile()).toThrow(/emulates no flash chip/);
    },
  );
});
