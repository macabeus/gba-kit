import { MODE_IRQ, MODE_SYS } from '@gba-kit/arm-emulator/arm-cpu';
import type { TypeDesc } from '@gba-kit/debug-info';
import { describe, expect, it } from 'vitest';

import { applySnapshotDelta, decodeDelta, deltaSnapshot, encodeDelta } from '../delta.js';
import { packSnapshot, unpackSnapshot } from '../delta.js';
import {
  type ExprEnv,
  type ExprHints,
  type ExprPlace,
  compile,
  compileExpression,
  compileHitCondition,
  compileLogMessage,
  splitAssignment,
} from '../expression.js';
import { ManualHost } from '../host.js';
import { ioRegisterAt } from '../io.js';
import { LabelStore } from '../labels.js';
import { stackBoundFor } from '../machine.js';
import { LOG, TILES, entryCount, rewindFrameCount, tileCount } from '../protocol.js';
import { decodeTake, encodeTake, recordingToScript, toSegments } from '../recorder.js';
import { Ring } from '../rings.js';
import { base64ToBytes, bytesToBase64, encodeSaveState } from '../snapshot-codec.js';
import { SourceMapper } from '../source-map.js';

/**
 * A program the tests can state in full: two Entities, four ints and a frame
 * counter, with the types the DWARF would give them. Types are plain data, so
 * nothing here needs an ELF.
 */
const int32: TypeDesc = { kind: 'int', name: 'int', size: 4 };
const u16Type: TypeDesc = { kind: 'uint', name: 'u16', size: 2 };
const u32Type: TypeDesc = { kind: 'uint', name: 'u32', size: 4 };
const entity: TypeDesc = { kind: 'struct', name: 'struct Entity', size: 8, members: [] };
const entityPtr: TypeDesc = { kind: 'pointer', name: 'struct Entity *', size: 4, target: entity };
entity.members = [
  { name: 'id', offset: 0, type: int32 },
  { name: 'next', offset: 4, type: entityPtr },
];
const samplesType: TypeDesc = { kind: 'array', name: 'int[4]', size: 16, count: 4, target: int32 };
/** `extern struct Entity gEntityInfo[];`: a decomp's header declaration, with no count. */
const entityArray: TypeDesc = { kind: 'array', name: 'struct Entity[]', size: 0, count: null, target: entity };
/** The two pointees a decomp's tables are full of and the DWARF gives no width: a void, and code. */
const voidPtr: TypeDesc = { kind: 'pointer', name: 'void *', size: 4, target: { kind: 'void', name: 'void', size: 0 } };
const handler: TypeDesc = {
  kind: 'pointer',
  name: 'Handler',
  size: 4,
  target: { kind: 'function', name: 'void (void)', size: 0 },
};

const SAMPLES_AT = 0x03000200;
const ENTITIES_AT = 0x03000300;
const FRAME_AT = 0x03000400;

const bytes = new Map<number, number>();
const store = (at: number, width: number, value: number): void => {
  for (let i = 0; i < width; i++) {
    bytes.set(at + i, (value >>> (i * 8)) & 0xff);
  }
};
[3, 5, 8, 13].forEach((v, i) => store(SAMPLES_AT + i * 4, 4, v));
store(ENTITIES_AT, 4, 100);
store(ENTITIES_AT + 4, 4, ENTITIES_AT + 8);
store(ENTITIES_AT + 8, 4, 101);
store(ENTITIES_AT + 12, 4, 0);
store(FRAME_AT, 4, 2);
const peek = (a: number, size: number): number | undefined => {
  let v = 0;
  for (let i = size - 1; i >= 0; i--) {
    const b = bytes.get(a + i);
    if (b === undefined) {
      return undefined;
    }
    v = v * 256 + b;
  }
  return v >>> 0;
};

const SYMBOL_ADDRESSES: Record<string, number> = {
  gHp: 0x03000000,
  g_samples: SAMPLES_AT,
  gEntityInfo: ENTITIES_AT,
  g_frame: FRAME_AT,
};
const SYMBOLS: Record<string, number> = {
  gHp: 3,
  // gSigned is an `int` holding -7, delivered as its 32-bit word
  gSigned: 0xfffffff9,
  g_frame: 2,
  // a pointer the compiler keeps in a register: no address, only a value
  p: ENTITIES_AT,
  gRaw: ENTITIES_AT,
  gRaw2: ENTITIES_AT + 8,
  gHandler: 0x08001235,
};

const env: ExprEnv = {
  reg: (i) => (i === 0 ? 10 : i === 13 ? 0x03007f00 : 0),
  cpsr: () => 0x1f,
  read: (a, size) =>
    a === 0x03000000
      ? size === 1
        ? 0x12
        : size === 2
          ? 0x3412
          : 0x78563412
      : a === 0x03000100
        ? size === 1
          ? 0xf0
          : 0xfff0
        : peek(a, size),
  symbol: (path) => SYMBOLS[path],
  symbolAddress: (name) => SYMBOL_ADDRESSES[name],
  frame: () => 42,
  scanline: () => 7,
  cycle: () => 1000,
};

