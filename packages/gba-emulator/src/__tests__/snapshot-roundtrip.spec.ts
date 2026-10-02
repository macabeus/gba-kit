import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { GbaButton } from '../types.js';

/**
 * ARM: start timer 0 (prescaler F/1, no IRQ) and spin. The timer overflows about
 * four times per frame, so a restore that re-derived its overflow event from the
 * counter would drift within a frame.
 *
 *   mov  r0, #0x04000000
 *   add  r0, r0, #0x100     ; ARM halfword offsets are 8-bit, so TM0CNT_H needs a nearer base
 *   mov  r1, #0x80
 *   strh r1, [r0, #0x2]     ; TM0CNT_H = enable
 *   b    .
 */
const TIMER_SPIN = [0xe3a00301, 0xe2800c01, 0xe3a01080, 0xe1c010b2, 0xeafffffe];

function romOf(words: number[]): Uint8Array {
  const rom = new Uint8Array(words.length * 4);
  words.forEach((w, i) => {
    rom[i * 4] = w & 0xff;
    rom[i * 4 + 1] = (w >>> 8) & 0xff;
    rom[i * 4 + 2] = (w >>> 16) & 0xff;
    rom[i * 4 + 3] = w >>> 24;
  });
  return rom;
}

function boot(words: number[]): Gba {
  const gba = new Gba();
  gba.loadRom(romOf(words));
  gba.armCpu.cpsr = 0x1f;
  gba.armCpu.registers[15] = 0x08000000;
  return gba;
}

