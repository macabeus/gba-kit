/**
 * Capture RAM, compare the captures, and say what the differences are called.
 *
 * The cheat-device loop — search a value, change it, narrow — needs the value to be
 * a number the player can read off the screen. The thing a decomp is usually after is
 * not: "which variable holds the highlighted menu item" has no number to search for,
 * only a state the user can reproduce. So the unit here is a *capture* — both RAM
 * regions, frozen — and the question is asked of several of them at once.
 *
 * Tags are what make that one question rather than a sequence of guesses. Capture on
 * item A, on item B, on item A again; tag them `A`, `B`, `A`; then ask for the
 * addresses that are **equal wherever the tags are equal and different wherever they
 * differ**. The sound mixer fails that on the first pair sharing a tag, and so does
 * every counter and every RNG; a menu cursor cannot. Iterative narrowing stays
 * available for states that cannot be reproduced, but the tag pattern is the fast
 * path, and on the measured target it took 294,912 addresses to five with no mutes at
 * all.
 *
 * Candidates are a bitset rather than a list of addresses: `unchanged` between two
 * captures answers 291,679 of them, which is 2.3 MB as a `number[]` for every undo
 * step and 36 KB as bits.
 */
import type { DebugInfo, Placement, TypeDesc, ValueReader } from '@gba-kit/debug-info';
import { bitfieldPlacement, formatBitfield, formatValue, placementAt, scalarSize } from '@gba-kit/debug-info';

import { type Machine, RAM_REGIONS } from './machine.js';
import { type Mute, type MuteSource, MuteStore } from './memory-noise.js';
import { searchMemory } from './memory-search.js';
import type { Screen } from './ppu.js';

/** The two regions a capture holds; the keys are `RAM_REGIONS`'. */
export type RamRegion = keyof typeof RAM_REGIONS;

export type RamPair = Record<RamRegion, Uint8Array>;

const REGIONS: readonly RamRegion[] = ['iwram', 'ewram'];

/** How many candidates are worth grouping, ranking and ordering, and how deep undo goes. */
export const DIFF_LIMITS = {
  /** beyond this a result is a count and a page of addresses: nobody reads 290,000 ranked rows */
  detail: 5000,
  rowsDefault: 512,
  rowsMax: 5000,
  undoDepth: 20,
} as const;

/** A capture as the session holds it: the RAM never leaves, everything else describes it. */
export interface Capture {
  /** stable within a session; a panel's ①②③ is its position, this is its identity */
  id: number;
  /** what the user calls it; equal tags are what the tag filter matches on */
  tag: string;
  frame: number;
  createdAt: string;
  /** where it came from, since a state-adopted capture was never live here */
  origin: 'machine' | 'state';
  ram: RamPair;
  thumbnail: Screen;
}

/** What a filter asks of the captures. */
export type DiffMode =
  | { kind: 'value'; value: number }
  | { kind: 'changed' | 'unchanged'; from: number; to: number }
  | { kind: 'increased' | 'decreased'; from: number; to: number; by?: number }
  | { kind: 'tags' };

export interface DiffRow {
  address: number;
  /** one per capture, in capture order — the matrix the user reads by eye */
  values: number[];
  /** how each value reads through its type, when a type reached the address */
  formatted?: string[];
  placement: Placement;
  /** how ranking judged it, and why, so the order is arguable rather than magic */
  rank: number;
  reasons: string[];
}

export interface DiffGroup {
  key: string;
  tier: Placement['tier'];
  label: string;
  rows: number;
  topRank: number;
}

export interface DiffResult {
  total: number;
  /** too many candidates to group, rank or order: the rows are a page in address order */
  capped: boolean;
  undoDepth: number;
  /** how many candidates each mute source hid, by source */
  hidden: Record<string, number>;
}

/** What a filter would do, without doing it. */
export interface DiffPreview {
  kept: number;
  removed: number;
  hidden: Record<string, number>;
}

