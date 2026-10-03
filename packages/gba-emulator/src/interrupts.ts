/**
 * GBA Interrupt Controller
 *
 * Manages IME (master enable), IE (individual enables), and IF (request flags).
 * When an interrupt is requested and enabled, the CPU is signaled to enter IRQ mode.
 *
 * The signal takes IRQ_DELAY cycles to reach the CPU: an enabled request wakes a halted CPU, and
 * becomes an exception the CPU can take, that long after it is raised (mGBA gba.c GBATestIRQ,
 * GBA_IRQ_DELAY; mgba-suite "Timer IRQ").
 *
 * IME gates only the IRQ line, the exception's input: setting it while the CPU already sees a
 * request raises the line IRQ_DELAY cycles later (NanoBoyAdvance irq.cc: an IME write updates
 * irq_line; irq_available follows IE AND IF).
 *
 * Halt (HALTCNT bit 7 clear) pauses the CPU until it sees IE AND IF non-zero, whatever IME holds,
 * and a Halt entered while the CPU already sees a request ends at once (GBATEK "System Control":
 * "the CPU is paused as long as (IE AND IF)=0"; NanoBoyAdvance IRQ::ShouldUnhaltCPU). Stop (bit 7
 * set) ends the same way, on keypad, Game Pak and serial requests only.
 */
import type { InterruptSnapshot } from './savestate.js';
import type { Scheduler } from './scheduler.js';
import { EventId, IrqFlag } from './types.js';

/** Cycles from an enabled interrupt request to the CPU seeing it. */
const IRQ_DELAY = 7;

/** Every request source. */
const ALL_IRQS = 0x3fff;

/** The requests that end Stop mode: the ones whose hardware runs while the GBA sleeps. */
const STOP_WAKE_IRQS = IrqFlag.Keypad | IrqFlag.GamePak | IrqFlag.Serial;

/** The ImeLine event only marks time: irqPending checks whether it is still scheduled. */
const imeLineReached = (): void => {};

export class InterruptController {
  /** Master Interrupt Enable (0x04000208) — only bit 0 matters */
  ime = 0;

  /** Interrupt Enable (0x04000200) — which interrupts are enabled */
  ie = 0;

  /** Interrupt Flags (0x04000202) — which interrupts are pending */
  if_ = 0;

  /** Whether the CPU sleeps in Halt or Stop mode, waiting for an interrupt request. */
  halted = false;

  /** The requests that end the current sleep: all of them for Halt, a few for Stop. */
  #wakeIrqs = ALL_IRQS;

  /** Observer for every interrupt request (an event log's IRQ rows). */
  onRequest: ((flag: number) => void) | null = null;

  readonly #scheduler: Scheduler;

  constructor(scheduler: Scheduler) {
    this.#scheduler = scheduler;
  }

  /**
   * Request an interrupt by setting bits in IF. `at` is the cycle the hardware raised it, which an
   * event serviced late passes so the CPU still sees the request IRQ_DELAY cycles after it.
   */
  requestInterrupt(flag: number, at: number = this.#scheduler.currentCycle): void {
    const wasSignalled = (this.ie & this.if_) !== 0;
    this.if_ |= flag;
    this.onRequest?.(flag);
    if (!wasSignalled) {
      this.#signal(at);
    } else if (!this.#scheduler.isScheduled(EventId.Irq)) {
      this.#onSignal(); // the CPU already sees an enabled request
    }
  }

