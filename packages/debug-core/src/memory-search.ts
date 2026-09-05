/**
 * The cheat-device workflow: find every address holding a value, then narrow the
 * candidates as the value changes. Reads through the machine's side-effect-free
 * peek, so a search never disturbs the game.
 */
import type { Machine } from './machine.js';

export type SearchRegion = 'iwram' | 'ewram' | 'both';

export interface SearchOptions {
  value: number;
  size: 1 | 2 | 4;
  region?: SearchRegion;
  /** stop after this many hits (default 10,000) */
  limit?: number;
}

const REGIONS: Record<Exclude<SearchRegion, 'both'>, [number, number]> = {
  iwram: [0x03000000, 0x8000],
  ewram: [0x02000000, 0x40000],
};

export function searchMemory(machine: Machine, options: SearchOptions): number[] {
  const size = options.size;
  const limit = options.limit ?? 10_000;
  const mask = size === 4 ? 0xffffffff : (1 << (size * 8)) - 1;
  const wanted = (options.value & mask) >>> 0;
  const out: number[] = [];
  const regions =
    options.region === 'both' || !options.region ? (['iwram', 'ewram'] as const) : ([options.region] as const);
  for (const name of regions) {
    const [base, length] = REGIONS[name];
    const data = machine.peekPartial(base, length).data;
    for (let i = 0; i + size <= length; i += size === 1 ? 1 : size) {
      let v = 0;
      for (let k = size - 1; k >= 0; k--) {
        v = v * 256 + data[i + k]!;
      }
      if (v >>> 0 === wanted) {
        out.push(base + i);
        if (out.length >= limit) {
          return out;
        }
      }
    }
  }
  return out;
}

/** Keep the addresses among `candidates` that now hold `value`. */
export function filterMemory(machine: Machine, candidates: number[], value: number, size: 1 | 2 | 4): number[] {
  const mask = size === 4 ? 0xffffffff : (1 << (size * 8)) - 1;
  const wanted = (value & mask) >>> 0;
  return candidates.filter((a) => machine.peekUnsigned(a, size) === wanted);
}