/** What the engine reaches outside itself for: the live machine, and what the program says about an address. */
export interface DiffContext {
  /** an exact-value filter asks memory rather than the captures, the way `searchMemory` always has */
  machine(): Machine;
  info(): DebugInfo | null;
}

const bitAt = (bits: Uint8Array, i: number): number => (bits[i >> 3]! >> (i & 7)) & 1;
const setBit = (bits: Uint8Array, i: number): void => {
  bits[i >> 3]! |= 1 << (i & 7);
};

/** Little-endian unsigned integer of `size` bytes out of a capture's region. */
function readAt(bytes: Uint8Array, offset: number, size: number): number {
  let value = 0;
  for (let k = size - 1; k >= 0; k--) {
    value = value * 256 + bytes[offset + k]!;
  }
  return value >>> 0;
}

/** Which region an address is in and where in it, or null when it is in neither. */
function locate(address: number): { region: RamRegion; offset: number } | null {
  for (const region of REGIONS) {
    const { base, size } = RAM_REGIONS[region];
    if (address >= base && address < base + size) {
      return { region, offset: address - base };
    }
  }
  return null;
}

/**
 * Which addresses are still in play, one bit per addressable byte of each region. A
 * filter at `size` keeps an aligned address only when every one of its bytes was in
 * play, so narrowing at a wider size after a narrow one means what it says.
 */
export class CandidateMask {
  readonly iwram: Uint8Array;
  readonly ewram: Uint8Array;

  /** Use {@link CandidateMask.empty} or {@link CandidateMask.full}; the arrays are the bits themselves. */

  constructor(iwram: Uint8Array, ewram: Uint8Array) {
    this.iwram = iwram;
    this.ewram = ewram;
  }

  static empty(): CandidateMask {
    return new CandidateMask(new Uint8Array(RAM_REGIONS.iwram.size >> 3), new Uint8Array(RAM_REGIONS.ewram.size >> 3));
  }

  static full(): CandidateMask {
    const mask = CandidateMask.empty();
    mask.iwram.fill(0xff);
    mask.ewram.fill(0xff);
    return mask;
  }

  bits(region: RamRegion): Uint8Array {
    return region === 'iwram' ? this.iwram : this.ewram;
  }

  has(address: number): boolean {
    const at = locate(address);
    return at !== null && bitAt(this.bits(at.region), at.offset) === 1;
  }

  /** Whether all `size` bytes from `offset` are in play. */
  spans(region: RamRegion, offset: number, size: number): boolean {
    const bits = this.bits(region);
    for (let k = 0; k < size; k++) {
      if (bitAt(bits, offset + k) === 0) {
        return false;
      }
    }
    return true;
  }

  setSpan(region: RamRegion, offset: number, size: number): void {
    const bits = this.bits(region);
    for (let k = 0; k < size; k++) {
      setBit(bits, offset + k);
    }
  }

  /** Drop `[lo, hi)`, whatever regions it reaches. */
  clearRange(lo: number, hi: number): void {
    for (const region of REGIONS) {
      const { base, size } = RAM_REGIONS[region];
      const from = Math.max(lo, base) - base;
      const to = Math.min(hi, base + size) - base;
      const bits = this.bits(region);
      for (let i = from; i < to; i++) {
        bits[i >> 3]! &= ~(1 << (i & 7));
      }
    }
  }

  and(other: CandidateMask): CandidateMask {
    const out = CandidateMask.empty();
    for (const region of REGIONS) {
      const a = this.bits(region);
      const b = other.bits(region);
      const into = out.bits(region);
      for (let i = 0; i < into.length; i++) {
        into[i] = a[i]! & b[i]!;
      }
    }
    return out;
  }

  /** How many `size`-aligned addresses are wholly in play. */
  count(size: 1 | 2 | 4): number {
    let total = 0;
    for (const region of REGIONS) {
      const length = RAM_REGIONS[region].size;
      for (let offset = 0; offset + size <= length; offset += size) {
        if (this.spans(region, offset, size)) {
          total++;
        }
      }
    }
    return total;
  }

