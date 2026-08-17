/**
 * The debug read surface refuses questions it cannot answer.
 *
 * The hardware bus answers every address, because the console does: it forces an
 * unaligned load to an aligned one and returns open bus for unmapped space. Correct
 * for the CPU, and a trap for a human or an agent, who cannot tell that number from
 * the one they asked for. These tests pin the refusals AND — because a refusal test
 * can pass for the wrong reason, e.g. the value was unreachable anyway — each one
 * carries a positive control showing the well-posed form of the same read still works
 * and still returns the right bytes.
 */
import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { ScriptingEngine, type ScriptingHost } from '../scripting.js';

const stubHost: ScriptingHost = {
  writeScreenshot: async () => {},
  writeMemorySnapshot: async () => {},
  writeSaveState: async () => {},
  readSaveState: async () => {
    throw new Error('not used');
  },
  log: () => {},
};

/** An engine with a known byte pattern at `base` in IWRAM. */
function engineWithBytes(base: number, bytes: number[]): ScriptingEngine {
  const gba = new Gba();
  bytes.forEach((b, i) => gba.bus.write8(base + i, b));
  return new ScriptingEngine(gba, stubHost);
}

const BASE = 0x03000100; // word-aligned, so BASE+1 and BASE+3 are the odd cases
const BYTES = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];

describe('read16 / read32 alignment', () => {
  it('reads an aligned halfword and word', () => {
    const engine = engineWithBytes(BASE, BYTES);
    expect(engine.read16(BASE)).toBe(0x2211);
    expect(engine.read16(BASE + 2)).toBe(0x4433);
    expect(engine.read32(BASE)).toBe(0x44332211);
  });

  it('refuses an odd halfword instead of silently reading the even one', () => {
    const engine = engineWithBytes(BASE, BYTES);
    // The bus, left to itself, answers this with the halfword at BASE+2.
    expect(() => engine.read16(BASE + 3)).toThrow(/not 2-byte aligned/);
    // Positive control: the value IS reachable, by the API that means what it says.
    expect(engine.readBytes(BASE + 3, 2)).toBe(0x5544);
    // …and that is genuinely different from what the silent alignment would have given.
    expect(engine.read16(BASE + 2)).toBe(0x4433);
  });

  it('refuses a misaligned word the same way', () => {
    const engine = engineWithBytes(BASE, BYTES);
    for (const off of [1, 2, 3]) {
      expect(() => engine.read32(BASE + off)).toThrow(/not 4-byte aligned/);
    }
    expect(engine.readBytes(BASE + 1, 4)).toBe(0x55443322);
    expect(engine.read32(BASE)).toBe(0x44332211); // positive control
  });

  it('names the address the hardware would have read instead', () => {
    const engine = engineWithBytes(BASE, BYTES);
    expect(() => engine.read16(BASE + 3)).toThrow(new RegExp(`silently read 0x${(BASE + 2).toString(16)}`));
  });
});

describe('read32 signedness', () => {
  it('returns an unsigned word even when bit 31 is set', () => {
    // The bus assembles words with `|`, an int32 operator, so this reads as
    // -369098706 there and formats as "-15ffffd2" — not an address, and not a value
    // any comparison against a GBA constant will match.
    const engine = engineWithBytes(BASE, [0x2e, 0x00, 0x00, 0xea]);
    expect(engine.read32(BASE)).toBe(0xea00002e);
    expect(engine.read32(BASE)).toBeGreaterThan(0);
    expect(engine.read32(BASE).toString(16)).toBe('ea00002e');
    // Positive control: a word with bit 31 clear was never affected and still isn't.
    const low = engineWithBytes(BASE, [0x78, 0x56, 0x34, 0x12]);
    expect(low.read32(BASE)).toBe(0x12345678);
  });

  it('agrees with readBytes on the same word', () => {
    const engine = engineWithBytes(BASE, [0x2e, 0x00, 0x00, 0xea]);
    expect(engine.read32(BASE)).toBe(engine.readBytes(BASE, 4));
  });
});

describe('unmapped memory', () => {
  it('refuses reads from address space nothing backs', () => {
    const engine = engineWithBytes(BASE, BYTES);
    for (const addr of [0x01000000, 0x10000000, 0x04001000]) {
      expect(() => engine.read32(addr)).toThrow(/nothing is mapped/);
      expect(() => engine.readBytes(addr, 1)).toThrow(/nothing is mapped/);
    }
  });

  it('refuses a span that starts in memory and runs off the end of it', () => {
    const engine = engineWithBytes(BASE, BYTES);
    // The last byte of the MMIO register file; a word from there leaves the region.
    expect(() => engine.readBytes(0x040003fe, 4)).toThrow(/run off the end of MMIO/);
    expect(engine.readBytes(0x040003fe, 1)).toBeTypeOf('number'); // positive control
  });

  it('still reads every region that IS backed', () => {
    const engine = engineWithBytes(BASE, BYTES);
    // Positive control for the guard as a whole: it must not reject ordinary memory.
    for (const addr of [0x02000000, 0x03000000, 0x04000000, 0x05000000, 0x06000000, 0x07000000]) {
      expect(() => engine.read16(addr)).not.toThrow();
    }
  });
});

