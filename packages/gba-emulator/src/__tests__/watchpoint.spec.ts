import { describe, expect, it } from 'vitest';

import { GbaSystemBus } from '../system-bus.js';

// ─── Data watchpoints (system bus) ───────────────────────────────────

describe('GbaSystemBus write watchpoints', () => {
  it('fires for writes that overlap the watched range, with address/value/size', () => {
    const bus = new GbaSystemBus();
    const hits: Array<{ address: number; value: number; size: number }> = [];
    bus.addWriteWatchpoint(0x03005220, 1, (info) => hits.push(info));

    bus.write8(0x03005220, 2); // hit
    bus.write8(0x03005221, 9); // adjacent byte — no hit
    bus.write16(0x03005220, 0x1234); // hit (size 2)

    expect(hits).toEqual([
      { address: 0x03005220, value: 2, size: 1 },
      { address: 0x03005220, value: 0x1234, size: 2 },
    ]);
  });

  it('detects a wide write that straddles into the watched byte', () => {
    const bus = new GbaSystemBus();
    const hits: number[] = [];
    bus.addWriteWatchpoint(0x03000003, 1, (info) => hits.push(info.address));

    bus.write32(0x03000000, 0xdeadbeef); // covers 0x00..0x03 -> overlaps 0x03
    expect(hits).toEqual([0x03000000]);
  });

  it('stops firing after the disposer runs and after clearWriteWatchpoints()', () => {
    const bus = new GbaSystemBus();
    let count = 0;
    const dispose = bus.addWriteWatchpoint(0x02000000, 4, () => count++);

    bus.write8(0x02000000, 1);
    expect(count).toBe(1);

    dispose();
    bus.write8(0x02000000, 1);
    expect(count).toBe(1);

    bus.addWriteWatchpoint(0x02000000, 4, () => count++);
    bus.clearWriteWatchpoints();
    bus.write8(0x02000000, 1);
    expect(count).toBe(1);
  });
});
