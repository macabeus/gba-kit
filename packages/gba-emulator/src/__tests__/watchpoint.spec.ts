import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { ScriptingEngine, type ScriptingHost } from '../scripting.js';
import { GbaSystemBus, type WatchpointWrite } from '../system-bus.js';

const here = dirname(fileURLToPath(import.meta.url));
const AGBCC_ELF = join(here, '..', '..', '..', 'debug-info', 'test-projects', 'agbcc-min', 'build', 'min.elf');

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
      { address: 0x03005220, value: 2, size: 1, dmaChannel: -1, dmaOrigin: null },
      { address: 0x03005220, value: 0x1234, size: 2, dmaChannel: -1, dmaOrigin: null },
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

  it('matches writes that reach the watched byte through a region mirror', () => {
    const bus = new GbaSystemBus();
    const hits: number[] = [];
    bus.addWriteWatchpoint(0x05000010, 2, (info) => hits.push(info.address)); // canonical palette addr

    bus.write16(0x05000010, 0x1111); // direct
    bus.write16(0x05000410, 0x2222); // palette mirror (offset & 0x3ff) -> same physical byte

    expect(hits).toEqual([0x05000010, 0x05000010]); // both report the canonical address
  });

  it('does NOT fire for EEPROM serial writes (no addressable byte)', () => {
    const bus = new GbaSystemBus();
    let count = 0;
    bus.addWriteWatchpoint(0x0d000000, 4, () => count++);

    bus.write16(0x0d000000, 1);
    bus.write32(0x0d000000, 1);
    expect(count).toBe(0);
  });

  it('attributes DMA writes to a dma channel + start origin, then back to the CPU', () => {
    const bus = new GbaSystemBus();
    const hits: Array<Pick<WatchpointWrite, 'dmaChannel' | 'dmaOrigin'>> = [];
    bus.addWriteWatchpoint(0x02000000, 1, ({ dmaChannel, dmaOrigin }) => hits.push({ dmaChannel, dmaOrigin }));

    // Emulate what the DMA controller does: mark the source around its writes.
    const origin = { pc: 0x08001234, instructionAddress: 0x08001232, thumb: true };
    bus.setDmaSource(3, origin);
    bus.write16(0x02000000, 0xabcd);
    bus.clearDmaSource();
    // ...and a plain CPU write afterwards.
    bus.write16(0x02000000, 0x0001);

    expect(hits).toEqual([
      { dmaChannel: 3, dmaOrigin: origin },
      { dmaChannel: -1, dmaOrigin: null },
    ]);
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
    expect(hits[0]!.dmaChannel).toBe(3);
    // The store to DMA3CNT_H was at pc-2 (Thumb).
    expect(hits[0]!.dmaOrigin).toEqual({ pc: 0x08001236, instructionAddress: 0x08001234, thumb: true });
    expect(hits[0]!.value).toBe(0xbeef);
  });

  it('still performs the DMA copy when no watchpoint is set (source-tag work is skipped)', () => {
    const gba = new Gba();
    const bus = gba.bus;
    expect(bus.hasWatchpoints()).toBe(false);

    bus.write16(0x02000000, 0xcafe);
    bus.write32(0x040000d4, 0x02000000); // DMA3SAD
    bus.write32(0x040000d8, 0x02000100); // DMA3DAD
    bus.write16(0x040000dc, 1);
    bus.write16(0x040000de, 0x8000); // enable immediate

    expect(bus.read16(0x02000100)).toBe(0xcafe); // copy still happens
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

describe('ScriptingEngine watchMemory maxHits', () => {
  it('reports the writes it dropped, so a full array is not read as the whole story', () => {
    const gba = new Gba();
    const engine = new ScriptingEngine(gba, stubHost);
    const w = engine.watchMemory({ address: 0x03000000, length: 4, maxHits: 2 });
    for (let i = 0; i < 10; i++) {
      gba.bus.write8(0x03000000, i);
    }
    w.stop();
    expect(w.hits).toHaveLength(2);
    expect(w.dropped).toBe(8);
  });

  it('reports zero drops when nothing was capped', () => {
    const gba = new Gba();
    const engine = new ScriptingEngine(gba, stubHost);
    const w = engine.watchMemory({ address: 0x03000000, length: 4 });
    for (let i = 0; i < 10; i++) {
      gba.bus.write8(0x03000000, i);
    }
    w.stop();
    expect(w.hits).toHaveLength(10);
    expect(w.dropped).toBe(0);
  });
});

// ─── Execution watchpoints (scripting engine) ────────────────────────

describe('ScriptingEngine watchExecution', () => {
  const BASE = 0x02000000;

  /** A Gba whose CPU loops over three Thumb instructions at BASE. */
  function loopingGba(): Gba {
    const gba = new Gba();
    // nop; nop; b -4 (see arm-emulator/src/__tests__/exec-watchpoint.spec.ts).
    [0x46c0, 0x46c0, 0xe7fc].forEach((instr, i) => {
      gba.bus.write16(BASE + i * 2, instr);
    });
    gba.armCpu.registers[15] = BASE;
    gba.armCpu.setT(true);
    return gba;
  }

  function step(gba: Gba, n: number): void {
    for (let i = 0; i < n; i++) {
      gba.armCpu.step();
    }
  }

  it('counts every execution, and zero means it did not run', () => {
    const gba = loopingGba();
    const engine = new ScriptingEngine(gba, stubHost);
    const ran = engine.watchExecution(BASE);
    const never = engine.watchExecution(BASE + 0x100);
    step(gba, 30);
    ran.stop();
    never.stop();
    expect(ran.count).toBe(10);
    expect(ran.hits).toHaveLength(10);
    expect(ran.dropped).toBe(0);
    // The zero is only meaningful because the count above is not zero.
    expect(never.count).toBe(0);
  });

  it('keeps the count exact under maxHits and says what it dropped', () => {
    const gba = loopingGba();
    const engine = new ScriptingEngine(gba, stubHost);
    const w = engine.watchExecution(BASE, { maxHits: 3 });
    step(gba, 30);
    w.stop();
    expect(w.hits).toHaveLength(3);
    expect(w.count).toBe(10); // the cap bounds memory, not the finding
    expect(w.dropped).toBe(7);
    expect(w.hits.length + w.dropped).toBe(w.count);
  });

  it('records the caller’s return address', () => {
    const gba = loopingGba();
    gba.armCpu.registers[14] = 0x08001234;
    const engine = new ScriptingEngine(gba, stubHost);
    const w = engine.watchExecution(BASE);
    step(gba, 3);
    w.stop();
    expect(w.hits[0]).toMatchObject({ address: BASE, lr: 0x08001234, thumb: true });
  });

  it('stops recording after stop()', () => {
    const gba = loopingGba();
    const engine = new ScriptingEngine(gba, stubHost);
    const w = engine.watchExecution(BASE);
    step(gba, 15);
    const atStop = w.count;
    w.stop();
    step(gba, 15);
    expect(atStop).toBeGreaterThan(0);
    expect(w.count).toBe(atStop);
  });

  it('needs debug info to accept a symbol name', () => {
    const engine = new ScriptingEngine(loopingGba(), stubHost);
    expect(() => engine.watchExecution('SomeFunction')).toThrow(/requires debug info/);
  });
});

describe('addressing code and data by number or name', () => {
  const BASE = 0x02000000;

  it('clears the Thumb bit on a numeric code address', () => {
    // A Thumb function POINTER carries bit 0 set — read32 of a callback table returns
    // exactly that. Left set, the watchpoint address is odd and never matches, so the
    // function reads as never executed.
    const gba = new Gba();
    [0x46c0, 0x46c0, 0xe7fc].forEach((instr, i) => gba.bus.write16(BASE + i * 2, instr));
    gba.armCpu.registers[15] = BASE;
    gba.armCpu.setT(true);
    const engine = new ScriptingEngine(gba, stubHost);

    const even = engine.watchExecution(BASE);
    const asPointer = engine.watchExecution(BASE | 1);
    for (let i = 0; i < 30; i++) {
      gba.armCpu.step();
    }
    even.stop();
    asPointer.stop();
    expect(even.count).toBe(10);
    expect(asPointer.count).toBe(10); // the same instruction, addressed as a pointer
  });

  it('watchMemory takes a symbol and watches the whole object', () => {
    const gba = new Gba();
    const engine = new ScriptingEngine(gba, stubHost);
    engine.loadDebugInfo(new Uint8Array(readFileSync(AGBCC_ELF)));
    const probe = engine.symbolToAddress('g_probe')!;
    const extent = engine.symbolExtent('g_probe')!;

    expect(extent.size).toBeGreaterThan(1); // otherwise this proves nothing

    const w = engine.watchMemory({ address: 'g_probe' }); // no explicit length
    gba.bus.write8(probe, 1); // first byte
    gba.bus.write8(probe + extent.size - 1, 2); // last byte — only caught if the
    gba.bus.write8(probe + extent.size, 3); // default length is the whole object
    w.stop();
    expect(w.hits.map((h) => h.address)).toEqual([probe, probe + extent.size - 1]);
  });

  it('refuses an unknown symbol rather than watching nothing', () => {
    const engine = new ScriptingEngine(new Gba(), stubHost);
    engine.loadDebugInfo(new Uint8Array(readFileSync(AGBCC_ELF)));
    expect(() => engine.watchMemory({ address: 'no_such_global' })).toThrow(/unknown symbol/);
  });

  it('needs debug info before it can take a name', () => {
    const engine = new ScriptingEngine(new Gba(), stubHost);
    expect(() => engine.watchMemory({ address: 'g_probe' })).toThrow(/requires debug info/);
  });
});
