/**
 * GBA Keypad Input Controller
 *
 * KEYINPUT (0x04000130): Active-low — bit 0 = pressed means the bit is 0.
 * KEYCNT (0x04000132): Interrupt control for keypad IRQ.
 */
import type { InterruptController } from './interrupts.js';
import type { InputSnapshot } from './savestate.js';
import { GbaButton, IrqFlag } from './types.js';

export class InputController {
  /** Raw button state: bit set = pressed (internal representation) */
  #buttons = 0;

  /** KEYCNT register value */
  #keycnt = 0;

  readonly #interrupts: InterruptController;

  constructor(interrupts: InterruptController) {
    this.#interrupts = interrupts;
  }

  /** Press a button */
  press(button: GbaButton): void {
    this.#buttons |= 1 << button;
    this.#checkKeypadIrq();
  }

  /** Release a button */
  release(button: GbaButton): void {
    this.#buttons &= ~(1 << button);
  }

  /** Set all buttons at once (bitmask, bit set = pressed) */
  setButtons(mask: number): void {
    this.#buttons = mask & 0x3ff;
    this.#checkKeypadIrq();
  }

  /** Read KEYINPUT register (active-low: 0 = pressed, 1 = released) */
  readKeyInput(): number {
    return ~this.#buttons & 0x3ff;
  }

  /** Read KEYCNT register */
  readKeyCnt(): number {
    return this.#keycnt;
  }

  /** Write KEYCNT register */
  writeKeyCnt(value: number): void {
    this.#keycnt = value & 0xc3ff;
    this.#checkKeypadIrq();
  }

  /** Check if keypad IRQ condition is met */
  #checkKeypadIrq(): void {
    const irqEnable = (this.#keycnt & (1 << 14)) !== 0;
    if (!irqEnable) {
      return;
    }

    const selectedButtons = this.#keycnt & 0x3ff;
    const logicalAnd = (this.#keycnt & (1 << 15)) !== 0;
    const pressed = this.#buttons & selectedButtons;

    if (logicalAnd) {
      // All selected buttons must be pressed
      if (pressed === selectedButtons && selectedButtons !== 0) {
        this.#interrupts.requestInterrupt(IrqFlag.Keypad);
      }
    } else {
      // Any selected button pressed
      if (pressed !== 0) {
        this.#interrupts.requestInterrupt(IrqFlag.Keypad);
      }
    }
  }

  /** Serialize to a plain snapshot. */
  serialize(): InputSnapshot {
    return { buttons: this.#buttons, keycnt: this.#keycnt };
  }

  /** Restore from a snapshot. */
  deserialize(snap: InputSnapshot): void {
    this.#buttons = 0;
    this.#keycnt = snap.keycnt;
  }

  /** Reset */
  reset(): void {
    this.#buttons = 0;
    this.#keycnt = 0;
  }
}
