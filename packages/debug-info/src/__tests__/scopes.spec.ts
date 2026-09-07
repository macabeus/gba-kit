/**
 * Scope-level DWARF: functions, visible variables and their locations, typed
 * values, call-frame information — on the real devkitARM (DWARF 5, -O2) and agbcc
 * (DWARF 2) test ELFs, plus hand-built bytes for the expression evaluator and the
 * list readers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DebugInfo } from '../debug-info.js';
import { DW_AT, DW_FORM, DW_OP, DW_TAG } from '../dwarf/constants.js';
import { EntryIndex, type UnitInfo, addrxValue } from '../dwarf/entries.js';
import { type EvalContext, evaluate } from '../dwarf/expr.js';
import { entryRanges, locationAt } from '../dwarf/lists.js';
import type { Memory } from '../scopes.js';
import type { DwarfEntry } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEVKITARM_ELF = join(here, '..', '..', 'test-projects', 'devkitarm-min', 'build', 'min.elf');
const AGBCC_ELF = join(here, '..', '..', 'test-projects', 'agbcc-min', 'build', 'min.elf');

const devkitarm = DebugInfo.fromElf(new Uint8Array(readFileSync(DEVKITARM_ELF)));
const agbcc = DebugInfo.fromElf(new Uint8Array(readFileSync(AGBCC_ELF)));

/** A memory that answers with a fixed byte pattern: byte at `a` is `a & 0xff`. */
const patternMemory: Memory = {
  read: (address, size) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      out[i] = (address + i) & 0xff;
    }
    return out;
  },
};

function regs(overrides: Record<number, number>): number[] {
  const r = new Array<number>(16).fill(0);
  r[13] = 0x03007f00;
  for (const [k, v] of Object.entries(overrides)) {
    r[Number(k)] = v;
  }
  return r;
}

describe.each([
  { label: 'devkitARM (DWARF 5, -O2)', di: devkitarm },
  { label: 'agbcc (DWARF 2)', di: agbcc },
])('DwarfScopes on $label', ({ di }) => {
  const scopes = di.scopes;

  it('finds the function containing a pc and names it', () => {
    const add = di.symbolToAddress('add')!;
    const fn = scopes.functionAt(add);
    expect(fn && scopes.name(fn)).toBe('add');
    expect(scopes.functionAt(0x09000000)).toBeNull();
  });

  it('lists the parameters of add and reads them from r0/r1 at entry', () => {
    const add = di.symbolToAddress('add')!;
    const fn = scopes.functionAt(add)!;
    const vars = scopes.scopeVariables(fn, add);
    const names = vars.map((v) => scopes.name(v));
    expect(names).toContain('a');
    expect(names).toContain('b');
    const frame = scopes.liveFrame(add, regs({ 0: 3, 1: 4 }));
    const a = scopes.variableNode(vars.find((v) => scopes.name(v) === 'a')!, frame, patternMemory);
    const b = scopes.variableNode(vars.find((v) => scopes.name(v) === 'b')!, frame, patternMemory);
    expect(a.value).toBe('3');
    expect(b.value).toBe('4');
    expect(a.type).toContain('(param)');
  });

  it('knows the globals and can shape a struct at an address', () => {
    expect(scopes.globalByName('g_counter')).not.toBeNull();
    const probe = scopes.typeByName('Probe');
    expect(probe).not.toBeNull();
    const node = scopes.castNode('p', probe!, 0x03000000, patternMemory);
    const kids = node.children!();
    expect(kids.map((k) => k.name)).toEqual(['tag', 'count', 'flags', 'name', 'ptr', 'inner', 'tail']);
    // count is the int at offset 4: bytes 04 05 06 07 → 0x07060504
    expect(kids[1]!.value).toBe(`${0x07060504} (0x07060504)`);
    expect(kids[1]!.address).toBe(0x03000004);
    expect(kids[1]!.writable).toEqual({ address: 0x03000004, size: 4, kind: 'int' });
    const inner = kids[5]!.children!();
    expect(inner.map((k) => k.name)).toEqual(['x', 'y']);
    expect(scopes.typeByName('struct Probe')).toBe(probe);
    expect(scopes.typeByName('NoSuchType')).toBeNull();
  });

  it('describes a bitfield struct with absolute bit offsets, LSB-first', () => {
    const bits = scopes.typeByName('Bits')!;
    const desc = scopes.types.describe(bits);
    const byName = Object.fromEntries(desc.members!.map((m) => [m.name, m]));
    expect(byName.hearts).toMatchObject({ bitOffset: 0, bitSize: 2 });
    expect(byName.stars).toMatchObject({ bitOffset: 2, bitSize: 3 });
    expect(byName.cross).toMatchObject({ bitOffset: 5, bitSize: 7 });
    expect(byName.wide).toMatchObject({ bitOffset: 12, bitSize: 4 });
    const node = scopes.castNode('b', bits, 0x03000000, {
      read: (_a, size) => {
        const out = new Uint8Array(size);
        out[0] = 0b1110_1101; // hearts=1, stars=3, cross low bits 111
        out[1] = 0b0101_0000; // cross high bits 0000 → cross=0b0000111=7, wide=0b0101=5
        return out;
      },
    });
    const kids = node.children!();
    expect(kids.find((k) => k.name === 'hearts')!.value).toBe('1 (2 bits)');
    expect(kids.find((k) => k.name === 'stars')!.value).toBe('3 (3 bits)');
    expect(kids.find((k) => k.name === 'cross')!.value).toBe('7 (7 bits)');
    expect(kids.find((k) => k.name === 'wide')!.value).toBe('5 (4 bits)');
  });

  it('a unit contains its own functions', () => {
    const add = di.symbolToAddress('add')!;
    const unit = scopes.unitContaining(add);
    expect(unit).not.toBeNull();
    expect(scopes.globals(unit!).map((g) => scopes.name(g))).toContain('g_counter');
  });

  it('finds an enumerator by name, from a tagged enum or a typedef of an anonymous one', () => {
    const green = scopes.enumeratorByName('COLOR_GREEN')!;
    expect(green.value).toBe(5);
    expect(scopes.types.describe(green.type).name).toBe('enum Color');
    expect(scopes.enumeratorByName('MODE_ON')?.value).toBe(1);
    expect(scopes.enumeratorByName('COLOR_NOPE')).toBeNull();
  });
});