  /**
   * When IE AND IF is non-zero as of the cycle `at`, the CPU sees it IRQ_DELAY cycles later. A
   * signal already on its way keeps its cycle.
   */
  #signal(at: number): void {
    if ((this.ie & this.if_) !== 0 && !this.#scheduler.isScheduled(EventId.Irq)) {
      this.#scheduler.scheduleAt(EventId.Irq, at + IRQ_DELAY, () => this.#onSignal());
    }
  }

  /** The request reached the CPU, which wakes if the request is one its sleep waits for. */
  #onSignal(): void {
    if ((this.ie & this.if_ & this.#wakeIrqs) !== 0) {
      this.halted = false;
    }
  }

  /** Whether the CPU sees an enabled request now: IE AND IF is non-zero and its delay has passed. */
  #signalled(): boolean {
    return (this.ie & this.if_) !== 0 && !this.#scheduler.isScheduled(EventId.Irq);
  }

  /** HALTCNT with bit 7 clear: Halt, until the CPU sees an enabled request. */
  halt(): void {
    this.#sleep(ALL_IRQS);
  }

  /**
   * HALTCNT with bit 7 set: Stop, until the CPU sees an enabled keypad, Game Pak or serial
   * request. The emulator keeps the LCD, sound and timers clocked here, where the hardware pauses
   * most of them (GBATEK "System Control"), so frames still complete while the CPU sleeps.
   */
  stop(): void {
    this.#sleep(STOP_WAKE_IRQS);
  }

  /** Whether the current sleep is Stop rather than Halt. */
  get stopped(): boolean {
    return this.halted && this.#wakeIrqs !== ALL_IRQS;
  }

  #sleep(wakeIrqs: number): void {
    this.#wakeIrqs = wakeIrqs;
    this.halted = !(this.#signalled() && (this.ie & this.if_ & wakeIrqs) !== 0);
  }

  /** Acknowledge (clear) interrupt flags by writing to IF. Writing 1 clears. */
  acknowledge(value: number): void {
    this.if_ &= ~value;
  }

  /**
   * Whether the IRQ line is up, an IRQ exception unless CPSR.I masks it: the CPU sees an enabled
   * request, and IME is set and has reached the line.
   */
  irqPending(): boolean {
    return this.ime !== 0 && this.#signalled() && !this.#scheduler.isScheduled(EventId.ImeLine);
  }

  /** Read IE register (16-bit). */
  readIe(): number {
    return this.ie & 0x3fff;
  }

  /** Write IE register (16-bit). Enabling a pending request signals the CPU like a new request. */
  writeIe(value: number): void {
    const wasSignalled = (this.ie & this.if_) !== 0;
    this.ie = value & 0x3fff;
    if (!wasSignalled) {
      this.#signal(this.#scheduler.currentCycle);
    }
  }

  /** Read IF register (16-bit). */
  readIf(): number {
    return this.if_ & 0x3fff;
  }

  /** Write IF register — writing 1 acknowledges (clears) the flag. */
  writeIf(value: number): void {
    this.acknowledge(value & 0x3fff);
  }

  /** Read IME register. */
  readIme(): number {
    return this.ime & 1;
  }

  /**
   * Write IME register. Setting it while the CPU already sees a request raises the IRQ line
   * IRQ_DELAY cycles later, as enabling the request in IE would (mGBA io.c: an IME write calls
   * GBATestIRQ); a request still on its way keeps its own cycle. Clearing it lowers the line at once.
   */
  writeIme(value: number): void {
    const enabling = this.ime === 0 && (value & 1) !== 0;
    this.ime = value & 1;
    if (enabling && this.#signalled()) {
      this.#scheduler.schedule(EventId.ImeLine, IRQ_DELAY, imeLineReached);
    } else if (this.ime === 0) {
      this.#scheduler.cancel(EventId.ImeLine);
    }
  }

  /** Serialize to a plain snapshot. */
  serialize(): InterruptSnapshot {
    return {
      ime: this.ime,
      ie: this.ie,
      if_: this.if_,
      halted: this.halted,
      stopped: this.stopped,
    };
  }

  /** Restore from a snapshot. */
  deserialize(snap: InterruptSnapshot): void {
    this.ime = snap.ime;
    this.ie = snap.ie;
    this.if_ = snap.if_;
    this.halted = snap.halted;
    // A snapshot without `stopped` restores as Halt.
    this.#wakeIrqs = snap.stopped ? STOP_WAKE_IRQS : ALL_IRQS;
  }

  /**
   * After a snapshot restore: a signal on its way to the CPU, and IME on its way to the IRQ line,
   * keep their cycles and get their callbacks back.
   */
  reattachEvents(): void {
    if (this.#scheduler.isScheduled(EventId.Irq)) {
      this.#scheduler.reattach(EventId.Irq, () => this.#onSignal());
    }
    if (this.#scheduler.isScheduled(EventId.ImeLine)) {
      this.#scheduler.reattach(EventId.ImeLine, imeLineReached);
    }
  }

  /** Reset all state. */
  reset(): void {
    this.ime = 0;
    this.ie = 0;
    this.if_ = 0;
    this.halted = false;
    this.#wakeIrqs = ALL_IRQS;
    this.#scheduler.cancel(EventId.Irq);
    this.#scheduler.cancel(EventId.ImeLine);
  }
}