describe('snapshot round trip', () => {
  it('the spin program leaves timer 0 running and overflowing several times a frame', () => {
    const gba = boot(TIMER_SPIN);
    let overflows = 0;
    // Stands in for the APU's DirectSound hook, which this ROM never feeds.
    gba.timers.setOverflowCallback(0, () => overflows++);
    gba.runFrame();
    const channel = gba.serialize().timers.channels[0]!;
    expect(channel.enabled).toBe(true);
    expect(channel.prescaler).toBe(0);
    // a frame is 280896 cycles and the counter is 16-bit, so it wraps 4 times and stops
    // partway through the fifth
    expect(overflows).toBeGreaterThanOrEqual(4);
    expect(gba.timers.readCounter(0)).toBeGreaterThan(0);
  });

  it('serialize → deserialize → serialize is the identity', () => {
    const gba = boot(TIMER_SPIN);
    for (let i = 0; i < 3; i++) {
      gba.runFrame();
    }
    const a = gba.serialize();
    gba.deserialize(a);
    expect(gba.serialize()).toEqual(a);
  });

  it('running from a restored snapshot reproduces the original run, timers included', () => {
    const gba = boot(TIMER_SPIN);
    for (let i = 0; i < 3; i++) {
      gba.runFrame();
    }
    const a = gba.serialize();
    for (let i = 0; i < 4; i++) {
      gba.runFrame();
    }
    const original = gba.serialize();

    gba.deserialize(a);
    for (let i = 0; i < 4; i++) {
      gba.runFrame();
    }
    expect(gba.serialize()).toEqual(original);
    expect(gba.frameCount).toBe(7);
  });

  it('a restored snapshot into a fresh machine behaves the same', () => {
    const a = boot(TIMER_SPIN);
    for (let i = 0; i < 2; i++) {
      a.runFrame();
    }
    const snap = a.serialize();
    for (let i = 0; i < 3; i++) {
      a.runFrame();
    }
    const b = boot(TIMER_SPIN);
    b.deserialize(snap);
    for (let i = 0; i < 3; i++) {
      b.runFrame();
    }
    expect(b.serialize()).toEqual(a.serialize());
  });

  it('held buttons survive a restore', () => {
    const gba = boot(TIMER_SPIN);
    gba.pressButton(GbaButton.A);
    gba.pressButton(GbaButton.Right);
    const snap = gba.serialize();
    gba.releaseButton(GbaButton.A);
    gba.releaseButton(GbaButton.Right);
    expect(gba.input.readKeyInput()).toBe(0x3ff);
    gba.deserialize(snap);
    expect(gba.input.readKeyInput()).toBe(0x3ff & ~((1 << GbaButton.A) | (1 << GbaButton.Right)));
  });

  it('an old snapshot carrying an extra cpu field still loads', () => {
    const gba = boot(TIMER_SPIN);
    gba.runFrame();
    const snap = gba.serialize();
    const legacy = { ...snap, cpu: { ...snap.cpu, haltedBySWI: true } };
    const fresh = boot(TIMER_SPIN); // a machine the snapshot has to move, not one already there
    fresh.deserialize(legacy);
    expect(fresh.armCpu.halted).toBe(false);
    expect(fresh.serialize()).toEqual(snap);
  });

  it("the CPU's prefetch pipeline is restored; an old snapshot without it refills from memory", () => {
    const gba = boot(TIMER_SPIN);
    gba.runFrame();
    const snap = gba.serialize();
    // Spinning on `b .`: the decoded opcode is the branch itself, at its own address.
    expect(snap.cpu.pipeline![0]).toBe(0x08000010);
    expect(snap.cpu.pipeline![1]).toBe(TIMER_SPIN[4]! >>> 0);
    gba.runFrame();
    const original = gba.serialize();

    const legacy = { ...snap, cpu: { ...snap.cpu } };
    delete legacy.cpu.pipeline;
    const fresh = boot(TIMER_SPIN);
    fresh.deserialize(legacy);
    fresh.runFrame();
    // The ROM is the memory the pipeline would refill from, so the two runs meet again.
    expect(fresh.serialize()).toEqual(original);
  });

  it('memory control, DMA3’s Game Pak DRQ bit and the BIOS latch are restored; old snapshots take the BIOS’s values', () => {
    const gba = boot(TIMER_SPIN);
    gba.bus.write32(0x04000800, 0x0e000020);
    gba.bus.write16(0x040000de, 0x0800);
    gba.bus.latchBiosOpcode(0xe3a02004);
    gba.runFrame();
    const snap = gba.serialize();
    expect(snap.bus.memoryControl).toBe(0x0e000020);
    expect(snap.dma.channels[3]!.gamePakDrq).toBe(true);
    expect(snap.bus.lastBiosRead).toBe(0xe3a02004);

    const fresh = boot(TIMER_SPIN);
    fresh.deserialize(snap);
    expect(fresh.serialize()).toEqual(snap);
    expect(fresh.bus.read32(0)).toBe(0xe3a02004);

    const legacy = { ...snap, bus: { ...snap.bus }, dma: { channels: snap.dma.channels.map((c) => ({ ...c })) } };
    delete legacy.bus.memoryControl;
    delete legacy.dma.channels[3]!.gamePakDrq;
    fresh.deserialize(legacy);
    expect(fresh.bus.read32(0x04000800)).toBe(0x0d000020);
    expect(fresh.bus.read16(0x040000de) & 0x0800).toBe(0);
  });

  it('the game pak prefetch buffer is restored; an old snapshot without it restores it empty', () => {
    // ldr r2, [sp] ; b .-4 from ROM with the prefetch buffer on: every load lets it fetch ahead.
    const program = [0xe59d2000, 0xeafffffd];
    const start = (): Gba => {
      const gba = boot(program);
      gba.armCpu.registers[13] = 0x03007f00;
      gba.bus.write16(0x04000204, 0x4317);
      return gba;
    };
    const gba = start();
    gba.runFrame();
    expect(gba.runFrame(() => gba.armCpu.registers[15] === 0x08000004)).toBe('stopped'); // after a load
    const snap = gba.serialize();
    expect(snap.bus.prefetchEnd).toBeGreaterThan(0x08000000);

    const fresh = start();
    fresh.deserialize(snap);
    expect(fresh.serialize()).toEqual(snap);
    gba.runFrame();
    fresh.runFrame();
    expect(fresh.serialize()).toEqual(gba.serialize());

    const legacy = { ...snap, bus: { ...snap.bus } };
    delete legacy.bus.prefetchEnd;
    const old = start();
    old.deserialize(legacy);
    expect(old.serialize().bus.prefetchEnd).toBe(0);
    expect(old.runFrame()).toBe('done');
  });

  it('frameCount is restored, and an old snapshot without it reads as 0', () => {
    const gba = boot(TIMER_SPIN);
    gba.runFrame();
    gba.runFrame();
    const snap = gba.serialize();
    expect(snap.frameCount).toBe(2);
    const legacy = { ...snap };
    delete legacy.frameCount;
    gba.deserialize(legacy);
    expect(gba.frameCount).toBe(0);
    gba.deserialize(snap);
    expect(gba.frameCount).toBe(2);
  });
});
