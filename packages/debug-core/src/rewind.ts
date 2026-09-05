/**
 * Rewind history: keyframes every few frames plus the buttons held on every
 * frame. Any past frame is reached by restoring the nearest earlier keyframe and
 * replaying the input log through the machine — exact, because the machine is
 * deterministic and a restored snapshot replays exactly. Keyframes are
 * delta-encoded against the previous one; a full one is kept every `fullEvery`
 * so a restore never applies more than that many deltas.
 */
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';

import { type SnapshotDelta, applySnapshotDelta, deltaSnapshot } from './delta.js';

interface Keyframe {
  frame: number;
  full: GbaSnapshot | null;
  delta: SnapshotDelta | null;
  bytes: number;
}

export interface RewindOptions {
  /** frames between keyframes (default 10) */
  keyframeInterval?: number;
  /** a full snapshot every N keyframes, deltas in between (default 12) */
  fullEvery?: number;
  /** total bytes of history to keep (default 96 MiB) */
  maxBytes?: number;
}

export class RewindHistory {
  readonly keyframeInterval: number;
  readonly #fullEvery: number;
  readonly #maxBytes: number;
  #keyframes: Keyframe[] = [];
  #bytes = 0;
  /** buttons held during each frame, indexed by frame number minus `#inputBase` */
  #inputs: number[] = [];
  #inputBase = 0;
  #sinceFull = 0;

  constructor(options: RewindOptions = {}) {
    this.keyframeInterval = Math.max(1, options.keyframeInterval ?? 10);
    this.#fullEvery = Math.max(1, options.fullEvery ?? 12);
    this.#maxBytes = options.maxBytes ?? 96 * 1024 * 1024;
  }

  get keyframeCount(): number {
    return this.#keyframes.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** The earliest frame that can be reached, or null when there is no history. */
  get earliestFrame(): number | null {
    return this.#keyframes[0]?.frame ?? null;
  }

  /** Record the buttons held while `frame` ran (called once per completed frame). */
  recordInput(frame: number, buttons: number): void {
    if (this.#inputs.length === 0) {
      this.#inputBase = frame;
    }
    const index = frame - this.#inputBase;
    if (index < 0) {
      return;
    }
    this.#inputs[index] = buttons;
  }

  inputAt(frame: number): number {
    return this.#inputs[frame - this.#inputBase] ?? 0;
  }

  /** Whether `frame` is on the keyframe grid. */
  isKeyframe(frame: number): boolean {
    return frame % this.keyframeInterval === 0;
  }

  /** Store a keyframe for `frame` (the snapshot must be of the machine at the start of that frame). */
  push(frame: number, snapshot: GbaSnapshot): void {
    const last = this.#keyframes[this.#keyframes.length - 1];
    if (last && last.frame >= frame) {
      this.truncateAfter(frame - 1);
    }
    const base = this.#keyframes.length > 0 ? this.#reconstruct(this.#keyframes.length - 1) : null;
    let entry: Keyframe;
    if (!base || this.#sinceFull >= this.#fullEvery) {
      entry = { frame, full: snapshot, delta: null, bytes: snapshotBytes(snapshot) };
      this.#sinceFull = 0;
    } else {
      const delta = deltaSnapshot(base, snapshot);
      entry = { frame, full: null, delta, bytes: delta.bytes };
      this.#sinceFull++;
    }
    this.#keyframes.push(entry);
    this.#bytes += entry.bytes;
    this.#enforceBudget();
  }

  /** Drop everything after `frame` (the future is discarded on a rewind). */
  truncateAfter(frame: number): void {
    while (this.#keyframes.length > 0 && this.#keyframes[this.#keyframes.length - 1]!.frame > frame) {
      const k = this.#keyframes.pop()!;
      this.#bytes -= k.bytes;
    }
    const keep = frame + 1 - this.#inputBase;
    if (keep < this.#inputs.length) {
      this.#inputs.length = Math.max(0, keep);
    }
    // The chain now ends on whatever entry is last; count deltas since the last full one.
    this.#sinceFull = 0;
    for (let i = this.#keyframes.length - 1; i >= 0 && !this.#keyframes[i]!.full; i--) {
      this.#sinceFull++;
    }
  }

  /**
   * The nearest keyframe at or before `frame`, reconstructed, or null when the
   * history does not reach back that far.
   */
  keyframeAtOrBefore(frame: number): { frame: number; snapshot: GbaSnapshot } | null {
    let index = -1;
    for (let i = this.#keyframes.length - 1; i >= 0; i--) {
      if (this.#keyframes[i]!.frame <= frame) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      return null;
    }
    return { frame: this.#keyframes[index]!.frame, snapshot: this.#reconstruct(index) };
  }

  #reconstruct(index: number): GbaSnapshot {
    let fullIndex = index;
    while (fullIndex >= 0 && !this.#keyframes[fullIndex]!.full) {
      fullIndex--;
    }
    if (fullIndex < 0) {
      throw new Error('rewind history has no full keyframe');
    }
    let snap = this.#keyframes[fullIndex]!.full!;
    for (let i = fullIndex + 1; i <= index; i++) {
      snap = applySnapshotDelta(snap, this.#keyframes[i]!.delta!);
    }
    return snap;
  }

  #enforceBudget(): void {
    // Drop from the front, but only at a full keyframe boundary so the chain stays decodable.
    while (this.#bytes > this.#maxBytes && this.#keyframes.length > 1) {
      let nextFull = 1;
      while (nextFull < this.#keyframes.length && !this.#keyframes[nextFull]!.full) {
        nextFull++;
      }
      if (nextFull >= this.#keyframes.length) {
        // Only one full keyframe: materialize the second entry as full and drop the first.
        const second = this.#keyframes[1];
        if (!second) {
          break;
        }
        const snap = this.#reconstruct(1);
        this.#bytes -= second.bytes;
        second.full = snap;
        second.delta = null;
        second.bytes = snapshotBytes(snap);
        this.#bytes += second.bytes;
        nextFull = 1;
      }
      const dropped = this.#keyframes.splice(0, nextFull);
      for (const k of dropped) {
        this.#bytes -= k.bytes;
      }
      const newBase = this.#keyframes[0]!.frame;
      const cut = newBase - this.#inputBase;
      if (cut > 0) {
        this.#inputs.splice(0, cut);
        this.#inputBase = newBase;
      }
    }
  }

  clear(): void {
    this.#keyframes = [];
    this.#bytes = 0;
    this.#inputs = [];
    this.#inputBase = 0;
    this.#sinceFull = 0;
  }
}

function snapshotBytes(snap: GbaSnapshot): number {
  let total = 0;
  const walk = (v: unknown): void => {
    if (ArrayBuffer.isView(v)) {
      total += v.byteLength;
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(snap);
  return total;
}
