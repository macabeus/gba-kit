import { describe, expect, it } from 'vitest';

import { decodeDelta, encodeDelta } from '../delta.js';
import { type ExprEnv, compileExpression, compileHitCondition, compileLogMessage } from '../expression.js';
import { ManualHost } from '../host.js';
import { LabelStore } from '../labels.js';
import { recordingToScript, toSegments } from '../recorder.js';
import { Ring } from '../rings.js';
import { base64ToBytes, bytesToBase64 } from '../snapshot-codec.js';
import { SourceMapper } from '../source-map.js';

const env: ExprEnv = {
  reg: (i) => (i === 0 ? 10 : i === 13 ? 0x03007f00 : 0),
  cpsr: () => 0x1f,
  read: (a, size) => (a === 0x03000000 ? (size === 1 ? 0x12 : size === 2 ? 0x3412 : 0x78563412) : undefined),
  symbol: (path) => (path === 'gHp' ? 3 : path === 'gState.hp' ? 9 : undefined),
  symbolAddress: (name) => (name === 'gHp' ? 0x03000000 : undefined),
  frame: () => 42,
  scanline: () => 7,
  cycle: () => 1000,
};

describe('expression grammar', () => {
  const ev = (s: string): number => compileExpression(s)(env);

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
    expect(() => ev('[0x09000000]')).toThrow(/unreadable/);
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
    expect(ev('-1')).toBe(0xffffffff);
    expect(ev('~0')).toBe(0xffffffff);
    expect(ev('!0')).toBe(1);
    expect(ev('1 << 31 >> 31')).toBe(1);
    expect(ev('gHp > 2 ? 100 : 200')).toBe(100);
    expect(ev('5 % 3')).toBe(2);
    expect(ev('7 / 0')).toBe(0);
  });

  it('rejects malformed input with a message', () => {
    expect(() => compileExpression('1 +')).toThrow();
    expect(() => compileExpression('(1')).toThrow(/expected/);
    expect(() => compileExpression('1 $ 2')).toThrow(/unexpected/);
  });

  it('hit conditions and log messages', () => {
    expect(compileHitCondition('3')(3)).toBe(true);
    expect(compileHitCondition('3')(2)).toBe(false);
    expect(compileHitCondition('== 2')(3)).toBe(false);
    expect(compileHitCondition('% 4')(8)).toBe(true);
    expect(() => compileHitCondition('abc')).toThrow();
    expect(compileLogMessage('hp={gHp} at {frame} {bad +}')(env)).toBe(
      'hp=3 (0x3) at 42 (0x2a) {bad +: unexpected end of expression}',
    );
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
    const random = base.map(() => Math.floor(Math.random() * 256));
    expect(decodeDelta(base, encodeDelta(base, random))).toEqual(random);
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
    expect(fired.filter((f) => f === 'a').length).toBe(3);
  });
});