  /** A window of the candidate addresses, in address order. */
  addresses(size: 1 | 2 | 4, from: number, limit: number): number[] {
    const out: number[] = [];
    let seen = 0;
    for (const region of REGIONS) {
      const { base, size: length } = RAM_REGIONS[region];
      for (let offset = 0; offset + size <= length; offset += size) {
        if (!this.spans(region, offset, size)) {
          continue;
        }
        if (seen++ < from) {
          continue;
        }
        out.push(base + offset);
        if (out.length >= limit) {
          return out;
        }
      }
    }
    return out;
  }
}

/** The enabled mutes as a byte per address saying which source hides it, for a filter that asks per candidate. */
function muteMask(mutes: Mute[]): Record<RamRegion, Uint8Array> | null {
  if (mutes.length === 0) {
    return null;
  }
  const codes: Record<MuteSource, number> = { idle: 1, dma: 2, stack: 3, user: 4 };
  const mask = {
    iwram: new Uint8Array(RAM_REGIONS.iwram.size),
    ewram: new Uint8Array(RAM_REGIONS.ewram.size),
  };
  for (const mute of mutes) {
    for (const range of mute.ranges) {
      for (const region of REGIONS) {
        const { base, size } = RAM_REGIONS[region];
        const from = Math.max(range.lo, base) - base;
        const to = Math.min(range.hi, base + size) - base;
        const into = mask[region];
        for (let i = from; i < to; i++) {
          // the first mute covering an address is the one credited with hiding it, so
          // the tally adds up to the number of candidates removed rather than over-counting
          if (into[i] === 0) {
            into[i] = codes[mute.source];
          }
        }
      }
    }
  }
  return mask;
}

const SOURCE_NAMES = ['', 'idle', 'dma', 'stack', 'user'] as const;

/** A reader over a capture's frozen RAM, so a value is formatted as it was then rather than as it is now. */
function captureReader(capture: Capture): ValueReader {
  return {
    read(address: number, size: number): Uint8Array | null {
      const at = locate(address);
      if (!at || at.offset + size > RAM_REGIONS[at.region].size) {
        return null;
      }
      return capture.ram[at.region].subarray(at.offset, at.offset + size);
    },
  };
}

/** Whether a type is worth formatting a single value through: a scalar, an enum, a bool, a bitfield. */
function formattable(placement: Placement): TypeDesc | null {
  const type = placement.type;
  if (!type || placement.straddles) {
    return null;
  }
  return placement.member?.bitSize !== undefined || scalarSize(type) > 0 ? type : null;
}

export class MemoryDiff {
  readonly mutes = new MuteStore();
  readonly #context: DiffContext;
  #captures: Capture[] = [];
  #nextId = 1;
  #mask = CandidateMask.full();
  /** the candidate set before each filter, with the size it was addressed at: undoing restores both */
  #undo: Array<{ mask: CandidateMask; size: 1 | 2 | 4 }> = [];
  #size: 1 | 2 | 4 = 1;
  #hidden: Record<string, number> = {};
  /** the placed, ranked, ordered rows of the current candidate set: `rows` and `groups` are both this */
  #rows: DiffRow[] | null = null;

  constructor(context: DiffContext) {
    this.#context = context;
  }

