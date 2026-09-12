/**
 * The cartridge's battery-backed save: what the ROM declares, and the bytes of a
 * `.sav` going in and coming back out in the order every other emulator keeps them.
 */
import { describe, expect, it } from 'vitest';

import { GbaSystemBus } from '../system-bus.js';

/** A ROM that declares `id`, with the string word-aligned the way a build puts it there. */
function romDeclaring(id: string | null, at = 0x400): Uint8Array {
  const rom = new Uint8Array(0x1000);
  if (id !== null) {
    for (let i = 0; i < id.length; i++) {
      rom[at + i] = id.charCodeAt(i);
    }
  }
  return rom;
}

function busFor(id: string | null): GbaSystemBus {
  const bus = new GbaSystemBus();
  bus.loadRom(romDeclaring(id));
  return bus;
}

/** The serial line: a bit in, as a DMA to the EEPROM window does it. */
function sendBits(bus: GbaSystemBus, bits: number[]): void {
  for (const bit of bits) {
    bus.write16(0x0d000000, bit);
  }
}

function bitsOf(value: number, count: number): number[] {
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push((value >>> i) & 1);
  }
  return out;
}

/** The eight bytes of one EEPROM word, read over the protocol: 4 dummy bits, then 64 data bits. */
function readWord(bus: GbaSystemBus, word: number, addrBits: number): Uint8Array {
  sendBits(bus, [1, 1, ...bitsOf(word, addrBits), 0]);
  const bits: number[] = [];
  for (let i = 0; i < 68; i++) {
    bits.push(bus.read16(0x0d000000) & 1);
  }
  const data = bits.slice(4);
  const out = new Uint8Array(8);
  for (let i = 0; i < 64; i++) {
    out[i >> 3]! |= data[i]! << (7 - (i & 7));
  }
  return out;
}

/** Clock eight bytes into one EEPROM word, as the game's own save routine does. */
function writeWord(bus: GbaSystemBus, word: number, addrBits: number, bytes: Uint8Array): void {
  const bits: number[] = [];
  for (const byte of bytes) {
    bits.push(...bitsOf(byte, 8));
  }
  sendBits(bus, [1, 0, ...bitsOf(word, addrBits), ...bits, 0]);
}

function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 7 + 3) & 0xff);
}

describe('declared save type', () => {
  it.each([
    ['EEPROM_V121', 'eeprom'],
    ['SRAM_V113', 'sram'],
    ['SRAM_F_V102', 'sram'],
    ['FLASH_V126', 'flash512'],
    ['FLASH512_V130', 'flash512'],
    ['FLASH1M_V103', 'flash1m'],
  ])('reads %s as %s', (id, type) => {
    expect(busFor(id).save).toEqual({ type, id });
  });

  it('declares nothing when the ROM says nothing, as homebrew does', () => {
    expect(busFor(null).save).toEqual({ type: null, id: null });
  });

  it('wants the three version digits, so a bare prefix is not a declaration', () => {
    expect(busFor('EEPROM_V and then some').save.type).toBeNull();
  });

  it('wants the word alignment a build gives the string', () => {
    const bus = new GbaSystemBus();
    bus.loadRom(romDeclaring('EEPROM_V121', 0x401));
    expect(bus.save.type).toBeNull();
  });

  it('finds a declaration that ends the ROM, where a build often leaves it', () => {
    const id = 'EEPROM_V121';
    const rom = new Uint8Array(0x400 + id.length);
    for (let i = 0; i < id.length; i++) {
      rom[0x400 + i] = id.charCodeAt(i);
    }
    const bus = new GbaSystemBus();
    bus.loadRom(rom);
    expect(bus.save.id).toBe(id);
  });

  it('backs the 0x0E window for every type but EEPROM, which is serial', () => {
    for (const id of ['SRAM_V113', 'SRAM_F_V102', 'FLASH_V126', 'FLASH1M_V103']) {
      const bus = busFor(id);
      bus.poke(0x0e000000, Uint8Array.of(0x5a));
      expect(bus.sram[0], id).toBe(0x5a);
    }
    for (const id of ['EEPROM_V121', null]) {
      const bus = busFor(id);
      bus.poke(0x0e000000, Uint8Array.of(0x5a));
      expect(bus.sram[0], String(id)).toBe(0);
    }
  });
});

