/**
 * Snapshot deltas: a keyframe stored as the XOR against the previous one,
 * run-length encoded. RAM changes little between keyframes a few frames apart,
 * so a delta is usually a few kilobytes against a ~600 KB snapshot. The
 * framebuffer is left out (it is re-rendered when the machine runs) and the
 * scalar fields are kept verbatim.
 */
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';

import { arrayFrom, arrayKind, viewBytes } from './typed-arrays.js';

/** A typed-array field of the snapshot, addressed by path. */
type ArrayPath = string[];

function walk(obj: unknown, path: ArrayPath, out: Array<{ path: ArrayPath; array: Uint8Array }>): void {
  if (arrayKind(obj) !== null) {
    out.push({ path, array: viewBytes(obj as ArrayBufferView) });
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walk(v, [...path, String(i)], out));
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (path.length === 1 && path[0] === 'ppu' && k === 'framebuffer') {
        continue; // re-rendered, not state
      }
      walk(v, [...path, k], out);
    }
  }
}

/** Every typed array of a snapshot except `ppu.framebuffer`, in a stable order. */
export function snapshotArrays(snap: GbaSnapshot): Array<{ path: ArrayPath; array: Uint8Array }> {
  const out: Array<{ path: ArrayPath; array: Uint8Array }> = [];
  walk(snap, [], out);
  return out;
}

/**
 * XOR + run-length encode `next` against `base`, both the same length. Output
 * alternates: zero-run length (u32), literal length (u32), literal bytes.
 */
export function encodeDelta(base: Uint8Array, next: Uint8Array): Uint8Array {
  if (base.length !== next.length) {
    throw new Error('delta needs equal lengths');
  }
  const chunks: number[] = [];
  const literals: Uint8Array[] = [];
  let i = 0;
  let total = 0;
  while (i < next.length) {
    let zeros = 0;
    while (i < next.length && base[i] === next[i]) {
      zeros++;
      i++;
    }
    const start = i;
    while (i < next.length && base[i] !== next[i]) {
      i++;
    }
    // Absorb tiny zero gaps into the literal so headers do not dominate.
    while (i < next.length) {
      let gap = 0;
      while (i + gap < next.length && gap < 8 && base[i + gap] === next[i + gap]) {
        gap++;
      }
      if (i + gap >= next.length || gap >= 8) {
        break; // the run of equal bytes reaches the end, or is long enough to be its own zero run
      }
      i += gap; // the gap scan stopped on a difference: the literal continues through it
      while (i < next.length && base[i] !== next[i]) {
        i++;
      }
    }
    const literal = new Uint8Array(i - start);
    for (let k = start; k < i; k++) {
      literal[k - start] = base[k]! ^ next[k]!;
    }
    chunks.push(zeros, literal.length);
    literals.push(literal);
    total += 8 + literal.length;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  for (let c = 0; c < chunks.length; c += 2) {
    view.setUint32(o, chunks[c]!, true);
    view.setUint32(o + 4, chunks[c + 1]!, true);
    o += 8;
    out.set(literals[c / 2]!, o);
    o += literals[c / 2]!.length;
  }
  return out;
}

/** Apply a delta produced by {@link encodeDelta} to `base`, into a fresh array. */
export function decodeDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const out = base.slice();
  const view = new DataView(delta.buffer, delta.byteOffset, delta.byteLength);
  let o = 0;
  let i = 0;
  while (o + 8 <= delta.length) {
    const zeros = view.getUint32(o, true);
    const len = view.getUint32(o + 4, true);
    o += 8;
    i += zeros;
    for (let k = 0; k < len; k++) {
      out[i + k] = base[i + k]! ^ delta[o + k]!;
    }
    o += len;
    i += len;
  }
  return out;
}

/** A snapshot with its typed arrays replaced by deltas against a base snapshot. */
export interface SnapshotDelta {
  scalars: GbaSnapshot;
  deltas: Uint8Array[];
  bytes: number;
}

export function deltaSnapshot(base: GbaSnapshot, next: GbaSnapshot): SnapshotDelta {
  const baseArrays = snapshotArrays(base);
  const nextArrays = snapshotArrays(next);
  const deltas = nextArrays.map((n, i) => encodeDelta(baseArrays[i]!.array, n.array));
  return { scalars: stripArrays(next), deltas, bytes: deltas.reduce((s, d) => s + d.length, 0) };
}

export function applySnapshotDelta(base: GbaSnapshot, delta: SnapshotDelta): GbaSnapshot {
  const out = structuredClone(delta.scalars) as GbaSnapshot;
  const baseArrays = snapshotArrays(base);
  const restored = baseArrays.map((b, i) => decodeDelta(b.array, delta.deltas[i]!));
  baseArrays.forEach((b, i) => setPath(out, b.path, restored[i]!, getPath(base, b.path)));
  // The framebuffer is not part of a delta: carry the base's so the screen is never blank.
  out.ppu.framebuffer = new Uint32Array(base.ppu.framebuffer);
  return out;
}

/** A copy of the snapshot without its typed arrays (they come from the deltas). */
function stripArrays(snap: GbaSnapshot): GbaSnapshot {
  const clone = (v: unknown): unknown => {
    if (arrayKind(v) !== null) {
      return null;
    }
    if (Array.isArray(v)) {
      return v.map(clone);
    }
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        o[k] = clone(x);
      }
      return o;
    }
    return v;
  };
  return clone(snap) as GbaSnapshot;
}

function getPath(obj: unknown, path: ArrayPath): unknown {
  let cur = obj as Record<string, unknown>;
  for (const p of path) {
    cur = cur[p] as Record<string, unknown>;
  }
  return cur;
}

function setPath(obj: unknown, path: ArrayPath, bytes: Uint8Array, like: unknown): void {
  let cur = obj as Record<string, unknown>;
  for (const p of path.slice(0, -1)) {
    cur = cur[p] as Record<string, unknown>;
  }
  const key = path[path.length - 1]!;
  cur[key] = arrayFrom(arrayKind(like) ?? 'u8', bytes);
}