describe('inlined entries by name', () => {
  // The debug-core fixtures are the ELFs in this repository built with inlining
  // (-O2): tick and wait_vblank exist only inlined into main there.
  const elf = join(here, '..', '..', '..', 'debug-core', 'test-fixtures', 'build', 'thumb-O2.elf');
  const scopes = DebugInfo.fromElf(new Uint8Array(readFileSync(elf))).scopes;

  it('lists where a function that has no symbol of its own is entered inlined', () => {
    expect(scopes.inlineEntriesByName('tick')).toEqual([0x080001f4]);
    expect(scopes.inlineEntriesByName('wait_vblank')).toEqual([0x080001f2]);
    expect(scopes.inlineEntriesByName('no_such_function')).toEqual([]);
  });
});

describe('call-frame information', () => {
  it('devkitARM emits .debug_frame: the CFA at a function entry is sp', () => {
    const scopes = devkitarm.scopes;
    expect(scopes.frames.size).toBeGreaterThan(0);
    const main = devkitarm.symbolToAddress('main')!;
    expect(scopes.frames.covers(main)).toBe(true);
    expect(scopes.frames.cfa(main, regs({}))).toBe(0x03007f00);
  });

  it('unwinds one physical frame from inside add back to its caller through the saved lr', () => {
    const scopes = devkitarm.scopes;
    const add = devkitarm.symbolToAddress('add')!;
    // At entry nothing is pushed yet: the caller's pc is lr, and its sp is ours.
    const frames = scopes.physicalFrames(
      add,
      regs({ 14: 0x08000123 }),
      patternMemory,
      (a) => a >= 0x08000000 && a < 0x08010000,
    );
    expect(frames.length).toBe(2);
    expect(frames[1]!.pc).toBe(0x08000122);
    expect(frames[1]!.regs[13]).toBe(0x03007f00);
    expect(frames[1]!.exact).toBe(true);
  });

  it('agbcc has no .debug_frame, so only the LR guess is offered and it is flagged', () => {
    const scopes = agbcc.scopes;
    expect(scopes.frames.size).toBe(0);
    const add = agbcc.symbolToAddress('add')!;
    const frames = scopes.physicalFrames(add, regs({ 14: 0x08000201 }), patternMemory, () => true);
    expect(frames.length).toBe(2);
    expect(frames[1]!.exact).toBe(false);
    expect(frames[1]!.pc).toBe(0x08000200);
  });
});

