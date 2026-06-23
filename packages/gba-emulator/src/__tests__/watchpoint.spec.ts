import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { ScriptingEngine, type ScriptingHost } from '../scripting.js';
import { GbaSystemBus, type WatchpointWrite } from '../system-bus.js';
import type { WriteSource } from '../write-source.js';

const stubHost: ScriptingHost = {
  writeScreenshot: async () => {},
  writeMemorySnapshot: async () => {},
  writeSaveState: async () => {},
  readSaveState: async () => {
    throw new Error('not used');
  },
  log: () => {},
};

// ─── Data watchpoints (system bus) ───────────────────────────────────

describe('GbaSystemBus write watchpoints', () => {
  it('fires for committed writes that overlap the watched range, attributed to the CPU', () => {
    const bus = new GbaSystemBus();
    const hits: WatchpointWrite[] = [];
    bus.addWriteWatchpoint(0x03005220, 1, (info) => hits.push(info));

    bus.write8(0x03005220, 2); // hit
    bus.write8(0x03005221, 9); // adjacent byte — no hit
    bus.write16(0x03005220, 0x1234); // hit (size 2)

    expect(hits).toEqual([
      { address: 0x03005220, value: 2, size: 1, source: { kind: 'cpu' } },
      { address: 0x03005220, value: 0x1234, size: 2, source: { kind: 'cpu' } },
    ]);
  });

  it('reports the specific watched byte for a wide write that straddles into it', () => {
    const bus = new GbaSystemBus();
    const hits: number[] = [];
    bus.addWriteWatchpoint(0x03000003, 1, (info) => hits.push(info.address));

    bus.write32(0x03000000, 0xdeadbeef); // covers 0x00..0x03 -> overlaps 0x03
    expect(hits).toEqual([0x03000003]); // not the access base 0x03000000
  });

  it('masks the reported value to the access size', () => {
    const bus = new GbaSystemBus();
    const hits: WatchpointWrite[] = [];
    bus.addWriteWatchpoint(0x03000000, 1, (info) => hits.push(info));

    bus.write8(0x03000000, 0x1ff); // only 0xff lands in memory
    expect(hits[0]!.value).toBe(0xff);
    expect(bus.read8(0x03000000)).toBe(0xff);
  });

  it('does NOT fire for writes the hardware ignores (8-bit write to OAM)', () => {
    const bus = new GbaSystemBus();
    let count = 0;
    bus.addWriteWatchpoint(0x07000000, 4, () => count++);

    bus.write8(0x07000000, 0x12); // OAM ignores 8-bit writes -> no commit -> no hit
    expect(count).toBe(0);

    bus.write16(0x07000000, 0x1234); // 16-bit OAM write commits -> hit
    expect(count).toBe(1);
  });

  it('clamps length < 1 so the start byte is still watched', () => {
    const bus = new GbaSystemBus();
    let count = 0;
    bus.addWriteWatchpoint(0x02000000, 0, () => count++);

    bus.write8(0x02000000, 1);
    expect(count).toBe(1);
  });

  it('is iteration-safe when a callback clears watchpoints mid-write', () => {
    const bus = new GbaSystemBus();
    const order: string[] = [];
    bus.addWriteWatchpoint(0x02000000, 1, () => {
      order.push('a');
      bus.clearWriteWatchpoints(); // dispose mid-notify
    });
    bus.addWriteWatchpoint(0x02000000, 1, () => order.push('b'));

    // Both registered watchpoints overlap this write; clearing inside 'a' must
    // not skip 'b' for this same store (snapshot iteration).
    expect(() => bus.write8(0x02000000, 1)).not.toThrow();
    expect(order).toEqual(['a', 'b']);
    // After the clear, no further hits.
    bus.write8(0x02000000, 1);
    expect(order).toEqual(['a', 'b']);
  });

  it('attributes DMA writes to a dma source with the channel and start origin', () => {
    const bus = new GbaSystemBus();
    const hits: WriteSource[] = [];
    bus.addWriteWatchpoint(0x02000000, 1, (info) => hits.push(info.source));

    // Emulate what the DMA controller does: writes wrapped in a dma source.
    const origin = { pc: 0x08001234, instructionAddress: 0x08001232, thumb: true };
    bus.runWithWriteSource({ kind: 'dma', channel: 3, origin }, () => {
      bus.write16(0x02000000, 0xabcd);
    });
    // ...and a plain CPU write outside the wrapper.
    bus.write16(0x02000000, 0x0001);

    expect(hits).toEqual([{ kind: 'dma', channel: 3, origin }, { kind: 'cpu' }]);
  });

  it('end-to-end: a real immediate DMA write is attributed to the channel + start instruction', () => {
    const gba = new Gba();
    const bus = gba.bus;

    // Pretend the CPU is mid-Thumb-instruction at this PC when it kicks the DMA.
    gba.armCpu.registers[15] = 0x08001236;
    gba.armCpu.cpsr |= 0x20; // Thumb (CPSR_T)

    // Source word in EWRAM, watch the destination.
    bus.write16(0x02000000, 0xbeef);
    const hits: WatchpointWrite[] = [];
    bus.addWriteWatchpoint(0x02000100, 2, (info) => hits.push(info));

    // Program DMA3: SAD, DAD, count=1 (16-bit), then enable immediate -> runs now.
    bus.write32(0x040000d4, 0x02000000); // DMA3SAD
    bus.write32(0x040000d8, 0x02000100); // DMA3DAD
    bus.write16(0x040000dc, 1); // DMA3CNT_L (1 unit)
    bus.write16(0x040000de, 0x8000); // DMA3CNT_H: enable | immediate | 16-bit

    expect(bus.read16(0x02000100)).toBe(0xbeef); // copy happened
    expect(hits).toHaveLength(1);
    expect(hits[0]!.source).toEqual({
      kind: 'dma',
      channel: 3,
      // The store to DMA3CNT_H was at pc-2 (Thumb).
      origin: { pc: 0x08001236, instructionAddress: 0x08001234, thumb: true },
    });
    expect(hits[0]!.value).toBe(0xbeef);
  });
});