  captures(): Capture[] {
    return [...this.#captures];
  }

  /** The size the last filter ran at, which is what the rows are addressed by. */
  get size(): 1 | 2 | 4 {
    return this.#size;
  }

  capture(ram: RamPair, thumbnail: Screen, frame: number, tag = '', origin: Capture['origin'] = 'machine'): Capture {
    const capture: Capture = {
      id: this.#nextId++,
      tag: tag.trim(),
      frame,
      createdAt: new Date().toISOString(),
      origin,
      ram,
      thumbnail,
    };
    this.#captures.push(capture);
    this.#rows = null;
    return capture;
  }

  byId(id: number): Capture {
    const capture = this.#captures.find((c) => c.id === id);
    if (!capture) {
      throw new Error(`no capture ${id}`);
    }
    return capture;
  }

  retag(id: number, tag: string): Capture {
    const capture = this.byId(id);
    capture.tag = tag.trim();
    this.#rows = null;
    return capture;
  }

  forget(id: number): boolean {
    const at = this.#captures.findIndex((c) => c.id === id);
    if (at < 0) {
      return false;
    }
    this.#captures.splice(at, 1);
    this.#rows = null;
    return true;
  }

  /** Everything a restart invalidates: the captures are of a machine that no longer exists. */
  clear(): void {
    this.#captures = [];
    this.mutes.clear();
    this.reset();
  }

  reset(): DiffResult {
    this.#mask = CandidateMask.full();
    this.#undo = [];
    this.#hidden = {};
    this.#rows = null;
    return this.result();
  }

  undo(): DiffResult | null {
    const previous = this.#undo.pop();
    if (!previous) {
      return null;
    }
    this.#mask = previous.mask;
    this.#size = previous.size;
    this.#hidden = {};
    this.#rows = null;
    return this.result();
  }

  result(): DiffResult {
    const total = this.#mask.count(this.#size);
    return { total, capped: total > DIFF_LIMITS.detail, undoDepth: this.#undo.length, hidden: this.#hidden };
  }

  /** What `apply` would leave behind, and what each mute source would take, without committing it. */
  preview(mode: DiffMode, size: 1 | 2 | 4): DiffPreview {
    const scan = this.#scan(mode, size);
    return { kept: scan.kept, removed: this.#mask.count(size) - scan.kept, hidden: scan.hidden };
  }

  /** Narrow the candidates; the previous set goes on the undo stack. */
  apply(mode: DiffMode, size: 1 | 2 | 4): DiffResult {
    const scan = this.#scan(mode, size);
    this.#undo.push({ mask: this.#mask, size: this.#size });
    if (this.#undo.length > DIFF_LIMITS.undoDepth) {
      this.#undo.shift();
    }
    this.#mask = scan.mask;
    this.#size = size;
    this.#hidden = scan.hidden;
    this.#rows = null;
    return this.result();
  }

  #scan(mode: DiffMode, size: 1 | 2 | 4): { mask: CandidateMask; kept: number; hidden: Record<string, number> } {
    const keep = this.#predicate(mode, size);
    const mutes = muteMask(this.mutes.enabled());
    const mask = CandidateMask.empty();
    const hidden: Record<string, number> = {};
    let kept = 0;
    for (const region of REGIONS) {
      const { base, size: length } = RAM_REGIONS[region];
      const muted = mutes?.[region];
      for (let offset = 0; offset + size <= length; offset += size) {
        if (!this.#mask.spans(region, offset, size)) {
          continue;
        }
        if (!keep(region, offset, base + offset)) {
          continue;
        }
        let code = 0;
        for (let k = 0; k < size && code === 0; k++) {
          code = muted?.[offset + k] ?? 0;
        }
        if (code !== 0) {
          const name = SOURCE_NAMES[code]!;
          hidden[name] = (hidden[name] ?? 0) + 1;
          continue;
        }
        mask.setSpan(region, offset, size);
        kept++;
      }
    }
    return { mask, kept, hidden };
  }

  /**
   * An address survives when, for every pair of captures, its value is equal exactly
   * when their tags are equal. A sound mixer fails on the first pair that shares a
   * tag; a menu cursor cannot.
   */
  #predicate(mode: DiffMode, size: 1 | 2 | 4): (region: RamRegion, offset: number, address: number) => boolean {
    switch (mode.kind) {
      case 'value': {
        const found = CandidateMask.empty();
        for (const address of searchMemory(this.#context.machine(), {
          value: mode.value,
          size,
          limit: Number.MAX_SAFE_INTEGER,
        })) {
          const at = locate(address);
          if (at) {
            found.setSpan(at.region, at.offset, size);
          }
        }
        return (region, offset) => found.spans(region, offset, size);
      }
      case 'tags': {
        const captures = this.#requireCaptures(2);
        const values = new Array<number>(captures.length);
        return (region, offset) => {
          for (let i = 0; i < captures.length; i++) {
            values[i] = readAt(captures[i]!.ram[region], offset, size);
          }
          for (let i = 0; i < captures.length; i++) {
            for (let j = i + 1; j < captures.length; j++) {
              if ((captures[i]!.tag === captures[j]!.tag) !== (values[i] === values[j])) {
                return false;
              }
            }
          }
          return true;
        };
      }
      default: {
        const from = this.byId(mode.from);
        const to = this.byId(mode.to);
        const by = 'by' in mode ? mode.by : undefined;
        return (region, offset) => {
          const a = readAt(from.ram[region], offset, size);
          const b = readAt(to.ram[region], offset, size);
          switch (mode.kind) {
            case 'changed':
              return a !== b;
            case 'unchanged':
              return a === b;
            case 'increased':
              return by === undefined ? b > a : b - a === by;
            case 'decreased':
              return by === undefined ? b < a : a - b === by;
          }
        };
      }
    }
  }

