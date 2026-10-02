/**
 * The cycle model: wait states from WAITCNT, instruction costs, one clock read mid-run, DMA and
 * interrupt timing, and the PPU drawing a line at HBlank. The expected numbers come from the
 * hardware where a test ROM measured them (mgba-suite src/timing.c, src/timer-irq.c) and from GBATEK.
 */
import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { InterruptController } from '../interrupts.js';
import { Scheduler } from '../scheduler.js';
import { CYCLES_PER_FRAME, EventId, IrqFlag } from '../types.js';

const ROM = 0x08000000;
const EWRAM = 0x02000000;
const IWRAM = 0x03000000;
const WAITCNT = 0x04000204;

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

/** A machine running `words` at `at` in ARM state (Thumb when `thumb`), SYS mode, IRQs enabled. */
function machine(words: number[], at = ROM, thumb = false): Gba {
  const gba = new Gba();
  if (at === ROM) {
    gba.loadRom(romOf(words));
  } else {
    gba.loadRom(romOf([0xeafffffe]));
    words.forEach((w, i) => gba.bus.write32(at + i * 4, w));
  }
  gba.armCpu.cpsr = 0x1f | (thumb ? 0x20 : 0);
  gba.armCpu.registers[13] = 0x03007f00;
  gba.armCpu.registers[15] = at;
  return gba;
}

/** Run until the CPU is about to execute `address`. */
function runTo(gba: Gba, address: number): void {
  expect(gba.runFrame(() => gba.armCpu.registers[15] === address)).toBe('stopped');
}

describe('wait states', () => {
  it('WAITCNT sets the game pak’s, memory control sets EWRAM’s, and 32-bit accesses to 16-bit buses count twice', () => {
    const bus = new Gba().bus;
    // GBATEK "Waitstate Control": WAITCNT=0 gives WS0 4/2, WS1 4/4, WS2 4/8 waits and SRAM 4.
    expect([bus.accessCycles(ROM, 2, false), bus.accessCycles(ROM, 2, true)]).toEqual([5, 3]);
    expect([bus.accessCycles(0x0a000000, 2, true), bus.accessCycles(0x0c000000, 2, true)]).toEqual([5, 9]);
    expect([bus.accessCycles(ROM, 4, false), bus.accessCycles(ROM, 4, true)]).toEqual([8, 6]);
    expect(bus.accessCycles(0x0e000000, 1, false)).toBe(5);
    // GBATEK "Memory Control": the BIOS's 0x0D gives EWRAM 2 waits, 3/3/6 cycles for 8/16/32 bits.
    expect([
      bus.accessCycles(EWRAM, 1, false),
      bus.accessCycles(EWRAM, 2, true),
      bus.accessCycles(EWRAM, 4, false),
    ]).toEqual([3, 3, 6]);
    expect([
      bus.accessCycles(IWRAM, 4, false),
      bus.accessCycles(0x05000000, 4, false),
      bus.accessCycles(0x07000000, 4, false),
    ]).toEqual([1, 2, 1]);

    bus.write16(WAITCNT, 0x4317); // SRAM 8, WS0 3/1, WS1 4/4, WS2 8/8 (GBATEK: what cartridges use)
    expect([bus.accessCycles(ROM, 2, false), bus.accessCycles(ROM, 2, true), bus.accessCycles(ROM, 4, false)]).toEqual([
      4, 2, 6,
    ]);
    expect(bus.accessCycles(0x0e000000, 1, false)).toBe(9);
    bus.write8(0x04000803, 0x0e); // memory control: EWRAM 1 wait
    expect([bus.accessCycles(EWRAM, 2, false), bus.accessCycles(EWRAM, 4, false)]).toEqual([2, 4]);
  });

  // mgba-suite Timing, measured on hardware: for each WAITCNT setting (no prefetch, prefetch, WS0
  // first access 3, both, WS0 second access 1, ...), then EWRAM and IWRAM.
  const SETTINGS = [0x0000, 0x4000, 0x0004, 0x4004, 0x0010, 0x4010, 0x0014, 0x4014];
  const cases: Array<[string, number, boolean, number[], number, number]> = [
    ['ARM nop', 0xe1a00000 /* mov r0, r0 */, false, [6, 6, 6, 6, 4, 4, 4, 4], 6, 1],
    ['ARM ldrh r2, [sp]', 0xe1dd20b0, false, [10, 6, 9, 6, 9, 4, 8, 4], 8, 3],
    ['Thumb nop', 0x46c046c0 /* mov r8, r8 */, true, [3, 3, 3, 3, 2, 2, 2, 2], 3, 1],
  ];
  for (const [name, word, thumb, rom, ewram, iwram] of cases) {
    it(`${name} costs what the hardware takes from ROM under each WAITCNT, from EWRAM and from IWRAM`, () => {
      const cost = (at: number, waitcnt: number): number => {
        const gba = machine([word, word], at, thumb);
        gba.bus.write16(WAITCNT, waitcnt);
        return gba.armCpu.step();
      };
      expect(SETTINGS.map((w) => cost(ROM, w))).toEqual(rom);
      expect(cost(EWRAM, 0)).toBe(ewram);
      expect(cost(IWRAM, 0)).toBe(iwram);
    });
  }

  it('the prefetch buffer refills after a branch empties it', () => {
    const bus = new Gba().bus;
    bus.write16(WAITCNT, 0x4000);
    // A long stall fills all 8 halfwords; right after it, the buffer has room for one more.
    const stall = (): number => bus.stallCycles(20, ROM + 8, IWRAM);
    const first = stall();
    expect(stall()).toBeGreaterThan(first);
    bus.fetchCycles(ROM + 0x100, 4, false); // a branch
    expect(stall()).toBe(first);
    // Code outside the game pak, or data inside it, leaves the buffer out of it.
    expect(bus.stallCycles(4, IWRAM + 8, IWRAM)).toBe(4);
    expect(bus.stallCycles(4, ROM + 8, ROM + 0x200)).toBe(4);
  });
});