/** What the DWARF would say: `gHp` is deliberately untyped, as a symbol map's names are. */
const ROOT_TYPES: Record<string, TypeDesc> = {
  gSigned: int32,
  g_samples: samplesType,
  gEntityInfo: entityArray,
  p: entityPtr,
  g_frame: u32Type,
  gRaw: voidPtr,
  gRaw2: voidPtr,
  gHandler: handler,
};
const NAMED_TYPES: Record<string, TypeDesc> = {
  Entity: entity,
  'struct Entity': entity,
  u16: u16Type,
  vu16: u16Type,
  int: int32,
};
const hints: ExprHints = {
  rootType: (name) => ROOT_TYPES[name],
  typeByName: (name) => NAMED_TYPES[name],
};

describe('expression grammar', () => {
  const ev = (s: string): number => compileExpression(s, hints)(env);

  it('numbers, registers, machine values', () => {
    expect(ev('0x10 + 6')).toBe(22);
    expect(ev('0b101')).toBe(5);
    expect(ev("'A'")).toBe(65);
    expect(ev('r0 * 2')).toBe(20);
    expect(ev('sp')).toBe(0x03007f00);
    expect(ev('frame == 42 && scanline < 10')).toBe(1);
  });

  it('memory reads in Mesen syntax and typed readers', () => {
    expect(ev('[0x03000000]')).toBe(0x12);
    expect(ev('{0x03000000}')).toBe(0x3412);
    expect(ev('u32(0x03000000)')).toBe(0x78563412);
    expect(ev('s8(0x03000000)')).toBe(0x12);
    expect(ev('s8(0x03000100)')).toBe(-16);
    expect(ev('s16(0x03000100)')).toBe(-16);
    expect(ev('u8(0x03000100)')).toBe(0xf0);
    expect(() => ev('[0x09000000]')).toThrow(/unreadable/);
  });

  it('signedness follows C: signed operands compare and divide as signed, mixed ones as unsigned', () => {
    expect(ev('-1')).toBe(-1);
    expect(ev('-1 < 0')).toBe(1);
    expect(ev('-1 == 0xffffffff')).toBe(1);
    expect(ev('-1 > 0')).toBe(0);
    expect(ev('s8(0x03000100) < 0')).toBe(1);
    expect(ev('u8(0x03000100) < 0')).toBe(0);
    expect(ev('-7 / 2')).toBe(-3);
    expect(ev('-7 % 2')).toBe(-1);
    expect(ev('0xffffffff / 2')).toBe(0x7fffffff);
    expect(ev('gSigned')).toBe(-7);
    expect(ev('gSigned < 0')).toBe(1);
    expect(ev('gSigned - 10 < 0')).toBe(1);
    expect(ev('gHp - 10 < 0')).toBe(0); // unsigned symbol: wraps like a u32
    expect(ev('gSigned == -7')).toBe(1);
    expect(ev('-8 >> 1')).toBe(0x7ffffffc); // shifts are on the word
    expect(ev('gSigned & 0xff')).toBe(0xf9);
    expect(ev('gHp > 2 ? -1 : -2')).toBe(-1);
  });

  it('symbols and paths, address-of', () => {
    expect(ev('gHp + 1')).toBe(4);
    expect(ev('&gHp')).toBe(0x03000000);
    expect(() => ev('gNope')).toThrow(/unknown symbol/);
  });

  it('precedence, unary, ternary, shifts and comparisons wrap to u32', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('~0')).toBe(0xffffffff); // bitwise operators work on the word
    expect(ev('!0')).toBe(1);
    expect(ev('1 << 31 >> 31')).toBe(1);
    expect(ev('1 << 31')).toBe(0x80000000);
    // a count of 32 or more shifts everything out, as the hardware does
    expect(ev('1 << 32')).toBe(0);
    expect(ev('1 << 40')).toBe(0);
    expect(ev('0x80000000 >> 32')).toBe(0);
    expect(ev('0x80000000 >> 100')).toBe(0);
    expect(ev('1 << (0x10 - 0x20)')).toBe(0);
    expect(ev('gHp > 2 ? 100 : 200')).toBe(100);
    expect(ev('5 % 3')).toBe(2);
    expect(ev('7 / 0')).toBe(0);
  });

  it('tells an assignment apart from a comparison', () => {
    expect(splitAssignment('gUnk_03005220.dreamStones = 10')).toEqual({
      target: 'gUnk_03005220.dreamStones',
      value: '10',
    });
    expect(splitAssignment('gEntityInfo[3].id=2')).toEqual({ target: 'gEntityInfo[3].id', value: '2' });
    expect(splitAssignment('x = y == 3')).toEqual({ target: 'x', value: 'y == 3' });
    expect(splitAssignment("c = '='")).toEqual({ target: 'c', value: "'='" });
    expect(splitAssignment('p->hp = 0')).toEqual({ target: 'p->hp', value: '0' });
    expect(splitAssignment('*p = 3')).toEqual({ target: '*p', value: '3' });
    expect(splitAssignment('a[i] = 3')).toEqual({ target: 'a[i]', value: '3' });
    for (const read of [
      'g_frame == 3',
      'a != b',
      'a <= b',
      'a >= b',
      'g_player.pos.x',
      '[0x03000000]',
      'p->x >= 3',
      '*p == 3',
    ]) {
      expect(splitAssignment(read)).toBeNull();
    }
    expect(() => splitAssignment('x += 1')).toThrow(/'\+=' is not supported/);
    expect(() => splitAssignment('x = ')).toThrow(/needs a place and a value/);
    expect(() => splitAssignment('= 10')).toThrow(/needs a place and a value/);
  });

  it('rejects malformed input with a message', () => {
    expect(() => compileExpression('1 +')).toThrow();
    expect(() => compileExpression('(1')).toThrow(/expected/);
    expect(() => compileExpression('1 $ 2')).toThrow(/unexpected/);
  });

  it('a variable index, an arrow and a dereference read what C says they read', () => {
    expect(ev('gEntityInfo[g_frame - 2].id')).toBe(100);
    expect(ev('g_samples[g_frame & 3]')).toBe(8);
    expect(ev('p->id')).toBe(100);
    expect(ev('(*p).id')).toBe(100);
    expect(ev('p->next->id')).toBe(101);
    expect(ev('gEntityInfo[g_frame - 2].next->id')).toBe(101);
    expect(ev('g_samples [ 1 ]')).toBe(5);
    // a variable index lands exactly where the same constant index does
    for (const i of [0, 1, 2, 3]) {
      expect(ev(`g_samples[g_frame + ${i - 2}]`)).toBe(ev(`g_samples[${i}]`));
    }
    expect(ev('g_samples[g_samples[0] - 2]')).toBe(5); // an expression as the index
    expect(ev('g_samples[1 + 1]')).toBe(8);
    expect(ev('g_samples[4 - 3]')).toBe(5);
    // an index steps backwards as readily as forwards
    expect(ev('(&g_samples[3])[-1]')).toBe(8);
  });

  it('pointer arithmetic steps by the element, and untyped words do not', () => {
    expect(ev('(p + 1) - p')).toBe(1);
    expect(ev('(*(p + 1)).id')).toBe(ev('p[1].id'));
    expect(ev('p[1].id')).toBe(101);
    expect(ev('&g_samples[1] - &g_samples[0]')).toBe(1);
    expect(ev('gEntityInfo + 1')).toBe(ev('&gEntityInfo[1]'));
    expect(ev('(p + 1) - 1')).toBe(ev('p'));
    expect(ev('&g_samples[2] - g_samples')).toBe(2);
    // the compatibility spine: nothing without a type is ever scaled
    expect(ev('r0 + 1')).toBe(11);
    expect(ev('u32(0x03000000) + 1')).toBe(0x78563413);
    expect(ev('[0x03000000] + 1')).toBe(0x13);
    expect(ev('{0x03000000} + 1')).toBe(0x3413);
    expect(ev('0x10 + 1')).toBe(0x11);
    expect(ev('frame + 1')).toBe(43);
    expect(ev('gHp + 1')).toBe(4);
    expect(ev('&gHp + 1')).toBe(0x03000001);
    // and a pointer in an operator that is not pointer arithmetic keeps its word
    expect(ev('p & 0xff')).toBe(ENTITIES_AT & 0xff);
    expect(ev('p == &gEntityInfo[0]')).toBe(1);
  });

  it('a pointee with no width steps by the byte, and counts bytes', () => {
    expect(ev('gRaw + 4')).toBe(ENTITIES_AT + 4);
    // two pointers of one type are one type whether or not that type has a size
    expect(ev('gRaw2 - gRaw')).toBe(8);
    expect(ev('gRaw - gRaw')).toBe(0);
    expect(() => ev('gRaw - p')).toThrow(/they point at different types/);
  });

  it('casts compose: a pointer value, and the T at an address', () => {
    expect(ev('(Entity *)0x03000300')).toBe(ENTITIES_AT);
    expect(ev('(*(Entity *)0x03000300).id')).toBe(100);
    expect(ev('((Entity *)0x03000300)->id')).toBe(100);
    expect(ev('((Entity *)0x03000300)[1].id')).toBe(101);
    expect(ev('((struct Entity *)0x03000300)->next->id')).toBe(101);
    expect(ev('*(vu16 *)0x03000000')).toBe(0x3412);
    expect(ev('(u16)0x03000000')).toBe(0x3412); // (T)x is still the T at x's address
    expect(ev('(u16)(0x03000000)')).toBe(0x3412);
    expect(ev('(int)&g_samples[1]')).toBe(5);
    expect(ev('1 + (u16)0x03000000')).toBe(0x3413);
    // a parenthesised expression is not a cast, whatever it looks like
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('(gHp) * 2')).toBe(6);
    expect(ev('(gHp)')).toBe(3);
    expect(ev('-(gHp)')).toBe(-3);
    expect(ev('(gHp) + 1')).toBe(4);
  });

  it('a root the debug info does not type is a word, and nothing below it can be measured', () => {
    expect(ev('gHp')).toBe(3);
    expect(ev('&gHp')).toBe(0x03000000);
    // A symbol table has no offsets, so every step below one is refused — naming the
    // root, not a type the ELF was never asked about.
    expect(() => ev('gHp.a')).toThrow(/'gHp' has no type here; cast it to reach through it/);
    expect(() => ev('gHp->a')).toThrow(/'gHp' has no type here; cast it to reach through it/);
    expect(() => ev('gHp[1]')).toThrow(/'gHp' has no type here; cast it to subscript it/);
    expect(() => ev('*gHp')).toThrow(/'gHp' has no type here; cast it to read through it/);
    // and a name that resolves nowhere is a missing name, whatever is written after it
    expect(() => ev('gNope.a')).toThrow(/unknown symbol 'gNope'/);
    expect(() => ev('gNope->a')).toThrow(/unknown symbol 'gNope'/);
    expect(() => ev('gNope[1]')).toThrow(/unknown symbol 'gNope'/);
    expect(() => ev('*gNope')).toThrow(/unknown symbol 'gNope'/);
    expect(() => ev('gNope->a->b')).toThrow(/unknown symbol 'gNope'/);
  });

  it('names what it cannot do, and what to type instead', () => {
    expect(() => ev('*5')).toThrow(/not a typed pointer — read what is there with u8\(5\)/);
    expect(() => ev('*r0')).toThrow(/not a typed pointer/);
    expect(() => ev('*g_frame')).toThrow(/cannot dereference 'g_frame': it is a u32, not a pointer/);
    expect(() => ev('p->nope')).toThrow(/'p' \(struct Entity \*\) has no member 'nope'/);
    expect(() => ev('g_samples[0].id')).toThrow(/'g_samples\[0\]' \(int\) has no members/);
    expect(() => ev('g_samples[4]')).toThrow(/index 4 is out of range for 'g_samples' \(int\[4\]\)/);
    expect(() => ev('p.id')).toThrow(/is a pointer; read a member through it with 'p->id'/);
    expect(() => ev('gEntityInfo[0]->id')).toThrow(/is not a pointer; use '\.' for a member of a value/);
    expect(() => ev('r0[1]')).toThrow(/cannot subscript 'r0': a plain 32-bit word has no element type/);
    expect(() => ev('r0.x')).toThrow(
      /cannot read a member of 'r0': a plain 32-bit word has no members — cast it first, as in \(\(struct Foo \*\)r0\)->x/,
    );
    expect(() => ev('r0->x')).toThrow(/cast it first, as in \(\(struct Foo \*\)r0\)->x/);
    expect(() => ev('g_frame[1]')).toThrow(/'g_frame' \(u32\) is not an array or a pointer/);
    expect(() => ev('&5')).toThrow(/cannot take the address of '5': it is a value, not a place in memory/);
    expect(() => ev('p + p')).toThrow(/cannot add two pointers \('p' and 'p'\)/);
    expect(() => ev('*gRaw')).toThrow(/a void \* points at no type — read what is there with u8\(gRaw\)/);
    expect(() => ev('gHandler + 1')).toThrow(/cannot step 'gHandler' \(Handler\): it points at code, not at values/);
    expect(() => ev('gHandler - gHandler')).toThrow(/it points at code, not at values/);
    expect(() => ev('p - &g_samples[0]')).toThrow(/they point at different types/);
    expect(() => ev('gEntityInfo[0]')).toThrow(/'gEntityInfo\[0\]' is a struct Entity, not a scalar/);
    expect(() => ev('(Nope *)0x03000300')).toThrow(/unknown type 'Nope' \(the ELF has no DWARF for it\)/);
    expect(() => ev('(Nope)0x03000300')).toThrow(/unknown type 'Nope' \(the ELF has no DWARF for it\)/);
    expect(() => ev('(u16)(g_frame + 1)')).toThrow(
      /'g_frame \+ 1' evaluates to 0x00000003, which is not a readable address/,
    );
    expect(() => ev('(u16)(g_frame + 1)')).toThrow(/use \(u16\)&g_frame \+ 1 to read the variable/);
    expect(() => ev('((Entity *)0x09000000)->id')).toThrow(/unreadable address 0x9000000/);
    expect(() => ev('1.5')).toThrow(/floating-point values are not supported/);
    expect(() => ev('p->')).toThrow(/expected a member name after '->'/);
    expect(() => compileExpression('-'.repeat(600) + '1')).toThrow(/nested too deeply/);
  });

  it('a root the compiler keeps in a register, and one it kept nowhere', () => {
    /** a struct small enough to live in a register, holding another struct at its start */
    const pair: TypeDesc = {
      kind: 'struct',
      name: 'struct Pair',
      size: 4,
      members: [
        { name: 'lo', offset: 0, type: u16Type },
        { name: 'hi', offset: 2, type: u16Type },
      ],
    };
    const boxedType: TypeDesc = {
      kind: 'struct',
      name: 'struct Boxed',
      size: 4,
      members: [{ name: 'pair', offset: 0, type: pair }],
    };
    const places: Record<string, ExprPlace> = {
      p: { word: ENTITIES_AT },
      arg0: { word: 0xffffff01 },
      wide: { word: 0x11223344 },
      boxed: { word: 0x11223344 },
      gone: { absent: 'r4 was not recovered in this frame' },
    };
    const live: ExprEnv = { ...env, place: (name) => places[name] };
    const withPlaces: ExprHints = {
      ...hints,
      rootType: (name) =>
        name === 'arg0'
          ? ({ kind: 'uchar', name: 'u8', size: 1 } as TypeDesc)
          : name === 'gone'
            ? int32
            : name === 'wide'
              ? entity
              : name === 'boxed'
                ? boxedType
                : ROOT_TYPES[name],
    };
    const run = (s: string): number => compileExpression(s, withPlaces)(live);
    expect(run('p->id')).toBe(100);
    expect(run('p->next->id')).toBe(101);
    expect(run('gEntityInfo[arg0].id')).toBe(101); // a u8 register holding 1, its junk high bytes ignored
    expect(() => run('&p')).toThrow(/cannot take the address of 'p': the compiler keeps it in a register here/);
    expect(() => run('gone')).toThrow(/'gone' is not available here: r4 was not recovered in this frame/);
    // the low bytes of a register-held struct are readable; what is not says which reason it is
    expect(run('wide.id')).toBe(0x11223344);
    expect(() => run('wide.next')).toThrow(
      /'wide.next' is not available here: the compiler keeps 'wide' in a register, and 'next' is past its low 4 bytes/,
    );
    expect(() => run('boxed.pair.lo')).toThrow(
      /the compiler keeps 'boxed' in a register, which gives 'pair' \(struct Pair\) no address to read/,
    );
  });

  it('reports the type and the place it compiled, for the panes that need them', () => {
    expect(compile('&g_samples[1]', hints).lvalue).toBeNull();
    expect(compile('&g_samples[1]', hints).type!.name).toBe('int *');
    expect(compile('g_samples[1]', hints).type!.name).toBe('int');
    expect(compile('g_samples[1]', hints).lvalue!.address(env)).toBe(SAMPLES_AT + 4);
    expect(compile('p->next', hints).lvalue!.address(env)).toBe(ENTITIES_AT + 4);
    expect(compile('r0 + 1', hints).type).toBeNull();
    expect(compile('r0 + 1', hints).lvalue).toBeNull();
    expect(compile('(Entity *)0x03000300', hints).type!.kind).toBe('pointer');
    // a pointer is spelled as C declares one, whatever it points at
    expect(compile('&gEntityInfo[0]', hints).type!.name).toBe('struct Entity *');
    expect(compile('&p', hints).type!.name).toBe('struct Entity **');
    expect(compile('&g_samples', hints).type!.name).toBe('int (*)[4]');
    expect(compile('*(Entity *)0x03000300', hints).lvalue!.address(env)).toBe(ENTITIES_AT);
  });

  it('bounds literals, length and nesting instead of wrapping or overflowing', () => {
    expect(() => compileExpression('4294967296')).toThrow(/32 bits/);
    expect(() => compileExpression('0x100000000')).toThrow(/32 bits/);
    expect(ev('0xffffffff')).toBe(0xffffffff);
    expect(() => compileExpression('('.repeat(600) + '1' + ')'.repeat(600))).toThrow(/nested too deeply/);
    expect(() => compileExpression('x'.repeat(10000))).toThrow(/too long/);
  });

  it('hit conditions and log messages', () => {
    expect(compileHitCondition('3')(3)).toBe(true);
    expect(compileHitCondition('3')(2)).toBe(false);
    expect(compileHitCondition('== 2')(3)).toBe(false);
    expect(compileHitCondition('% 4')(8)).toBe(true);
    expect(() => compileHitCondition('abc')).toThrow();
    // hits count from 1, so these could never fire
    expect(() => compileHitCondition('% 0')).toThrow(/never be satisfied/);
    expect(() => compileHitCondition('== 0')).toThrow(/never be satisfied/);
    expect(() => compileHitCondition('< 0')).toThrow(/never be satisfied/);
    expect(() => compileHitCondition('<= 0')).toThrow(/never be satisfied/);
    expect(compileHitCondition('0')(1)).toBe(true);
    expect(compileHitCondition('>= 0')(1)).toBe(true);
    expect(compileHitCondition('> 0')(1)).toBe(true);
    expect(compileLogMessage('hp={gHp} at {frame} {bad +}')(env)).toBe(
      'hp=3 (0x3) at 42 (0x2a) {bad +: unexpected end of expression}',
    );
    // braces nest: the u16 read of the grammar works inside an interpolation
    expect(compileLogMessage('v={{0x03000000}} n={[0x03000000]}')(env)).toBe('v=13330 (0x3412) n=18 (0x12)');
    expect(compileLogMessage('open {gHp')(env)).toBe('open {gHp');
    expect(compileLogMessage('signed {gSigned}', hints)(env)).toBe('signed -7 (0xfffffff9)');
    expect(compileLogMessage('{p->id} {g_samples[g_frame & 3]}', hints)(env)).toBe('100 (0x64) 8 (0x8)');
  });
});

