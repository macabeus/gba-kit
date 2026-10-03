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
    expect([bus.accessCycles(ROM, 2, false), bus.accessCycles(ROM + 2, 2, true)]).toEqual([5, 3]);
    expect([bus.accessCycles(0x0a000002, 2, true), bus.accessCycles(0x0c000002, 2, true)]).toEqual([5, 9]);
    expect([bus.accessCycles(ROM, 4, false), bus.accessCycles(ROM + 4, 4, true)]).toEqual([8, 6]);
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
    expect([
      bus.accessCycles(ROM, 2, false),
      bus.accessCycles(ROM + 2, 2, true),
      bus.accessCycles(ROM, 4, false),
    ]).toEqual([4, 2, 6]);
    expect(bus.accessCycles(0x0e000000, 1, false)).toBe(9);
    bus.write8(0x04000803, 0x0e); // memory control: EWRAM 1 wait
    expect([bus.accessCycles(EWRAM, 2, false), bus.accessCycles(EWRAM, 4, false)]).toEqual([2, 4]);
  });

  it('an access at the start of a 128 KB block of the game pak is nonsequential', () => {
    // GBATEK "GBA System Control": "LDMIA [801fff8h],r0-r7" has non-sequential timing at 8020000h.
    const bus = new Gba().bus;
    expect([bus.accessCycles(ROM + 0x1fffe, 2, true), bus.accessCycles(ROM + 0x20000, 2, true)]).toEqual([3, 5]);
    expect([bus.accessCycles(0x0a040000, 4, true), bus.accessCycles(0x0c000000, 1, true)]).toEqual([10, 5]);
    expect(bus.accessCycles(IWRAM + 0x20000, 4, true)).toBe(1);
  });

  it('a block transfer that runs from OAM into the game pak pays an N access there', () => {
    // mgba-suite Timing "ldmia r2!, {r3-r7}" from 0x07FFFFF0, run from IWRAM: 14 cycles on hardware,
    // 1S fetch, four OAM words, N32 at 0x08000000 and the I cycle.
    const gba = machine([0xe8b200f8 /* ldmia r2!, {r3-r7} */], IWRAM);
    gba.armCpu.registers[2] = 0x07fffff0;
    expect(gba.armCpu.step()).toBe(1 + 4 + 8 + 1);
  });
});

/**
 * The cycles `code` takes, measured the way mgba-suite's Timing tests measure them on hardware:
 * TM0 counts at F/1 from a store before the code to a load after it, less the count with no code
 * between (src/timing.c, src/tests/macros.s START and END). `code` holds ARM words, or Thumb
 * halfwords when `thumb` is set; `regs` are what the test's setup leaves in registers.
 */
function measure(code: number[], at: number, waitcnt: number, thumb: boolean, regs: Record<number, number>): number {
  const count = (body: number[]): number => {
    let words: number[];
    let end: number;
    if (thumb) {
      // ldr r0, =TM0CNT_LO ; ldr r1, =0x800000 ; str r1, [r0] ; body ; ldrh r2, [r0] ; b .
      const halves = [0, 0, 0x6001, ...body, 0x8802, 0xe7fe];
      if (halves.length % 2) {
        halves.push(0x46c0);
      }
      const literal = halves.length * 2;
      halves[0] = 0x4800 | ((literal - 4) >> 2);
      halves[1] = 0x4900 | ((literal + 4 - 4) >> 2);
      end = at + (3 + body.length + 1) * 2;
      words = [];
      for (let i = 0; i < halves.length; i += 2) {
        words.push((halves[i]! | (halves[i + 1]! << 16)) >>> 0);
      }
      words.push(0x04000100, 0x00800000);
    } else {
      // ldr r0, =TM0CNT_LO ; mov r1, #0x800000 ; str r1, [r0] ; body ; ldrh r2, [r0] ; b .
      words = [0, 0xe3a01502, 0xe5801000, ...body, 0xe1d020b0, 0xeafffffe, 0x04000100];
      words[0] = 0xe59f0000 | ((words.length - 1) * 4 - 8);
      end = at + (words.length - 2) * 4;
    }
    const gba = machine(words, at, thumb);
    gba.bus.write16(WAITCNT, waitcnt);
    for (const [index, value] of Object.entries(regs)) {
      gba.armCpu.registers[Number(index)] = value;
    }
    runTo(gba, end);
    return gba.armCpu.registers[2]!;
  };
  return count(code) - count([]);
}