describe('one clock for the whole machine', () => {
  // str r1, [r0] starts TM0 at prescaler 1; four nops; ldrh r3, [r0] reads it.
  const TIMER = [
    0xe3a00301, // mov r0, #0x04000000
    0xe2800c01, // add r0, r0, #0x100
    0xe3a01502, // mov r1, #0x800000
    0xe5801000, // str r1, [r0]
    0xe1a02002, // mov r2, r2
    0xe1a02002, // mov r2, r2
    0xe1a02002, // mov r2, r2
    0xe1a02002, // mov r2, r2
    0xe1d030b0, // ldrh r3, [r0]
    0xeafffffe, // b .
  ];

  it('a timer read mid-run counts the cycles of the instructions since the start', () => {
    // mgba-suite Timing: the start and the read alone read 0 in IWRAM, an IWRAM nop is 1 cycle.
    const iwram = machine(TIMER, IWRAM);
    runTo(iwram, IWRAM + 9 * 4);
    expect(iwram.armCpu.registers[3]).toBe(4);
    // From ROM at WAITCNT=0 the start and the read alone read 7, and each nop is 6 cycles.
    const rom = machine(TIMER);
    runTo(rom, ROM + 9 * 4);
    expect(rom.armCpu.registers[3]).toBe(7 + 4 * 6);
  });

  it('events fire earliest first, each with the cycle it was due at', () => {
    const scheduler = new Scheduler();
    const fired: string[] = [];
    scheduler.schedule(EventId.HBlank, 20, (due) => fired.push(`hblank@${due}`));
    scheduler.schedule(EventId.Dma3, 10, (due) => {
      fired.push(`dma@${due}`);
      scheduler.scheduleAt(EventId.Dma3, due + 5, (again) => fired.push(`dma@${again}`));
    });
    scheduler.tick(25);
    expect(fired).toEqual(['dma@10', 'dma@15', 'hblank@20']);
    expect(scheduler.currentCycle).toBe(25);
  });

  it('a BIOS call longer than a frame still ends one frame per runFrame', () => {
    // CpuSet copying 0x10000 halfwords in EWRAM: about 13 cycles each, three frames' worth.
    const gba = machine([0xe3a00402, 0xe3a01402, 0xe3a02801, 0xef0b0000, 0xeafffffe]);
    for (let frame = 1; frame <= 3; frame++) {
      expect(gba.runFrame()).toBe('done');
      expect(gba.frameCount).toBe(frame);
      expect(gba.scanline).toBe(0);
    }
    expect(gba.scheduler.currentCycle).toBeGreaterThan(3 * CYCLES_PER_FRAME);
  });
});

