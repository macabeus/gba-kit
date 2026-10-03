import { MODE_IRQ, MODE_SVC, MODE_SYS } from '@gba-kit/arm-emulator/arm-cpu';
import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { InterruptController } from '../interrupts.js';
import { Scheduler } from '../scheduler.js';
import { BIOS_LATCH_AFTER_SWI, IrqFlag, MMIO } from '../types.js';

/**
 * The ROM the tests run. Each `main_*` entry is a program; `isr` is the game's interrupt handler:
 * it acknowledges IF, counts its calls at 0x03000000, and reports to IntrWait (at 0x03007FF8, through
 * its mirror at 0x03FFFFF8) the flags that the mask at 0x03000004 lets through.
 */
const ROM = [
  0xef050000, // 00 main_vbw:   swi 0x50000             VBlankIntrWait
  0xe2899001, // 04 loop:       add r9, r9, #1
  0xeafffffd, // 08             b loop
  0xe3a00000, // 0c main_iw:    mov r0, #0
  0xe3a01001, // 10             mov r1, #1
  0xef040000, // 14             swi 0x40000             IntrWait(0, VBlank)
  0xeafffffe, // 18             b .
  0xef020000, // 1c main_halt:  swi 0x20000             Halt
  0xeafffffe, // 20             b .
  0xef000000, // 24 main_reset: swi 0                   SoftReset
  0xe3a00301, // 28 isr:        mov r0, #0x04000000
  0xe2800c02, // 2c             add r0, r0, #0x200
  0xe1d010b2, // 30             ldrh r1, [r0, #2]       IF
  0xe1c010b2, // 34             strh r1, [r0, #2]       acknowledge it
  0xe3a02403, // 38             mov r2, #0x03000000
  0xe5923000, // 3c             ldr r3, [r2]
  0xe2833001, // 40             add r3, r3, #1
  0xe5823000, // 44             str r3, [r2]            count the call
  0xe5923004, // 48             ldr r3, [r2, #4]        the flags to report
  0xe0011003, // 4c             and r1, r1, r3
  0xe3a02301, // 50             mov r2, #0x04000000
  0xe15230b8, // 54             ldrh r3, [r2, #-8]
  0xe1833001, // 58             orr r3, r3, r1
  0xe14230b8, // 5c             strh r3, [r2, #-8]      0x03007FF8
  0xe12fff1e, // 60             bx lr
  0xe3a01301, // 64 main_haltcnt: mov r1, #0x04000000
  0xe5c11301, // 68             strb r1, [r1, #0x301]   HALTCNT from the cartridge
  0xeafffffe, // 6c             b .
];
const MAIN_VBLANK_INTR_WAIT = 0x08000000;
const LOOP = 0x08000004;
const MAIN_INTR_WAIT = 0x0800000c;
const MAIN_HALT = 0x0800001c;
const AFTER_HALT = 0x08000020;
const MAIN_SOFT_RESET = 0x08000024;
const ISR = 0x08000028;
const MAIN_HALTCNT = 0x08000064;
const ISR_CALLS = 0x03000000;
const ISR_REPORTS = 0x03000004;
const INTR_CHECK = 0x03007ff8;

function romOf(words: number[]): Uint8Array {
  const rom = new Uint8Array(words.length * 4);
  const view = new DataView(rom.buffer);
  words.forEach((w, i) => view.setUint32(i * 4, w >>> 0, true));
  return rom;
}

/** A machine at `entry`, the handler installed, VBlank IRQs on in DISPSTAT and IE. */
function boot(entry: number, { ime = 1, reports = IrqFlag.VBlank } = {}): Gba {
  const gba = new Gba();
  gba.loadRom(romOf(ROM));
  gba.armCpu.registers[15] = entry;
  gba.bus.write32(0x03007ffc, ISR);
  gba.bus.write32(ISR_REPORTS, reports);
  gba.bus.write16(MMIO.DISPSTAT, 0x0008);
  gba.bus.write16(MMIO.IE, IrqFlag.VBlank);
  gba.bus.write16(MMIO.IME, ime);
  return gba;
}

const inBios = (gba: Gba): boolean => gba.armCpu.registers[15]! < 0x4000;