describe('deltas', () => {
  it('round-trips arbitrary changes and stays small for small changes', () => {
    const base = new Uint8Array(4096).map((_, i) => i & 0xff);
    const next = base.slice();
    next[10] = 0xff;
    next[11] = 0xfe;
    next[3000] = 0;
    const delta = encodeDelta(base, next);
    expect(delta.length).toBeLessThan(64);
    expect(decodeDelta(base, delta)).toEqual(next);
    expect(decodeDelta(base, encodeDelta(base, base))).toEqual(base);
    // a seeded generator: a failure here reproduces
    let seed = 0x12345678;
    const random = base.map(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 24;
    });
    expect(decodeDelta(base, encodeDelta(base, random))).toEqual(random);
  });

  it('absorbs a short run of equal bytes into a literal, and starts a new chunk at a long one', () => {
    const base = new Uint8Array(64);
    const near = base.slice();
    near[0] = 1;
    near[8] = 1; // 7 equal bytes between two changes: one literal chunk of 9
    const headers = (d: Uint8Array): number[] => {
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const out: number[] = [];
      for (let o = 0; o + 8 <= d.length; o += 8 + v.getUint32(o + 4, true)) {
        out.push(v.getUint32(o, true), v.getUint32(o + 4, true));
      }
      return out;
    };
    expect(headers(encodeDelta(base, near))).toEqual([0, 9, 55, 0]);
    const far = base.slice();
    far[0] = 1;
    far[9] = 1; // 8 equal bytes: a zero run of its own
    expect(headers(encodeDelta(base, far))).toEqual([0, 1, 8, 1, 54, 0]);
    for (const next of [near, far]) {
      expect(decodeDelta(base, encodeDelta(base, next))).toEqual(next);
    }
  });

  it('round-trips every typed-array kind of a snapshot and refuses an unlisted one', () => {
    const shape = (r: number, ram: number, buf: number) => ({
      cpu: { r: new Uint32Array([1, r]) },
      ram: new Uint8Array([3, ram]),
      apu: { buf: new Int8Array([buf]) },
      ppu: { framebuffer: new Uint32Array(1) },
    });
    const like = shape(2, 4, -1);
    const next = shape(5, 9, -2);
    const restored = applySnapshotDelta(
      like as never,
      deltaSnapshot(like as never, next as never),
    ) as unknown as typeof next;
    expect(restored.cpu.r).toBeInstanceOf(Uint32Array);
    expect(Array.from(restored.cpu.r)).toEqual([1, 5]);
    expect(Array.from(restored.ram)).toEqual([3, 9]);
    expect(restored.apu.buf).toBeInstanceOf(Int8Array);
    expect(Array.from(restored.apu.buf)).toEqual([-2]);
    const odd = { x: new Uint16Array([3, 4]) };
    expect(() => deltaSnapshot(odd as never, odd as never)).toThrow(/unsupported typed array Uint16Array/);
    expect(() => encodeSaveState(odd as never, { romHash: 'h', frame: 0 })).toThrow(/unsupported typed array/);
  });
});

