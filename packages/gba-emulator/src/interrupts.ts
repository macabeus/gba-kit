/**
 * GBA Interrupt Controller
 *
 * Manages IME (master enable), IE (individual enables), and IF (request flags).
 * When an interrupt is requested and enabled, the CPU is signaled to enter IRQ mode.
 *
 * The signal takes IRQ_DELAY cycles to reach the CPU: an enabled request wakes a halted CPU, and
 * becomes an exception the CPU can take, that long after it is raised (mGBA gba.c GBATestIRQ,
 * GBA_IRQ_DELAY; mgba-suite "Timer IRQ").
 */
import type { InterruptSnapshot } from './savestate.js';
import type { Scheduler } from './scheduler.js';
import { EventId } from './types.js';

/** Cycles from an enabled interrupt request to the CPU seeing it. */
const IRQ_DELAY = 7;

export class InterruptController {
  /** Master Interrupt Enable (0x04000208) — only bit 0 matters */
  ime = 0;

  /** Interrupt Enable (0x04000200) — which interrupts are enabled */
  ie = 0;

  /** Interrupt Flags (0x04000202) — which interrupts are pending */
  if_ = 0;

  /** Whether the CPU is in HALT state (waiting for interrupt) */
  halted = false;

  /**
   * IntrWait flags — set by HLE SWI IntrWait/VBlankIntrWait.
   * When non-zero, halt only breaks when one of these specific interrupts fires.
   * This prevents the game loop from running at HBlank rate when VBlankIntrWait
   * is used with HBlank IRQs enabled.
   */
  intrWaitFlags = 0;

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
   * IE AND IF just became non-zero at the cycle `at`: the CPU sees it IRQ_DELAY cycles later. An
   * interrupt the CPU already sees keeps its signal, so a second request adds no delay.
   */
  #signal(at: number): void {
    if ((this.ie & this.if_) !== 0 && !this.#scheduler.isScheduled(EventId.Irq)) {
      this.#scheduler.scheduleAt(EventId.Irq, at + IRQ_DELAY, () => this.#onSignal());
    }
  }

  /**
   * The request reached the CPU. A halted CPU wakes for any enabled interrupt, even during
   * IntrWait: on hardware the BIOS IRQ handler runs and the IntrWait loop halts again until its
   * own interrupt has fired, which the GBA coordinator checks after the handler returns.
   */
  #onSignal(): void {
    if ((this.ie & this.if_) !== 0) {
      this.halted = false;
    }
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

  /** Write IME register. */
  writeIme(value: number): void {
    this.ime = value & 1;
  }

  /** Serialize to a plain snapshot. */
  serialize(): InterruptSnapshot {
    return {
      ime: this.ime,
      ie: this.ie,
      if_: this.if_,
      halted: this.halted,
      intrWaitFlags: this.intrWaitFlags,
    };
  }

  /** Restore from a snapshot. */
  deserialize(snap: InterruptSnapshot): void {
    this.ime = snap.ime;
    this.ie = snap.ie;
    this.if_ = snap.if_;
    this.halted = snap.halted;
    this.intrWaitFlags = snap.intrWaitFlags;
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
    this.intrWaitFlags = 0;
    this.#scheduler.cancel(EventId.Irq);
  }
}