describe('IntrWait and VBlankIntrWait run as BIOS code', () => {
  it('VBlankIntrWait turns IME on and returns once the game’s handler reports VBlank', () => {
    // GBATEK "IntrWait": "the function forcefully sets IME=1".
    const gba = boot(MAIN_VBLANK_INTR_WAIT, { ime: 0 });
    expect(gba.runFrame(() => gba.armCpu.registers[15] === LOOP)).toBe('stopped');
    expect(gba.scanline).toBe(160);
    expect(gba.interrupts.ime).toBe(1);
    expect(gba.bus.read32(ISR_CALLS)).toBe(1);
    expect(gba.bus.read16(INTR_CHECK)).toBe(0); // the flag it waited for is taken
    expect(gba.armCpu.getMode()).toBe(MODE_SYS);
  });

  it('leaves nothing behind: interrupts after the wait return straight to the program', () => {
    const gba = boot(MAIN_VBLANK_INTR_WAIT);
    gba.runFrame(); // through the wait
    // HBlank IRQs too; the handler reports only VBlank to IntrWait.
    gba.bus.write16(MMIO.DISPSTAT, 0x0018);
    gba.bus.write16(MMIO.IE, IrqFlag.VBlank | IrqFlag.HBlank);
    const before = gba.armCpu.registers[9]!;
    gba.runFrame();
    const after = gba.armCpu.registers[9]!;
    gba.runFrame();
    // About 280896 cycles of a 26-cycle loop, less 229 handlers: no frame spent asleep.
    expect(after - before).toBeGreaterThan(5000);
    expect(gba.armCpu.registers[9]! - after).toBeGreaterThan(5000);
    expect(gba.interrupts.halted).toBe(false);
  });

  it('IntrWait(0, flags) returns at once when a flag is already reported, and takes only that flag', () => {
    const gba = boot(MAIN_INTR_WAIT, { ime: 0 });
    gba.bus.write16(INTR_CHECK, IrqFlag.VBlank | IrqFlag.HBlank);
    expect(gba.runFrame(() => gba.armCpu.registers[15] === MAIN_INTR_WAIT + 0xc)).toBe('stopped');
    expect(gba.scanline).toBe(0);
    expect(gba.bus.read16(INTR_CHECK)).toBe(IrqFlag.HBlank);
    expect(gba.armCpu.registers[0]).toBe(IrqFlag.VBlank); // the flags it took
    expect(gba.interrupts.ime).toBe(1);
  });

  it('keeps waiting while the handler reports nothing, taking each interrupt in the BIOS', () => {
    const gba = boot(MAIN_VBLANK_INTR_WAIT, { reports: 0 });
    for (let i = 0; i < 3; i++) {
      gba.runFrame();
    }
    expect(inBios(gba)).toBe(true);
    expect(gba.bus.read32(ISR_CALLS)).toBe(3);
    expect(gba.armCpu.registers[9]).toBe(0);
  });

  it('a halt in the IntrWait loop is a hardware halt: the BIOS wrote HALTCNT', () => {
    const gba = boot(MAIN_VBLANK_INTR_WAIT);
    gba.runScanline();
    expect(gba.interrupts.halted).toBe(true);
    expect(inBios(gba)).toBe(true);
  });
});

describe('a call the real BIOS never returns from runs on in the BIOS', () => {
  const CALL = 0x03000100;
  const INFO = 0x02020000;
  const DST = 0x02010000;

  /** A machine that runs `swi n` from IWRAM with r0-r2 set, VBlank IRQs on. */
  function stuckIn(n: number, regs: number[], setup: (gba: Gba) => void): Gba {
    const gba = boot(LOOP);
    setup(gba);
    gba.bus.write32(CALL, (0xef000000 | (n << 16)) >>> 0);
    regs.forEach((value, r) => (gba.armCpu.registers[r] = value >>> 0));
    gba.armCpu.registers[15] = CALL;
    return gba;
  }

  it('BitUnPack with a source width of 0 stores past its destination forever; interrupts and frames go on', () => {
    // The real BIOS's unit loop never reaches the next source byte: each 8-bit unit is the offset 5,
    // which bit 31 adds to zero units too, and every fourth unit stores a word.
    const gba = stuckIn(0x10, [0x02000000, DST, INFO], (m) => {
      m.bus.write16(INFO, 4); // 4 source bytes
      m.bus.write16(INFO + 2, 0x0800); // source width 0, destination width 8
      m.bus.write32(INFO + 4, 0x80000005);
    });
    gba.runFrame();
    gba.runFrame();
    expect(inBios(gba)).toBe(true);
    expect(gba.frameCount).toBe(2);
    expect(gba.bus.read32(ISR_CALLS)).toBe(2);
    expect(gba.bus.read32(DST + 0x1000)).toBe(0x05050505);
  });

  it('HuffUnComp whose walk leaves its tree reads on and never returns', () => {
    // A tree of one node with no leaf flags, over zeroed memory: every node after it is the same.
    const gba = stuckIn(0x13, [0x02000000, DST], (m) => m.bus.write32(0x02000000, 0x00010028));
    gba.runFrame();
    expect(inBios(gba)).toBe(true);
    expect(gba.bus.read32(ISR_CALLS)).toBe(1);
    expect(gba.bus.read32(DST)).toBe(0);
  });
});