describe('DWARF expressions', () => {
  const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
    reg: (n) => (n === 13 ? 0x03007f00 : n === 4 ? 0x1234 : undefined),
    readMem: (a, size) => (a === 0x03007f10 && size === 4 ? 0xdeadbeef : undefined),
    frameBase: () => 0x03007f20,
    cfa: () => 0x03007f30,
    ...over,
  });

  it('fbreg, breg, call_frame_cfa and addr name memory', () => {
    expect(evaluate(new Uint8Array([DW_OP.fbreg, 0x78]), ctx())).toEqual({ kind: 'memory', address: 0x03007f20 - 8 });
    expect(evaluate(new Uint8Array([DW_OP.breg0 + 13, 0x10]), ctx())).toEqual({ kind: 'memory', address: 0x03007f10 });
    expect(evaluate(new Uint8Array([DW_OP.call_frame_cfa]), ctx())).toEqual({ kind: 'memory', address: 0x03007f30 });
    expect(evaluate(new Uint8Array([DW_OP.addr, 0x20, 0x52, 0x00, 0x03]), ctx())).toEqual({
      kind: 'memory',
      address: 0x03005220,
    });
  });

  it('registers, computed values and pieces', () => {
    expect(evaluate(new Uint8Array([DW_OP.reg0 + 4]), ctx())).toEqual({ kind: 'register', reg: 4 });
    expect(evaluate(new Uint8Array([DW_OP.breg0 + 4, 0x02, DW_OP.stack_value]), ctx())).toEqual({
      kind: 'value',
      value: 0x1236,
    });
    expect(evaluate(new Uint8Array([DW_OP.reg0 + 4, DW_OP.piece, 4, DW_OP.reg0 + 5, DW_OP.piece, 4]), ctx())).toEqual({
      kind: 'composite',
      pieces: [
        { loc: { kind: 'register', reg: 4 }, size: 4 },
        { loc: { kind: 'register', reg: 5 }, size: 4 },
      ],
    });
    expect(evaluate(new Uint8Array([DW_OP.breg0 + 13, 0x10, DW_OP.deref]), ctx())).toEqual({
      kind: 'memory',
      address: 0xdeadbeef,
    });
  });

  it('refuses what it cannot know rather than guessing', () => {
    expect(evaluate(new Uint8Array([DW_OP.entry_value, 1, DW_OP.reg0]), ctx()).kind).toBe('optimized-out');
    expect(evaluate(new Uint8Array([DW_OP.breg0 + 7, 0]), ctx()).kind).toBe('optimized-out'); // r7 unknown
    expect(evaluate(new Uint8Array([DW_OP.fbreg, 0]), ctx({ frameBase: () => undefined })).kind).toBe('optimized-out');
    expect(evaluate(new Uint8Array([DW_OP.plus]), ctx()).kind).toBe('optimized-out'); // stack underflow
  });
});

describe('unit lookup', () => {
  const die = (offset: number, unitOffset: number, attrs: Record<number, unknown> = {}): DwarfEntry => ({
    tag: DW_TAG.compile_unit,
    offset,
    attrs: new Map(Object.entries(attrs).map(([at, v]) => [Number(at), v as never])),
    forms: new Map(),
    children: [],
    version: 5,
    unitOffset,
  });
  const first = die(0x0b, 0, { [DW_AT.low_pc]: 0x08000000 });
  const second = die(0x4b, 0x40, { [DW_AT.low_pc]: 0x08001000 });
  const index = new EntryIndex([first, second]);

  it('answers with the unit whose offset the entry names', () => {
    expect(index.unit(second).lowPc).toBe(0x08001000);
  });

  it('throws naming the offset when the entry belongs to no indexed unit', () => {
    // The per-unit facts (lowPc, the .debug_addr/loclists/rnglists bases) are what every
    // address form is resolved against, so a substituted unit misplaces addresses silently.
    expect(() => index.unit(die(0x90, 0x80))).toThrow(/0x80/);
  });
});

