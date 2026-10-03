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
 * Halt (HALTCNT bit 7 clear) pauses the CPU while the signal is down: IE AND IF is zero or still on
 * its way. IME plays no part, and a halt entered while the CPU already sees a request ends at once
 * (GBATEK "System Control": "the CPU is paused as long as (IE AND IF)=0"; NanoBoyAdvance
 * IRQ::ShouldUnhaltCPU). Stop (bit 7 set) ends the same way, for keypad, Game Pak and serial
 * requests only.
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
   * An enabled request appeared to the CPU at the cycle `at`: IE AND IF became non-zero, or IME was
   * set. The CPU sees it IRQ_DELAY cycles later. A signal already on its way keeps its cycle, and a
   * second request adds no delay to a signal the CPU already sees.
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
   * request. The LCD, sound and timers keep their clocks here, so frames still complete while the
   * CPU sleeps.
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

  /** Whether the CPU sees an enabled interrupt request with IME set (an IRQ exception unless CPSR.I masks it). */
  irqPending(): boolean {
    return this.ime !== 0 && (this.ie & this.if_) !== 0 && !this.#scheduler.isScheduled(EventId.Irq);
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
   * Write IME register. Setting it signals the CPU the way a new request does, so a request that
   * was waiting behind IME reaches the CPU IRQ_DELAY cycles later, like one that IE lets through
   * (mGBA io.c: an IME write calls GBATestIRQ).
   */
  writeIme(value: number): void {
    const enabling = this.ime === 0 && (value & 1) !== 0;
    this.ime = value & 1;
    if (enabling) {
      this.#signal(this.#scheduler.currentCycle);
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
    // Older snapshots carry no `stopped`: they knew only Halt.
    this.#wakeIrqs = snap.stopped ? STOP_WAKE_IRQS : ALL_IRQS;
  }

  /** After a snapshot restore: a signal on its way to the CPU keeps its cycle and gets its callback back. */
  reattachEvents(): void {
    if (this.#scheduler.isScheduled(EventId.Irq)) {
      this.#scheduler.reattach(EventId.Irq, () => this.#onSignal());
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
  }
}
