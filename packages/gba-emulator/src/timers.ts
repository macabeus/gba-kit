/**
 * GBA Timer Controller
 *
 * 4 independent 16-bit timers. Each can use a prescaler divider
 * or cascade (increment when the previous timer overflows).
 * Timers 0/1 drive DirectSound sample rates.
 */
import type { InterruptController } from './interrupts.js';
import type { TimerSnapshot } from './savestate.js';
import type { Scheduler } from './scheduler.js';
import { EventId, IrqFlag, TIMER_PRESCALERS } from './types.js';

/** State for a single timer channel */
interface TimerChannel {
  /** Current counter value (16-bit, counts up) */
  counter: number;
  /** Reload value (written to counter on overflow or enable) */
  reload: number;
  /** Prescaler index (0-3) → divides CPU_FREQ by 1/64/256/1024 */
  prescaler: number;
  /** Cascade mode: increment when previous timer overflows */
  cascade: boolean;
  /** IRQ on overflow */
  irqEnable: boolean;
  /** Timer is running */
  enabled: boolean;
  /** Cycle count when this timer was last updated (for computing elapsed ticks) */
  lastUpdateCycle: number;
  /** Overflow callback (for DirectSound FIFO) */
  onOverflow?: () => void;
}

const TIMER_EVENT_IDS = [
  EventId.Timer0Overflow,
  EventId.Timer1Overflow,
  EventId.Timer2Overflow,
  EventId.Timer3Overflow,
] as const;

const TIMER_IRQ_FLAGS = [IrqFlag.Timer0, IrqFlag.Timer1, IrqFlag.Timer2, IrqFlag.Timer3] as const;

/**
 * The clock stands at an instruction's first cycle while it runs. A counter read sees the count as
 * of READ_OFFSET cycles earlier, while a control write acts at the clock's cycle, which gives the
 * counts the hardware reads (mGBA io.c GBAIORead, `GBATimerUpdateRegister(gba, 0, 2)`, and
 * GBATimerWriteTMCNT_HI; mgba-suite Timing calibration, "Timer IRQ"). An overflow is serviced once
 * a read can see it, READ_OFFSET cycles after it happens, or earlier when a control write comes
 * after it.
 */
const READ_OFFSET = 2;

export class TimerController {
  readonly #channels: TimerChannel[] = [];
  readonly #scheduler: Scheduler;
  readonly #interrupts: InterruptController;