describe('range and location lists', () => {
  /** the byte order these hand-built payloads are written in */
  const LE = { littleEndian: true };
  const unit = (version: number, lowPc: number): UnitInfo => ({
    offset: 0,
    version,
    root: entry(0x11, {}),
    lowPc,
    addrBase: 8,
    loclistsBase: 12,
    rnglistsBase: 12,
  });
  function entry(tag: number, attrs: Record<number, [number, unknown]>): DwarfEntry {
    const e: DwarfEntry = {
      tag,
      offset: 0,
      attrs: new Map(),
      forms: new Map(),
      children: [],
      version: 5,
      unitOffset: 0,
    };
    for (const [at, [form, value]] of Object.entries(attrs)) {
      e.attrs.set(Number(at), value as never);
      e.forms.set(Number(at), form);
    }
    return e;
  }

  it('high_pc is an offset in a constant form and an address in an address form', () => {
    const u = unit(5, 0);
    const byOffset = entry(0x2e, {
      [DW_AT.low_pc]: [DW_FORM.addr, 0x08000100],
      [DW_AT.high_pc]: [DW_FORM.data4, 0x20],
    });
    expect(entryRanges(byOffset, u, LE)).toEqual([[0x08000100, 0x08000120]]);
    const byAddress = entry(0x2e, {
      [DW_AT.low_pc]: [DW_FORM.addr, 0x08000100],
      [DW_AT.high_pc]: [DW_FORM.addr, 0x08000130],
    });
    expect(entryRanges(byAddress, u, LE)).toEqual([[0x08000100, 0x08000130]]);
  });

  it('reads the DWARF 5 index tables in the payload byte order', () => {
    // .debug_addr holding 0x08001234 at index 0, written each way round
    const little = new Uint8Array([0x34, 0x12, 0x00, 0x08]);
    const big = new Uint8Array([0x08, 0x00, 0x12, 0x34]);
    const u = { ...unit(5, 0), addrBase: 0 };
    expect(addrxValue(0, u, { littleEndian: true, addr: little })).toBe(0x08001234);
    expect(addrxValue(0, u, { littleEndian: false, addr: big })).toBe(0x08001234);
    // a rnglistx offset is an index-table read too: the same list, addressed through it
    const rnglists = new Uint8Array([0, 0, 0, 0, 4, 0x10, 0x20, 0]);
    const indexed = entry(0x1d, { [DW_AT.ranges]: [DW_FORM.rnglistx, 0] });
    const base = { ...unit(5, 0x08000000), rnglistsBase: 0 };
    for (const [littleEndian, table] of [
      [true, new Uint8Array([4, 0, 0, 0])],
      [false, new Uint8Array([0, 0, 0, 4])],
    ] as const) {
      const section = new Uint8Array(rnglists);
      section.set(table, 0);
      expect(entryRanges(indexed, base, { littleEndian, rnglists: section })).toEqual([[0x08000010, 0x08000020]]);
    }
  });

  it('reads a DWARF 5 range list of offset pairs against the unit base', () => {
    // DW_RLE_offset_pair(0x10, 0x20), DW_RLE_offset_pair(0x40, 0x48), DW_RLE_end_of_list
    const rnglists = new Uint8Array([4, 0x10, 0x20, 4, 0x40, 0x48, 0]);
    const e = entry(0x1d, { [DW_AT.ranges]: [DW_FORM.sec_offset, 0] });
    expect(entryRanges(e, unit(5, 0x08000000), { ...LE, rnglists })).toEqual([
      [0x08000010, 0x08000020],
      [0x08000040, 0x08000048],
    ]);
  });

  it('reads a DWARF 2–4 range list with a base-address selection entry', () => {
    const ranges = new Uint8Array(24);
    const dv = new DataView(ranges.buffer);
    dv.setUint32(0, 0xffffffff, true);
    dv.setUint32(4, 0x08001000, true); // base = 0x08001000
    dv.setUint32(8, 0x10, true);
    dv.setUint32(12, 0x18, true);
    // 0,0 terminator already zero
    const e = entry(0x0b, { [DW_AT.ranges]: [DW_FORM.data4, 0] });
    expect(entryRanges(e, unit(4, 0), { ...LE, ranges })).toEqual([[0x08001010, 0x08001018]]);
  });

  it('picks the location-list entry covering pc, and says where the value was otherwise', () => {
    // DW_LLE_offset_pair(0x00, 0x10) → reg0 ; DW_LLE_offset_pair(0x10, 0x30) → reg4 ; end
    const loclists = new Uint8Array([4, 0x00, 0x10, 1, DW_OP.reg0, 4, 0x10, 0x30, 1, DW_OP.reg0 + 4, 0]);
    const e = entry(0x34, { [DW_AT.location]: [DW_FORM.sec_offset, 0] });
    const u = unit(5, 0x08000000);
    expect(locationAt(e, DW_AT.location, 0x08000008, u, { ...LE, loclists })).toEqual({
      kind: 'expr',
      expr: new Uint8Array([DW_OP.reg0]),
    });
    expect(locationAt(e, DW_AT.location, 0x08000020, u, { ...LE, loclists })).toEqual({
      kind: 'expr',
      expr: new Uint8Array([DW_OP.reg0 + 4]),
    });
    const gone = locationAt(e, DW_AT.location, 0x08000040, u, { ...LE, loclists });
    expect(gone.kind).toBe('not-here');
    expect(gone.kind === 'not-here' && gone.entries.map((x) => [x.lo, x.hi])).toEqual([
      [0x08000000, 0x08000010],
      [0x08000010, 0x08000030],
    ]);
  });

  it('an exprloc is the expression itself, and a missing attribute is none', () => {
    const e = entry(0x34, { [DW_AT.location]: [DW_FORM.exprloc, new Uint8Array([DW_OP.fbreg, 0x7c])] });
    expect(locationAt(e, DW_AT.location, 0, unit(5, 0), LE)).toEqual({
      kind: 'expr',
      expr: new Uint8Array([DW_OP.fbreg, 0x7c]),
    });
    expect(locationAt(entry(0x34, {}), DW_AT.location, 0, unit(5, 0), LE)).toEqual({ kind: 'none' });
  });
});
