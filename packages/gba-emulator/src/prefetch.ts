/**
 * GBA Game Pak prefetch unit — the opcode buffer WAITCNT bit 14 turns on.
 *
 * After every opcode fetch the CPU makes from the cartridge, the unit goes on reading the opcodes
 * that follow, one S access at a time, while the CPU leaves the cartridge bus alone: during its
 * internal cycles and its accesses to other memory. It holds up to 8 halfwords in Thumb state and
 * 4 words in ARM state.
 *
 * - A fetch of the oldest opcode in the buffer takes 1 cycle.
 * - A fetch of the opcode the unit is reading waits for that read to end.
 * - Any other fetch from the cartridge, and any data access to it or its save chip, stops the unit
 *   and discards what it holds; when the unit was in the last cycle of a halfword read, the access
 *   waits one more cycle.
 *
 * References: GBATEK "GBA GamePak Prefetch"; NanoBoyAdvance src/nba/src/bus/timing.cc
 * (Bus::Prefetch, Bus::StopPrefetch, Bus::Step).
 */
import type { PrefetchSnapshot } from './savestate.js';

/** The buffer holds 16 bytes: 8 Thumb opcodes or 4 ARM opcodes. */
const BUFFER_BYTES = 16;

export class GamePakPrefetch {
  /** WAITCNT bit 14: whether the unit reads ahead. The bus keeps it in step with WAITCNT. */
  enabled = false;

  /** Whether the unit holds or reads opcodes that follow the CPU's last fetch from the cartridge. */
  #active = false;
  /** Address of the oldest opcode in the buffer. */
  #head = 0;
  /** Opcodes in the buffer. */
  #count = 0;
  /** Cycles left of the read in progress, which brings in the opcode after the buffered ones; 0 when the unit is not reading. */
  #countdown = 0;
  /** Opcode width: 2 in Thumb state, 4 in ARM state. */
  #width: 2 | 4 = 2;
  /** Cycles one read takes: an S access of `#width` bytes. */
  #duty = 0;

  /**
   * The CPU fetches the opcode at `address` from the cartridge, which costs `price` cycles from the
   * cartridge itself and `duty` cycles as an S access. Returns the cycles the fetch takes.
   * `cpuInGamePak` says whether the CPU runs from the cartridge, the case the stop penalty needs.
   */
  fetch(address: number, width: 2 | 4, price: number, duty: number, cpuInGamePak: boolean): number {
    if (this.#active) {
      if (this.#count > 0 && address === this.#head) {
        this.#count--;
        this.#head = (address + width) >>> 0;
        this.#resume();
        this.step(1);
        return 1;
      }
      if (this.#countdown > 0 && address === this.#inFlight()) {
        const wait = this.#countdown;
        this.step(wait);
        // The CPU takes the opcode as it arrives; opcodes buffered before it are skipped.
        this.#head = (address + width) >>> 0;
        this.#count = 0;
        this.#resume();
        return wait;
      }
    }

    const cycles = this.stop(cpuInGamePak) + price;
    if (this.enabled) {
      this.#active = true;
      this.#head = (address + width) >>> 0;
      this.#count = 0;
      this.#width = width;
      this.#duty = duty;
      this.#countdown = duty;
    }
    return cycles;
  }

  /**
   * A data access to the cartridge or its save chip: the unit stops and discards its buffer.
   * Returns the cycle the access waits when it comes as the unit finishes a halfword read, which
   * happens only while the CPU runs from the cartridge.
   */
  stop(cpuInGamePak: boolean): number {
    if (!this.#active) {
      return 0;
    }
    this.#active = false;
    const finishing = this.#countdown === 1 || (this.#width === 4 && this.#countdown === (this.#duty >> 1) + 1);
    return cpuInGamePak && finishing ? 1 : 0;
  }

  /** `cycles` pass in which the CPU leaves the cartridge bus alone: the read in progress goes on. */
  step(cycles: number): void {
    if (this.#countdown <= 0) {
      return;
    }
    this.#countdown -= cycles;
    while (this.#countdown <= 0) {
      this.#count++;
      if (!this.enabled || this.#count * this.#width >= BUFFER_BYTES) {
        this.#countdown = 0;
        return;
      }
      this.#countdown += this.#duty;
    }
  }

  /** The address the read in progress brings in: the one after the buffered opcodes. */
  #inFlight(): number {
    return (this.#head + this.#count * this.#width) >>> 0;
  }

  /** After the CPU takes an opcode, a unit that stopped with a full buffer reads the next one. */
  #resume(): void {
    if (this.#countdown === 0 && this.enabled) {
      this.#countdown = this.#duty;
    }
  }

  /** Serialize to a plain snapshot. */
  serialize(): PrefetchSnapshot {
    return {
      active: this.#active,
      head: this.#head,
      count: this.#count,
      countdown: this.#countdown,
      width: this.#width,
      duty: this.#duty,
    };
  }

  /** Restore from a snapshot; without one (an older snapshot) the unit restores stopped and empty. */
  deserialize(snap: PrefetchSnapshot | undefined): void {
    if (!snap) {
      this.reset();
      return;
    }
    this.#active = snap.active;
    this.#head = snap.head;
    this.#count = snap.count;
    this.#countdown = snap.countdown;
    this.#width = snap.width;
    this.#duty = snap.duty;
  }

  /** Stopped and empty, as at power-on. */
  reset(): void {
    this.#active = false;
    this.#head = 0;
    this.#count = 0;
    this.#countdown = 0;
    this.#width = 2;
    this.#duty = 0;
  }
}