  constructor(scheduler: Scheduler, interrupts: InterruptController) {
    this.#scheduler = scheduler;
    this.#interrupts = interrupts;

    for (let i = 0; i < 4; i++) {
      this.#channels.push({
        counter: 0,
        reload: 0,
        prescaler: 0,
        cascade: false,
        irqEnable: false,
        enabled: false,
        lastUpdateCycle: 0,
      });
    }
  }

  /** Set an overflow callback for a timer (used by DirectSound). */
  setOverflowCallback(index: number, callback: () => void): void {
    this.#channels[index]!.onOverflow = callback;
  }

  /** Read timer counter (TM0CNT_L etc.): the count as of the read (see READ_OFFSET). */
  readCounter(index: number): number {
    const ch = this.#channels[index]!;
    if (ch.enabled && !ch.cascade) {
      this.#syncCounter(index, this.#scheduler.currentCycle - READ_OFFSET);
    }
    return ch.counter & 0xffff;
  }

  /** The reload value as last written. TMxCNT_L reads the counter, so this is the write side's register. */
  readReload(index: number): number {
    return this.#channels[index]!.reload;
  }

  /** Write timer reload value (TM0CNT_L etc.). Does NOT update running counter. */
  writeReload(index: number, value: number): void {
    this.#channels[index]!.reload = value & 0xffff;
  }

  /** Read timer control (TM0CNT_H etc.). */
  readControl(index: number): number {
    const ch = this.#channels[index]!;
    return (ch.prescaler & 3) | (ch.cascade ? 1 << 2 : 0) | (ch.irqEnable ? 1 << 6 : 0) | (ch.enabled ? 1 << 7 : 0);
  }

  /**
   * Write timer control (TM0CNT_H etc.). Starting a timer loads the reload value and counts from
   * the cycle of the write. A running timer whose prescaler or cascade bit changes keeps the count
   * it has reached and goes on at the new rate (mGBA timer.c GBATimerWriteTMCNT_HI).
   */
  writeControl(index: number, value: number): void {
    const ch = this.#channels[index]!;
    const now = this.#scheduler.currentCycle;
    const wasEnabled = ch.enabled;
    const oldPrescaler = ch.prescaler;
    const oldCascade = ch.cascade;
    if (wasEnabled && !oldCascade) {
      this.#serviceOverflowsBefore(index, now);
      this.#syncCounter(index, now);
    }

    ch.prescaler = value & 3;
    ch.cascade = index > 0 && (value & (1 << 2)) !== 0;
    ch.irqEnable = (value & (1 << 6)) !== 0;
    ch.enabled = (value & (1 << 7)) !== 0;

    if (!wasEnabled && ch.enabled) {
      // Timer just enabled: reload counter
      ch.counter = ch.reload;
      ch.lastUpdateCycle = now;

      if (!ch.cascade) {
        this.#scheduleOverflow(index);
      }
    } else if (wasEnabled && !ch.enabled) {
      // Timer disabled: cancel scheduled overflow
      this.#scheduler.cancel(TIMER_EVENT_IDS[index]!);
    } else if (ch.enabled && (ch.prescaler !== oldPrescaler || ch.cascade !== oldCascade)) {
      ch.lastUpdateCycle = now;
      if (ch.cascade) {
        this.#scheduler.cancel(TIMER_EVENT_IDS[index]!);
      } else {
        this.#scheduleOverflow(index);
      }
    }
  }

  /** Service the overflows that happened by `now` and wait for a read to see them, so a write comes after them. */
  #serviceOverflowsBefore(index: number, now: number): void {
    const id = TIMER_EVENT_IDS[index]!;
    while (this.#scheduler.dueCycle(id) - READ_OFFSET <= now) {
      const overflow = this.#scheduler.dueCycle(id) - READ_OFFSET;
      this.#scheduler.cancel(id);
      this.#onOverflow(index, overflow);
    }
  }

  /** Bring a non-cascade timer's counter up to the cycle `now`. */
  #syncCounter(index: number, now: number): void {
    const ch = this.#channels[index]!;
    const elapsed = now - ch.lastUpdateCycle;
    const prescaler = TIMER_PRESCALERS[ch.prescaler]!;
    const ticks = Math.floor(elapsed / prescaler);

    if (ticks > 0) {
      ch.counter = (ch.counter + ticks) & 0xffff;
      ch.lastUpdateCycle += ticks * prescaler;
    }
  }

  /** Schedule the next overflow, counted from the cycle the counter was last brought up to. */
  #scheduleOverflow(index: number): void {
    const ch = this.#channels[index]!;
    const ticksUntilOverflow = 0x10000 - ch.counter;
    const prescaler = TIMER_PRESCALERS[ch.prescaler]!;
    const overflow = ch.lastUpdateCycle + ticksUntilOverflow * prescaler;
    this.#scheduler.scheduleAt(TIMER_EVENT_IDS[index]!, overflow + READ_OFFSET, (due) =>
      this.#onOverflow(index, due - READ_OFFSET),
    );
  }

  /**
   * Handle a timer overflow that happened at the cycle `due`. The timer reloads and counts on from
   * that cycle, so its period holds whenever the event is serviced, and its IRQ is raised then.
   */
  #onOverflow(index: number, due: number): void {
    const ch = this.#channels[index]!;

    // Reload counter
    ch.counter = ch.reload;
    ch.lastUpdateCycle = due;

    // Fire IRQ if enabled
    if (ch.irqEnable) {
      this.#interrupts.requestInterrupt(TIMER_IRQ_FLAGS[index]!, due);
    }

    // Notify listeners (DirectSound FIFO)
    ch.onOverflow?.();

    // Cascade: increment next timer
    if (index < 3) {
      const next = this.#channels[index + 1]!;
      if (next.enabled && next.cascade) {
        next.counter = (next.counter + 1) & 0xffff;
        if (next.counter === 0) {
          // Cascade overflow
          this.#onOverflow(index + 1, due);
        }
      }
    }

    // Reschedule if still running (must happen even after cascade)
    if (ch.enabled && !ch.cascade) {
      this.#scheduleOverflow(index);
    }
  }

  /** Serialize to a plain snapshot. */
  serialize(): TimerSnapshot {
    return {
      channels: this.#channels.map((ch) => ({
        counter: ch.counter,
        reload: ch.reload,
        prescaler: ch.prescaler,
        cascade: ch.cascade,
        irqEnable: ch.irqEnable,
        enabled: ch.enabled,
        lastUpdateCycle: ch.lastUpdateCycle,
      })),
    };
  }

  /** Restore from a snapshot. Overflow callbacks must be reinstalled by APU. */
  deserialize(snap: TimerSnapshot): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.#channels[i]!;
      const s = snap.channels[i]!;
      ch.counter = s.counter;
      ch.reload = s.reload;
      ch.prescaler = s.prescaler;
      ch.cascade = s.cascade;
      ch.irqEnable = s.irqEnable;
      ch.enabled = s.enabled;
      ch.lastUpdateCycle = s.lastUpdateCycle;
      // onOverflow preserved from current state (reinstalled by APU)
    }
  }

  /**
   * After a snapshot restore: give every pending overflow event its callback back
   * at the cycle the snapshot recorded. Rescheduling from `counter` instead would
   * move the event by up to one prescaler period per restore, and the restored
   * machine would no longer replay the original.
   */
  reattachEvents(): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.#channels[i]!;
      const id = TIMER_EVENT_IDS[i]!;
      if (this.#scheduler.isScheduled(id)) {
        this.#scheduler.reattach(id, (due) => this.#onOverflow(i, due - READ_OFFSET));
      } else if (ch.enabled && !ch.cascade) {
        this.#scheduleOverflow(i); // an older snapshot, with no overflow event of its own
      }
    }
  }

  /** Reset all timers. */
  reset(): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.#channels[i]!;
      ch.counter = 0;
      ch.reload = 0;
      ch.prescaler = 0;
      ch.cascade = false;
      ch.irqEnable = false;
      ch.enabled = false;
      ch.lastUpdateCycle = 0;
      ch.onOverflow = undefined;
      this.#scheduler.cancel(TIMER_EVENT_IDS[i]!);
    }
  }
}
