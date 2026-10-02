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

  it("the PPU's line-start state survives a restore: the OBJ line prepared ahead, latches, window flip-flops", () => {
    /** BG0 and a sprite on screen, WIN1 held open across frames, BG2's point stepping in mode 1. */
    const scene = (): Gba => {
      const gba = boot(TIMER_SPIN);
      const io = (offset: number, value: number) => gba.bus.write16(0x04000000 + offset, value);
      gba.bus.write16(0x05000002, 0x001f); // BG colour 1
      gba.bus.write16(0x05000202, 0x03e0); // OBJ colour 1
      for (let i = 0; i < 0x800; i += 2) {
        gba.bus.write16(0x06000000 + i, 0x1111); // BG tiles
        gba.bus.write16(0x06010000 + i, 0x1111); // OBJ tiles
      }
      gba.bus.write16(0x07000000, 0); // OAM 0: 64x64 at (0, 0)
      gba.bus.write16(0x07000002, 3 << 14);
      io(0x08, 31 << 8); // BG0: map at 0xF800 (all tile 0)
      io(0x46, 0x50e4); // WIN1 from line 80, never closed
      io(0x42, 0x00f0);
      io(0x48, 0x1100); // WIN1: BG0 + OBJ
      io(0x00, 1 | (1 << 6) | (1 << 8) | (1 << 12) | (1 << 14));
      gba.runFrame();
      gba.runFrame();
      while (gba.scanline !== 20) {
        gba.runScanline();
      }
      return gba;
    };
    const moveSprite = (gba: Gba) => gba.bus.write16(0x07000002, (3 << 14) | 100);

    const original = scene();
    const snap = original.serialize();
    moveSprite(original);
    original.runFrame();
    original.runFrame();

    const restored = boot(TIMER_SPIN);
    restored.deserialize(snap);
    expect(restored.serialize()).toEqual(snap);
    moveSprite(restored);
    restored.runFrame();
    restored.runFrame();
    expect(restored.serialize()).toEqual(original.serialize());
  });

  it('an older PPU snapshot without the line-start state loads, with the layers DISPCNT enables showing', () => {
    const gba = boot(TIMER_SPIN);
    gba.bus.write16(0x05000002, 0x001f);
    for (let i = 0; i < 0x20; i += 2) {
      gba.bus.write16(0x06000000 + i, 0x1111);
    }
    gba.bus.write16(0x04000008, 31 << 8);
    gba.bus.write16(0x04000000, 1 << 8);
    gba.runFrame();
    gba.runFrame();
    const snap = gba.serialize();
    // The shape snapshots had before: latch flags, no line-start state
    const ppu = { ...snap.ppu };
    delete ppu.refWritten;
    delete ppu.dispcntLatch;
    delete ppu.windowFlags;
    delete ppu.bgMosaicY;
    delete ppu.objMosaicY;
    delete ppu.objLines;
    delete ppu.objLineNumbers;
    const legacy = { ...snap, ppu: { ...ppu, bg2RefLatched: true, bg3RefLatched: true } };

    const fresh = boot(TIMER_SPIN);
    fresh.deserialize(legacy);
    expect(fresh.serialize().ppu.dispcntLatch).toEqual([1 << 8, 1 << 8, 1 << 8]);
    fresh.runFrame();
    expect(fresh.ppu.getFramebuffer()[0]).toBe(0xff0000f8);
  });

  it("the APU's wave RAM banks, force-75% bit and FIFO latch survive a restore", () => {
    /** Channel 3 playing bank 0 at forced 75% in dimension mode, bank 1 filled, FIFO A half-written. */
    const scene = (): Gba => {
      const gba = boot(TIMER_SPIN);
      const io8 = (offset: number, value: number) => gba.bus.write8(0x04000000 + offset, value);
      io8(0x84, 0x80);
      io8(0x81, 0x44); // channel 3 left + right
      io8(0x80, 0x77);
      io8(0x82, 0x02);
      io8(0x70, 0x40); // the CPU fills bank 0
      for (let i = 0; i < 16; i++) {
        io8(0x90 + i, 0x9f);
      }
      io8(0x70, 0x00); // ...then bank 1
      for (let i = 0; i < 16; i++) {
        io8(0x90 + i, 0x31);
      }
      io8(0x70, 0xa0); // play both banks
      io8(0x73, 0x80); // force 75%
      io8(0x75, 0x87); // restart at the top sample rate
      gba.bus.write16(0x040000a2, 0x4433);
      gba.runFrame();
      return gba;
    };

    const original = scene();
    const snap = original.serialize();
    expect(snap.apu!.ch3.waveRam.length).toBe(32);
    expect(snap.apu!.ch3.forceVolume).toBe(true);
    expect(snap.apu!.dsA.latch).toBe(0x44330000);
    original.bus.write16(0x040000a0, 0x2211);
    original.runFrame();

    const restored = boot(TIMER_SPIN);
    restored.deserialize(snap);
    expect(restored.serialize()).toEqual(snap);
    restored.bus.write16(0x040000a0, 0x2211);
    restored.runFrame();
    expect(restored.serialize()).toEqual(original.serialize());
  });

  it('an older APU snapshot with one wave RAM bank, no force-75% bit and no FIFO latch loads', () => {
    const gba = boot(TIMER_SPIN);
    gba.runFrame();
    const snap = gba.serialize();
    const ch3 = { ...snap.apu!.ch3, waveRam: new Uint8Array(16).fill(0x5a) };
    delete ch3.forceVolume;
    const dsA = { ...snap.apu!.dsA };
    delete dsA.latch;
    const legacy = { ...snap, apu: { ...snap.apu!, ch3, dsA } };

    const fresh = boot(TIMER_SPIN);
    fresh.deserialize(legacy);
    const apu = fresh.serialize().apu!;
    // the single bank served playback and the CPU alike, so both banks take it
    expect(Array.from(apu.ch3.waveRam)).toEqual(new Array(32).fill(0x5a));
    expect(apu.ch3.forceVolume).toBe(false);
    expect(apu.dsA.latch).toBe(0);
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