describe('instruction costs measured like mgba-suite Timing', () => {
  // For each WAITCNT setting (no prefetch, prefetch, WS0 first access 3, both, WS0 second access 1,
  // ...), then EWRAM and IWRAM; the numbers are the hardware's (mgba-suite src/timing.c).
  const SETTINGS = [0x0000, 0x4000, 0x0004, 0x4004, 0x0010, 0x4010, 0x0014, 0x4014];
  const cases: Array<[string, number[], boolean, number[], number, number, Record<number, number>?]> = [
    ['ARM nop', [0xe1a00000], false, [6, 6, 6, 6, 4, 4, 4, 4], 6, 1],
    ['ARM ldrh r2, [sp]', [0xe1dd20b0], false, [10, 6, 9, 6, 9, 4, 8, 4], 8, 3],
    ['ARM ldr r2, [r3] from 0x08000000', [0xe5932000], false, [17, 17, 15, 15, 15, 15, 13, 13], 15, 10, { 3: ROM }],
    ['ARM ldr r2, [sp] x2', [0xe59d2000, 0xe59d2000], false, [20, 12, 18, 12, 18, 8, 16, 8], 16, 6],
    ['ARM ldmia sp, {r2-r7}', [0xe89d00fc], false, [15, 8, 14, 8, 14, 8, 13, 8], 13, 8],
    [
      'ARM ldmia r2!, {r3-r7} from 0x07FFFFFC',
      [0xe8b200f8],
      false,
      [36, 36, 34, 34, 28, 29, 26, 27],
      34,
      29,
      { 2: 0x07fffffc },
    ],
    ['Thumb nop', [0x46c0], true, [3, 3, 3, 3, 2, 2, 2, 2], 3, 1],
    [
      'Thumb nop / ldr r2, [sp] (the suite’s ldrh r2, [sp] in Thumb)',
      [0x46c0, 0x9a00],
      true,
      [10, 6, 9, 6, 9, 5, 8, 5],
      8,
      4,
    ],
    ['Thumb ldr r2, [r3] from 0x08000000', [0x681a], true, [14, 14, 12, 12, 13, 13, 11, 11], 12, 10, { 3: ROM }],
    [
      'Thumb ldmia r2!, {r3-r7} from 0x07FFFFF0',
      [0xcaf8],
      true,
      [18, 18, 16, 16, 17, 17, 15, 15],
      16,
      14,
      { 2: 0x07fffff0 },
    ],
    ['Thumb muls r3, r2 by 0xFF', [0x4353], true, [6, 3, 5, 3, 6, 2, 5, 2], 4, 2, { 3: 0x78, 2: 0xff }],
  ];
  for (const [name, code, thumb, rom, ewram, iwram, regs = {}] of cases) {
    it(`${name} takes what the hardware takes from ROM under each WAITCNT, from EWRAM and from IWRAM`, () => {
      expect(SETTINGS.map((w) => measure(code, ROM, w, thumb, regs))).toEqual(rom);
      expect(measure(code, EWRAM, 0, thumb, regs)).toBe(ewram);
      expect(measure(code, IWRAM, 0, thumb, regs)).toBe(iwram);
    });
  }
});

