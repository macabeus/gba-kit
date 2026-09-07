// Drive the DAP adapter without VS Code: a tiny in-process DAP client. This is the
// same thing nvim-dap would do over stdio, and it verifies the whole stack below the
// editor — breakpoints resolve, the stop lands on the right line, stepping moves,
// rewind goes back, scripts run — against a real ROM + ELF.
//
//   node test/headless.mjs [rom] [elf] [cwd] [sourceMapFrom=sourceMapTo]
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { GbaDebugSession } = require('../dist/dap.js');

const rom = process.argv[2] ?? '/Users/macabeus/ApenasMeu/balatro-gba/build/balatro-gba.gba';
const elf = process.argv[3] ?? '/Users/macabeus/ApenasMeu/balatro-gba/build/balatro-gba.elf';
const cwd = process.argv[4] ?? '/Users/macabeus/ApenasMeu/balatro-gba';
const [mapFrom, mapTo] = (process.argv[5] ?? '/balatro-gba=/Users/macabeus/ApenasMeu/balatro-gba').split('=');
const breakFile = process.argv[6] ?? path.join(cwd, 'source/main.c');
const breakLine = Number(process.argv[7] ?? 122); // VBlankIntrWait() in balatro's main loop

class Client {
  seq = 1;
  pending = new Map();
  events = [];
  waiters = [];
  constructor(session) {
    this.session = session;
    session.onDidSendMessage((m) => this.#onMessage(m));
  }
  #onMessage(m) {
    if (m.type === 'response') {
      const p = this.pending.get(m.request_seq);
      this.pending.delete(m.request_seq);
      m.success ? p.resolve(m.body) : p.reject(new Error(m.message));
    } else if (m.type === 'event') {
      this.events.push(m);
      const i = this.waiters.findIndex((w) => w.event === m.event);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m.body);
    }
  }
  request(command, args = {}) {
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.session.handleMessage({ seq, type: 'request', command, arguments: args });
    });
  }
  waitEvent(event, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
      this.waiters.push({
        event,
        resolve: (b) => {
          clearTimeout(t);
          resolve(b);
        },
      });
    });
  }
}

/** Register the stop waiter BEFORE the request: synchronous steps emit `stopped` before their response. */
async function go(command, args = {}, timeoutMs = 30000) {
  const stopped = c.waitEvent('stopped', timeoutMs);
  await c.request(command, args);
  return stopped;
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('ok  :', msg);
}

const session = new GbaDebugSession();
const c = new Client(session);

await c.request('initialize', { adapterID: 'gba-kit', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true });
const initialized = c.waitEvent('initialized');
const launched = c.request('launch', {
  rom,
  elf,
  cwd,
  sourceMap: { [mapFrom]: mapTo },
  stopOnEntry: true,
  outputDir: '/tmp/gba-kit-poc-out',
});
await initialized;
const bps = await c.request('setBreakpoints', { source: { path: breakFile }, breakpoints: [{ line: breakLine }] });
assert(
  bps.breakpoints[0].verified,
  `source breakpoint at ${path.basename(breakFile)}:${breakLine} resolved to ${bps.breakpoints[0].instructionReference} (line ${bps.breakpoints[0].line})`,
);
const entryStop = c.waitEvent('stopped');
await c.request('configurationDone');
await launched;
await entryStop;

let st = await c.request('stackTrace', { threadId: 1 });
assert(
  st.stackFrames[0].instructionPointerReference === '0x08000000',
  `stopped on entry at ${st.stackFrames[0].instructionPointerReference}`,
);

let t = Date.now();
let stop = await go('continue', { threadId: 1 });
st = await c.request('stackTrace', { threadId: 1 });
assert(
  stop.reason === 'breakpoint',
  `hit breakpoint after ${Date.now() - t} ms: ${st.stackFrames[0].name} ${path.basename(st.stackFrames[0].source?.path ?? '?')}:${st.stackFrames[0].line} at ${st.stackFrames[0].instructionPointerReference}`,
);
assert(st.stackFrames[0].line === bps.breakpoints[0].line, 'stopped on the breakpoint line');

const scopes = await c.request('scopes', { frameId: 0 });
const regs = await c.request('variables', {
  variablesReference: scopes.scopes.find((s) => s.name === 'Registers').variablesReference,
});
assert(
  regs.variables.find((v) => v.name === 'pc')?.value === st.stackFrames[0].instructionPointerReference,
  'registers scope agrees with the frame',
);