describe('ScriptingEngine watchMemory', () => {
  it('reads Thumb state from the CPU (no reliance on the optional cpuCpsr callback)', () => {
    const gba = new Gba();
    const engine = new ScriptingEngine(gba, stubHost);
    // cpuCpsr is intentionally left unwired; armCpu is in Thumb at a known PC.
    gba.armCpu.registers[15] = 0x08000100;
    gba.armCpu.cpsr |= 0x20; // Thumb

    const w = engine.watchMemory({ address: 0x03000000 });
    gba.bus.write8(0x03000000, 7);

    expect(w.hits).toHaveLength(1);
    expect(w.hits[0]!.thumb).toBe(true);
    expect(w.hits[0]!.instructionAddress).toBe(0x080000fe); // pc - 2 (Thumb)
    w.stop();
  });

  it('caps recorded hits at maxHits', () => {
    const gba = new Gba();
    const engine = new ScriptingEngine(gba, stubHost);
    const w = engine.watchMemory({ address: 0x03000000, maxHits: 2 });
    for (let i = 0; i < 5; i++) {
      gba.bus.write8(0x03000000, i);
    }
    expect(w.hits).toHaveLength(2);
    w.stop();
  });

  it('clearWatchpoints() removes only watchpoints this engine created', () => {
    const gba = new Gba();
    const engine = new ScriptingEngine(gba, stubHost);

    const a = engine.watchMemory({ address: 0x03000000 });
    const b = engine.watchMemory({ address: 0x03000000 });
    // A watchpoint registered directly on the bus (e.g. another engine) must survive.
    let busCount = 0;
    gba.bus.addWriteWatchpoint(0x03000000, 1, () => busCount++);

    engine.clearWatchpoints();
    gba.bus.write8(0x03000000, 1);

    expect(a.hits).toHaveLength(0);
    expect(b.hits).toHaveLength(0);
    expect(busCount).toBe(1); // foreign watchpoint untouched
  });
});
