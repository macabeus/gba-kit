/**
 * The serial port with nothing plugged in: what each register reads in each mode, and Normal-mode
 * transfers on the internal clock completing on their own. The read values are the hardware's, as
 * mgba-suite src/sio-read.c records them; the transfer times follow GBATEK "SIO Normal Mode" and
 * mgba-suite src/sio-timing.c.
 */
import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { EventId, IrqFlag } from '../types.js';

const SIODATA32_L = 0x04000120;
const SIODATA32_H = 0x04000122;
const SIOMULTI2 = 0x04000124;
const SIOCNT = 0x04000128;
const SIODATA8 = 0x0400012a;
const RCNT = 0x04000134;
const JOYCNT = 0x04000140;
const JOY_RECV_L = 0x04000150;
const JOY_TRANS_L = 0x04000154;
const JOYSTAT = 0x04000158;

const START = 1 << 7;
const INTERNAL = 1 << 0;
const FAST = 1 << 1;
const LENGTH_32 = 1 << 12;
const IRQ = 1 << 14;

/** A machine with RCNT and SIOCNT selecting a mode, the way mgba-suite's sio-read sets them up. */
function inMode(siocnt: number, rcnt = 0): Gba {
  const gba = new Gba();
  gba.bus.write16(RCNT, rcnt);
  gba.bus.write16(SIOCNT, siocnt);
  return gba;
}

/** Write `value` to `address` and read it back, as each sio-read test does. */
function writeRead(gba: Gba, address: number, value: number): number {
  gba.bus.write16(address, value);
  return gba.bus.read16(address);
}

describe('register reads with nothing connected', () => {
  it('Normal 8-bit: SIOCNT shows SI high and bits 4-6 and 15 as 0; SIODATA32 takes no write', () => {
    const gba = inMode(0x0000);
    expect(writeRead(gba, SIOCNT, 0xcfff)).toBe(0x4f8f);
    expect(writeRead(gba, SIODATA8, 0xffff)).toBe(0xffff);
    expect(writeRead(gba, SIODATA32_L, 0xffff)).toBe(0);
    expect(writeRead(gba, SIOMULTI2, 0xffff)).toBe(0);
  });

  it('Normal 32-bit: SIODATA32 is read/write', () => {
    const gba = inMode(LENGTH_32);
    expect(writeRead(gba, SIODATA32_L, 0xffff)).toBe(0xffff);
    expect(writeRead(gba, SIODATA32_H, 0xffff)).toBe(0xffff);
    expect(writeRead(gba, SIOCNT, 0xdfff)).toBe(0x5f8f);
  });

  it('RCNT bits 0-3 read the lines: Normal idles SC and SI high, SO follows SIOCNT bit 3', () => {
    const gba = inMode(0x0000);
    expect(writeRead(gba, RCNT, 0x3fff)).toBe(0x01f5);
    gba.bus.write16(SIOCNT, 0x0008);
    expect(gba.bus.read16(RCNT)).toBe(0x01fd);
  });

  it('Multi-Player: SIOCNT reads SI and SD high, ID and error 0, and every line idles high', () => {
    const gba = inMode(0x2000);
    expect(writeRead(gba, SIOCNT, 0xefff)).toBe(0x6f8f);
    expect(writeRead(gba, SIODATA8, 0xffff)).toBe(0xffff); // SIOMLT_SEND
    expect(writeRead(gba, SIODATA32_L, 0xffff)).toBe(0); // SIOMULTI0
    expect(writeRead(gba, RCNT, 0x3fff)).toBe(0x01ff);
  });

  it('UART: the receive FIFO is empty and SIODATA8 reads it', () => {
    const gba = inMode(0x3000);
    expect(writeRead(gba, SIOCNT, 0xffff)).toBe(0x7faf);
    expect(writeRead(gba, SIODATA8, 0xffff)).toBe(0);
    expect(writeRead(gba, RCNT, 0x3fff)).toBe(0x01ff);
  });

  it('General Purpose: RCNT reads the levels it drives, and inputs read their pull-ups', () => {
    const gba = inMode(0x0000, 0x8000);
    expect(writeRead(gba, RCNT, 0xbfff)).toBe(0x81ff);
    expect(writeRead(gba, RCNT, 0x8030)).toBe(0x803c); // SC, SD driven low; SI, SO inputs
    expect(writeRead(gba, SIOCNT, 0xcfff)).toBe(0x4f8f); // laid out by its own bits 12-13
  });

  it('JOY bus: SC and SD are low, SI and SO high', () => {
    const gba = inMode(0x0000, 0xc000);
    expect(writeRead(gba, RCNT, 0xffff)).toBe(0xc1fc);
  });

  it('JOYCNT acknowledges flags with 1s, JOY_RECV takes no write, JOY_TRANS reads 0, unused bits read 0', () => {
    const gba = inMode(0x0000);
    expect(writeRead(gba, JOYCNT, 0xffff)).toBe(0x0040);
    gba.bus.write8(JOYCNT + 1, 0xff); // the other lane acknowledges nothing and keeps the IRQ bit
    expect(gba.bus.read16(JOYCNT)).toBe(0x0040);
    expect(writeRead(gba, JOY_RECV_L, 0xffff)).toBe(0);
    expect(writeRead(gba, JOY_TRANS_L, 0xffff)).toBe(0);
    expect(writeRead(gba, JOYSTAT, 0xffff)).toBe(0x0030);
    expect(gba.bus.read16(0x04000136)).toBe(0);
  });
});