describe('base64', () => {
  it('round-trips every length mod 3', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) & 0xff);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
    expect(bytesToBase64(new Uint8Array([0x4d, 0x61, 0x6e]))).toBe('TWFu');
    expect(bytesToBase64(new Uint8Array([0x4d]))).toBe('TQ==');
  });
});

describe('ring', () => {
  it('overwrites the oldest entries and reads back in order', () => {
    const r = new Ring<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => r.push(n));
    expect(r.size).toBe(3);
    expect(r.last(2)).toEqual([4, 5]);
    expect(r.slice(0, 10)).toEqual([3, 4, 5]);
    r.clear();
    expect(r.size).toBe(0);
  });
});

describe('recordings', () => {
  it('collapses masks into segments and scripts', () => {
    expect(toSegments([0, 0, 1, 1, 1, 0])).toEqual([
      { buttons: 0, frames: 2 },
      { buttons: 1, frames: 3 },
      { buttons: 0, frames: 1 },
    ]);
    const script = recordingToScript({
      format: 'gba-kit-input',
      version: 1,
      romHash: 'abc',
      startFrame: 0,
      frames: [0, 0, 1, 1, 1, 0],
    });
    expect(script).toContain('await wait({ frames: 2 });');
    expect(script).toContain("await press('a', { hold: 3 });");
    const combo = recordingToScript({
      format: 'gba-kit-input',
      version: 1,
      romHash: 'abc',
      startFrame: 0,
      frames: [0b11],
    });
    expect(combo).toContain("['a+b', 1]");
  });

  it('writes a take to a file and reads it back, script and all', () => {
    const take = {
      recording: {
        format: 'gba-kit-input' as const,
        version: 1 as const,
        romHash: 'abc',
        startFrame: 12,
        frames: [0, 1, 1],
      },
      script: 'stale, and not stored',
      thumbnail: { width: 2, height: 1, rgba: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]) },
      createdAt: '2026-09-06T12:00:00.000Z',
    };
    const back = decodeTake(encodeTake(take));
    expect(back.recording).toEqual(take.recording);
    expect(back.thumbnail).toEqual(take.thumbnail);
    expect(back.createdAt).toBe(take.createdAt);
    // the script is what the input makes of it, not what was stored beside it
    expect(back.script).toContain("await press('a', { hold: 2 });");

    for (const bad of ['{}', '{"format":"gba-kit-recording"}', 'not json']) {
      expect(() => decodeTake(bad)).toThrow();
    }
  });

  it('packs the machine a take begins on, small enough to keep beside it', () => {
    const ram = new Uint8Array(4096);
    ram.set([1, 2, 3], 100); // as a GBA's RAM is: mostly zero, with a little in it
    const snapshot = {
      frame: 7,
      cpu: { r: new Uint32Array([1, 2]) },
      ram,
      apu: { buf: new Int8Array([-1]) },
      ppu: { framebuffer: new Uint32Array(240 * 160), mode: 3 },
    };
    const packed = packSnapshot(snapshot as never);
    const rle = packed.arrays.reduce((n, a) => n + a.rle.length, 0);
    const raw = packed.arrays.reduce((n, a) => n + a.bytes, 0);
    expect(rle).toBeLessThan(raw / 4);
    // the framebuffer is not among them: it is drawn again by the frame that follows
    expect(packed.arrays.some((a) => a.path.includes('framebuffer'))).toBe(false);

    const back = unpackSnapshot(packed) as unknown as typeof snapshot;
    expect(back.ram).toBeInstanceOf(Uint8Array);
    expect(Array.from(back.ram.subarray(98, 104))).toEqual([0, 0, 1, 2, 3, 0]);
    expect(Array.from(back.cpu.r)).toEqual([1, 2]);
    expect(Array.from(back.apu.buf)).toEqual([-1]);
    expect(back.frame).toBe(7);
    expect(back.ppu.mode).toBe(3);
    expect(back.ppu.framebuffer.length).toBe(240 * 160);
  });
});