describe('the game pak prefetch unit', () => {
  // WAITCNT 0x4000: prefetch on, WS0 N 5 and S 3 cycles per halfword.
  function prefetching(): Gba {
    const gba = machine([0xeafffffe], ROM, true);
    gba.bus.write16(WAITCNT, 0x4000);
    return gba;
  }

  it('reads the opcodes after a fetch while the CPU leaves the cartridge alone, and serves them in 1 cycle', () => {
    const bus = prefetching().bus;
    expect(bus.fetchCycles(ROM, 2, false)).toBe(5);
    bus.idle(6); // two S reads: ROM+2 and ROM+4
    expect([bus.fetchCycles(ROM + 2, 2, true), bus.fetchCycles(ROM + 4, 2, true)]).toEqual([1, 1]);
    // ROM+6 has been reading since ROM+4 arrived, 2 cycles ago: it arrives 1 cycle later.
    expect(bus.fetchCycles(ROM + 6, 2, true)).toBe(1);
  });

  it('holds 8 halfwords, or 4 words in ARM state, and reads on once the CPU takes one', () => {
    const bus = prefetching().bus;
    bus.fetchCycles(ROM, 2, false);
    bus.idle(100);
    for (let i = 1; i <= 8; i++) {
      expect(bus.fetchCycles(ROM + 2 * i, 2, true)).toBe(1);
    }
    // Taking the first made room, so ROM+18 came in 3 cycles later, while the CPU took the rest.
    expect(bus.fetchCycles(ROM + 18, 2, true)).toBe(1);

    // In ARM state: 4 words, then the fifth, read from the first hit on, has 6 - 4 cycles to go.
    bus.fetchCycles(ROM + 0x100, 4, false);
    bus.idle(100);
    expect([1, 2, 3, 4, 5].map((i) => bus.fetchCycles(ROM + 0x100 + 4 * i, 4, true))).toEqual([1, 1, 1, 1, 2]);
  });

  it('a data access to the cartridge, or a fetch of another address, discards what it holds', () => {
    const bus = prefetching().bus;
    bus.fetchCycles(ROM, 2, false);
    bus.idle(6);
    expect(bus.dataCycles(ROM + 0x200, 2, false)).toBe(5);
    expect(bus.fetchCycles(ROM + 2, 2, true)).toBe(3);
    bus.idle(6);
    expect(bus.fetchCycles(ROM + 0x40, 2, false)).toBe(5);
    // A data access elsewhere lets it read on.
    expect(bus.dataCycles(IWRAM, 4, false)).toBe(1);
    bus.idle(2);
    expect(bus.fetchCycles(ROM + 0x42, 2, true)).toBe(1);
  });

  it('a cartridge access as a halfword read ends waits one cycle more while the CPU runs from the cartridge', () => {
    // NanoBoyAdvance Bus::StopPrefetch: the one-cycle penalty of a game pak access that collides
    // with the last cycle of a prefetch.
    const gba = prefetching();
    gba.armCpu.registers[15] = ROM + 4;
    const bus = gba.bus;
    bus.fetchCycles(ROM, 2, false);
    bus.idle(2);
    expect(bus.dataCycles(ROM + 0x200, 2, false)).toBe(5 + 1);
    gba.armCpu.registers[15] = IWRAM;
    bus.fetchCycles(ROM, 2, false);
    bus.idle(2);
    expect(bus.dataCycles(ROM + 0x200, 2, false)).toBe(5);
  });

  it('with WAITCNT bit 14 clear it reads nothing ahead', () => {
    const bus = prefetching().bus;
    bus.write16(WAITCNT, 0);
    bus.fetchCycles(ROM, 2, false);
    bus.idle(100);
    expect(bus.fetchCycles(ROM + 2, 2, true)).toBe(3);
  });
});

