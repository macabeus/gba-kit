/**
 * DWARF file paths ⇄ files on disk.
 *
 * DWARF records whatever path the compiler saw: relative (`src/code_0.c`, a decomp
 * built in-tree) or absolute from another machine (`/balatro-gba/source/main.c`, a
 * homebrew built in Docker). Neither is guaranteed to exist locally, so:
 *
 *   1. apply the user's `sourceMap` prefix rewrites (longest prefix first);
 *   2. resolve a relative path against `cwd`;
 *   3. for an absolute path, drop leading segments until something exists under `cwd`.
 *
 * Existence is asked of the host through `exists`, so this works the same for a
 * Node file system and a browser workspace listing.
 */
import { normalizePath } from '@gba-kit/debug-info';

export interface SourceMapperOptions {
  /** the project root relative DWARF paths resolve against */
  cwd: string;
  /** DWARF path prefix → local prefix */
  sourceMap?: Record<string, string>;
  /** whether a local path exists; defaults to "yes" (trust the mapping) when absent */
  exists?: (localPath: string) => boolean;
  /** case-insensitive file systems compare paths folded; default: as-is */
  caseInsensitive?: boolean;
}

export class SourceMapper {
  readonly #cwd: string;
  readonly #prefixes: Array<[string, string]>;
  readonly #exists: (p: string) => boolean;
  readonly #fold: (p: string) => string;
  readonly #toLocalCache = new Map<string, string | null>();
  readonly #localToDwarf = new Map<string, string>();

  constructor(dwarfFiles: Iterable<string>, options: SourceMapperOptions) {
    this.#cwd = options.cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    this.#prefixes = Object.entries(options.sourceMap ?? {})
      .map(([from, to]): [string, string] => [
        from.replace(/\\/g, '/').replace(/\/+$/, ''),
        to.replace(/\\/g, '/').replace(/\/+$/, ''),
      ])
      .sort((a, b) => b[0].length - a[0].length);
    this.#exists = options.exists ?? (() => true);
    this.#fold = options.caseInsensitive ? (p) => p.toLowerCase() : (p) => p;
    for (const file of dwarfFiles) {
      const local = this.toLocal(file);
      if (local) {
        this.#localToDwarf.set(this.#fold(local), normalizePath(file));
      }
    }
  }

  /** DWARF path → local path, or null when nothing on disk matches. */
  toLocal(dwarfPath: string): string | null {
    const p = normalizePath(dwarfPath);
    const cached = this.#toLocalCache.get(p);
    if (cached !== undefined) {
      return cached;
    }
    const result = this.#resolve(p);
    this.#toLocalCache.set(p, result);
    return result;
  }

  /** Local path → DWARF path (as the line table spells it), or null when the ELF never compiled that file. */
  toDwarf(localPath: string): string | null {
    return this.#localToDwarf.get(this.#fold(normalizePath(localPath))) ?? null;
  }

  /** Every local file the ELF's sources were mapped to. */
  get localFiles(): string[] {
    return [...this.#localToDwarf.keys()];
  }

  #resolve(p: string): string | null {
    for (const [from, to] of this.#prefixes) {
      if (p === from || p.startsWith(from + '/')) {
        const candidate = to + p.slice(from.length);
        if (this.#exists(candidate)) {
          return candidate;
        }
      }
    }
    const absolute = p.startsWith('/') || /^[A-Za-z]:\//.test(p);
    if (!absolute) {
      const candidate = `${this.#cwd}/${p}`;
      return this.#exists(candidate) ? candidate : null;
    }
    if (this.#exists(p)) {
      return p;
    }
    const segments = p.split('/').filter(Boolean);
    for (let i = 1; i < segments.length; i++) {
      const candidate = `${this.#cwd}/${segments.slice(i).join('/')}`;
      if (this.#exists(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}
