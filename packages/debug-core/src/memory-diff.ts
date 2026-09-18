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
 *
 * A mute is a view over that set, not a filter into it: the bits a mute covers stay
 * in the candidate set and are dropped when the set is reported. That is what makes
 * switching a mute off put its addresses back — with no filter to re-run — and what
 * lets the tally say how many candidates each source is hiding right now.
 */
import type { DebugInfo, Placement, TypeDesc, ValueReader } from '@gba-kit/debug-info';
import { bitfieldPlacement, formatBitfield, formatValue, placementAt, scalarSize } from '@gba-kit/debug-info';

import { DIFF_LIMITS } from './diff-limits.js';
import { RAM_REGIONS } from './machine.js';
import { MUTE_SOURCES, type Mute, type MuteSource, MuteStore } from './memory-noise.js';
import type { Screen } from './ppu.js';

/** The two regions a capture holds; the keys are `RAM_REGIONS`'. */
export type RamRegion = keyof typeof RAM_REGIONS;

export type RamPair = Record<RamRegion, Uint8Array>;

const REGIONS: readonly RamRegion[] = ['iwram', 'ewram'];

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

/** What one link expects of a value between the two captures it joins. */
export type Relation = 'same' | 'changed' | 'increased' | 'decreased';

/**
 * How much a candidate looks like a variable rather than a byte of something bigger. The
 * score behind it is an ordering and not a calibrated scale — the reasons a row carries
 * are what a user reads to disagree with it — so it is reported as one of three words,
 * which is as much as the weights can honestly claim.
 */
export type RankLevel = 'likely' | 'possible' | 'unlikely';

/** What each level is worth explaining as, where a row shows one. */
export const RANK_LEVELS: Record<RankLevel, string> = {
  likely: 'Looks like a variable',
  possible: 'Could be a variable',
  unlikely: 'Looks like part of something bigger',
};

/** Which of the three a score falls in. The highest any one criterion is worth is 4, so a row needs two of them to lead. */
export function rankLevel(score: number): RankLevel {
  return score >= 7 ? 'likely' : score >= 4 ? 'possible' : 'unlikely';
}

/** Every relation a link can carry, in the order the panel offers them. */
export const RELATIONS: readonly Relation[] = ['changed', 'same', 'increased', 'decreased'];

/**
 * One expectation, between two captures. The links along the strip and an arc back to a
 * capture a later one repeats are the same thing: `same` between captures that are not
 * neighbours is what says "I went back", and it is the constraint that does the work —
 * "changed, then changed again" is what every churning byte does.
 */
export interface DiffEdge {
  from: number;
  to: number;
  relation: Relation;
}

/** A value a capture held, for the states that do put a number on the screen. */
export interface DiffValue {
  capture: number;
  value: number;
}

/** What a filter asks of the captures: every edge and every value, all at once. */
export interface DiffQuery {
  edges?: DiffEdge[];
  values?: DiffValue[];
}

export interface DiffRow {
  address: number;
  /** the group it belongs to, so a client that pages the rows needs no second request */
  group: string;
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
  /** how many candidates a page of rows can still reach, so a client knows what it is not showing */
  detail: number;
  /** too many candidates to group, rank or order: the rows are a page in address order */
  capped: boolean;
  /** whether a query has been answered at all: an untouched set is every address there is, which nobody asked for */
  asked: boolean;
  /** how many candidates each mute source hid, by source */
  hidden: Record<string, number>;
}

/** What the engine reaches outside itself for: the live machine, and what the program says about an address. */
export interface DiffContext {
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

  /** Takes the bit arrays themselves; {@link CandidateMask.empty} and {@link CandidateMask.full} size them. */
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

/**
 * The enabled mutes as a byte per address saying which source hides it, for a view
 * that asks per candidate. Code 0 is "nothing hides this", so a source's code is one
 * past its place in `MUTE_SOURCES` and `sourceOfCode` reads it back off the same list.
 */
function muteMask(mutes: Mute[]): Record<RamRegion, Uint8Array> | null {
  if (mutes.length === 0) {
    return null;
  }
  const codes = (source: MuteSource): number => MUTE_SOURCES.indexOf(source) + 1;
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
            into[i] = codes(mute.source);
          }
        }
      }
    }
  }
  return mask;
}

const sourceOfCode = (code: number): MuteSource => MUTE_SOURCES[code - 1]!;

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