await go('next', { threadId: 1, granularity: 'instruction' });
const st2 = await c.request('stackTrace', { threadId: 1 });
assert(
  st2.stackFrames[0].instructionPointerReference !== st.stackFrames[0].instructionPointerReference,
  `stepped one instruction to ${st2.stackFrames[0].instructionPointerReference}`,
);

stop = await go('next', { threadId: 1, granularity: 'line' });
const st3 = await c.request('stackTrace', { threadId: 1 });
assert(
  st3.stackFrames[0].line !== st.stackFrames[0].line,
  `step over moved to line ${st3.stackFrames[0].line} (${st3.stackFrames[0].name})`,
);

// step over follows the C statements of main's loop: 123 mmFrame → 124 key_poll → 125 update → 126 draw → back to 122
{
  const seen = [st3.stackFrames[0].line];
  for (let i = 0; i < 4; i++) {
    await go('next', { threadId: 1, granularity: 'line' });
    const f = (await c.request('stackTrace', { threadId: 1 })).stackFrames[0];
    seen.push(f.line);
    assert(
      path.basename(f.source?.path ?? '') === 'main.c' && f.name === 'main',
      `step over stays in main (${f.name} ${path.basename(f.source?.path ?? '?')}:${f.line})`,
    );
  }
  // 120 is the `while (true)` back-edge GCC attributes the loop branch to; gdb shows it too.
  assert(
    seen.join(',') === '123,124,125,126,120',
    `step over walked main's loop (inlined update()/draw() shown at their call sites): ${seen.join(' → ')}`,
  );
  await go('next', { threadId: 1, granularity: 'line' });
  assert((await c.request('stackTrace', { threadId: 1 })).stackFrames[0].line === 122, 'loop head 120 → 122');
}
// step into enters update() and step out comes back to main's next statement
{
  await go('next', { threadId: 1, granularity: 'line' }); // 122 → 123
  await go('next', { threadId: 1, granularity: 'line' }); // 123 → 124
  await go('next', { threadId: 1, granularity: 'line' }); // 124 → 125 update()
  await go('stepIn', { threadId: 1, granularity: 'line' });
  const st = await c.request('stackTrace', { threadId: 1 });
  assert(
    st.stackFrames[0].name.startsWith('update') && st.stackFrames[1].name === 'main' && st.stackFrames[1].line === 125,
    `step into revealed ${st.stackFrames[0].name} at ${path.basename(st.stackFrames[0].source?.path ?? '?')}:${st.stackFrames[0].line}; stack: ${st.stackFrames.map((f) => `${f.name}:${f.line}`).join(' < ')}`,
  );
  await go('stepOut', { threadId: 1 });
  const back = (await c.request('stackTrace', { threadId: 1 })).stackFrames[0];
  assert(back.name === 'main' && back.line === 126, `step out returned to main:${back.line}`);
}
// locals: break inside a function with parameters and locals, read the Locals scope
{
  const candidates = [
    ['graphic_utils.c', 524],
    ['audio_utils.c', 106],
    ['card.c', 67],
    ['hand.c', 731],
    ['joker.c', 282],
  ];
  for (const [file, line] of candidates) {
    await c.request('setBreakpoints', { source: { path: path.join(cwd, 'source', file) }, breakpoints: [{ line }] });
  }
  await c.request('setBreakpoints', { source: { path: breakFile }, breakpoints: [] });
  const stop = await go('continue', { threadId: 1 }, 60000);
  const st = await c.request('stackTrace', { threadId: 1 });
  const top = st.stackFrames[0];
  assert(
    stop.reason === 'breakpoint',
    `stopped in ${top.name} at ${path.basename(top.source?.path ?? '?')}:${top.line}; stack: ${st.stackFrames.map((f) => f.name).join(' < ')}`,
  );
  assert(
    st.stackFrames.length >= 3 && st.stackFrames.some((f) => f.name === 'main'),
    `CFI call stack reaches main (${st.stackFrames.length} frames)`,
  );
  const scopes = (await c.request('scopes', { frameId: 0 })).scopes;
  const localsScope = scopes.find((s) => s.name === 'Locals');
  assert(localsScope, `scopes: ${scopes.map((s) => s.name).join(', ')}`);
  const locals = (await c.request('variables', { variablesReference: localsScope.variablesReference })).variables;
  assert(locals.length >= 2, `locals of ${top.name}: ${locals.map((v) => `${v.name}=${v.value}`).join(', ')}`);
  const live = locals.filter((v) => !v.value.startsWith('<optimized out'));
  assert(live.length >= 1, `${live.length}/${locals.length} locals have live values`);
  const expandable = locals.find((v) => v.variablesReference > 0);
  if (expandable) {
    const kids = (await c.request('variables', { variablesReference: expandable.variablesReference })).variables;
    assert(
      kids.length > 0,
      `expanded ${expandable.name} (${expandable.type}) → ${kids
        .slice(0, 4)
        .map((k) => `${k.name}=${k.value}`)
        .join(', ')}`,
    );
  }
  const globals = (
    await c.request('variables', {
      variablesReference: scopes.find((s) => s.name.startsWith('Globals')).variablesReference,
    })
  ).variables;
  assert(
    globals.length >= 1,
    `${globals.length} file globals, e.g. ${globals
      .slice(0, 3)
      .map((g) => `${g.name}=${g.value}`)
      .join('; ')}`,
  );
  // a DWARF-typed global from another compilation unit unfolds on hover
  const gl = await c.request('evaluate', { expression: 'deck_names', context: 'hover', frameId: 0 });
  assert(gl.variablesReference > 0, `hover deck_names -> ${gl.result.slice(0, 50)}… (expandable)`);
  const glKids = (await c.request('variables', { variablesReference: gl.variablesReference })).variables;
  assert(glKids[0]?.value.includes('Red Deck'), `deck_names[0] = ${glKids[0]?.value}`);
  // a cast applies a struct the ELF knows to any address
  const castEv = await c.request('evaluate', { expression: '(Card*)0x0300243c', context: 'watch', frameId: 0 });
  assert(castEv.variablesReference > 0 && castEv.result.includes('suit'), `(Card*)0x0300243c -> ${castEv.result}`);
  // an untyped address unfolds as words
  const raw = await c.request('evaluate', { expression: '0x03007f00', context: 'watch', frameId: 0 });
  const rawKids = (await c.request('variables', { variablesReference: raw.variablesReference })).variables;
  assert(
    rawKids[0]?.name === '+0x00' && rawKids.some((k) => k.name === 'bytes'),
    `raw memory unfolds: ${rawKids
      .slice(0, 2)
      .map((k) => `${k.name}=${k.value}`)
      .join(', ')} …`,
  );
  const hover = await c.request('evaluate', { expression: live[0].name, context: 'hover', frameId: 0 });
  assert(hover.result === live[0].value, `hover ${live[0].name} -> ${hover.result}`);
  // a step over from a function's first line (before its prologue) stays in the function
  await go('next', { threadId: 1, granularity: 'line' });
  const after = (await c.request('stackTrace', { threadId: 1 })).stackFrames[0];
  assert(
    after.name === top.name && after.line > top.line,
    `step over from ${top.name}:${top.line} stayed in ${after.name}:${after.line}`,
  );
  const callerScopes = (await c.request('scopes', { frameId: 1 })).scopes;
  const callerRegs = (
    await c.request('variables', {
      variablesReference: callerScopes.find((s) => s.name === 'Registers').variablesReference,
    })
  ).variables;
  assert(
    callerRegs.find((r) => r.name === 'pc').value === st.stackFrames[1].instructionPointerReference,
    `caller frame registers are unwound (pc ${callerRegs.find((r) => r.name === 'pc').value})`,
  );
  for (const [file] of candidates) {
    await c.request('setBreakpoints', { source: { path: path.join(cwd, 'source', file) }, breakpoints: [] });
  }
  await c.request('setBreakpoints', { source: { path: breakFile }, breakpoints: [{ line: breakLine }] });
  await go('continue', { threadId: 1 });
}