describe('readBytes', () => {
  it('assembles 1..4 bytes little-endian at any alignment', () => {
    const engine = engineWithBytes(BASE, BYTES);
    expect(engine.readBytes(BASE + 1, 1)).toBe(0x22);
    expect(engine.readBytes(BASE + 1, 2)).toBe(0x3322);
    expect(engine.readBytes(BASE + 1, 3)).toBe(0x443322);
    expect(engine.readBytes(BASE + 1, 4)).toBe(0x55443322);
  });

  it('rejects a width it cannot represent', () => {
    const engine = engineWithBytes(BASE, BYTES);
    expect(() => engine.readBytes(BASE, 0)).toThrow(/size must be 1\.\.4/);
    expect(() => engine.readBytes(BASE, 8)).toThrow(/size must be 1\.\.4/);
  });
});

describe('readMember / writeMember', () => {
  // The shape that produced a wrong reading in practice: a 2-byte member at an ODD
  // offset inside a struct — `u8 bgMapSize[2]` at offset 3 of Klonoa's GfxControlFlags.
  const oddTwoByte = { offset: 3, size: 2 };
  const bitfieldAtOddByte = { offset: 1, size: 1, bitOffset: 0, bitWidth: 1 };

  it('reads a 2-byte member at an odd offset as the bytes it names', () => {
    const engine = engineWithBytes(BASE, BYTES);
    expect(engine.readMember(BASE, oddTwoByte)).toBe(0x5544);
    // Ablation: the old implementation went through the bus's read16, which would
    // have answered 0x4433 here. Pin the difference so a regression is loud.
    expect(engine.readMember(BASE, oddTwoByte)).not.toBe(0x4433);
  });

  it('decodes a bitfield in an odd-byte container', () => {
    const engine = engineWithBytes(BASE, [0x00, 0b0000_0011]);
    expect(engine.readMember(BASE, bitfieldAtOddByte)).toBe(1);
    // Positive control: the bit really is what is being read, not a constant.
    const zero = engineWithBytes(BASE, [0xff, 0b0000_0010]);
    expect(zero.readMember(BASE, bitfieldAtOddByte)).toBe(0);
  });

  it('writes a bitfield without disturbing its neighbours', () => {
    const engine = engineWithBytes(BASE, [0xaa, 0b0000_0010, 0xcc]);
    engine.writeMember(BASE, bitfieldAtOddByte, 1);
    expect(engine.readBytes(BASE + 1, 1)).toBe(0b0000_0011);
    expect(engine.readBytes(BASE, 1)).toBe(0xaa); // the byte before is untouched
    expect(engine.readBytes(BASE + 2, 1)).toBe(0xcc); // and the one after
  });

  it('writes a 2-byte member at an odd offset to the right bytes', () => {
    const engine = engineWithBytes(BASE, BYTES);
    engine.writeMember(BASE, oddTwoByte, 0xbeef);
    expect(engine.readBytes(BASE + 3, 2)).toBe(0xbeef);
    expect(engine.readBytes(BASE + 2, 1)).toBe(0x33); // the aligned neighbour survived
  });

  it('refuses a write to read-only memory rather than dropping it', () => {
    const gba = new Gba();
    gba.loadRom(new Uint8Array(0x100).fill(0x5a));
    const engine = new ScriptingEngine(gba, stubHost);
    expect(() => engine.writeMember(0x08000000, { offset: 0, size: 2 }, 1)).toThrow(/ROM, which is read-only/);
    // Positive control: the same address READS fine — the refusal is about the write,
    // not about the region being unreachable.
    expect(engine.readMember(0x08000000, { offset: 0, size: 2 })).toBe(0x5a5a);
    // And past the cartridge's end is unmapped, not zero.
    expect(() => engine.readMember(0x08000100, { offset: 0, size: 2 })).toThrow(/nothing is mapped/);
  });

  it('refuses a member with no known size', () => {
    const engine = engineWithBytes(BASE, BYTES);
    expect(() => engine.readMember(BASE, { offset: 0, size: null })).toThrow(/no known byte size/);
  });

  it('refuses an aggregate member rather than truncating it to 4 bytes', () => {
    const engine = engineWithBytes(BASE, BYTES);
    // `u8 pad[0x15]` is a real member of the struct this came from; it is not a number.
    expect(() => engine.readMember(BASE, { offset: 5, size: 0x15 })).toThrow(/is not a number/);
    expect(engine.getMemory(BASE + 5, 1)).toHaveLength(1); // positive control
  });
});
