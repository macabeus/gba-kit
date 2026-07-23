import { describe, expect, it } from 'vitest';

import { Cursor, cstrAt } from '../reader.js';

const bytes = (...b: number[]) => new Uint8Array(b);

describe('Cursor', () => {
  it('reads LE integers and advances', () => {
    const c = new Cursor(bytes(0x01, 0x02, 0x03, 0x04, 0xff));
    expect(c.u8()).toBe(0x01);
    expect(c.u16()).toBe(0x0302);
    expect(c.u8()).toBe(0x04);
    expect(c.u8()).toBe(0xff);
    expect(c.eof).toBe(true);
  });

  it('u32 stays unsigned', () => {
    expect(new Cursor(bytes(0x00, 0x00, 0x00, 0x80)).u32()).toBe(0x80000000);
  });

  it('reads BIG-endian integers when constructed with littleEndian=false', () => {
    const c = new Cursor(bytes(0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07), 0, false);
    expect(c.u8()).toBe(0x01);
    expect(c.u16()).toBe(0x0203);
    expect(c.u32()).toBe(0x04050607);
    expect(c.u16At(1)).toBe(0x0203);
    expect(c.u32At(3)).toBe(0x04050607);
  });

  it('BE u32 stays unsigned', () => {
    expect(new Cursor(bytes(0x80, 0x00, 0x00, 0x00), 0, false).u32()).toBe(0x80000000);
  });

  it('decodes ULEB128 (verified encodings)', () => {
    expect(new Cursor(bytes(0x00)).uleb()).toBe(0);
    expect(new Cursor(bytes(0x7f)).uleb()).toBe(127);
    expect(new Cursor(bytes(0x80, 0x01)).uleb()).toBe(128);
    expect(new Cursor(bytes(0xac, 0x02)).uleb()).toBe(300);
    expect(new Cursor(bytes(0x84, 0x3d)).uleb()).toBe(0x1e84);
  });

  it('decodes SLEB128 including negatives (verified encodings)', () => {
    expect(new Cursor(bytes(0x00)).sleb()).toBe(0);
    expect(new Cursor(bytes(0x7f)).sleb()).toBe(-1);
    expect(new Cursor(bytes(0x3f)).sleb()).toBe(63);
    expect(new Cursor(bytes(0xc0, 0x00)).sleb()).toBe(64);
    expect(new Cursor(bytes(0x40)).sleb()).toBe(-64);
    expect(new Cursor(bytes(0x80, 0x7f)).sleb()).toBe(-128);
  });

  it('reads consecutive NUL-terminated strings', () => {
    // Bytes: "a.c\0bc\0"
    const c = new Cursor(bytes(0x61, 0x2e, 0x63, 0x00, 0x62, 0x63, 0x00));
    expect(c.cstr()).toBe('a.c');
    expect(c.cstr()).toBe('bc');
  });

  it('cstrAt reads at an absolute offset', () => {
    // Bytes: "\0foo\0bar\0"
    const b = bytes(0x00, 0x66, 0x6f, 0x6f, 0x00, 0x62, 0x61, 0x72, 0x00);
    expect(cstrAt(b, 1)).toBe('foo');
    expect(cstrAt(b, 5)).toBe('bar');
  });
});