describe('Normal-mode transfers', () => {
  it('8 bits at 256 KHz take 512 cycles, shift in ones from SI and request the serial IRQ', () => {
    const gba = inMode(0x0000);
    gba.bus.write16(SIODATA8, 0xaa55);
    gba.bus.write16(SIOCNT, START | INTERNAL | IRQ);
    gba.scheduler.tick(511);
    expect(gba.bus.read16(SIOCNT) & START).toBe(START);
    expect(gba.interrupts.if_ & IrqFlag.Serial).toBe(0);
    gba.scheduler.tick(1);
    expect(gba.bus.read16(SIOCNT) & START).toBe(0);
    expect(gba.bus.read16(SIODATA8)).toBe(0xaaff);
    expect(gba.interrupts.if_ & IrqFlag.Serial).toBe(IrqFlag.Serial);
  });

  it('32 bits at 2 MHz take 256 cycles and fill SIODATA32', () => {
    const gba = inMode(LENGTH_32);
    gba.bus.write32(SIODATA32_L, 0x12345678);
    gba.bus.write16(SIOCNT, LENGTH_32 | START | INTERNAL | FAST);
    gba.scheduler.tick(255);
    expect(gba.bus.read32(SIODATA32_L)).toBe(0x12345678);
    gba.scheduler.tick(1);
    expect(gba.bus.read32(SIODATA32_L)).toBe(0xffffffff);
    expect(gba.interrupts.if_ & IrqFlag.Serial).toBe(0);
  });

  it('the start bit stays set against writes until the transfer completes', () => {
    const gba = inMode(0x0000);
    gba.bus.write16(SIOCNT, START | INTERNAL | FAST);
    gba.bus.write16(SIOCNT, INTERNAL | FAST);
    expect(gba.bus.read16(SIOCNT) & START).toBe(START);
    gba.scheduler.tick(64);
    expect(gba.bus.read16(SIOCNT) & START).toBe(0);
  });

  it('with the external clock and no partner the transfer waits; clearing the start bit stops it', () => {
    const gba = inMode(0x0000);
    gba.bus.write16(SIOCNT, START);
    gba.scheduler.tick(100_000);
    expect(gba.bus.read16(SIOCNT) & START).toBe(START);
    gba.bus.write16(SIOCNT, 0);
    expect(gba.bus.read16(SIOCNT) & START).toBe(0);
  });

  it('Multi-Player and General Purpose modes start nothing', () => {
    for (const gba of [inMode(0x2000), inMode(0x0000, 0x8000)]) {
      gba.bus.write16(SIOCNT, (gba.bus.read16(SIOCNT) & 0x3000) | START | INTERNAL | IRQ);
      gba.scheduler.tick(100_000);
      expect(gba.scheduler.isScheduled(EventId.Serial)).toBe(false);
      expect(gba.interrupts.if_ & IrqFlag.Serial).toBe(0);
    }
  });

  it('a transfer in progress survives a snapshot and completes at the same cycle', () => {
    const gba = inMode(0x0000);
    gba.bus.write16(SIOCNT, START | INTERNAL | IRQ);
    gba.scheduler.tick(100);
    const snap = gba.serialize();
    expect(snap.scheduler.events[EventId.Serial]!.active).toBe(true);
    gba.scheduler.tick(412);
    const fresh = new Gba();
    fresh.deserialize(snap);
    fresh.scheduler.tick(412);
    expect(fresh.bus.read16(SIOCNT) & START).toBe(0);
    expect(fresh.interrupts.if_ & IrqFlag.Serial).toBe(IrqFlag.Serial);
    expect(fresh.serialize()).toEqual(gba.serialize());

    // A snapshot from before the serial event existed restores with no transfer running.
    const legacy = {
      ...snap,
      scheduler: { ...snap.scheduler, events: snap.scheduler.events.slice(0, EventId.Serial) },
    };
    fresh.deserialize(legacy);
    expect(fresh.scheduler.isScheduled(EventId.Serial)).toBe(false);
  });
});