/**
 * Whether a type is worth formatting a row's value through: a scalar, an enum, a bool,
 * a bitfield — and only where the row's own bytes are that object's bytes. A byte of a
 * `u32` is not the `u32`: formatting it through the word would print a number the row's
 * filter never looked at, so a row kept by `unchanged` would read as one that changed.
 */
function formattable(placement: Placement, size: 1 | 2 | 4): TypeDesc | null {
  const type = placement.type;
  if (!type || placement.straddles) {
    return null;
  }
  const bits = placement.member ? bitfieldPlacement(placement.member) : null;
  const start = (placement.base ?? placement.address) + (bits?.byteOffset ?? 0);
  const width = bits ? bits.bits.span : scalarSize(type);
  return start === placement.address && width === size ? type : null;
}

/** `①`, `②`, … for a capture at a position, so a refusal names it the way the strip does. */
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫'];

const positionName = (captures: Capture[], id: number): string => {
  const at = captures.findIndex((c) => c.id === id);
  return at < 0 ? `capture ${id}` : (CIRCLED[at] ?? `#${at + 1}`);
};

/**
 * Why no value could satisfy this query, or null. Links between neighbours could never
 * contradict each other, but an arc back to an earlier capture can: `①` up to `②`, `②` up
 * to `③` and `③` the same as `①` describes a value that is both larger than itself and
 * equal to it. That is one click away here, and a query nothing can satisfy has to say so
 * rather than answer with no rows and look like a feature that found nothing.
 */
/**
 * How many distinct states the query describes, and which captures take part. Captures an
 * arc joins hold one state between them, so `A, B, A` describes two — and a
 * candidate taking exactly that many distinct values is answering the question that was
 * asked rather than merely moving.
 */
export function queryStates(asked: DiffQuery, captures: Capture[]): { count: number; taking: number[] } {
  const edges = asked.edges ?? [];
  const named = new Set(edges.flatMap((e) => [e.from, e.to]));
  const group = new Map<number, number>();
  const find = (id: number): number => {
    let root = group.get(id) ?? id;
    while (root !== (group.get(root) ?? root)) {
      root = group.get(root) ?? root;
    }
    return root;
  };
  for (const edge of edges.filter((e) => e.relation === 'same')) {
    group.set(find(edge.from), find(edge.to));
  }
  const taking = captures.flatMap((c, i) => (named.has(c.id) ? [i] : []));
  return { count: new Set([...named].map(find)).size, taking };
}

export function queryProblem(asked: DiffQuery, captures: Capture[]): string | null {
  const query = { edges: asked.edges ?? [], values: asked.values ?? [] };
  const known = new Set(captures.map((c) => c.id));
  for (const edge of query.edges) {
    for (const end of [edge.from, edge.to]) {
      if (!known.has(end)) {
        return `no capture ${end}`;
      }
    }
  }
  for (const value of query.values) {
    if (!known.has(value.capture)) {
      return `no capture ${value.capture}`;
    }
  }

  // captures a `same` link joins hold one value between them, so every other link is
  // really a link between the groups those form
  const group = new Map<number, number>();
  const find = (id: number): number => {
    let root = group.get(id) ?? id;
    while (root !== (group.get(root) ?? root)) {
      root = group.get(root) ?? root;
    }
    return root;
  };
  for (const edge of query.edges.filter((e) => e.relation === 'same')) {
    group.set(find(edge.from), find(edge.to));
  }

  const name = (id: number): string => positionName(captures, id);
  for (const edge of query.edges) {
    if (edge.relation !== 'same' && find(edge.from) === find(edge.to)) {
      return `${name(edge.from)} and ${name(edge.to)} are the same state, so nothing can have ${edge.relation} between them`;
    }
  }

  // an increase is a strict order between groups: a cycle in it is a value above itself
  const after = new Map<number, number[]>();
  for (const edge of query.edges) {
    if (edge.relation !== 'increased' && edge.relation !== 'decreased') {
      continue;
    }
    const [low, high] =
      edge.relation === 'increased' ? [find(edge.from), find(edge.to)] : [find(edge.to), find(edge.from)];
    after.set(low, [...(after.get(low) ?? []), high]);
  }
  const done = new Set<number>();
  const onPath = new Set<number>();
  const cycles = (node: number): boolean => {
    if (onPath.has(node)) {
      return true;
    }
    if (done.has(node)) {
      return false;
    }
    onPath.add(node);
    for (const next of after.get(node) ?? []) {
      if (cycles(next)) {
        return true;
      }
    }
    onPath.delete(node);
    done.add(node);
    return false;
  };
  for (const node of after.keys()) {
    if (cycles(node)) {
      return 'these links describe a value that rises and falls back to itself; loosen one of them';
    }
  }
  return null;
}