describe('DMA and interrupt timing', () => {
  it('a DMA starts 3 cycles after it is enabled and holds the bus for its accesses', () => {
    const gba = new Gba();
    for (let i = 0; i < 16; i++) {
      gba.bus.write16(IWRAM + i * 2, 0x100 + i);
    }
    gba.bus.write32(0x040000d4, IWRAM); // DMA3SAD
    gba.bus.write32(0x040000d8, IWRAM + 0x100); // DMA3DAD
    gba.bus.write16(0x040000dc, 16);
    const start = gba.scheduler.currentCycle;
    gba.bus.write16(0x040000de, 0x8000); // enable, immediate, 16-bit
    gba.scheduler.tick(2);
    expect(gba.bus.read16(IWRAM + 0x100)).toBe(0);
    gba.scheduler.tick(1);
    expect(gba.bus.read16(IWRAM + 0x11e)).toBe(0x10f);
    // 16 reads and writes of a zero-wait memory, and the 2 internal cycles that end the transfer.
    expect(gba.scheduler.currentCycle - start).toBe(3 + 16 * 2 + 2);
  });

  it('an interrupt request reaches the CPU 7 cycles after it is raised', () => {
    const scheduler = new Scheduler();
    const irq = new InterruptController(scheduler);
    irq.ie = IrqFlag.Timer0;
    irq.ime = 1;
    irq.halted = true;
    scheduler.tick(100);
    irq.requestInterrupt(IrqFlag.Timer0, 100);
    scheduler.tick(6);
    expect(irq.irqPending()).toBe(false);
    expect(irq.halted).toBe(true);
    scheduler.tick(1);
    expect(irq.irqPending()).toBe(true);
    expect(irq.halted).toBe(false);
  });

  it('the PPU draws a line at HBlank: a V-count IRQ handler’s palette write shows on its own line', () => {
    const HANDLER = [
      0xe3a00405, // mov r0, #0x05000000
      0xe3a0101f, // mov r1, #0x1f
      0xe1c010b0, // strh r1, [r0]       backdrop red
      0xe3a00301, // mov r0, #0x04000000
      0xe2800c02, // add r0, r0, #0x200
      0xe3a01004, // mov r1, #4
      0xe1c010b2, // strh r1, [r0, #2]   acknowledge the V-count IRQ
      0xe12fff1e, // bx lr
    ];
    const gba = machine([
      0xe3a00301, // mov r0, #0x04000000
      0xe3a01000, // mov r1, #0
      0xe1c010b0, // strh r1, [r0]       DISPCNT: mode 0, nothing on, the backdrop shows
      0xe59f1018, // ldr r1, =0x5020
      0xe1c010b4, // strh r1, [r0, #4]   DISPSTAT: LYC 80, V-count IRQ
      0xe2802c02, // add r2, r0, #0x200
      0xe3a01004, // mov r1, #4
      0xe1c210b0, // strh r1, [r2]       IE: V-count
      0xe3a01001, // mov r1, #1
      0xe1c210b8, // strh r1, [r2, #8]   IME
      0xeafffffe, // b .
      0x00005020,
    ]);
    HANDLER.forEach((w, i) => gba.bus.write32(IWRAM + i * 4, w));
    gba.bus.write32(0x03007ffc, IWRAM);
    gba.runFrame();
    const pixel = (line: number): number => gba.ppu.getFramebuffer()[line * 240]!;
    expect(pixel(80)).not.toBe(pixel(79));
    expect(pixel(80)).toBe(pixel(159));
  });
});