describe('Halt and HALTCNT', () => {
  it('Halt returns at once while IE AND IF is already set, whatever IME says', () => {
    // GBATEK "HALTCNT": the CPU is paused as long as (IE AND IF) = 0.
    const gba = boot(MAIN_HALT, { ime: 0 });
    gba.interrupts.requestInterrupt(IrqFlag.VBlank);
    gba.scheduler.tick(7); // the request reaches the CPU
    expect(gba.runFrame(() => gba.armCpu.registers[15] === AFTER_HALT)).toBe('stopped');
    expect(gba.scanline).toBe(0);
    expect(gba.scheduler.currentCycle).toBeLessThan(200);
  });

  it('Halt sleeps to the next request, and the SWI returns with the latch every SWI leaves', () => {
    const gba = boot(MAIN_HALT, { ime: 0 });
    expect(gba.runFrame(() => gba.armCpu.registers[15] === AFTER_HALT)).toBe('stopped');
    expect(gba.scanline).toBe(160);
    expect(gba.bus.read32(0)).toBe(BIOS_LATCH_AFTER_SWI);
  });

  it('HALTCNT written from the cartridge does not halt', () => {
    const gba = boot(MAIN_HALTCNT);
    gba.runScanline();
    expect(gba.interrupts.halted).toBe(false);
    expect(gba.armCpu.registers[15]).toBe(MAIN_HALTCNT + 8);
  });

  it('Halt and Stop end on the request the CPU sees, Stop only for keypad, Game Pak or serial', () => {
    const scheduler = new Scheduler();
    const irq = new InterruptController(scheduler);
    irq.ie = IrqFlag.VBlank | IrqFlag.Keypad;
    irq.stop();
    expect(irq.halted).toBe(true);
    expect(irq.stopped).toBe(true);
    irq.requestInterrupt(IrqFlag.VBlank);
    scheduler.tick(7);
    expect(irq.halted).toBe(true);
    irq.requestInterrupt(IrqFlag.Keypad);
    expect(irq.halted).toBe(false);
    // The line is up now, so Halt returns at once.
    irq.halt();
    expect(irq.halted).toBe(false);
    irq.acknowledge(IrqFlag.VBlank | IrqFlag.Keypad);
    irq.halt();
    expect(irq.halted).toBe(true);
    expect(irq.stopped).toBe(false);
  });

  it('a Stop survives a snapshot; an older snapshot restores as Halt', () => {
    const gba = boot(MAIN_HALT);
    gba.interrupts.stop();
    const snap = gba.serialize();
    expect(snap.interrupts.stopped).toBe(true);
    const fresh = new Gba();
    fresh.loadRom(romOf(ROM));
    fresh.deserialize(snap);
    expect(fresh.interrupts.stopped).toBe(true);
    // A snapshot in the earlier format: `inIrqHandler` and `intrWaitFlags`, and no `stopped`.
    const legacy = { ...snap, inIrqHandler: true, interrupts: { ...snap.interrupts, intrWaitFlags: 1 } };
    delete legacy.interrupts.stopped;
    fresh.deserialize(legacy);
    expect(fresh.interrupts.halted).toBe(true);
    expect(fresh.interrupts.stopped).toBe(false);
    expect(fresh.serialize().interrupts).toEqual({ ...snap.interrupts, stopped: false });
  });
});

