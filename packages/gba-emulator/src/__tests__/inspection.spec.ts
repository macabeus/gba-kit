import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { GbaSystemBus } from '../system-bus.js';

describe('GbaSystemBus.peek', () => {
  it('reads RAM through its mirrors and reports how much was mapped', () => {
    const bus = new GbaSystemBus();
    bus.write8(0x03000010, 0xab);
    bus.write16(0x02000000, 0x1234);
    expect(bus.peek(0x03000010, 1)).toEqual({ data: new Uint8Array([0xab]), readable: 1 });
    expect(bus.peek(0x02040000, 2)).toEqual({ data: new Uint8Array([0x34, 0x12]), readable: 2 }); // EWRAM mirror
    // two bytes at the top of OAM's mirror space, then the ROM window with nothing loaded
    const edge = bus.peek(0x07fffffe, 4);
    expect(edge.readable).toBe(2);
    expect(Array.from(edge.data.subarray(2))).toEqual([0, 0]);
  });

  it('decodes MMIO like a CPU read would', () => {
    const gba = new Gba();
    gba.pressButton(0); // A
    const key = gba.bus.peek(0x04000130, 2);
    expect(key.readable).toBe(2);
    expect(key.data[0]! | (key.data[1]! << 8)).toBe(0x3fe);
    expect(gba.bus.peek(0x04000400, 1).readable).toBe(0);
  });

  it('refuses the EEPROM window and leaves its protocol state alone', () => {
    const bus = new GbaSystemBus();
    const before = bus.serialize().eeprom;
    expect(bus.peek(0x0d000000, 4).readable).toBe(0);
    expect(bus.serialize().eeprom).toEqual(before);
  });

  it('reads the ROM up to its real length and no further', () => {
    const bus = new GbaSystemBus();
    bus.loadRom(new Uint8Array([1, 2, 3, 4]));
    expect(bus.peek(0x08000002, 4)).toEqual({ data: new Uint8Array([3, 4, 0, 0]), readable: 2 });
    expect(bus.peek(0x0a000000, 2).readable).toBe(2); // wait-state mirror of the cartridge
  });
});

describe('GbaSystemBus.poke', () => {
  it('stores single bytes where the hardware would drop or duplicate them', () => {
    const bus = new GbaSystemBus();
    expect(bus.poke(0x07000001, new Uint8Array([0x5a]))).toBe(1); // a bus write8 to OAM is ignored
    expect(bus.oam[1]).toBe(0x5a);
    expect(bus.poke(0x06000000, new Uint8Array([0x11]))).toBe(1); // a bus write8 to VRAM duplicates
    expect(bus.vram[0]).toBe(0x11);
    expect(bus.vram[1]).toBe(0);
  });

  it('refuses ROM and BIOS, and stops at the first refused byte', () => {
    const bus = new GbaSystemBus();
    bus.loadRom(new Uint8Array(16));
    expect(bus.poke(0x08000000, new Uint8Array([1]))).toBe(0);
    expect(bus.poke(0x00000000, new Uint8Array([1]))).toBe(0);
    // two bytes at the top of OAM's mirror space, then the ROM (refused)
    expect(bus.poke(0x07fffffe, new Uint8Array([1, 2, 3, 4]))).toBe(2);
    expect(bus.oam[0x3fe]).toBe(1);
    expect(bus.oam[0x3ff]).toBe(2);
  });

  it('writes MMIO through the bus so the register takes effect', () => {
    const bus = new GbaSystemBus();
    expect(bus.poke(0x04000000, new Uint8Array([0x03, 0x04]))).toBe(2); // DISPCNT = mode 3, BG2 on
    expect(bus.read16(0x04000000)).toBe(0x0403);
  });

  it('does not notify data watchpoints', () => {
    const bus = new GbaSystemBus();
    let hits = 0;
    bus.addWriteWatchpoint(0x03000000, 4, () => hits++);
    bus.poke(0x03000000, new Uint8Array([1, 2, 3, 4]));
    expect(hits).toBe(0);
    bus.write8(0x03000000, 9);
    expect(hits).toBe(1);
  });
});
