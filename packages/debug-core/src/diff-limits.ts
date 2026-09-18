/**
 * How far a memory diff goes, and how many idle frames a noise baseline runs.
 *
 * `protocol.ts` is the vocabulary a browser client speaks with no Node package
 * behind it, so nothing it imports at runtime may reach the emulator. The diff
 * engine and the noise baseline both do — they read RAM off a `Machine` — which is
 * why the few numbers they share with the wire live here, in a module that imports
 * nothing.
 */

/** What a result is worth placing, how much of one a response carries, and how far back undo reaches. */
export const DIFF_LIMITS = {
  /** beyond this a result is a count and a page of addresses: nobody reads 290,000 ranked rows */
  detail: 5000,
  /** a page of rows, and the most one response may carry — which is every row that was placed */
  rowsDefault: 512,
  rowsMax: 5000,
  /** how many filters undo reaches back through; each step holds a whole candidate set, at 36 KB */
  undoDepth: 20,
  /**
   * How many captures one session holds. A capture is 288 KB of RAM and a thumbnail,
   * and the strip names them `①`…`⑳`: past the last circled number a card has no name
   * to be picked out of the strip by, which is what a capture is chosen by everywhere.
   */
  captures: 20,
} as const;

/** The looks an idle baseline may take, shortest first; the last of them is the cap. */
const NOISE_LOOKS = [60, 300, 900] as const;

/**
 * How long an idle baseline watches for: what a panel may offer, what it starts at,
 * and what a request is refused past.
 *
 * The default is set by what survives an ordering the panel does not control. What
 * the churn mask holds saturates early — 3,360 of its eventual 3,476 bytes are found
 * by frame 60 on the measured target — but the bytes it finds last are the mixer's
 * per-note state, which moves at note boundaries rather than every frame, so a look
 * only covers the notes played while it ran. Sixty frames leave 3 candidates when the
 * baseline runs immediately before three back-to-back captures and 15 — 12 of them
 * sound state — when the same run takes it afterwards, or 8, 11 and 17 when a second,
 * three or ten seconds pass between the captures, which is what clicking three buttons
 * costs. Three hundred leave 3 in every one of those orderings and 6 at a ten-second
 * gap. It costs 1.2 s against 260 ms, which is a price a once-per-session action can
 * pay; nine hundred, the cap, finds nothing three hundred did not.
 */
export const NOISE_FRAMES = { choices: NOISE_LOOKS, default: NOISE_LOOKS[1], max: NOISE_LOOKS[2] } as const;

/** How many addresses a set of half-open ranges covers. */
export function rangeBytes(ranges: ReadonlyArray<{ lo: number; hi: number }>): number {
  return ranges.reduce((sum, r) => sum + (r.hi - r.lo), 0);
}