const dis = await c.request('disassemble', {
  memoryReference: st3.stackFrames[0].instructionPointerReference,
  instructionOffset: -2,
  instructionCount: 6,
});
assert(
  dis.instructions.length === 6 && dis.instructions.some((i) => i.location),
  `disassembly: ${dis.instructions.map((i) => i.instruction).join(' | ')}`,
);

const mem = await c.request('readMemory', { memoryReference: '0x03007f00', count: 16 });
assert(
  Buffer.from(mem.data, 'base64').length === 16,
  `readMemory ${mem.address} -> ${Buffer.from(mem.data, 'base64').toString('hex')}`,
);

const ev = await c.request('evaluate', { expression: 'sp', context: 'hover' });
assert(/^0x0300/.test(ev.result), `evaluate sp -> ${ev.result}`);

const repl = await c.request('evaluate', { expression: 'readDisplayControl()', context: 'repl' });
assert(repl.result.includes('mode'), `repl evaluate readDisplayControl() -> ${repl.result}`);

const out = [];
const outputIdx = c.events.length;
await c.request('gba-kit/runScript', {
  code: "await wait({ frames: 30 }); console.log('hello from script, pc=' + getRegisters().r15.toString(16));",
  name: 'inline',
});
for (const e of c.events.slice(outputIdx)) if (e.event === 'output') out.push(e.body.output.trim());
assert(
  out.some((l) => l.startsWith('hello from script')),
  `script output: ${out.join(' / ')}`,
);

