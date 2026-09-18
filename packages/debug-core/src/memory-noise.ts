/**
 * What to hide from a memory diff, and how it was found — by watching the machine,
 * never by knowing what anything is called.
 *
 * A decomp renames its symbols as it progresses and no two projects agree on any of
 * them, so a built-in list of noisy names would work on one project and quietly
 * mislead on the next. Every mute here is a set of address ranges discovered by
 * observation: run the game with nothing held and whatever moves on its own is
 * background churn — the sound mixer, the RNG, the frame and animation counters;
 * watch the DMA in the same run and every RAM range copied into VRAM, OAM or palette
 * names itself a shadow buffer by where it goes, which is what a shadow buffer is;
 * and the live stack is bounded by the stack pointer and the layout the BIOS booted
 * with.
 *
 * Nothing here filters silently: a mute is a listed row carrying the byte count it
 * hid, and switching it off puts its addresses back.
 */
import type { HardwareEvent } from '@gba-kit/gba-emulator';

import { NOISE_FRAMES, rangeBytes } from './diff-limits.js';
import { type Machine, RAM_REGIONS, regionOf, stackBoundFor } from './machine.js';

/** Where a mute came from, which is also what a panel names it by. */
export const MUTE_SOURCES = ['idle', 'dma', 'stack', 'user'] as const;

export type MuteSource = (typeof MUTE_SOURCES)[number];

/** Half-open `[lo, hi)`. */
export interface MuteRange {
  lo: number;
  hi: number;
}

export interface Mute {
  /** stable within a session */
  id: number;
  source: MuteSource;
  /**
   * The addresses it hides. A discovery finds them together and they are one mute:
   * an idle baseline names hundreds of small runs of the same churn, and hundreds of
   * rows is not a list anyone reads.
   */
  ranges: MuteRange[];
  /** what it is, in the terms it was discovered in: a DMA mute says where the bytes went */
  note: string;
  enabled: boolean;
}

/** How many addresses a mute covers. */
export function muteBytes(mute: Mute): number {
  return rangeBytes(mute.ranges);
}

/** The mutes of a session: a discovery replaces the last one's ranges, what the user muted is theirs. */
export class MuteStore {
  #mutes: Mute[] = [];
  #nextId = 1;
  #version = 0;

  /**
   * Bumps on every change. A diff hides muted candidates when it reports them rather
   * than when it finds them, so what it reports has to know when this moved.
   */
  get version(): number {
    return this.#version;
  }

  all(): Mute[] {
    return this.#mutes.map((m) => ({ ...m, ranges: m.ranges.map((r) => ({ ...r })) }));
  }

  enabled(): Mute[] {
    return this.#mutes.filter((m) => m.enabled);
  }

  /** Add ranges the user picked out, as one reversible row. */
  add(ranges: MuteRange[], source: MuteSource, note: string): Mute {
    const mute: Mute = {
      id: this.#nextId++,
      source,
      ranges: ranges.map((r) => ({ lo: r.lo >>> 0, hi: r.hi >>> 0 })).filter((r) => r.hi > r.lo),
      note,
      enabled: true,
    };
    this.#mutes.push(mute);
    this.#version++;
    return mute;
  }

  /**
   * Put what one discovery found in place of what the last one found, so running the
   * baseline again does not stack a second copy of the same ranges on the first.
   */
  replaceDiscovered(found: Array<Omit<Mute, 'id' | 'enabled'>>): Mute[] {
    this.#mutes = this.#mutes.filter((m) => m.source === 'user');
    for (const m of found) {
      this.#mutes.push({ ...m, id: this.#nextId++, enabled: true });
    }
    this.#version++;
    return this.all();
  }

  setEnabled(id: number, enabled: boolean): boolean {
    const mute = this.#mutes.find((m) => m.id === id);
    if (!mute) {
      return false;
    }
    mute.enabled = enabled;
    this.#version++;
    return true;
  }

  remove(id: number): boolean {
    const at = this.#mutes.findIndex((m) => m.id === id);
    if (at < 0) {
      return false;
    }
    this.#mutes.splice(at, 1);
    this.#version++;
    return true;
  }

  clear(): void {
    this.#mutes = [];
    this.#version++;
  }
}

/** The runs of set bytes in a churn mask, as the address ranges they cover. */
function runsOf(mask: Uint8Array, base: number): MuteRange[] {
  const runs: MuteRange[] = [];
  let start = -1;
  for (let i = 0; i <= mask.length; i++) {
    if (i < mask.length && mask[i]) {
      if (start < 0) {
        start = i;
      }
    } else if (start >= 0) {
      runs.push({ lo: base + start, hi: base + i });
      start = -1;
    }
  }
  return runs;
}

