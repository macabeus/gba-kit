/**
 * What the session needs from its surroundings and cannot assume: a clock, a way to
 * be called back periodically, and (optionally) a place to keep project files.
 * Node and browser hosts implement it; tests implement it with a manual clock.
 */
export interface Host {
  /** Call `fn` about every `ms` milliseconds until the returned function is called. */
  interval(fn: () => void, ms: number): () => void;
  /** Milliseconds, monotonic enough for pacing and budgets. */
  now(): number;
  /** Persistence for the project's `.gba-kit/` files. Absent when the host has no file system. */
  files?: HostFiles;
}

export interface HostFiles {
  /** The file's text, or null when it does not exist. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array | null>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  list(dir: string): Promise<string[]>;
  join(...parts: string[]): string;
}

/** A host on top of the platform's own timers (Node or browser). */
export function timerHost(files?: HostFiles): Host {
  return {
    interval: (fn, ms) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    files,
  };
}

/**
 * A host whose clock only moves when a test says so. `tick(ms)` fires due intervals
 * in order, so a test drives the run loop deterministically.
 */
export class ManualHost implements Host {
  #now = 0;
  #timers: Array<{ fn: () => void; ms: number; due: number; alive: boolean }> = [];
  files?: HostFiles;

  constructor(files?: HostFiles) {
    this.files = files;
  }

  interval(fn: () => void, ms: number): () => void {
    const timer = { fn, ms, due: this.#now + ms, alive: true };
    this.#timers.push(timer);
    return () => {
      timer.alive = false;
      this.#timers = this.#timers.filter((t) => t !== timer);
    };
  }

  now(): number {
    return this.#now;
  }

  /** Advance the clock, firing each interval as many times as it would have fired. */
  tick(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const next = this.#timers.filter((t) => t.alive && t.due <= target).sort((a, b) => a.due - b.due)[0];
      if (!next) {
        break;
      }
      this.#now = next.due;
      next.due += next.ms;
      next.fn();
    }
    this.#now = target;
  }
}