const gbaScope = async () =>
  (
    await c.request('variables', {
      variablesReference: (await c.request('scopes', { frameId: 0 })).scopes.find((s) => s.name === 'GBA')
        .variablesReference,
    })
  ).variables;
const frameBefore = (await gbaScope()).find((v) => v.name === 'frame').value;
stop = await go('stepBack', { threadId: 1 });
const frameAfter = (await gbaScope()).find((v) => v.name === 'frame').value;
assert(
  stop.reason === 'rewind' && Number(frameAfter) < Number(frameBefore),
  `stepBack rewound from frame ${frameBefore} to ${frameAfter}`,
);

// A frame step stops at a breakpoint inside the frame, like any debugger; clear it first.
await c.request('setBreakpoints', { source: { path: breakFile }, breakpoints: [] });
await c.request('gba-kit/recordStart');
await c.request('gba-kit/input', { button: 3, down: true });
await go('gba-kit/stepFrame');
await go('gba-kit/stepFrame');
await c.request('gba-kit/input', { button: 3, down: false });
await go('gba-kit/stepFrame');
const rec = await c.request('gba-kit/recordStop');
assert(rec.script.includes("press('start'"), `recorded script:\n${rec.script}`);

// ─── regressions from the adversarial review ─────────────────────────────
// (2) a breakpoint that fires every frame must not freeze the frame counter / rewind ring
await c.request('setBreakpoints', { source: { path: breakFile }, breakpoints: [{ line: breakLine }] });
const f0 = Number((await gbaScope()).find((v) => v.name === 'frame').value);
for (let i = 0; i < 12; i++) await go('continue', { threadId: 1 });
const f1 = Number((await gbaScope()).find((v) => v.name === 'frame').value);
assert(f1 >= f0 + 10, `frames advance under a per-frame breakpoint: ${f0} -> ${f1}`);
await c.request('setBreakpoints', { source: { path: breakFile }, breakpoints: [] });
// (10) consecutive step-backs walk keyframes one at a time
const r1 = Number((await gbaScope()).find((v) => v.name === 'frame').value);
await go('stepBack', { threadId: 1 });
const r2 = Number((await gbaScope()).find((v) => v.name === 'frame').value);
await go('stepBack', { threadId: 1 });
const r3 = Number((await gbaScope()).find((v) => v.name === 'frame').value);
assert(r2 < r1 && r3 === r2 - 10, `two step-backs: ${r1} -> ${r2} -> ${r3}`);
// (9) REPL prints objects and does not hijack the session for a pure read
const evBefore = c.events.length;
const oam = await c.request('evaluate', { expression: 'readOAM()[0]', context: 'repl' });
const sideEvents = c.events.slice(evBefore).filter((e) => e.event === 'stopped' || e.event === 'continued');
assert(
  oam.result.includes('"index":0') && sideEvents.length === 0,
  `repl readOAM()[0] -> ${oam.result.slice(0, 60)}... (${sideEvents.length} stop/continue events)`,
);
// (3) a data breakpoint must not fire inside a script nor leave a stale stop behind
const info = await c.request('dataBreakpointInfo', { name: '__key_curr' });
assert(info.dataId, `dataBreakpointInfo __key_curr -> ${info.description}`);
await c.request('setDataBreakpoints', { breakpoints: [{ dataId: info.dataId }] });
const sf = Number((await gbaScope()).find((v) => v.name === 'frame').value);
await c.request('gba-kit/runScript', { code: 'await wait({ frames: 4 });', name: 'wait4' });
const sf2 = Number((await gbaScope()).find((v) => v.name === 'frame').value);
assert(sf2 === sf + 4, `script ran 4 real frames with a data breakpoint armed: ${sf} -> ${sf2}`);
await c.request('setDataBreakpoints', { breakpoints: [] });
const tEnd = Date.now();
const stopAfter = await go('continue', { threadId: 1 }, 3000).catch(() => null);
assert(
  stopAfter === null || stopAfter.reason !== 'data breakpoint',
  `no stale data-breakpoint stop after clearing (${stopAfter ? stopAfter.reason + ' after ' + (Date.now() - tEnd) + ' ms' : 'ran freely'})`,
);
if (stopAfter === null) await c.request('pause', { threadId: 1 });
await c.request('disconnect');
console.log('\nall headless checks passed');
process.exit(0);
