/**
 * GBA Event Scheduler
 *
 * The scheduler owns the machine's clock, `currentCycle`. The run loop adds each instruction's
 * cycles as it completes (an HLE BIOS call's included), the IRQ entry's, and the time a halted CPU
 * sleeps; a DMA adds the cycles it holds the bus. An instruction's cycles end with the opcode fetch
 * the next one begins with (ArmCpu.step), so an I/O access (a timer read, a timer start, an event
 * an I/O write schedules) sees the cycle just after its instruction's fetch, where its first data
 * access happens.
 *
 * Hardware events wait in one slot per `EventId` and fire once the clock reaches them, earliest
 * first. The CPU runs until the next event is due, so an event fires at the end of the instruction
 * during which it came due; its callback receives the cycle it was due at and schedules what follows
 * from there, so periodic events (scanlines, timer overflows) keep their period however late a long
 * instruction or DMA makes them.
 *
 * Design follows mGBA's event-driven scheduling (src/core/timing.c, `cyclesLate`).
 */
import type { SchedulerSnapshot } from './savestate.js';
import { EventId } from './types.js';

/** An event callback; `dueCycle` is the cycle the event was scheduled for (`currentCycle` may be past it). */
export type EventCallback = (dueCycle: number) => void;

interface ScheduledEvent {
  /** Absolute cycle count when this event fires */
  fireCycle: number;
  /** Callback to execute */
  callback: EventCallback;
  /** Whether this event is currently scheduled */
  active: boolean;
}

export class Scheduler {
  /** Current cycle count (global clock) */
  currentCycle = 0;

  /** Scheduled events indexed by EventId */
  readonly #events: ScheduledEvent[];

  /** The earliest `fireCycle` of an active event, Infinity when none is. */
  #nextEventCycle = Infinity;

  constructor() {
    this.#events = new Array(EventId.Count);
    for (let i = 0; i < EventId.Count; i++) {
      this.#events[i] = { fireCycle: 0, callback: () => {}, active: false };
    }
  }

  /** The cycle the next event is due at, Infinity when nothing is scheduled. */
  get nextEventCycle(): number {
    return this.#nextEventCycle;
  }

  /** Schedule an event to fire after `deltaCycles` cycles from now. */
  schedule(id: EventId, deltaCycles: number, callback: EventCallback): void {
    this.scheduleAt(id, this.currentCycle + deltaCycles, callback);
  }

  /** Schedule an event to fire at the absolute cycle `fireCycle`. */
  scheduleAt(id: EventId, fireCycle: number, callback: EventCallback): void {
    const event = this.#events[id]!;
    const wasEarliest = event.active && event.fireCycle === this.#nextEventCycle;
    event.fireCycle = fireCycle;
    event.callback = callback;
    event.active = true;
    if (wasEarliest) {
      this.#findNextEvent();
    } else if (fireCycle < this.#nextEventCycle) {
      this.#nextEventCycle = fireCycle;
    }
  }

  /**
   * Replace the callback of an already-scheduled event WITHOUT moving it. This is
   * how a restored snapshot gets its callbacks back: `fireCycle` is state and must
   * survive the round trip exactly, or a restored machine drifts from the original.
   */
  reattach(id: EventId, callback: EventCallback): void {
    this.#events[id]!.callback = callback;
  }

  /** Cancel a scheduled event. */
  cancel(id: EventId): void {
    const event = this.#events[id]!;
    if (!event.active) {
      return;
    }
    event.active = false;
    if (event.fireCycle === this.#nextEventCycle) {
      this.#findNextEvent();
    }
  }

  /** Check if an event is currently scheduled. */
  isScheduled(id: EventId): boolean {
    return this.#events[id]!.active;
  }

  /** The cycle a scheduled event is due at, Infinity when it is not scheduled. */
  dueCycle(id: EventId): number {
    const event = this.#events[id]!;
    return event.active ? event.fireCycle : Infinity;
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
    return Math.max(0, this.#nextEventCycle - this.currentCycle);
  }

  /** Move the clock forward by `cycles`, firing nothing: the CPU, a DMA or the BIOS used the time. */
  advance(cycles: number): void {
    this.currentCycle += cycles;
  }

  /**
   * Fire the earliest event if it is due (ties in EventId order); returns whether one fired. Firing
   * them one at a time lets the run loop stop between two, at a frame's end, when a long instruction
   * or DMA has let several frames' events come due at once.
   */
  runNextDueEvent(): boolean {
    if (this.#nextEventCycle > this.currentCycle) {
      return false;
    }
    let next: ScheduledEvent | undefined;
    for (let i = 0; i < EventId.Count; i++) {
      const event = this.#events[i]!;
      if (event.active && event.fireCycle === this.#nextEventCycle) {
        next = event;
        break;
      }
    }
    next!.active = false;
    this.#findNextEvent();
    next!.callback(next!.fireCycle);
    return true;
  }

  /** Fire every event that is due, earliest first, those the callbacks schedule included. */
  runDueEvents(): void {
    while (this.runNextDueEvent()) {
      // fire the next one
    }
  }

  /** Advance the clock by `cycles` and fire the events that come due. */
  tick(cycles: number): void {
    this.advance(cycles);
    this.runDueEvents();
  }

  #findNextEvent(): void {
    let min = Infinity;
    for (let i = 0; i < EventId.Count; i++) {
      const event = this.#events[i]!;
      if (event.active && event.fireCycle < min) {
        min = event.fireCycle;
      }
    }
    this.#nextEventCycle = min;
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

  /**
   * Restore from a snapshot. Callbacks must be re-registered by the caller. A slot missing from an
   * older snapshot restores as not scheduled.
   */
  deserialize(snap: SchedulerSnapshot): void {
    this.currentCycle = snap.currentCycle;
    for (let i = 0; i < EventId.Count; i++) {
      const e = this.#events[i]!;
      const s = snap.events[i];
      e.fireCycle = s?.fireCycle ?? 0;
      e.active = s?.active ?? false;
      // callback left as-is — caller must re-register
    }
    this.#findNextEvent();
  }

  /** Reset all events and the cycle counter. */
  reset(): void {
    this.currentCycle = 0;
    for (let i = 0; i < EventId.Count; i++) {
      this.#events[i]!.active = false;
    }
    this.#nextEventCycle = Infinity;
  }
}