describe('a .sav in and out', () => {
  it.each([
    ['EEPROM_V121', 512],
    ['EEPROM_V121', 8192],
    ['SRAM_V113', 32768],
  ])('%s keeps a %i byte file byte for byte', (id, size) => {
    const bus = busFor(id);
    const bytes = pattern(size);
    bus.writeBackup(bytes);
    expect(bus.readBackup()!.subarray(0, size)).toEqual(bytes);
  });

  it('has nothing to read when the ROM declares no save', () => {
    expect(busFor(null).readBackup()).toBeNull();
    expect(() => busFor(null).writeBackup(pattern(512))).toThrow(/declares no save type/);
  });

  it('refuses what the chip cannot hold', () => {
    expect(() => busFor('EEPROM_V121').writeBackup(pattern(32768))).toThrow(/do not fit/);
  });

  it('erases past the end of the file it installs', () => {
    const bus = busFor('EEPROM_V121');
    bus.writeBackup(pattern(512));
    expect(bus.readBackup()!.subarray(512, 520)).toEqual(new Uint8Array(8).fill(0xff));
  });

  it('lets the cartridge say whether the 0x0E window is backed, not a state loaded into it', () => {
    const bus = busFor('SRAM_V113');
    const blank = new GbaSystemBus();
    blank.loadRom(romDeclaring(null));
    // a state taken of a cartridge with no save does not take this one's SRAM away
    bus.deserialize(blank.serialize());
    bus.poke(0x0e000000, Uint8Array.of(0x5a));
    expect(bus.sram[0]).toBe(0x5a);
  });

  it('forgets the save on reset but keeps the cartridge', () => {
    const bus = busFor('EEPROM_V121');
    bus.writeBackup(pattern(512));
    bus.reset();
    expect(bus.save).toEqual({ type: 'eeprom', id: 'EEPROM_V121' });
    expect(bus.readBackup()!.subarray(0, 8)).toEqual(new Uint8Array(8).fill(0xff));
  });
});

describe('the EEPROM serial order', () => {
  it('sends the last byte of the word first, which is where a .sav keeps it', () => {
    const bus = busFor('EEPROM_V121');
    const bytes = pattern(512);
    bus.writeBackup(bytes);
    expect(readWord(bus, 3, 6)).toEqual(bytes.subarray(24, 32).slice().reverse());
  });

  it('puts what a game writes where a .sav would have it', () => {
    const bus = busFor('EEPROM_V121');
    bus.writeBackup(new Uint8Array(512).fill(0xff));
    // the bytes of `K_KLONOA`, as the game hands its struct to the EEPROM library
    const wire = Uint8Array.of(0x41, 0x4f, 0x4e, 0x4f, 0x4c, 0x4b, 0x5f, 0x4b);
    writeWord(bus, 2, 6, wire);
    expect(Buffer.from(bus.readBackup()!.subarray(16, 24)).toString('latin1')).toBe('K_KLONOA');
  });
});

describe('the EEPROM address width', () => {
  it('takes 6 bits from a 4 Kbit file', () => {
    const bus = busFor('EEPROM_V121');
    const bytes = pattern(512);
    bus.writeBackup(bytes);
    expect(bus.eepromAddrBits).toBe(6);
    expect(readWord(bus, 40, 6)).toEqual(bytes.subarray(320, 328).slice().reverse());
  });

  it('takes 14 bits from a 64 Kbit file', () => {
    const bus = busFor('EEPROM_V121');
    const bytes = pattern(8192);
    bus.writeBackup(bytes);
    expect(bus.eepromAddrBits).toBe(14);
    expect(readWord(bus, 1000, 14)).toEqual(bytes.subarray(8000, 8008).slice().reverse());
  });

  it('is why an import says: auto-detection latches 6 bits and never revises', () => {
    const bus = busFor('EEPROM_V121');
    const bytes = pattern(8192);
    bus.writeBackup(bytes);
    bus.reset();
    bus.writeBackup(bytes);
    // undo what `writeBackup` settled, leaving the guess to the first transfer
    const snap = bus.serialize();
    snap.eeprom.addrBits = 0;
    bus.deserialize(snap);
    expect(readWord(bus, 1000, 14)).not.toEqual(bytes.subarray(8000, 8008).slice().reverse());
  });
});
