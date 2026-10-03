/**
 * What memory nothing answers for reads as: open bus (the CPU's last fetched opcode), the BIOS's
 * read-protection latch, the cartridge's address lines past its end, and the half of VRAM's OBJ
 * mirror the bitmap modes leave unmapped (GBATEK "GBA Unpredictable Things", "BIOS Memory";
 * mGBA memory.c GBALoadBad, LOAD_BIOS, LOAD_CART, LOAD_VRAM; jsmolka gba-tests bios and unsafe).
 */
import { disassembleArm } from '@gba-kit/arm-emulator/disassembler';
import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { ScriptingEngine, type ScriptingHost } from '../scripting.js';
import { GbaSystemBus } from '../system-bus.js';

const stubHost: ScriptingHost = {
  writeScreenshot: async () => {},
  writeMemorySnapshot: async () => {},
  writeSaveState: async () => {},
  readSaveState: async () => {
    throw new Error('not used');
  },
  log: () => {},
};

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

/** ARM, from 0x08000000. */
function boot(words: number[]): Gba {
  const gba = new Gba();
  gba.loadRom(romOf(words));
  gba.armCpu.cpsr = 0x1f;
  gba.armCpu.registers[15] = 0x08000000;
  return gba;
}

describe('open bus', () => {
  it('in ARM state, an unmapped read returns [$+8], the word the CPU fetched last', () => {
    const gba = boot([
      0xe3a00201, // mov  r0, #0x10000000
      0xe5901000, // ldr  r1, [r0]
      0xea000000, // b    over the data
      0xdeadc0de,
      0xe3a00901, // mov  r0, #0x4000       past the BIOS
      0xe5902000, // ldr  r2, [r0]
      0xea000000,
      0x0badf00d,
      0xe5d03001, // ldrb r3, [r0, #1]      the byte lane address bits 0-1 select
      0xea000000,
      0x11223344,
      0xeafffffe, // b .
    ]);
    gba.runScanline();
    expect(gba.armCpu.registers[1]).toBe(0xdeadc0de);
    expect(gba.armCpu.registers[2]).toBe(0x0badf00d);
    expect(gba.armCpu.registers[3]).toBe(0x33);
  });

  it('in Thumb state from ROM, [$+4] on both halves', () => {
    const gba = boot([
      0xe28f0001, // add  r0, pc, #1
      0xe12fff10, // bx   r0              -> Thumb at 0x08000008
      0x07002001, // movs r0, #1 ; lsls r0, r0, #28
      0xe7fe6801, // ldr  r1, [r0] ; b .
      0x0000beef, // [$+4] of the ldr
    ]);
    gba.runScanline();
    expect(gba.armCpu.registers[1]).toBe(0xbeefbeef);
  });

  it('in Thumb state from IWRAM, [$+4] with its neighbour in the same word', () => {
    // GBATEK: IWRAM, 4-byte aligned $: low [$+4], high [$+2]; 2-byte aligned: low [$+2], high [$+4].
    const run = (halfwords: number[]): number => {
      const gba = boot([0xeafffffe]);
      halfwords.forEach((h, i) => gba.bus.write16(0x03000000 + i * 2, h));
      gba.armCpu.cpsr = 0x3f; // SYS, Thumb
      gba.armCpu.registers[15] = 0x03000000;
      gba.runScanline();
      return gba.armCpu.registers[1]!;
    };
    // movs r0, #1 ; lsls r0, r0, #28 ; ldr r1, [r0] ; b . ; data
    expect(run([0x2001, 0x0700, 0x6801, 0xe7fe, 0xbeef])).toBe(0xe7febeef);
    // the same after a nop, so the ldr sits at a 2-byte aligned address
    expect(run([0x46c0, 0x2001, 0x0700, 0x6801, 0xe7fe, 0xbeef])).toBe(0xbeefe7fe);
  });
});

