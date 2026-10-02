import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { CYCLES_PER_FRAME, CYCLES_PER_SCANLINE, EventId, HDRAW_CYCLES } from '../types.js';

/** ARM: `add r0, r0, #1` then `b` back to it — a loop that counts its iterations in r0. */
const COUNT_LOOP = [0xe2800001, 0xeafffffd];
/**
 * What the loop costs from ROM at WAITCNT=0 (GBATEK "Waitstate Control": 4 waits for an N access
 * and 2 for an S access of WS0's 16-bit bus, so an ARM opcode is 8 cycles nonsequential, 6
 * sequential). The `add` is its S fetch, the `b` its S fetch and a refill of 1N+1S.
 */
const ADD_CYCLES = 6;
const LOOP_CYCLES = ADD_CYCLES + 6 + 8 + 6;
/** The longest instruction the loop has: an event comes due during it at worst. */
const LONGEST_INSTRUCTION = 20;
/** ARM: `swi 0x05` (VBlankIntrWait) then `b .` */
const VBLANK_WAIT = [0xef050000, 0xeafffffe];

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
  gba.armCpu.cpsr = 0x1f; // SYS mode, IRQs enabled, ARM state
  gba.armCpu.registers[15] = 0x08000000;
  return gba;
}

describe('Gba run loop: debugger stops', () => {
  it('a predicate stop charges nothing: the instruction at PC has not run', () => {
    const gba = boot(COUNT_LOOP);
    const before = gba.serialize();
    expect(gba.runFrame(() => true)).toBe('stopped');
    expect(gba.serialize()).toEqual(before);
  });

  it('stops before the first instruction that satisfies the predicate', () => {
    const gba = boot(COUNT_LOOP);
    expect(gba.runFrame(() => gba.armCpu.registers[0] === 1)).toBe('stopped');
    expect(gba.armCpu.registers[0]).toBe(1);
    expect(gba.armCpu.registers[15]).toBe(0x08000004);
    expect(gba.scheduler.currentCycle).toBe(ADD_CYCLES);
  });

  it('a CPU debug hook that refuses an instruction charges no cycle either', () => {
    const gba = boot(COUNT_LOOP);
    gba.armCpu.setDebugHooks({ onInstructionPre: (address) => (address === 0x08000004 ? 'break' : 'continue') });
    expect(gba.runFrame()).toBe('stopped');
    expect(gba.armCpu.registers[15]).toBe(0x08000004);
    expect(gba.armCpu.registers[0]).toBe(1);
    expect(gba.scheduler.currentCycle).toBe(ADD_CYCLES);
  });

  it('can stop a halted CPU without advancing to the next event', () => {
    const gba = boot(COUNT_LOOP);
    gba.interrupts.halted = true;
    const cycle = gba.scheduler.currentCycle;
    expect(gba.runFrame(() => true)).toBe('stopped');
    expect(gba.scheduler.currentCycle).toBe(cycle);
  });

  /** The cycle the next line's HBlank is due at: the scanline grid, wherever the clock stands. */
  function nextHBlank(gba: Gba): number {
    return gba.scheduler.currentCycle + gba.scheduler.cyclesUntilEvent(EventId.HBlank);
  }

  it('frames stay on the hardware grid across a mid-frame stop', () => {
    const gba = boot(COUNT_LOOP);
    expect(gba.runFrame(() => gba.armCpu.registers[0] === 5000)).toBe('stopped');
    expect(gba.frameCount).toBe(0);
    expect(gba.runFrame()).toBe('done'); // finishes the SAME frame
    expect(gba.frameCount).toBe(1);
    expect(gba.scanline).toBe(0);
    // The frame ends with the instruction during which its last cycle passed.
    expect(gba.scheduler.currentCycle - CYCLES_PER_FRAME).toBeGreaterThanOrEqual(0);
    expect(gba.scheduler.currentCycle - CYCLES_PER_FRAME).toBeLessThan(LONGEST_INSTRUCTION);
    expect(nextHBlank(gba)).toBe(CYCLES_PER_FRAME + HDRAW_CYCLES);
    expect(gba.runFrame()).toBe('done');
    expect(nextHBlank(gba)).toBe(2 * CYCLES_PER_FRAME + HDRAW_CYCLES);
  });

  it('a frame runs the loop at its ARM7TDMI cost from ROM', () => {
    const gba = boot(COUNT_LOOP);
    gba.runFrame();
    // Every iteration that begins before the frame's last cycle runs.
    expect(gba.armCpu.registers[0]).toBe(Math.ceil(CYCLES_PER_FRAME / LOOP_CYCLES));
  });

  it('runScanline advances exactly one scanline', () => {
    const gba = boot(COUNT_LOOP);
    expect(gba.runScanline()).toBe('done');
    expect(gba.scanline).toBe(1);
    expect(nextHBlank(gba)).toBe(CYCLES_PER_SCANLINE + HDRAW_CYCLES);
    for (let i = 0; i < 227; i++) {
      gba.runScanline();
    }
    expect(gba.scanline).toBe(0);
    expect(gba.frameCount).toBe(1);
  });

  it('a halted game still completes frames: the scanline chain wakes the loop', () => {
    const gba = boot(VBLANK_WAIT);
    expect(gba.runFrame()).toBe('done');
    expect(gba.interrupts.halted).toBe(true);
    expect(gba.frameCount).toBe(1);
  });
});

describe('Gba HLE BIOS state is per instance', () => {
  it('IntrWait on one machine does not touch another', () => {
    const a = boot(VBLANK_WAIT);
    const b = boot(COUNT_LOOP);
    a.runFrame();
    expect(a.interrupts.intrWaitFlags).toBe(1);
    expect(b.interrupts.intrWaitFlags).toBe(0);
    b.runFrame();
    expect(b.interrupts.intrWaitFlags).toBe(0);
  });
});

describe('Gba.onHardwareEvent', () => {
  it('reports I/O writes, VBlank, HBlank and interrupt requests in order, and nothing once detached', () => {
    // mov r0,#0x04000000 ; mov r1,#8 ; strh r1,[r0,#4] (DISPSTAT: VBlank IRQ enable) ; b .
    const gba = boot([0xe3a00301, 0xe3a01008, 0xe1c010b4, 0xeafffffe]);
    const events: string[] = [];
    gba.onHardwareEvent = (e) =>
      events.push(
        e.kind === 'mmio-write'
          ? `mmio:${e.address.toString(16)}=${e.value}`
          : e.kind === 'irq-request'
            ? `irq:${e.flag}`
            : e.kind,
      );
    gba.runFrame();
    expect(events[0]).toBe('mmio:4000004=8');
    expect(events.filter((e) => e === 'hblank').length).toBe(228);
    expect(events.indexOf('vblank')).toBeGreaterThan(0);
    expect(events[events.indexOf('vblank') + 1]).toBe('irq:1');
    gba.onHardwareEvent = null;
    const before = events.length;
    gba.runFrame();
    expect(events.length).toBe(before);
  });
});
