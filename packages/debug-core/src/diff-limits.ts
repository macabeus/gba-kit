/**
 * How far a memory diff goes, and how many idle frames a noise baseline runs.
 *
 * `protocol.ts` is the vocabulary a browser client speaks with no Node package
 * behind it, so nothing it imports at runtime may reach the emulator. The diff
 * engine and the noise baseline both do — they read RAM off a `Machine` — which is
 * why the few numbers they share with the wire live here, in a module that imports
 * nothing.
 */

/** How many candidates are worth grouping, ranking and ordering, and how deep undo goes. */
export const DIFF_LIMITS = {
  /** beyond this a result is a count and a page of addresses: nobody reads 290,000 ranked rows */
  detail: 5000,
  rowsDefault: 512,
  rowsMax: 5000,
  undoDepth: 20,
} as const;

/**
 * How many idle frames a noise baseline runs by default, and at most.
 *
 * The default is set by how many candidates survive a tag filter, not by how much
 * of the churn mask is found: the mask is 92% of its eventual size by frame 16, yet
 * what the last 8% holds is the mixer's per-note state, which moves at note
 * boundaries rather than every frame and is exactly what survives. On the measured
 * target sixteen frames leave 36 candidates, 32 of them sound; sixty leave 3, which
 * is the answer and two of its neighbours. Sixty costs 250 ms against 80 ms, and
 * three hundred — the cap, and 1.6 s — finds nothing sixty did not.
 */
export const NOISE_FRAMES = { default: 60, max: 300 } as const;

/** How many addresses a set of half-open ranges covers. */
export function rangeBytes(ranges: ReadonlyArray<{ lo: number; hi: number }>): number {
  return ranges.reduce((sum, r) => sum + (r.hi - r.lo), 0);
}