describe('open bus after a DMA', () => {
  /** DMA3 copies the word 0xDEAD0000 within EWRAM, then the CPU reads unmapped memory twice. */
  function afterDma(withDma: boolean): Gba {
    const gba = boot([
      0xe5910000, // ldr r0, [r1]
      0xe5912000, // ldr r2, [r1]
      0xeafffffe, // b .
      0xe1a00000, // nop, [$+8] of the second ldr
    ]);
    gba.armCpu.registers[1] = 0x10000000;
    if (withDma) {
      gba.bus.write32(0x02000000, 0xdead0000);
      gba.bus.write32(0x040000d4, 0x02000000);
      gba.bus.write32(0x040000d8, 0x02000100);
      gba.bus.write16(0x040000dc, 1);
      gba.bus.write16(0x040000de, 0x8000 | (1 << 10)); // enable, immediate, 32-bit
      gba.scheduler.tick(3);
    }
    gba.armCpu.step();
    gba.armCpu.step();
    return gba;
  }

  it('the instruction right after a DMA reads the unit the DMA moved last; the next reads the CPU fetch again', () => {
    // mGBA dma.c GBADMAService puts every unit on the bus, and memory.c GBALoadBad returns it while
    // the DMA runs and in the instruction after it (mgba-suite Misc edge "DMA Prefetch": 0xDEAD0000).
    const gba = afterDma(true);
    expect(gba.armCpu.registers[0]! >>> 0).toBe(0xdead0000);
    expect(gba.armCpu.registers[2]! >>> 0).toBe(0xe1a00000);
  });

  it('without a DMA, the same read returns the CPU fetch', () => {
    const gba = afterDma(false);
    expect(gba.armCpu.registers[0]! >>> 0).toBe(0xeafffffe);
  });

  it('a DMA reading memory nothing answers for moves the unit it moved before', () => {
    const gba = new Gba();
    gba.bus.write32(0x02000000, 0x12345678);
    gba.bus.write32(0x040000d4, 0x02000000); // EWRAM, then the unmapped 0x10000000
    gba.bus.write32(0x040000d8, 0x02000100);
    gba.bus.write16(0x040000dc, 1);
    gba.bus.write16(0x040000de, 0x8000 | (1 << 10));
    gba.scheduler.tick(3);
    gba.bus.write32(0x040000d4, 0x10000000);
    gba.bus.write32(0x040000d8, 0x02000104);
    gba.bus.write16(0x040000de, 0x8000 | (1 << 10));
    gba.scheduler.tick(3);
    expect(gba.bus.read32(0x02000104) >>> 0).toBe(0x12345678);
  });
});

