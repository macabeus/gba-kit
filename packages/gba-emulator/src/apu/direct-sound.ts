/**
 * GBA DirectSound A/B — FIFO-based 8-bit PCM channels
 *
 * Each channel has a 32-byte FIFO queue. A timer overflow pops the
 * next sample; DMA refills the FIFO when it runs low.
 *
 * The FIFO register (FIFO_A at 0x40000A0, FIFO_B at 0x40000A4) takes 32-bit words. A byte or
 * halfword store updates that part of a 32-bit input latch and queues the whole latch as one
 * word, the way mGBA (src/gba/io.c GBAIOWrite, FIFO_A_LO/FIFO_A_HI) and NanoBoyAdvance
 * (hw/apu/channel/fifo.hh WriteByte/WriteHalf) queue a word per write of any width.
 */
import type { DirectSoundSnapshot } from '../savestate.js';

/** Maximum FIFO depth in bytes */
const FIFO_CAPACITY = 32;

export class DirectSoundChannel {
  /** Circular buffer backing the FIFO */
  readonly #buffer = new Int8Array(FIFO_CAPACITY);
  /** Read index into the circular buffer */
  #readIndex = 0;
  /** Write index into the circular buffer */
  #writeIndex = 0;
  /** Number of bytes currently in the FIFO */
  #size = 0;
  /** The 32-bit word last written to the FIFO register, which narrower writes merge into */
  #latch = 0;

  /** Current output sample (signed 8-bit, range -128..127) */
  currentSample = 0;

  /** Whether this channel is enabled (left) */
  enableLeft = false;
  /** Whether this channel is enabled (right) */
  enableRight = false;
  /** Volume: false = 50%, true = 100% */
  fullVolume = false;
  /** Which timer drives this channel (0 or 1) */
  timerSelect = 0;

  /**
   * Write `bytes` (1, 2 or 4) bytes of `value` at byte `offset` of the FIFO register, then
   * push the latch's 4 bytes into the FIFO, byte 0 first, as far as it has room.
   */
  writeFifo(offset: number, value: number, bytes: 1 | 2 | 4): void {
    const shift = (offset & 3) * 8;
    const mask = bytes === 4 ? 0xffffffff : ((1 << (bytes * 8)) - 1) << shift;
    this.#latch = ((this.#latch & ~mask) | ((value << shift) & mask)) >>> 0;
    for (let i = 0; i < 4; i++) {
      if (this.#size < FIFO_CAPACITY) {
        // Extract byte i (little-endian) and interpret as signed
        this.#buffer[this.#writeIndex] = ((this.#latch >> (i * 8)) << 24) >> 24;
        this.#writeIndex = (this.#writeIndex + 1) & (FIFO_CAPACITY - 1);
        this.#size++;
      }
    }
  }

  /** Pop the next sample from the FIFO (called on timer overflow) */
  popSample(): void {
    if (this.#size > 0) {
      this.currentSample = this.#buffer[this.#readIndex]!;
      this.#readIndex = (this.#readIndex + 1) & (FIFO_CAPACITY - 1);
      this.#size--;
    } else {
      this.currentSample = 0;
    }
  }

  /** Returns true if the FIFO needs a DMA refill (<= 16 bytes remaining) */
  needsRefill(): boolean {
    return this.#size <= 16;
  }

  /** Get current FIFO size */
  get size(): number {
    return this.#size;
  }

  /** Clear the FIFO */
  resetFifo(): void {
    this.#readIndex = 0;
    this.#writeIndex = 0;
    this.#size = 0;
    this.currentSample = 0;
    this.#buffer.fill(0);
  }

  /** Serialize to a plain snapshot. */
  serialize(): DirectSoundSnapshot {
    return {
      buffer: new Int8Array(this.#buffer),
      readIndex: this.#readIndex,
      writeIndex: this.#writeIndex,
      size: this.#size,
      latch: this.#latch,
      currentSample: this.currentSample,
      enableLeft: this.enableLeft,
      enableRight: this.enableRight,
      fullVolume: this.fullVolume,
      timerSelect: this.timerSelect,
    };
  }

  /** Restore from a snapshot. */
  deserialize(snap: DirectSoundSnapshot): void {
    this.#buffer.set(snap.buffer);
    this.#readIndex = snap.readIndex;
    this.#writeIndex = snap.writeIndex;
    this.#size = snap.size;
    this.#latch = snap.latch ?? 0;
    this.currentSample = snap.currentSample;
    this.enableLeft = snap.enableLeft;
    this.enableRight = snap.enableRight;
    this.fullVolume = snap.fullVolume;
    this.timerSelect = snap.timerSelect;
  }

  /** Full reset */
  reset(): void {
    this.resetFifo();
    this.#latch = 0;
    this.enableLeft = false;
    this.enableRight = false;
    this.fullVolume = false;
    this.timerSelect = 0;
  }
}
