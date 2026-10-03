/**
 * DMA channel rules: the enable edge that latches SAD/DAD/CNT_L, the game pak ROM source that
 * always increments, the channel's data latch for sources it cannot read, the sound FIFO request
 * and DMA3 video capture. Expected values follow GBATEK "DMA Transfers" and the hardware results
 * of mgba-suite src/dma.c.
 */
import { describe, expect, it } from 'vitest';

import { DmaController, type DmaMemoryAccess } from '../dma.js';
import { Gba } from '../gba.js';
import { InterruptController } from '../interrupts.js';
import { Scheduler } from '../scheduler.js';
import { CYCLES_PER_FRAME, CYCLES_PER_SCANLINE, MMIO } from '../types.js';

const ROM = 0x08000000;
const EWRAM = 0x02000000;
const IWRAM = 0x03000000;
const VRAM = 0x06000000;

const ENABLE = 0x8000;
const IRQ = 0x4000;
const HBLANK = 2 << 12;
const SPECIAL = 3 << 12;
const WORD = 1 << 10;
const REPEAT = 1 << 9;
const SRC_DECREMENT = 1 << 7;
const SRC_FIXED = 2 << 7;
const DST_FIXED = 2 << 5;

/** DMAx registers: SAD, DAD, CNT_L, CNT_H. */
function registers(channel: number): { sad: number; dad: number; cntL: number; cntH: number } {
  const base = 0x040000b0 + channel * 12;
  return { sad: base, dad: base + 4, cntL: base + 8, cntH: base + 10 };
}

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

/** Program and start a channel through its registers, then let the transfer run. */
function transfer(gba: Gba, channel: number, sad: number, dad: number, count: number, control: number): void {
  const r = registers(channel);
  gba.bus.write32(r.sad, sad);
  gba.bus.write32(r.dad, dad);
  gba.bus.write16(r.cntL, count);
  gba.bus.write16(r.cntH, control | ENABLE);
  gba.scheduler.tick(200);
}

describe('the enable edge', () => {
  /** DMA3 copies one halfword of a table to a fixed IWRAM address at each HBlank. */
  function hblankCopy(): Gba {
    const gba = new Gba();
    for (let i = 0; i < 16; i++) {
      gba.bus.write16(EWRAM + i * 2, 0x100 + i);
    }
    const r = registers(3);
    gba.bus.write32(r.sad, EWRAM);
    gba.bus.write32(r.dad, IWRAM);
    gba.bus.write16(r.cntL, 1);
    gba.bus.write16(r.cntH, ENABLE | HBLANK | REPEAT | DST_FIXED);
    return gba;
  }

  it('rewriting CNT_H of a running channel leaves its addresses where the transfer brought them', () => {
    const gba = hblankCopy();
    gba.scheduler.tick(3 * CYCLES_PER_SCANLINE);
    expect(gba.bus.read16(IWRAM)).toBe(0x102);
    expect(gba.dma.serialize().channels[3]!.srcAddr).toBe(EWRAM + 6);

    gba.bus.write16(registers(3).cntH, ENABLE | HBLANK | REPEAT | DST_FIXED);
    expect(gba.dma.serialize().channels[3]!.srcAddr).toBe(EWRAM + 6);
    gba.scheduler.tick(CYCLES_PER_SCANLINE);
    expect(gba.bus.read16(IWRAM)).toBe(0x103);
  });

  it('clearing the enable bit and setting it again reloads SAD', () => {
    const gba = hblankCopy();
    gba.scheduler.tick(3 * CYCLES_PER_SCANLINE);
    gba.bus.write16(registers(3).cntH, HBLANK | REPEAT | DST_FIXED);
    gba.bus.write16(registers(3).cntH, ENABLE | HBLANK | REPEAT | DST_FIXED);
    gba.scheduler.tick(CYCLES_PER_SCANLINE);
    expect(gba.bus.read16(IWRAM)).toBe(0x100);
  });

  it('rewriting an immediate channel before it starts runs it once', () => {
    const gba = new Gba();
    let transfers = 0;
    gba.dma.onTransfer = () => transfers++;
    const r = registers(3);
    gba.bus.write32(r.sad, EWRAM);
    gba.bus.write32(r.dad, IWRAM);
    gba.bus.write16(r.cntL, 4);
    gba.bus.write16(r.cntH, ENABLE);
    gba.bus.write16(r.cntH, ENABLE | IRQ);
    gba.scheduler.tick(100);
    expect(transfers).toBe(1);
  });
});