export class MemoryDiff {
  readonly mutes = new MuteStore();
  readonly #context: DiffContext;
  #captures: Capture[] = [];
  #nextId = 1;
  /** every address the filters kept, mutes included: what a mute hides is subtracted when this is read */
  #mask = CandidateMask.full();
  #asked = false;
  /** the states the standing query describes, which is what ranking judges a value's spread against */
  #states: { count: number; taking: number[] } = { count: 0, taking: [] };
  #size: 1 | 2 | 4 = 1;
  /** the two captures the last filter compared, which is the pair ranking judges a neighbourhood by */
  #pair: RankPair = null;
  /** the visible candidates, their rows and what the mutes took, held until any of the three could change */
  #view: View | null = null;

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
    if (this.#captures.length >= DIFF_LIMITS.captures) {
      throw new Error(`this session holds ${DIFF_LIMITS.captures} captures; forget one to take another`);
    }
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
    this.#view = null;
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
    this.#view = null;
    return capture;
  }

  /**
   * Put the captures in this order. A strip read left to right is the run the links
   * describe, and captures adopted from save states arrive in no order at all — so the
   * sequence is the user's to state, not the order they happened to be taken in.
   */
  reorder(ids: number[]): Capture[] {
    const byId = new Map(this.#captures.map((c) => [c.id, c]));
    const moved: Capture[] = [];
    for (const id of ids) {
      const capture = byId.get(id);
      if (!capture || moved.includes(capture)) {
        throw new Error(`no capture ${id}`);
      }
      moved.push(capture);
    }
    if (moved.length !== this.#captures.length) {
      throw new Error(`an order has to name every capture; ${moved.length} of ${this.#captures.length} were named`);
    }
    this.#captures = moved;
    this.#view = null;
    return this.#captures;
  }

  forget(id: number): Capture {
    const at = this.#captures.findIndex((c) => c.id === id);
    if (at < 0) {
      throw new Error(`no capture ${id}`);
    }
    const [gone] = this.#captures.splice(at, 1) as [Capture];
    // a pair naming a capture that is gone is no pair: ranking falls back to the captures
    // still held rather than asking the store for one it no longer has, which would fail
    // every read of the result — the rows and the groups alike
    this.#pair = withoutCapture(this.#pair, id);
    this.#view = null;
    return gone;
  }

  /** Everything a restart invalidates: the captures are of a machine that no longer exists. */
  clear(): void {
    this.#captures = [];
    this.mutes.clear();
    this.reset();
  }

  reset(): DiffResult {
    this.#mask = CandidateMask.full();
    this.#asked = false;
    this.#states = { count: 0, taking: [] };
    this.#pair = null;
    this.#view = null;
    return this.result();
  }

  result(): DiffResult {
    const view = this.#seen();
    const total = view.mask.count(this.#size);
    return {
      total,
      detail: DIFF_LIMITS.detail,
      capped: total > DIFF_LIMITS.detail,
      asked: this.#asked,
      hidden: view.hidden,
    };
  }

  /**
   * Answer the query. It is asked of the whole address space every time, not of what the
   * last one left: a query is a standing description of the run rather than a step in a
   * narrowing, so loosening a link has to be able to bring rows back. A pass over both
   * regions costs tens of milliseconds, which is what makes that affordable.
   */
  apply(asked: DiffQuery, size: 1 | 2 | 4): DiffResult {
    const query = { edges: asked.edges ?? [], values: asked.values ?? [] };
    const problem = queryProblem(query, this.#captures);
    if (problem) {
      throw new Error(problem);
    }
    this.#mask = this.#scan(query, size);
    this.#asked = true;
    this.#states = queryStates(query, this.#captures);
    this.#size = size;
    this.#pair = this.#pairOf(query);
    this.#view = null;
    return this.result();
  }

  /** Which addresses the query keeps, mutes not consulted: hiding is what reading does. */
  #scan(query: Required<DiffQuery>, size: 1 | 2 | 4): CandidateMask {
    const keep = this.#predicate(query, size);
    const mask = CandidateMask.empty();
    for (const region of REGIONS) {
      const { base, size: length } = RAM_REGIONS[region];
      for (let offset = 0; offset + size <= length; offset += size) {
        if (keep(region, offset, base + offset)) {
          mask.setSpan(region, offset, size);
        }
      }
    }
    return mask;
  }

  /** A candidate set as it is reported: what no enabled mute covers, and the tally of what each took. */
  #hide(mask: CandidateMask, size: 1 | 2 | 4): { mask: CandidateMask; hidden: Record<string, number> } {
    const mutes = muteMask(this.mutes.enabled());
    if (!mutes) {
      return { mask, hidden: {} };
    }
    const out = CandidateMask.empty();
    const hidden: Record<string, number> = {};
    for (const region of REGIONS) {
      const { size: length } = RAM_REGIONS[region];
      const muted = mutes[region];
      for (let offset = 0; offset + size <= length; offset += size) {
        if (!mask.spans(region, offset, size)) {
          continue;
        }
        let code = 0;
        for (let k = 0; k < size && code === 0; k++) {
          code = muted[offset + k] ?? 0;
        }
        if (code !== 0) {
          const name = sourceOfCode(code);
          hidden[name] = (hidden[name] ?? 0) + 1;
          continue;
        }
        out.setSpan(region, offset, size);
      }
    }
    return { mask: out, hidden };
  }

  /** The visible candidates and their rows, recomputed when the candidates, the captures or the mutes moved. */
  #seen(): View {
    const version = this.mutes.version;
    if (this.#view && this.#view.version === version) {
      return this.#view;
    }
    this.#view = { version, ...this.#hide(this.#mask, this.#size), rows: undefined };
    return this.#view;
  }

  /**
   * What the whole query asks of one address. Everything it needs from the captures is
   * worked out once here and closed over, so the scan is a loop over memory rather than
   * a loop over the query. An `any` link asks nothing and is dropped before the loop.
   */
  #predicate(
    query: Required<DiffQuery>,
    size: 1 | 2 | 4,
  ): (region: RamRegion, offset: number, address: number) => boolean {
    const mask = size === 4 ? 0xffffffff : (1 << (size * 8)) - 1;
    const values = query.values.map((v) => ({ ram: this.byId(v.capture).ram, value: (v.value & mask) >>> 0 }));
    const edges = query.edges.map((e) => ({
      a: this.byId(e.from).ram,
      b: this.byId(e.to).ram,
      relation: e.relation,
    }));
    return (region, offset) => {
      for (const v of values) {
        if (readAt(v.ram[region], offset, size) !== v.value) {
          return false;
        }
      }
      for (const e of edges) {
        const a = readAt(e.a[region], offset, size);
        const b = readAt(e.b[region], offset, size);
        if (
          e.relation === 'same'
            ? a !== b
            : e.relation === 'changed'
              ? a === b
              : e.relation === 'increased'
                ? b <= a
                : b >= a
        ) {
          return false;
        }
      }
      return true;
    };
  }

  /**
   * The two captures a filter compared, which is the pair its candidates are judged
   * against: a neighbourhood counted over some other pair describes memory the user did
   * not ask about, and the run lengths it reports would be of that pair's buffers. The
   * first link that asks for a difference is the one the user is looking at.
   */
  #pairOf(query: Required<DiffQuery>): RankPair {
    const told = query.edges.find((e) => e.relation !== 'same');
    return told ? [told.from, told.to] : null;
  }

  /**
   * The candidates as rows, ranked when there are few enough of them to rank.
   *
   * Ranking is by how *lonely* a candidate is, not by how well named it is. On a
   * decomp the interesting variable is precisely the one nothing names, so a point
   * for sitting inside a named symbol buries it: that ordering puts the answer 26th
   * of 39 on the measured target, below twenty-five sound-mixer bytes. Sparsity puts
   * it first.
   */
  rows(from: number, limit: number): DiffRow[] {
    const all = this.#detailRows();
    if (all) {
      return all.slice(from, from + limit);
    }
    const info = this.#context.info();
    return this.#seen()
      .mask.addresses(this.#size, from, limit)
      .map((address) => this.#row(address, this.#size, info, null, ['too many candidates to rank']));
  }

  /**
   * The groups the rows fall into, or none when there are too many candidates to place.
   * Ordered by their best row, so reading the groups top to bottom meets the candidates in
   * the order ranking put them in: a bigger group of equally ranked rows is a wider guess,
   * not a better one, and promoting it buries the row ranking chose under the ones it tied.
   */
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
    // the rows arrive ranked, so a group enters the map where its best row sits in that
    // order and a stable sort on the rank alone keeps it there
    return [...groups.values()].sort((a, b) => b.topRank - a.topRank);
  }

  /**
   * Every candidate placed, ranked and ordered — or null when there are more of them
   * than are worth placing, since placing one walks the symbol table and the DWARF and
   * nobody reads 290,000 ranked rows. Held until the candidates, the captures or the
   * mutes move, so asking for the rows and the groups of one result does the work once.
   */
  #detailRows(): DiffRow[] | null {
    const view = this.#seen();
    if (view.rows !== undefined) {
      return view.rows;
    }
    if (view.mask.count(this.#size) > DIFF_LIMITS.detail) {
      view.rows = null;
      return null;
    }
    const info = this.#context.info();
    const context = this.#rankContext();
    const rows = view.mask
      .addresses(this.#size, 0, DIFF_LIMITS.detail)
      .map((address) => this.#row(address, this.#size, info, context, []));
    rows.sort((a, b) => b.rank - a.rank || a.address - b.address);
    view.rows = rows;
    return rows;
  }

  /**
   * What ranking needs to know about the neighbourhood of an address, worked out once
   * per result: which bytes changed between the two captures the filter compared, how
   * many changed within reach of each one, and how long the run of changed bytes it
   * sits in is. All three are one pass over 288 KB, where asking per row would be a
   * 512-byte loop per row.
   */
  #rankContext(): RankContext | null {
    if (this.#captures.length < 2) {
      return null;
    }
    const pair = this.#pair;
    const first = pair ? this.byId(pair[0]) : this.#captures[0]!;
    const second = pair ? this.byId(pair[1]) : this.#captures[1]!;
    // a capture no link names takes no part in the question, so it is not one of the
    // values a candidate is expected to take
    const { count: states, taking } = this.#states;
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
    return { states, taking, per };
  }

  #row(address: number, size: 1 | 2 | 4, info: DebugInfo | null, rank: RankContext | null, reasons: string[]): DiffRow {
    const at = locate(address)!;
    const values = this.#captures.map((c) => readAt(c.ram[at.region], at.offset, size));
    const placement = info ? placementAt(info, address, size) : { address, tier: 'unattributed' as const };
    const row: DiffRow = { address, group: groupKey(placement).key, values, placement, rank: 0, reasons };
    const type = formattable(placement, size);
    if (type) {
      row.formatted = this.#captures.map((c) => format(c, placement, type));
    }
    if (rank) {
      const { prefix, runs } = rank.per[at.region];
      // ±256 bytes is a neighbourhood a scalar can be alone in and a buffer cannot: the
      // structures that survive a filter without being the answer — a sound mixer's
      // voices, a shadow OAM, a particle array — are hundreds of bytes of neighbours
      const near = prefix[Math.min(runs.length, at.offset + 256)]! - prefix[Math.max(0, at.offset - 256)]!;
      const run = runs[at.offset] || 1;
      const distinct = new Set(rank.taking.map((i) => values[i]!)).size;
      // the weights are an ordering, not a calibrated scale: the most any one criterion
      // is worth is what loneliness pays, so nothing a row is merely named by can carry
      // it past a candidate sitting on its own — and `reasons` is what a user reads to
      // disagree with the order, which the total on its own gives no way to do
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
      // below two states the strip asks nothing about how a value spreads, so there is
      // nothing for a candidate to answer well: awarding this to every row would claim a
      // criterion was met that the query never set
      if (rank.states >= 2 && distinct === rank.states) {
        score += 3;
        row.reasons.push(`${distinct} distinct value${distinct === 1 ? '' : 's'}, one per state`);
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
  states: number;
  /** which captures carry a tag, since only those are asked to hold one value per tag */
  taking: number[];
  per: Record<RamRegion, { prefix: Int32Array; runs: Uint16Array }>;
}

/** The ids of the two captures a filter compared, or none when it compared no pair. */
type RankPair = [number, number] | null;

/** The same pair, unless the forgotten capture is in it, in which case there is no pair. */
const withoutCapture = (pair: RankPair, id: number): RankPair => (pair && pair.includes(id) ? null : pair);

/** A candidate set as it is reported, with the rows it was worth placing. */
interface View {
  /** the `MuteStore` revision it was built against: a mute switched on or off makes it stale */
  version: number;
  mask: CandidateMask;
  hidden: Record<string, number>;
  /** the placed, ranked rows, `null` when there were too many to place, `undefined` until asked */
  rows?: DiffRow[] | null;
}

/**
 * One value, read through its type the way the variables tree reads it — from the
 * capture's own bytes, so the matrix shows what each capture held rather than what
 * memory holds now. Only a row covering the whole object gets here, so where it reads
 * from and what the row is addressed by are the same place.
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