describe('SoftReset and RegisterRamReset', () => {
  function resetFrom(returnByte: number): Gba {
    const gba = boot(MAIN_SOFT_RESET);
    gba.bus.write32(0x03007e10, 0x12345678); // inside the 0x200 bytes it clears
    gba.bus.write32(0x03007df0, 0xabcdef01); // below them
    gba.bus.write8(0x03007ffa, returnByte);
    for (let r = 0; r < 13; r++) {
      gba.armCpu.registers[r] = 0x1111 * (r + 1);
    }
    gba.armCpu.cpsr = MODE_SYS | 0xf0000000;
    return gba;
  }

  it('SoftReset leaves SYS mode, the boot stacks and zeroed registers, and jumps to the cartridge', () => {
    // GBATEK "SoftReset"; checked against the real BIOS.
    const gba = resetFrom(0);
    expect(gba.runFrame(() => gba.armCpu.registers[15] === 0x08000000)).toBe('stopped');
    const cpu = gba.armCpu;
    expect(cpu.cpsr).toBe(MODE_SYS);
    expect(Array.from(cpu.registers.slice(0, 13))).toEqual(new Array(13).fill(0));
    expect(cpu.registers[13]).toBe(0x03007f00);
    expect(cpu.registers[14]).toBe(0x08000000);
    expect(cpu.getBankedSP(MODE_IRQ)).toBe(0x03007fa0);
    expect(cpu.getBankedSP(MODE_SVC)).toBe(0x03007fe0);
    expect(cpu.getBankedLR(MODE_IRQ)).toBe(0);
    expect(cpu.getBankedLR(MODE_SVC)).toBe(0);
    expect(cpu.getBankedSPSR(MODE_SVC)).toBe(0);
    expect(gba.bus.read32(0x03007e10)).toBe(0);
    expect(gba.bus.read32(0x03007ffc)).toBe(0); // the IRQ handler pointer goes with it
    expect(gba.bus.read32(0x03007df0)).toBe(0xabcdef01);
  });

  it('SoftReset returns to EWRAM when the byte at 0x03007FFA is set', () => {
    const gba = resetFrom(1);
    expect(gba.runFrame(() => gba.armCpu.registers[15] === 0x02000000)).toBe('stopped');
    expect(gba.armCpu.cpsr).toBe(MODE_SYS);
  });

  it('RegisterRamReset clears the memory and registers r0 picks, and blanks the screen', () => {
    const gba = new Gba();
    gba.loadRom(romOf([0xef010000 /* swi 0x10000 */, 0xeafffffe /* b . */]));
    gba.armCpu.registers[0] = 0x83; // EWRAM, IWRAM, the other registers
    gba.bus.write32(0x02000100, 0x11111111);
    gba.bus.write32(0x03000100, 0x22222222);
    gba.bus.write32(0x03007e10, 0x33333333);
    gba.bus.write32(0x05000000, 0x44444444);
    gba.bus.write16(MMIO.DISPCNT, 0x0403);
    gba.bus.write16(MMIO.BG2PA, 0x0234);
    gba.bus.write16(MMIO.IE, 0x0001);
    gba.bus.write16(MMIO.RCNT, 0x0000);
    gba.bus.write16(MMIO.SIOCNT, 0x1000); // Normal 32-bit mode, where SIODATA32 holds data
    gba.bus.write16(MMIO.SIODATA32, 0xabcd);
    // Clearing EWRAM 8 words per STMIA at 6 cycles a word takes about 1.5 frames.
    expect(gba.runFrame(() => gba.armCpu.registers[15] === 0x08000004)).toBe('done');
    expect(gba.runFrame(() => gba.armCpu.registers[15] === 0x08000004)).toBe('stopped');
    expect(gba.frameCount).toBe(1);
    expect(gba.bus.read32(0x02000100)).toBe(0);
    expect(gba.bus.read32(0x03000100)).toBe(0);
    expect(gba.bus.read32(0x03007e10)).toBe(0x33333333); // the top 0x200 bytes stay
    expect(gba.bus.read32(0x05000000)).toBe(0x44444444); // bit 2 clear: the palette stays
    expect(gba.bus.read16(MMIO.DISPCNT)).toBe(0x0080);
    expect(gba.bus.peek(MMIO.BG2PA, 2).data).toEqual(new Uint8Array([0x00, 0x01]));
    expect(gba.interrupts.ie).toBe(0);
    // Bit 5 clear: the BIOS still writes 7 to SIODATA32's low byte (GBATEK "RegisterRamReset").
    expect(gba.bus.read16(MMIO.SIODATA32)).toBe(0xab07);
  });
});

describe('the post-BIOS boot state belongs to the machine', () => {
  function expectBootState(gba: Gba): void {
    const cpu = gba.armCpu;
    expect(cpu.cpsr).toBe(MODE_SYS);
    expect(cpu.registers[15]).toBe(0x08000000);
    expect(cpu.registers[13]).toBe(0x03007f00);
    expect(cpu.getBankedSP(MODE_IRQ)).toBe(0x03007fa0);
    expect(cpu.getBankedSP(MODE_SVC)).toBe(0x03007fe0);
    // mGBA io.c GBAIOInit and gba.c GBASkipBIOS.
    expect(gba.bus.read16(MMIO.DISPCNT)).toBe(0x0080);
    for (const register of [MMIO.BG2PA, MMIO.BG2PD, MMIO.BG3PA, MMIO.BG3PD]) {
      expect(gba.bus.peek(register, 2).data).toEqual(new Uint8Array([0x00, 0x01]));
    }
    expect(gba.bus.read16(MMIO.RCNT) & 0xc000).toBe(0x8000); // general-purpose mode
    expect(gba.bus.read16(MMIO.SOUNDBIAS)).toBe(0x0200);
    expect(gba.bus.read8(MMIO.POSTFLG)).toBe(1);
  }

  it('a new machine starts where the BIOS hands over to the cartridge', () => {
    expectBootState(new Gba());
  });

  it('reset returns to it', () => {
    const gba = boot(MAIN_VBLANK_INTR_WAIT);
    gba.runFrame();
    gba.bus.write16(MMIO.DISPCNT, 0x0403);
    gba.armCpu.switchMode(MODE_IRQ);
    gba.reset();
    expectBootState(gba);
  });
});