describe('labels', () => {
  it('sets, clears, imports and exports', () => {
    const store = new LabelStore();
    store.set({ address: 0x08001234, label: 'Main' });
    expect(store.at(0x08001234)?.label).toBe('Main');
    expect(store.byName('Main')?.address).toBe(0x08001234);
    store.set({ address: 0x08001234, label: '' });
    expect(store.at(0x08001234)).toBeUndefined();
    expect(store.importSymbols('0x03005220 gUnk_03005220 ; comment\n.text 0x08000000 code\nfoo = 0x02000000;')).toBe(2);
    expect(store.toFile('h').labels.map((l) => l.label)).toEqual(['foo', 'gUnk_03005220']);
    const copy = new LabelStore();
    copy.loadFile(store.toFile('h'));
    expect(copy.size).toBe(2);
    expect(copy.dirty).toBe(false);
  });
});

describe('source mapper', () => {
  it('rewrites prefixes, resolves relative paths, and strips foreign roots', () => {
    const existing = new Set(['/home/me/game/source/main.c', '/home/me/decomp/src/code_0.c']);
    const m = new SourceMapper(['/balatro-gba/source/main.c', 'src/code_0.c', 'src/missing.c'], {
      cwd: '/home/me/decomp',
      sourceMap: { '/balatro-gba': '/home/me/game' },
      exists: (p) => existing.has(p),
    });
    expect(m.toLocal('/balatro-gba/source/main.c')).toBe('/home/me/game/source/main.c');
    expect(m.toLocal('src/code_0.c')).toBe('/home/me/decomp/src/code_0.c');
    expect(m.toLocal('src/missing.c')).toBeNull();
    expect(m.toDwarf('/home/me/decomp/src/code_0.c')).toBe('src/code_0.c');
    expect(m.toDwarf('/home/me/game/source/main.c')).toBe('/balatro-gba/source/main.c');
    const stripped = new SourceMapper(['/docker/build/source/main.c'], {
      cwd: '/home/me/game',
      exists: (p) => existing.has(p),
    });
    expect(stripped.toLocal('/docker/build/source/main.c')).toBe('/home/me/game/source/main.c');
  });
});