/** Which memory a DMA landed in, named the way the mute describes itself. */
function destinationName(address: number): string | null {
  const region = regionOf(address);
  return region === 'palette' || region === 'vram' || region === 'oam' ? region.toUpperCase() : null;
}

export interface Noise {
  mutes: Array<Omit<Mute, 'id' | 'enabled'>>;
  /** how many bytes moved on their own, which is what the baseline is worth */
  churnBytes: number;
  frames: number;
}

/**
 * Background churn and shadow buffers, found by running the machine and putting it
 * back exactly as it was: the snapshot is taken first, the buttons are released for
 * the run and restored after, and the hardware-event sink is swapped out so the
 * session's event ring does not fill with frames nobody asked to run.
 *
 * How long the run is worth making is `NOISE_FRAMES`' own question, and the answer is
 * measured in candidates rather than in churn bytes.
 *
 * The DMA watch is not covered by the churn: a shadow buffer the game rebuilds only
 * when something changes sits perfectly still through an idle run, and the measured
 * overlap between the two was between 0% and 0.6%.
 *
 * The stack is watched by the stack pointer rather than by the memory: every frame's
 * abandoned call frames lie *below* the pointer, and how far below is only knowable by
 * looking while the code runs. The run already runs, so the lowest pointer it sees is
 * the depth the mute is bounded by.
 */
export function discoverNoise(machine: Machine, frames: number = NOISE_FRAMES.default): Noise {
  const count = Math.max(1, Math.min(NOISE_FRAMES.max, Math.floor(frames)));
  const snapshot = machine.snapshot();
  const held = machine.buttons;
  const sink = machine.onHardwareEvent;
  const churn = { iwram: new Uint8Array(RAM_REGIONS.iwram.size), ewram: new Uint8Array(RAM_REGIONS.ewram.size) };
  const shadows = new Map<string, { lo: number; hi: number; destination: string }>();

  machine.onHardwareEvent = (event: HardwareEvent): void => {
    if (event.kind !== 'dma') {
      return;
    }
    const { source, destination, count: words, wordSize } = event.info;
    const from = regionOf(source);
    const to = destinationName(destination);
    if ((from !== 'iwram' && from !== 'ewram') || !to) {
      return;
    }
    const lo = source >>> 0;
    const hi = (source + words * wordSize) >>> 0;
    const key = `${to}:${lo}`;
    const seen = shadows.get(key);
    if (seen) {
      seen.hi = Math.max(seen.hi, hi);
    } else {
      shadows.set(key, { lo, hi, destination: to });
    }
  };

  machine.setButtons(0);
  const registers = machine.registers;
  const stackRegion = regionOf(machine.registers[13]!);
  let deepest = machine.registers[13]!;
  const watchStack = (): boolean => {
    const sp = registers[13]!;
    if (sp < deepest && regionOf(sp) === stackRegion) {
      deepest = sp;
    }
    return false;
  };
  const previous = { iwram: machine.readRam('iwram'), ewram: machine.readRam('ewram') };
  for (let f = 0; f < count; f++) {
    machine.runFrame(watchStack);
    for (const region of ['iwram', 'ewram'] as const) {
      const now = machine.readRam(region);
      const was = previous[region];
      const mask = churn[region];
      for (let i = 0; i < mask.length; i++) {
        if (was[i] !== now[i]) {
          mask[i] = 1;
        }
      }
      previous[region] = now;
    }
  }

  machine.onHardwareEvent = sink;
  machine.restore(snapshot);
  machine.setButtons(held);

  const idle: MuteRange[] = [];
  let churnBytes = 0;
  for (const region of ['iwram', 'ewram'] as const) {
    for (const byte of churn[region]) {
      churnBytes += byte;
    }
    idle.push(...runsOf(churn[region], RAM_REGIONS[region].base));
  }
  const mutes: Noise['mutes'] = [];
  if (idle.length > 0) {
    mutes.push({
      source: 'idle',
      ranges: idle,
      note: `moves on its own over ${count} idle frame${count === 1 ? '' : 's'}`,
    });
  }
  for (const shadow of shadows.values()) {
    mutes.push({
      source: 'dma',
      ranges: [{ lo: shadow.lo, hi: shadow.hi }],
      note: `DMA'd into ${shadow.destination}`,
    });
  }
  const sp = machine.registers[13]!;
  const top = stackBoundFor(machine.cpsr & 0x1f, sp);
  // the live frames at and above the pointer are identical in every capture taken at
  // the same place, so they hide nothing; what moves is the abandoned frames below it,
  // and the run just measured how far down they reach
  const floor = Math.min(sp, deepest);
  if (top > floor) {
    mutes.push({
      source: 'stack',
      ranges: [{ lo: floor, hi: top }],
      note: `the stack, as deep as ${count} idle frame${count === 1 ? '' : 's'} saw it go`,
    });
  }
  return { mutes, churnBytes, frames: count };
}