describe('the run loop and instruction costs', () => {
  it('an instruction the CPU runs never ends the frame as a debugger stop', () => {
    // swp from ROM with the cartridge's usual WAITCNT 0x4317 and prefetch on, on an IWRAM operand.
    const gba = machine([
      0xe59f0010, // ldr r0, =WAITCNT
      0xe59f1010, // ldr r1, =0x4317
      0xe5801000, // str r1, [r0]
      0xe10d3092, // swp r3, r2, [sp]
      0xeafffffd, // b <swp>
      0x00000000,
      WAITCNT,
      0x4317,
    ]);
    expect(gba.runFrame()).toBe('done');
    expect(gba.frameCount).toBe(1);
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

  it('setting IME lets a waiting request through 7 cycles later, like enabling it in IE', () => {
    // mGBA io.c: an IME write runs GBATestIRQ, the same delayed test as an IE write.
    const scheduler = new Scheduler();
    const irq = new InterruptController(scheduler);
    irq.writeIe(IrqFlag.VBlank);
    irq.requestInterrupt(IrqFlag.VBlank);
    scheduler.tick(100);
    irq.writeIme(1);
    scheduler.tick(6);
    expect(irq.irqPending()).toBe(false);
    scheduler.tick(1);
    expect(irq.irqPending()).toBe(true);
  });

  it('setting IME delays only the IRQ line: a Halt right after it ends at once', () => {
    // GBATEK "System Control": Halt lasts while IE AND IF is zero. NanoBoyAdvance irq.cc: IME moves
    // irq_line, and ShouldUnhaltCPU reads irq_available alone.
    const scheduler = new Scheduler();
    const irq = new InterruptController(scheduler);
    irq.writeIe(IrqFlag.VBlank);
    irq.requestInterrupt(IrqFlag.VBlank);
    scheduler.tick(100);
    irq.writeIme(1);
    irq.halt();
    expect(irq.halted).toBe(false);
    scheduler.tick(6);
    expect(irq.irqPending()).toBe(false);
    scheduler.tick(1);
    expect(irq.irqPending()).toBe(true);
  });

  it('IME cleared and set again restarts its delay; a request on its way keeps its own cycle', () => {
    // NanoBoyAdvance irq.cc: each IME write moves irq_line through the same delay.
    const scheduler = new Scheduler();
    const irq = new InterruptController(scheduler);
    irq.writeIe(IrqFlag.VBlank);
    irq.requestInterrupt(IrqFlag.VBlank);
    scheduler.tick(100);
    irq.writeIme(1);
    scheduler.tick(4);
    irq.writeIme(0);
    irq.writeIme(1);
    scheduler.tick(6);
    expect(irq.irqPending()).toBe(false);
    scheduler.tick(1);
    expect(irq.irqPending()).toBe(true);

    // mGBA gba.c GBATestIRQ: an IRQ test with the signal already scheduled leaves it where it is.
    irq.writeIme(0);
    irq.acknowledge(IrqFlag.VBlank);
    irq.requestInterrupt(IrqFlag.VBlank);
    scheduler.tick(3);
    irq.writeIme(1);
    scheduler.tick(3);
    expect(irq.irqPending()).toBe(false);
    scheduler.tick(1);
    expect(irq.irqPending()).toBe(true);
  });

  it('IME set and cleared again by back-to-back stores lets no interrupt through', () => {
    const gba = machine(
      [
        0xe3a00301, // mov r0, #0x04000000
        0xe2800c02, // add r0, r0, #0x200
        0xe3a01001, // mov r1, #1
        0xe3a02000, // mov r2, #0
        0xe1c010b8, // strh r1, [r0, #8]   IME = 1
        0xe1c020b8, // strh r2, [r0, #8]   IME = 0
        0xeafffffe, // b .
      ],
      IWRAM,
    );
    gba.bus.write32(0x03007ffc, IWRAM + 0x100);
    gba.bus.write32(IWRAM + 0x100, 0xe12fff1e); // bx lr
    gba.interrupts.writeIe(IrqFlag.VBlank);
    gba.interrupts.requestInterrupt(IrqFlag.VBlank);
    gba.scheduler.tick(100);
    const entries: string[] = [];
    gba.onHardwareEvent = (event) => entries.push(event.kind);
    runTo(gba, IWRAM + 6 * 4);
    expect(entries).not.toContain('irq-enter');
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