describe('the stack bound', () => {
  it("is the mode's own stack top, or the top of the mirror a relocated stack is in", () => {
    // Not the end of IWRAM: the IRQ and SVC stacks sit above the SYS stack's top, and
    // a search that ran past it would read the interrupt stub's pushed block and
    // report a caller for the program's entry point.
    expect(stackBoundFor(MODE_SYS, 0x03007cd4)).toBe(0x03007f00);
    expect(stackBoundFor(MODE_IRQ, 0x03007f90)).toBe(0x03007fa0);
    // IWRAM repeats every 32 KB and EWRAM every 256 KB up to the next region, and a
    // stack pointer in a mirror addresses the same memory — so a bound taken from
    // the region's base would sit below the stack and end every walk at frame 0.
    expect(stackBoundFor(MODE_SYS, 0x03fffcd4)).toBe(0x04000000);
    expect(stackBoundFor(MODE_SYS, 0x0203fff0)).toBe(0x02040000);
    // A pointer in no region a stack belongs in leaves only the boot layout.
    expect(stackBoundFor(MODE_IRQ, undefined)).toBe(0x03007fa0);
    expect(stackBoundFor(MODE_SYS, 0x08000000)).toBe(0x03007f00);
  });
});

describe('manual host', () => {
  it('fires intervals in order as the clock moves', () => {
    const host = new ManualHost();
    const fired: string[] = [];
    const stopA = host.interval(() => fired.push('a'), 10);
    host.interval(() => fired.push('b'), 25);
    host.tick(30);
    expect(fired).toEqual(['a', 'a', 'b', 'a']);
    stopA();
    host.tick(30);
    expect(fired).toEqual(['a', 'a', 'b', 'a', 'b']); // b keeps firing after a is stopped
  });
});

