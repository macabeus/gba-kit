import { describe, expect, it } from 'vitest';

import { applySnapshotDelta, decodeDelta, deltaSnapshot, encodeDelta } from '../delta.js';
import { packSnapshot, unpackSnapshot } from '../delta.js';
import {
  type ExprEnv,
  compileExpression,
  compileHitCondition,
  compileLogMessage,
  splitAssignment,
} from '../expression.js';
import { ManualHost } from '../host.js';
import { ioRegisterAt } from '../io.js';
import { LabelStore } from '../labels.js';
import { LOG, TILES, entryCount, rewindFrameCount, tileCount } from '../protocol.js';
import { decodeTake, encodeTake, recordingToScript, toSegments } from '../recorder.js';
import { Ring } from '../rings.js';
import { base64ToBytes, bytesToBase64, encodeSaveState } from '../snapshot-codec.js';
import { SourceMapper } from '../source-map.js';

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
        : undefined,
  // gSigned is an `int` holding -7, delivered as its 32-bit word
  symbol: (path) => (path === 'gHp' ? 3 : path === 'gState.hp' ? 9 : path === 'gSigned' ? 0xfffffff9 : undefined),
  symbolAddress: (name) => (name === 'gHp' ? 0x03000000 : undefined),
  frame: () => 42,
  scanline: () => 7,
  cycle: () => 1000,
};
const hints = { symbolSigned: (path: string) => (path === 'gSigned' ? true : undefined) };

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
    expect(ev('gState.hp == 9')).toBe(1);
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
    for (const read of ['g_frame == 3', 'a != b', 'a <= b', 'a >= b', 'g_player.pos.x', '[0x03000000]']) {
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

  it('says what it does not support instead of "unexpected token"', () => {
    expect(() => compileExpression('gEntityInfo[var_sb].id == 5')).toThrow(/constant subscripts/);
    expect(() => compileExpression('g_samples[g_frame & 3]')).toThrow(/constant subscripts/);
    expect(() => compileExpression('p->x')).toThrow(/constant subscripts/);
    expect(() => compileExpression('*p')).toThrow(/dereference is not supported/);
    expect(() => compileExpression('g_player . pos')).toThrow(/constant subscripts/);
    expect(compileExpression('gEntityInfo[3].id == 5')).toBeTypeOf('function');
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