describe('sources', () => {
  const TABLE = [0xdeadbeec, 0xdeadbeed, 0xdeadbeee, 0xdeadbeef, 0xdeadbef0, 0xdeadbef1, 0xdeadbef2];

  it('a game pak ROM source increments whatever its address control says (mgba-suite "=ROM", "-ROM")', () => {
    for (const srcControl of [SRC_FIXED, SRC_DECREMENT]) {
      const gba = new Gba();
      gba.loadRom(romOf(TABLE));
      transfer(gba, 3, ROM + 12, IWRAM, 4, WORD | DST_FIXED | srcControl);
      expect(gba.bus.read32(IWRAM)).toBe(0xdeadbef2);
      expect(gba.dma.serialize().channels[3]!.srcAddr).toBe(ROM + 28);
    }
  });

  it('a decrementing source outside the ROM decrements', () => {
    const gba = new Gba();
    TABLE.forEach((w, i) => gba.bus.write32(EWRAM + i * 4, w));
    transfer(gba, 3, EWRAM + 12, IWRAM, 4, WORD | DST_FIXED | SRC_DECREMENT);
    expect(gba.bus.read32(IWRAM)).toBe(0xdeadbeec);
  });

  it('DMA0 sees 27 address bits, so a ROM source is the BIOS region and the channel writes its latch', () => {
    const gba = new Gba();
    gba.loadRom(romOf(TABLE));
    gba.bus.write32(IWRAM + 0x100, 0xcafebabe);
    transfer(gba, 0, IWRAM + 0x100, IWRAM, 1, WORD);
    transfer(gba, 0, ROM, IWRAM + 0x10, 4, WORD);
    expect([0, 4, 8, 12].map((o) => gba.bus.read32(IWRAM + 0x10 + o))).toEqual(Array(4).fill(0xcafebabe));
  });

  it('a BIOS source gives the latch; a 16-bit unit takes the latch half that the destination selects', () => {
    const gba = new Gba();
    gba.bus.write32(IWRAM + 0x100, 0xcafebabe);
    transfer(gba, 1, IWRAM + 0x100, IWRAM, 1, WORD); // a 32-bit read fills the latch
    transfer(gba, 1, 0x10, IWRAM + 0x20, 2, 0); // 16-bit, from the BIOS
    expect(gba.bus.read32(IWRAM + 0x20)).toBe(0xcafebabe);
    // A 16-bit read fills both halves (mgba-suite "+BIOS": 0xCAFECAFE after a 16-bit DMA).
    transfer(gba, 1, IWRAM + 0x102, IWRAM, 1, 0);
    transfer(gba, 1, 0x10, IWRAM + 0x30, 1, WORD);
    expect(gba.bus.read32(IWRAM + 0x30)).toBe(0xcafecafe);
  });

  it('the latch survives a snapshot; an old snapshot without it restores 0', () => {
    const gba = new Gba();
    gba.bus.write32(IWRAM + 0x100, 0x12345678);
    transfer(gba, 2, IWRAM + 0x100, IWRAM, 1, WORD);
    const snap = gba.serialize();
    expect(snap.dma.channels[2]!.latch).toBe(0x12345678);

    const fresh = new Gba();
    fresh.deserialize(snap);
    transfer(fresh, 2, 0, IWRAM + 0x10, 1, WORD);
    expect(fresh.bus.read32(IWRAM + 0x10)).toBe(0x12345678);

    const legacy = { ...snap, dma: { channels: snap.dma.channels.map((c) => ({ ...c })) } };
    delete legacy.dma.channels[2]!.latch;
    fresh.deserialize(legacy);
    transfer(fresh, 2, 0, IWRAM + 0x10, 1, WORD);
    expect(fresh.bus.read32(IWRAM + 0x10)).toBe(0);
  });
});