describe('BIOS read protection', () => {
  it('after boot, code outside the BIOS reads [0xDC+8] of the real BIOS', () => {
    const gba = boot([
      0xe3a00000, // mov  r0, #0
      0xe5901000, // ldr  r1, [r0]
      0xe1d020b2, // ldrh r2, [r0, #2]
      0xe5d03003, // ldrb r3, [r0, #3]
      0xeafffffe,
    ]);
    gba.runScanline();
    expect(gba.armCpu.registers[1]).toBe(0xe129f000);
    expect(gba.armCpu.registers[2]).toBe(0xe129);
    expect(gba.armCpu.registers[3]).toBe(0xe1);
  });

  it('after an SWI, [0x188+8]', () => {
    const gba = boot([
      0xe3a00000, // mov  r0, #0
      0xef080000, // swi  0x08 (Sqrt)
      0xe3a00000, // mov  r0, #0
      0xe5901000, // ldr  r1, [r0]
      0xeafffffe,
    ]);
    gba.runScanline();
    expect(gba.armCpu.registers[1]).toBe(0xe3a02004);
  });

  it('during an IRQ handler [0x134+8], and after it returns [0x13C+8]', () => {
    const words = new Array<number>(0x45).fill(0);
    words[0] = 0xeafffffe; // b .
    words.splice(
      0x40,
      9,
      0xe3a00000, // 0x08000100: mov  r0, #0
      0xe5901000, //             ldr  r1, [r0]
      0xe3a02403, //             mov  r2, #0x03000000
      0xe5821000, //             str  r1, [r2]
      0xe3a03301, //             mov  r3, #0x04000000
      0xe2833c02, //             add  r3, r3, #0x200
      0xe3a04001, //             mov  r4, #1
      0xe1c340b2, //             strh r4, [r3, #2]      IF: acknowledge VBlank
      0xe12fff1e, //             bx   lr
    );
    const gba = boot(words);
    gba.bus.write32(0x03007ffc, 0x08000100);
    gba.bus.write16(0x04000200, 1); // IE: VBlank
    gba.bus.write16(0x04000208, 1); // IME
    gba.interrupts.requestInterrupt(1);
    gba.runScanline();
    expect(gba.bus.read32(0x03000000)).toBe(0xe25ef004);
    expect(gba.armCpu.registers[15]! >>> 24).toBe(0x08); // back in the spin loop
    expect(gba.bus.read32(0)).toBe(0xe55ec002);
  });

  it('answers while the CPU executes in the BIOS, and a debugger’s peek always', () => {
    const bus = new GbaSystemBus(); // no CPU connected: the bus sees one held in reset, at PC 0
    bus.writeBios32(0x10, 0x12345678);
    expect(bus.read32(0x10)).toBe(0x12345678);
    const gba = boot([0xeafffffe]);
    gba.bus.writeBios32(0x10, 0x12345678);
    expect(gba.bus.read32(0x10)).toBe(0xe129f000);
    expect(Array.from(gba.bus.peek(0x10, 4).data)).toEqual([0x78, 0x56, 0x34, 0x12]);
  });

  it('a script disassembles the BIOS as stored, wherever the CPU runs', () => {
    const gba = boot([0xeafffffe]);
    const engine = new ScriptingEngine(gba, stubHost);
    expect(engine.disassemble(0x94, 1, 'arm')[0]!.instruction).toBe(disassembleArm(0xe25ef004, 0x94));
  });

  it('a script reads memory as stored: the BIOS wherever the CPU runs, a write-only register as written', () => {
    const gba = boot([0xeafffffe]);
    gba.bus.writeBios32(0x10, 0x12345678);
    gba.bus.write16(0x04000010, 0x0123); // BG0HOFS, which the CPU reads as open bus
    const engine = new ScriptingEngine(gba, stubHost);
    let hits = 0;
    gba.bus.addReadWatchpoint(0x00000000, 0x4000, () => hits++);
    expect(engine.read32(0x10)).toBe(0x12345678);
    expect(Array.from(engine.getMemory(0x10, 4))).toEqual([0x78, 0x56, 0x34, 0x12]);
    expect(engine.readBytes(0x11, 2)).toBe(0x3456);
    expect(engine.read16(0x04000010)).toBe(0x0123);
    expect(hits).toBe(0); // a script's read is not the program's
  });
});

describe('the cartridge past its end', () => {
  it('reads the halfword address the bus last carried, (address / 2) & 0xFFFF', () => {
    const bus = new GbaSystemBus();
    bus.loadRom(new Uint8Array(16));
    expect(bus.read16(0x08000010)).toBe(0x0008);
    expect(bus.read16(0x08100002)).toBe(0x0001);
    expect(bus.read32(0x08100004)).toBe(0x00030002);
    expect(bus.read8(0x08100002)).toBe(0x01);
    expect(bus.read8(0x08100003)).toBe(0x00);
    expect(bus.read16(0x0a100002)).toBe(0x0001); // a wait-state mirror, same lines
  });
});

describe('VRAM above 96 KB', () => {
  function busInMode(mode: number): GbaSystemBus {
    const bus = new GbaSystemBus();
    bus.write16(0x04000000, mode);
    return bus;
  }

  it('mirrors OBJ VRAM in the tile modes', () => {
    const bus = busInMode(0);
    bus.write16(0x06018000, 0x1234);
    expect(bus.read16(0x06010000)).toBe(0x1234);
    expect(bus.read16(0x06018000)).toBe(0x1234);
  });

  it('in the bitmap modes, leaves 0x06018000-0x0601BFFF unmapped: reads 0, writes dropped', () => {
    const bus = busInMode(3);
    bus.write16(0x06010000, 0x5555);
    bus.write16(0x06018000, 0x1234);
    bus.write32(0x0601bffc, 0x89abcdef);
    expect(bus.read16(0x06010000)).toBe(0x5555);
    expect(bus.read16(0x06018000)).toBe(0);
    expect(bus.read32(0x0601bffc)).toBe(0);
    expect(bus.vram[0x13ffc]).toBe(0);
    // the second half still mirrors OBJ VRAM at 0x14000
    bus.write16(0x0601c000, 0x5678);
    expect(bus.read16(0x06014000)).toBe(0x5678);
  });
});