  #requireCaptures(least: number): Capture[] {
    if (this.#captures.length < least) {
      throw new Error(
        `this filter needs at least ${least} captures; there ${this.#captures.length === 1 ? 'is 1' : `are ${this.#captures.length}`}`,
      );
    }
    return this.#captures;
  }

  /**
   * The candidates as rows, ranked when there are few enough of them to rank.
   *
   * Ranking is by how *lonely* a candidate is, not by how well named it is: a first
   * attempt that awarded a point for sitting inside a named symbol put the right
   * answer 26th of 39 on the measured target, below twenty-five sound-mixer bytes,
   * because on a decomp the interesting variable is precisely the unnamed one.
   * Sparsity put it first.
   */
  rows(from: number, limit: number): DiffRow[] {
    const all = this.#detailRows();
    if (all) {
      return all.slice(from, from + limit);
    }
    const info = this.#context.info();
    return this.#mask
      .addresses(this.#size, from, limit)
      .map((address) => this.#row(address, this.#size, info, null, ['too many candidates to rank']));
  }

  /** The groups the rows fall into, or none when there are too many candidates to place. */
  groups(): DiffGroup[] {
    const all = this.#detailRows();
    if (!all) {
      return [];
    }
    const groups = new Map<string, DiffGroup>();
    for (const row of all) {
      const key = groupKey(row.placement);
      const group = groups.get(key.key);
      if (group) {
        group.rows++;
        group.topRank = Math.max(group.topRank, row.rank);
      } else {
        groups.set(key.key, { ...key, tier: row.placement.tier, rows: 1, topRank: row.rank });
      }
    }
    return [...groups.values()].sort((a, b) => b.topRank - a.topRank || b.rows - a.rows);
  }

  /**
   * Every candidate placed, ranked and ordered — or null when there are more of them
   * than are worth placing, since placing one walks the symbol table and the DWARF and
   * nobody reads 290,000 ranked rows. Held until the candidates or the captures change,
   * so asking for the rows and the groups of one result does the work once.
   */
  #detailRows(): DiffRow[] | null {
    if (this.#rows) {
      return this.#rows;
    }
    if (this.#mask.count(this.#size) > DIFF_LIMITS.detail) {
      return null;
    }
    const info = this.#context.info();
    const context = this.#rankContext();
    const rows = this.#mask
      .addresses(this.#size, 0, DIFF_LIMITS.detail)
      .map((address) => this.#row(address, this.#size, info, context, []));
    rows.sort((a, b) => b.rank - a.rank || a.address - b.address);
    this.#rows = rows;
    return rows;
  }

  /**
   * What ranking needs to know about the neighbourhood of an address, worked out once
   * per result: which bytes changed between the first two captures, how many changed
   * within reach of each one, and how long the run of changed bytes it sits in is. All
   * three are one pass over 288 KB, where asking per row would be a 512-byte loop per
   * row.
   */
  #rankContext(): RankContext | null {
    if (this.#captures.length < 2) {
      return null;
    }
    const [first, second] = this.#captures as [Capture, Capture];
    const tags = new Set(this.#captures.map((c) => c.tag)).size;
    const per = {} as RankContext['per'];
    for (const region of REGIONS) {
      const a = first.ram[region];
      const b = second.ram[region];
      const length = a.length;
      const prefix = new Int32Array(length + 1);
      const runs = new Uint16Array(length);
      for (let i = 0; i < length; i++) {
        prefix[i + 1] = prefix[i]! + (a[i] !== b[i] ? 1 : 0);
      }
      for (let i = 0; i < length; ) {
        if (a[i] === b[i]) {
          i++;
          continue;
        }
        let end = i;
        while (end < length && a[end] !== b[end]) {
          end++;
        }
        runs.fill(Math.min(0xffff, end - i), i, end);
        i = end;
      }
      per[region] = { prefix, runs };
    }
    return { tags, per };
  }

  #row(address: number, size: 1 | 2 | 4, info: DebugInfo | null, rank: RankContext | null, reasons: string[]): DiffRow {
    const at = locate(address)!;
    const values = this.#captures.map((c) => readAt(c.ram[at.region], at.offset, size));
    const placement = info ? placementAt(info, address, size) : { address, tier: 'unattributed' as const };
    const row: DiffRow = { address, values, placement, rank: 0, reasons };
    const type = formattable(placement);
    if (type) {
      row.formatted = this.#captures.map((c) => format(c, placement, type));
    }
    if (rank) {
      const { prefix, runs } = rank.per[at.region];
      const near = prefix[Math.min(runs.length, at.offset + 256)]! - prefix[Math.max(0, at.offset - 256)]!;
      const run = runs[at.offset] || 1;
      const distinct = new Set(values).size;
      let score = 0;
      if (near <= 4) {
        score += 4;
      } else if (near <= 16) {
        score += 2;
      } else if (near <= 64) {
        score += 1;
      }
      if (near <= 64) {
        row.reasons.push(`${near} changed byte${near === 1 ? '' : 's'} within ±256`);
      }
      if (distinct === rank.tags) {
        score += 3;
        row.reasons.push(`${distinct} distinct value${distinct === 1 ? '' : 's'}, one per tag`);
      }
      if (run <= 4) {
        score += run <= 2 ? 3 : 1;
        row.reasons.push(`a run of ${run} changed byte${run === 1 ? '' : 's'}`);
      }
      row.rank = score;
    }
    return row;
  }
}

interface RankContext {
  tags: number;
  per: Record<RamRegion, { prefix: Int32Array; runs: Uint16Array }>;
}

/**
 * One value, read through its type the way the variables tree reads it — from the
 * capture's own bytes, so the matrix shows what each capture held rather than what
 * memory holds now. A value is read at the start of the object the address landed in,
 * not at the address: halfway into a `u32` is not a `u32`.
 */
function format(capture: Capture, placement: Placement, type: TypeDesc): string {
  const reader = captureReader(capture);
  const base = placement.base ?? placement.address;
  const name = placement.path ?? '';
  const bits = placement.member ? bitfieldPlacement(placement.member) : null;
  if (bits) {
    const at = base + bits.byteOffset;
    return formatBitfield(name, type, reader.read(at, bits.bits.span), at, bits.bits).value;
  }
  return formatValue(name, type, reader.read(base, Math.max(1, type.size)), base, reader).value;
}

/** What a row is grouped under: the object when one is claimed, else the memory it is in. */
function groupKey(placement: Placement): { key: string; label: string } {
  if (placement.tier === 'unattributed' || !placement.symbol) {
    const at = locate(placement.address);
    const region = at ? at.region.toUpperCase() : 'memory';
    return { key: `region:${region}`, label: `unattributed ${region}` };
  }
  return { key: `symbol:${placement.symbol.name}`, label: placement.symbol.name };
}