describe('sound FIFO DMA', () => {
  /** A controller over a memory whose words read as their address and whose writes are logged. */
  function controller(): { dma: DmaController; writes: [number, number][] } {
    const scheduler = new Scheduler();
    const dma = new DmaController(scheduler, new InterruptController(scheduler));
    const writes: [number, number][] = [];
    const memory: DmaMemoryAccess = {
      read16: (a) => a & 0xffff,
      read32: (a) => a >>> 0,
      write16: (a, v) => writes.push([a, v]),
      write32: (a, v) => writes.push([a, v]),
      dataCycles: () => 1,
      idle: () => {},
    };
    dma.setMemoryAccess(memory);
    return { dma, writes };
  }

  function program(dma: DmaController, index: number, sad: number, dad: number, control: number): void {
    dma.writeSrcAddr(index, sad);
    dma.writeDstAddr(index, dad);
    dma.writeControl(index, control | ENABLE | SPECIAL);
  }

  it('the channel whose destination is the FIFO answers its request, with 4 words', () => {
    const { dma, writes } = controller();
    program(dma, 1, EWRAM + 0x100, MMIO.FIFO_B, REPEAT | WORD);
    program(dma, 2, EWRAM, MMIO.FIFO_A, REPEAT | WORD);
    dma.requestSoundFifo(MMIO.FIFO_A);
    expect(writes).toEqual([
      [MMIO.FIFO_A, EWRAM],
      [MMIO.FIFO_A, EWRAM + 4],
      [MMIO.FIFO_A, EWRAM + 8],
      [MMIO.FIFO_A, EWRAM + 12],
    ]);
    dma.requestSoundFifo(MMIO.FIFO_B);
    expect(writes.slice(4).map(([a]) => a)).toEqual(Array(4).fill(MMIO.FIFO_B));
  });

  it('moves words even when the width bit says 16, from a word-aligned source', () => {
    const { dma, writes } = controller();
    program(dma, 1, EWRAM + 2, MMIO.FIFO_A, REPEAT);
    dma.requestSoundFifo(MMIO.FIFO_A);
    expect(writes[0]).toEqual([MMIO.FIFO_A, EWRAM]);
    expect(writes[3]).toEqual([MMIO.FIFO_A, EWRAM + 12]);
  });

  it('without the repeat bit the channel serves one request and turns itself off', () => {
    const { dma, writes } = controller();
    program(dma, 1, EWRAM, MMIO.FIFO_A, WORD);
    dma.requestSoundFifo(MMIO.FIFO_A);
    dma.requestSoundFifo(MMIO.FIFO_A);
    expect(writes).toHaveLength(4);
    expect(dma.readControl(1) & ENABLE).toBe(0);
  });
});

describe('video capture', () => {
  it('DMA3 in Special timing runs on lines 2-161 and the hardware turns it off at line 162', () => {
    const gba = new Gba();
    const lines: number[] = [];
    gba.dma.onTransfer = (channel) => {
      if (channel === 3) {
        lines.push(gba.scanline);
      }
    };
    const r = registers(3);
    gba.bus.write32(r.sad, EWRAM);
    gba.bus.write32(r.dad, VRAM);
    gba.bus.write16(r.cntL, 120);
    gba.bus.write16(r.cntH, ENABLE | SPECIAL | REPEAT);
    gba.scheduler.tick(CYCLES_PER_FRAME);
    expect(lines).toEqual(Array.from({ length: 160 }, (_, i) => i + 2));
    expect(gba.bus.read16(r.cntH) & ENABLE).toBe(0);
  });
});
