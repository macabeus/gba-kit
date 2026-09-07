/**
 * Source mapper — the bridge between DWARF file paths and files on disk.
 *
 * DWARF records whatever path the compiler saw: relative (`src/code_0.c`, a
 * decomp built in-tree) or absolute from another machine (`/balatro-gba/source/main.c`,
 * a homebrew built in Docker). Neither is guaranteed to exist locally, so:
 *
 *   1. apply the user's `sourceMap` prefix rewrites (longest prefix first);
 *   2. resolve a relative path against `cwd`;
 *   3. for an absolute path, drop leading segments until something exists under `cwd`.
 *
 * The reverse direction (local file -> DWARF path) is a lookup in a table built
 * once from every file the line table mentions.
 *
 * IDE-agnostic: no VS Code imports. This is the piece a Neovim/Emacs client would
 * reuse untouched.
 */
import type { DebugInfo } from '@gba-kit/debug-info';
import fs from 'node:fs';
import path from 'node:path';

export interface LineRowInfo {
  file: string;
  line: number;
  isStmt: boolean;
}

export interface SourceMapperOptions {
  cwd: string;
  sourceMap?: Record<string, string>;
}

export class SourceMapper {
  readonly #di: DebugInfo;
  readonly #cwd: string;
  readonly #prefixes: Array<[string, string]>;
  readonly #toLocalCache = new Map<string, string | null>();
  readonly #localToDwarf = new Map<string, string>();
  /** dwarfFile -> line -> lowest address (first row of the line) */
  readonly #lineIndex = new Map<string, Map<number, number>>();
  /** address -> the row that starts there (a step-stop candidate when isStmt) */
  readonly #rowStarts = new Map<number, LineRowInfo>();

  constructor(di: DebugInfo, options: SourceMapperOptions) {
    this.#di = di;
    this.#cwd = options.cwd;
    this.#prefixes = Object.entries(options.sourceMap ?? {}).sort((a, b) => b[0].length - a[0].length);

    for (const row of di.lines.rows) {
      if (row.endSequence) {
        continue;
      }
      const file = normalizeDwarf(row.file);
      let byLine = this.#lineIndex.get(file);
      if (!byLine) {
        byLine = new Map();
        this.#lineIndex.set(file, byLine);
      }
      const prev = byLine.get(row.line);
      if (prev === undefined || row.address < prev) {
        byLine.set(row.line, row.address);
      }
      // Several rows may share an address (GCC "views"); a stmt row wins the label.
      const isStmt = (row as { isStmt?: boolean }).isStmt ?? true;
      const existing = this.#rowStarts.get(row.address);
      if (!existing || isStmt || !existing.isStmt) {
        this.#rowStarts.set(row.address, { file, line: row.line, isStmt: isStmt || (existing?.isStmt ?? false) });
      }
    }

    for (const file of this.#lineIndex.keys()) {
      const local = this.toLocal(file);
      if (local) {
        this.#localToDwarf.set(canonicalLocal(local), file);
      }
    }
  }

  /** The line-table row that starts exactly at `address`, if any. */
  rowAt(address: number): LineRowInfo | undefined {
    return this.#rowStarts.get(address);
  }

  /** The (file, line) whose address range contains `pc` (the row semantics `pcToSource` uses). */
  lineAt(pc: number): { file: string; line: number } | null {
    if (pc < 0x02000000) {
      return null;
    }
    const src = this.#di.pcToSource(pc);
    return src ? { file: normalizeDwarf(src.file), line: src.line } : null;
  }

  /** Every file the line table mentions, as DWARF spells it. */
  get dwarfFiles(): string[] {
    return [...this.#lineIndex.keys()];
  }

  /** DWARF path -> existing local path, or null when nothing on disk matches. */
  toLocal(dwarfPath: string): string | null {
    const p = normalizeDwarf(dwarfPath);
    const cached = this.#toLocalCache.get(p);
    if (cached !== undefined) {
      return cached;
    }
    const result = this.#resolveLocal(p);
    this.#toLocalCache.set(p, result);
    return result;
  }

  /** Local path -> DWARF path, or null when the ELF never compiled that file. */
  toDwarf(localPath: string): string | null {
    return this.#localToDwarf.get(canonicalLocal(localPath)) ?? null;
  }

  /**
   * Address of the first instruction of `line` in `dwarfFile`. When the line has no
   * code (a comment, a declaration), slide forward up to `slack` lines — the same
   * thing gdb does — and report the line actually used.
   */
  lineToAddress(dwarfFile: string, line: number, slack = 8): { address: number; line: number } | null {
    const byLine = this.#lineIndex.get(normalizeDwarf(dwarfFile));
    if (!byLine) {
      return null;
    }
    for (let l = line; l <= line + slack; l++) {
      const address = byLine.get(l);
      if (address !== undefined) {
        return { address, line: l };
      }
    }
    return null;
  }

  /** PC -> local file + line + function, or null. */
  pcToLocal(pc: number): { path: string; dwarfFile: string; line: number; func?: string } | null {
    if (pc < 0x02000000) {
      return null; // BIOS / gc'd sections: the ELF's stray low-address rows are not source
    }
    const src = this.#di.pcToSource(pc);
    if (!src) {
      return null;
    }
    const local = this.toLocal(src.file);
    if (!local) {
      return null;
    }
    return { path: local, dwarfFile: normalizeDwarf(src.file), line: src.line, func: src.func };
  }

  #resolveLocal(p: string): string | null {
    for (const [from, to] of this.#prefixes) {
      if (p === from || p.startsWith(from.endsWith('/') ? from : from + '/')) {
        const candidate = path.join(to, p.slice(from.length));
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
    if (!p.startsWith('/')) {
      const candidate = path.join(this.#cwd, p);
      return fs.existsSync(candidate) ? candidate : null;
    }
    if (fs.existsSync(p)) {
      return p;
    }
    const segments = p.split('/').filter(Boolean);
    for (let i = 1; i < segments.length; i++) {
      const candidate = path.join(this.#cwd, ...segments.slice(i));
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}

function normalizeDwarf(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/'));
}

function canonicalLocal(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}
