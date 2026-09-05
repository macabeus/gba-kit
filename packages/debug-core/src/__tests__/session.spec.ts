/**
 * The session against the owned fixtures: a small game loop built as Thumb -O0,
 * Thumb -O2 and ARM -O0. Everything here goes through the public Session API the
 * way a Debug Adapter would drive it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ManualHost } from '../host.js';
import { Machine } from '../machine.js';
import { Session, type StopInfo } from '../session.js';

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
  /** run until the next stop (or `maxFrames`), returning the stop */
  run(maxFrames?: number): StopInfo | null;
}

async function boot(variant: (typeof VARIANTS)[number]): Promise<Harness> {
  const host = new ManualHost();
  const session = await Session.create(host, {
    rom: new Uint8Array(readFileSync(join(fixtures, 'build', `${variant}.gba`))),
    elf: new Uint8Array(readFileSync(join(fixtures, 'build', `${variant}.elf`))),
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
  session.on({ stopped: (info) => stops.push(info) });
  return {
    session,
    host,
    stops,
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
    // paths and the expression grammar
    expect(h.session.evaluate('g_player.pos.x').node.value).toMatch(/^\d+ \(0x[0-9a-f]+\)$/);
    expect(h.session.evaluate('g_samples[1] + 1').node.value).toMatch(/^\d+/);
    expect(h.session.evaluate('{&g_frame} == g_frame').node.value.startsWith('1 ')).toBe(true);
  });

  it('writing a scalar changes the program', async () => {
    const h = await boot(variant);
    h.session.setSourceBreakpoints(MAIN, [{ line: lineOf('main.c', 'update();') }]);
    h.run();
    const before = h.session.evaluate('g_player.pos.x').node;
    const members = h.session.evaluate('g_player').node.children!();
    const x = members.find((m) => m.name === 'pos')!.children!().find((m) => m.name === 'x')!;
    expect(h.session.setVariable(x, '200')).toContain('200');
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
    h.run(3);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0]).toMatch(/^frame \d+ \(0x[0-9a-f]+\) keys 0 \(0x0\)$/);
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
    expect(h.session.evaluate('(u16)&gMystery').node.value).toBeDefined();
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
