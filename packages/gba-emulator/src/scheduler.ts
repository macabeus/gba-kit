/**
 * GBA Event Scheduler
 *
 * The scheduler coordinates all hardware timing. The CPU runs until
 * the next scheduled event, then the event fires and may schedule
 * further events. This avoids checking timing conditions on every
 * CPU cycle.
 *
 * Design follows mGBA's event-driven scheduling pattern.
 */
import type { SchedulerSnapshot } from './savestate.js';
import { EventId } from './types.js';

interface ScheduledEvent {
  /** Absolute cycle count when this event fires */
  fireCycle: number;
  /** Callback to execute */
  callback: () => void;
  /** Whether this event is currently scheduled */
  active: boolean;
}

export class Scheduler {
  /** Current cycle count (global clock) */
  currentCycle = 0;

  /** Scheduled events indexed by EventId */
  readonly #events: ScheduledEvent[];

  constructor() {
    this.#events = new Array(EventId.Count);
    for (let i = 0; i < EventId.Count; i++) {
      this.#events[i] = { fireCycle: 0, callback: () => {}, active: false };
    }
  }

  /** Schedule an event to fire after `deltaCycles` cycles from now. */
  schedule(id: EventId, deltaCycles: number, callback: () => void): void {
    const event = this.#events[id]!;
    event.fireCycle = this.currentCycle + deltaCycles;
    event.callback = callback;
    event.active = true;
  }

  /** Cancel a scheduled event. */
  cancel(id: EventId): void {
    this.#events[id]!.active = false;
  }

  /** Check if an event is currently scheduled. */
  isScheduled(id: EventId): boolean {
    return this.#events[id]!.active;
  }

  /** Get the number of cycles until a specific event fires. Returns 0 if not scheduled. */
  cyclesUntilEvent(id: EventId): number {
    const event = this.#events[id]!;
    if (!event.active) {
      return 0;
    }
    return Math.max(0, event.fireCycle - this.currentCycle);
  }

  /**
   * Get the number of cycles until the next event fires.
   * Returns Infinity if no events are scheduled.
   */
  cyclesUntilNextEvent(): number {
    let minCycle = Infinity;
    for (let i = 0; i < EventId.Count; i++) {
      const event = this.#events[i]!;
      if (event.active && event.fireCycle < minCycle) {
        minCycle = event.fireCycle;
      }
    }
    if (minCycle === Infinity) {
      return Infinity;
    }
    return Math.max(0, minCycle - this.currentCycle);
  }

  /**
   * Advance the clock by `cycles` and fire any events that are due.
   * Events may schedule new events — those are not fired in this tick.
   */
  tick(cycles: number): void {
    this.currentCycle += cycles;

    // Fire all events whose time has come.
    // Process in priority order (lower EventId = higher priority).
    for (let i = 0; i < EventId.Count; i++) {
      const event = this.#events[i]!;
      if (event.active && event.fireCycle <= this.currentCycle) {
        event.active = false;
        event.callback();
      }
    }
  }

  /** Serialize to a plain snapshot (callbacks are NOT saved). */
  serialize(): SchedulerSnapshot {
    const events = [];
    for (let i = 0; i < EventId.Count; i++) {
      const e = this.#events[i]!;
      events.push({ fireCycle: e.fireCycle, active: e.active });
    }
    return { currentCycle: this.currentCycle, events };
  }

  /** Restore from a snapshot. Callbacks must be re-registered by the caller. */
  deserialize(snap: SchedulerSnapshot): void {
    this.currentCycle = snap.currentCycle;
    for (let i = 0; i < EventId.Count; i++) {
      const e = this.#events[i]!;
      const s = snap.events[i]!;
      e.fireCycle = s.fireCycle;
      e.active = s.active;
      // callback left as-is — caller must re-register
    }
  }

  /** Reset all events and the cycle counter. */
  reset(): void {
    this.currentCycle = 0;
    for (let i = 0; i < EventId.Count; i++) {
      this.#events[i]!.active = false;
    }
  }
}
