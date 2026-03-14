/**
 * GBA Interrupt Controller
 *
 * Manages IME (master enable), IE (individual enables), and IF (request flags).
 * When an interrupt is requested and enabled, the CPU is signaled to enter IRQ mode.
 */
import type { InterruptSnapshot } from './savestate.js';

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

  /** Request an interrupt by setting bits in IF. */
  requestInterrupt(flag: number): void {
    this.if_ |= flag;
    // If this interrupt is enabled and master enable is on, wake from halt.
    // Always wake for ANY enabled interrupt, even during IntrWait.
    // On real GBA hardware, IntrWait wakes for all IRQs — the BIOS IRQ handler
    // runs, then the IntrWait loop re-halts if its specific interrupt hasn't fired.
    // The GBA coordinator handles the re-halt check after the IRQ handler returns.
    if (this.halted && (this.ie & this.if_) !== 0) {
      this.halted = false;
    }
  }

  /** Acknowledge (clear) interrupt flags by writing to IF. Writing 1 clears. */
  acknowledge(value: number): void {
    this.if_ &= ~value;
  }

  /** Check if any enabled interrupt is pending and IME is set. */
  irqPending(): boolean {
    return this.ime !== 0 && (this.ie & this.if_) !== 0;
  }

  /** Read IE register (16-bit). */
  readIe(): number {
    return this.ie & 0x3fff;
  }

  /** Write IE register (16-bit). */
  writeIe(value: number): void {
    this.ie = value & 0x3fff;
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

  /** Reset all state. */
  reset(): void {
    this.ime = 0;
    this.ie = 0;
    this.if_ = 0;
    this.halted = false;
    this.intrWaitFlags = 0;
  }
}
