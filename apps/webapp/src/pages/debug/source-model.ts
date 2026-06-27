/**
 * Pure view-model for the Source debug panel: turn a DWARF DebugInfo + a
 * disassembler + (optionally) source-file text into the interleaved C/asm render
 * items the panel draws. No React / no emulator types, so it's unit-testable and
 * reusable headlessly.
 */
import type { DebugInfo, SourceLocation } from '@gba-kit/debug-info';

export interface DisasmLine {
  address: number;
  mnemonic: string;
}

export interface SourceRow {
  address: number;
  mnemonic: string;
  src: SourceLocation | null;
}

export function baseName(path: string): string {
  return path.replace(/^.*\//, '');
}

/**
 * Index of the candidate whose path shares the longest *trailing* segment run
 * with `dwarfPath` (basename minimum), or -1. Handles relative DWARF paths
 * (`src/code_1.c`) and absolute ones (`/proj/source/game.c`) against picked
 * paths like `<root>/source/game.c`.
 *
 * Returns -1 when the best score is a tie between two or more candidates: the
 * trailing-segment match can't disambiguate them (e.g. several `util.c` in
 * different dirs whose DWARF path only matches on the basename), so we'd rather
 * show no source than confidently show the wrong file.
 */
export function matchSegmentsIndex(dwarfPath: string, candidates: { segments: string[] }[]): number {
  const want = dwarfPath.split('/').filter(Boolean);
  let bestIdx = -1;
  let bestScore = 0;
  let bestTies = 0;
  candidates.forEach((c, i) => {
    let k = 0;
    while (
      k < want.length &&
      k < c.segments.length &&
      want[want.length - 1 - k] === c.segments[c.segments.length - 1 - k]
    ) {
      k++;
    }
    if (k > bestScore) {
      bestScore = k;
      bestIdx = i;
      bestTies = 1;
    } else if (k === bestScore && k > 0) {
      bestTies++;
    }
  });
  return bestScore >= 1 && bestTies === 1 ? bestIdx : -1;
}

/**
 * Disassemble the function `[fnAddress, fnEnd)` and attach each instruction's C
 * location. Independent of the live PC (ROM is static).
 */
export function buildSourceRows(
  disassemble: (address: number, count: number) => DisasmLine[],
  di: DebugInfo,
  fnAddress: number,
  fnEnd: number,
): SourceRow[] {
  const count = Math.max(1, Math.ceil((fnEnd - fnAddress) / 2)); // Thumb = 2 bytes
  const rows: SourceRow[] = [];
  for (const ins of disassemble(fnAddress, count)) {
    if (ins.address >= fnEnd) {
      break;
    }
    rows.push({ address: ins.address, mnemonic: ins.mnemonic, src: di.lines.pcToSource(ins.address) });
  }
  return rows;
}

/** A flat render list the view maps to JSX (and tests/headless dogfood can assert). */
export type RenderItem =
  | { kind: 'file'; file: string }
  | { kind: 'cline'; file: string; line: number; text: string | null; active: boolean }
  | { kind: 'asm'; address: number; mnemonic: string; current: boolean };

/**
 * Group rows into file dividers + C-source lines + asm rows. `getLine` returns
 * the source text for a (file,line) or null when sources aren't loaded; `current`
 * is the PC's source location (for highlighting the active C line).
 */
export function toRenderItems(
  rows: SourceRow[],
  getLine: (file: string, line: number) => string | null,
  current: SourceLocation | null,
  pc: number,
): RenderItem[] {
  const items: RenderItem[] = [];
  let prevKey: string | null = null;
  let prevFile: string | null = null;
  for (const row of rows) {
    const src = row.src;
    if (src && src.file !== prevFile) {
      items.push({ kind: 'file', file: baseName(src.file) });
      prevFile = src.file;
    }
    const key = src ? `${src.file}:${src.line}` : null;
    if (src && key !== prevKey) {
      const active = !!(current && current.file === src.file && current.line === src.line);
      items.push({ kind: 'cline', file: src.file, line: src.line, text: getLine(src.file, src.line), active });
      prevKey = key;
    }
    items.push({ kind: 'asm', address: row.address, mnemonic: row.mnemonic, current: row.address === pc });
  }
  return items;
}
