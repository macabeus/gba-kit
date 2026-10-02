/**
 * Timer control and reload writes on a running timer (GBATEK "Timers"; mGBA timer.c
 * GBATimerWriteTMCNT_HI; mgba-suite src/timer-irq.c). A counter read sees the count 2 cycles
 * before the clock (timers.ts READ_OFFSET).
 */
import { describe, expect, it } from 'vitest';

import { InterruptController } from '../interrupts.js';
import { Scheduler } from '../scheduler.js';
import { TimerController } from '../timers.js';
import { EventId } from '../types.js';

const ENABLE = 0x80;
const CASCADE = 0x04;

function timers(): { scheduler: Scheduler; timers: TimerController } {
  const scheduler = new Scheduler();
  return { scheduler, timers: new TimerController(scheduler, new InterruptController(scheduler)) };
}

describe('a running timer', () => {
  it('switched from prescaler 1024 to 1 keeps its count and goes on at the new rate', () => {
    const { scheduler, timers: t } = timers();
    t.writeControl(0, ENABLE | 3);
    scheduler.tick(15 * 1024 + 500);
    const switchedAt = scheduler.currentCycle;
    t.writeControl(0, ENABLE);
    scheduler.tick(1232);
    expect(t.readCounter(0)).toBe(15 + 1232 - 2);
    // The overflow comes 0x10000 - 15 cycles after the switch, serviced 2 cycles later.
    expect(scheduler.dueCycle(EventId.Timer0Overflow)).toBe(switchedAt + 0x10000 - 15 + 2);
  });

  it('switched to count-up stops counting on its own', () => {
    const { scheduler, timers: t } = timers();
    t.writeReload(1, 0xfff0);
    t.writeControl(1, ENABLE);
    scheduler.tick(5);
    t.writeControl(1, ENABLE | CASCADE);
    expect(scheduler.isScheduled(EventId.Timer1Overflow)).toBe(false);
    const count = t.readCounter(1);
    scheduler.tick(1000);
    expect(t.readCounter(1)).toBe(count);
  });

  it('an overflow before a reload write reloads the old value, one in the write’s cycle the new one', () => {
    // mgba-suite timer-irq.c "FFFF": TM0 starts at FFFF, TM0CNT_L becomes 0 two cycles later, and
    // the counter reads 0 right after. The overflow at cycle 1 took FFFF, the one at cycle 2 took 0.
    const { scheduler, timers: t } = timers();
    t.writeReload(0, 0xffff);
    t.writeControl(0, ENABLE);
    scheduler.advance(2);
    t.writeReload(0, 0);
    scheduler.tick(4);
    expect(t.readCounter(0)).toBe(2);
  });

  it('a reload write services the past overflows of the timer that drives a count-up chain', () => {
    const { scheduler, timers: t } = timers();
    t.writeReload(0, 0xffff);
    t.writeReload(1, 0xfffe);
    t.writeControl(1, ENABLE | CASCADE);
    t.writeControl(0, ENABLE);
    scheduler.advance(3);
    // TM0 overflowed at cycles 1 and 2, before this write: TM1 went FFFE -> FFFF -> overflow,
    // reloading FFFE. Stopping TM0 in the same cycle counts its overflow at cycle 3 too.
    t.writeReload(1, 0);
    t.writeControl(0, 0);
    expect(t.readCounter(1)).toBe(0xffff);
  });
});
