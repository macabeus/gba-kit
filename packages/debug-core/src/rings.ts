/**
 * Bounded rings for the trace logger and the hardware event log. Both are
 * stamped with the machine's time (frame, scanline, cycle). "Cycle" is what the
 * emulator's scheduler counts, which today is one per instruction plus event
 * time — an instruction count, not ARM7TDMI bus cycles.
 */
import type { HardwareEvent } from '@gba-kit/gba-emulator';

export interface TimeStamp {
  frame: number;
  scanline: number;
  cycle: number;
}

export interface TraceEntry extends TimeStamp {
  pc: number;
  thumb: boolean;
  /** the instruction word (16-bit in Thumb) */
  opcode: number;
  /** r0–r3 as the instruction executed; the cheap subset a trace is usually read for */
  r0: number;
  r1: number;
  r2: number;
  r3: number;
}

export interface EventEntry extends TimeStamp {
  event: HardwareEvent;
  /** the PC when the event happened */
  pc: number;
}

/** A fixed-capacity ring: pushes overwrite the oldest entries. */
export class Ring<T> {
  readonly #items: (T | undefined)[];
  #start = 0;
  #count = 0;

  constructor(readonly capacity: number) {
    this.#items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.#count;
  }

  push(item: T): void {
    if (this.#count < this.capacity) {
      this.#items[(this.#start + this.#count) % this.capacity] = item;
      this.#count++;
    } else {
      this.#items[this.#start] = item;
      this.#start = (this.#start + 1) % this.capacity;
    }
  }

  /** The newest `count` entries, oldest first. */
  last(count: number): T[] {
    const n = Math.min(count, this.#count);
    const out: T[] = [];
    for (let i = this.#count - n; i < this.#count; i++) {
      out.push(this.#items[(this.#start + i) % this.capacity]!);
    }
    return out;
  }

  /** Entries `offset` from the oldest, `count` of them. */
  slice(offset: number, count: number): T[] {
    const out: T[] = [];
    for (let i = Math.max(0, offset); i < Math.min(this.#count, offset + count); i++) {
      out.push(this.#items[(this.#start + i) % this.capacity]!);
    }
    return out;
  }

  clear(): void {
    this.#start = 0;
    this.#count = 0;
    this.#items.fill(undefined);
  }
}