describe('protocol argument semantics', () => {
  it('an entry count falls back when unsaid, means none when 0, and never exceeds the cap', () => {
    expect(entryCount(undefined, LOG.traceDefault)).toBe(LOG.traceDefault);
    expect(entryCount(null, 7)).toBe(7);
    expect(entryCount('nope', 7)).toBe(7);
    expect(entryCount(0, 7)).toBe(0);
    expect(entryCount(-3, 7)).toBe(0);
    expect(entryCount(2.9, 7)).toBe(2);
    expect(entryCount(1e9, 7)).toBe(LOG.max);
    expect(entryCount(50, 7, 10)).toBe(10);
  });

  it('a rewind is at least one whole frame', () => {
    expect(rewindFrameCount(0)).toBe(1);
    expect(rewindFrameCount(-5)).toBe(1);
    expect(rewindFrameCount(undefined)).toBe(1);
    expect(rewindFrameCount(2.7)).toBe(2);
    expect(rewindFrameCount(60)).toBe(60);
  });

  it('a tile count defaults, and stays within the reach of a character base', () => {
    expect(tileCount(undefined)).toBe(TILES.defaultCount);
    expect(tileCount(0)).toBe(TILES.defaultCount);
    expect(tileCount(4)).toBe(4);
    expect(tileCount(99_999)).toBe(TILES.maxCount);
  });
});

describe('I/O registers', () => {
  it('names the register an address falls in, and nothing for a gap between two', () => {
    expect(ioRegisterAt(0x04000000)?.name).toBe('DISPCNT');
    expect(ioRegisterAt(0x04000001)?.name).toBe('DISPCNT'); // the high byte of a halfword register
    expect(ioRegisterAt(0x0400002a)?.name).toBe('BG2X'); // inside a word register
    expect(ioRegisterAt(0x0400004e)).toBeNull(); // past MOSAIC, which is two bytes at 0x400004c
    expect(ioRegisterAt(0x03000000)).toBeNull();
  });
});
