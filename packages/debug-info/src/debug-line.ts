/**
 * DWARF `.debug_line` line-number program parser (DWARF 2–5).
 *
 * Produces a flat, address-sorted table of rows so a runtime PC can be mapped to
 * a source `file:line`. Handles the traditional line-program header (DWARF 2/3/4)
 * emitted by both old (GCC 2.95) and modern (GCC 14 / devkitARM) toolchains, and
 * the DWARF 5 header (directory and file tables described by entry formats, names
 * in `.debug_line_str`) that a modern assembler emits for a `.s` file even when
 * the C units next to it are version 3.
 *
 * The section is a concatenation of independent units, so parsing is per-unit and
 * never all-or-nothing: a unit we can't model (a later version, 64-bit DWARF, an
 * entry format we do not know) is skipped by its own `unit_length` and the
 * remaining units still yield rows.
 */
import { DW_FORM } from './dwarf/constants.js';
import { Cursor } from './reader.js';

/** The string sections a DWARF 5 line header refers to. */
export interface LineStringSections {
  /** `.debug_line_str` */
  lineStr?: Uint8Array;
  /** `.debug_str` */
  str?: Uint8Array;
}

export interface LineRow {
  /** Absolute address (VMA) of the first byte this row covers. */
  address: number;
  /** File index as the unit numbers its files: 1-based in DWARF 2–4, 0-based in DWARF 5. */
  fileIndex: number;
  /** Resolved file path (dir + name) for convenience. */
  file: string;
  line: number;
  /** True for the DW_LNE_end_sequence marker that bounds a run of addresses. */
  endSequence: boolean;
  /**
   * The row's `is_stmt` flag: a recommended breakpoint / step-stop location. An
   * optimizing compiler emits non-stmt rows for the middle of an expression, so a
   * debugger that stops at every row over-steps.
   */
  isStmt: boolean;
}

// Standard opcodes
const DW_LNS_copy = 1;
const DW_LNS_advance_pc = 2;
const DW_LNS_advance_line = 3;
const DW_LNS_set_file = 4;
const DW_LNS_set_column = 5;
const DW_LNS_negate_stmt = 6;
const DW_LNS_set_basic_block = 7;
const DW_LNS_const_add_pc = 8;
const DW_LNS_fixed_advance_pc = 9;
// Extended opcodes
const DW_LNE_end_sequence = 1;
const DW_LNE_set_address = 2;
const DW_LNE_define_file = 3;
// DWARF 5 entry-format content types
const DW_LNCT_path = 1;
const DW_LNCT_directory_index = 2;

/** The lowest reserved value of an initial-length field (0xfffffff0–0xffffffff). */
const RESERVED_LENGTH = 0xfffffff0;
/** Initial length escape introducing 64-bit DWARF (a 64-bit length follows). */
const DWARF64_ESCAPE = 0xffffffff;

/** Parse all compilation units in a `.debug_line` section into a sorted table. */
export function parseDebugLine(section: Uint8Array, littleEndian = true, strings: LineStringSections = {}): LineTable {
  const rows: LineRow[] = [];
  const c = new Cursor(section, 0, littleEndian);

  while (c.remaining >= 4) {
    const unitStart = c.offset;
    const next = parseUnit(c, rows, strings);
    if (next === null || next <= unitStart) {
      // Either the unit told us nothing can be trusted after it, or it made no
      // forward progress. Keep the rows collected so far and stop walking.
      break;
    }
    c.seek(next);
  }

  // Sort by address; at a shared address put an end_sequence boundary BEFORE a
  // real row, so a PC there maps to the row that actually starts at it (the next
  // function's first line) rather than the previous sequence's terminator.
  rows.sort((a, b) => a.address - b.address || Number(b.endSequence) - Number(a.endSequence));
  return new LineTable(rows);
}

/**
 * Parse the unit at `c.offset`, appending its rows.
 *
 * Returns the section offset where the next unit begins, or `null` when nothing
 * past this point can be walked (truncated/reserved/64-bit-too-large unit) — the
 * caller keeps every row parsed so far.
 */
function parseUnit(c: Cursor, rows: LineRow[], strings: LineStringSections): number | null {
  const sectionEnd = c.bytes.length;
  const unitStart = c.offset;
  const unitLength = c.u32();

  if (unitLength === 0) {
    // Not a unit: some producers pad the section with zero words. Step over it.
    return unitStart + 4;
  }
  if (unitLength >= RESERVED_LENGTH) {
    if (unitLength !== DWARF64_ESCAPE || sectionEnd - c.offset < 8) {
      return null; // Reserved initial-length value: the section is unwalkable.
    }
    // 64-bit DWARF: a 64-bit unit_length follows the escape. We don't parse the
    // unit (GBA/32-bit targets never emit it), but we can skip it precisely.
    const low = c.u32();
    const high = c.u32();
    const end = unitStart + 12 + low;
    return high === 0 && end <= sectionEnd ? end : null;
  }

  const unitEnd = unitStart + 4 + unitLength;
  // A unit that claims more bytes than the section holds: parse what is there,
  // then stop — there is no next unit to find.
  const truncated = unitEnd > sectionEnd;
  const limit = truncated ? sectionEnd : unitEnd;
  const skipUnit = (): number | null => (truncated ? null : unitEnd);

  if (limit - c.offset < 6) {
    return skipUnit(); // No room for version + header_length.
  }
  const version = c.u16();
  if (version < 2 || version > 5) {
    // A header this parser does not model: skip the unit rather than mis-decode
    // it; the other units in the section still parse.
    return skipUnit();
  }
  if (version >= 5) {
    if (limit - c.offset < 6) {
      return skipUnit();
    }
    c.u8(); // address_size (the set_address operand is sized by its statement)
    c.u8(); // segment_selector_size
  }

  // The line program starts header_length bytes after the header_length field —
  // always seek there rather than trusting where parsing the dir/file tables
  // lands, so an unmodelled header field can't desync the program.
  const headerLength = c.u32();
  const programStart = c.offset + headerLength;
  if (programStart < c.offset || programStart > limit) {
    return skipUnit();
  }
  if (programStart - c.offset < (version >= 4 ? 6 : 5)) {
    return skipUnit(); // No room for the fixed header fields.
  }

  const minInstLength = c.u8();
  if (version >= 4) {
    c.u8(); // maximum_operations_per_instruction (always 1 on ARM/MIPS/PPC)
  }
  const defaultIsStmt = c.u8() !== 0;
  const lineBase = c.s8();
  const lineRange = c.u8() || 1; // guard against a divide-by-zero on a bogus header
  const opcodeBase = c.u8() || 1;

  const standardOpcodeLengths: number[] = [0]; // 1-indexed
  for (let i = 1; i < opcodeBase && c.offset < programStart; i++) {
    standardOpcodeLengths.push(c.u8());
  }

  const tables = version >= 5 ? readV5Tables(c, programStart, strings) : readLegacyTables(c, programStart);
  if (!tables) {
    return skipUnit(); // an entry format we cannot read: the file table is unknowable
  }
  const { resolveFile } = tables;

  // Run the program.
  c.seek(programStart);
  let address = 0;
  let file = 1;
  let line = 1;
  /**
   * True once a statement has run without the sequence being terminated, i.e. the
   * program is mid-sequence. The line program is self-delimiting — every sequence
   * ends with DW_LNE_end_sequence — so this flag, not `unit_length`, is what says
   * whether the program is still running (see the loop condition below).
   */
  let inSequence = false;
  let isStmt = defaultIsStmt;
  /** rows.length when execution first reached the declared unit end. */
  let rowsAtUnitEnd = -1;

  const emit = () =>
    rows.push({ address: address >>> 0, fileIndex: file, file: resolveFile(file), line, endSequence: false, isStmt });
  const endSequence = () => {
    rows.push({ address: address >>> 0, fileIndex: file, file: resolveFile(file), line, endSequence: true, isStmt });
    address = 0;
    file = 1;
    line = 1;
    isStmt = defaultIsStmt;
    inSequence = false;
  };

  // Statements run to the declared unit end — and past it while a sequence is
  // still open. `unit_length` is not a dependable end marker: agbcc (GCC 2.95, as
  // shipped with the pret decomps) sizes a unit by *predicting* the encoded length
  // of each statement, and mispredicts by a few bytes, so the tail of the last
  // sequence can spill past it (in pokeemerald 28 of 303 units, by 1–4 bytes and
  // one by 51). Stopping at the declared end would leave the cursor mid-statement
  // and mis-read the next unit's header as line-program bytes, which desyncs the
  // rest of the section. DW_LNE_end_sequence is the authority on where the program
  // — and so the unit — ends; well-formed units end with it precisely, so they see
  // no difference.
  while ((c.offset < limit || inSequence) && c.offset < sectionEnd) {
    if (rowsAtUnitEnd < 0 && c.offset >= limit) {
      rowsAtUnitEnd = rows.length;
    }
    const opcode = c.u8();

    if (opcode >= opcodeBase) {
      // Special opcode: advance address + line and emit a row.
      const adjusted = opcode - opcodeBase;
      address += Math.floor(adjusted / lineRange) * minInstLength;
      line += lineBase + (adjusted % lineRange);
      inSequence = true;
      emit();
      continue;
    }

    if (opcode === 0) {
      // Extended opcode: <uleb length> <sub-opcode> <operands...>. Unknown
      // sub-opcodes (and DW_LNE_define_file) are skipped by that length.
      const len = readUleb(c, sectionEnd);
      const extStart = c.offset;
      const extEnd = extStart + len;
      if (len < 1 || extEnd > sectionEnd) {
        break; // Truncated statement: nothing further in this unit is readable.
      }
      const sub = c.u8();
      switch (sub) {
        case DW_LNE_end_sequence:
          endSequence();
          break;
        case DW_LNE_set_address: {
          // The operand is the target's address; its size is whatever the rest of
          // the statement holds (4 on every target this parses; 2 on tiny targets,
          // 8 on 64-bit ones, where the low word is the addressable part).
          const size = len - 1;
          if (size >= 4) {
            address = c.u32();
          } else if (size === 2) {
            address = c.u16();
          } else if (size === 1) {
            address = c.u8();
          }
          inSequence = true;
          break;
        }
        case DW_LNE_define_file:
        default:
          break;
      }
      c.seek(extEnd);
      continue;
    }

    inSequence = true;
    switch (opcode) {
      case DW_LNS_copy:
        emit();
        break;
      case DW_LNS_advance_pc:
        address += readUleb(c, sectionEnd) * minInstLength;
        break;
      case DW_LNS_advance_line:
        line += readSleb(c, sectionEnd);
        break;
      case DW_LNS_set_file:
        file = readUleb(c, sectionEnd);
        break;
      case DW_LNS_set_column:
        readUleb(c, sectionEnd);
        break;
      case DW_LNS_negate_stmt:
        isStmt = !isStmt;
        break;
      case DW_LNS_set_basic_block:
        break;
      case DW_LNS_const_add_pc:
        address += Math.floor((255 - opcodeBase) / lineRange) * minInstLength;
        break;
      case DW_LNS_fixed_advance_pc:
        if (sectionEnd - c.offset < 2) {
          return null; // Truncated operand: nothing past this is readable.
        }
        address += c.u16();
        break;
      default: {
        // Unknown standard opcode (vendor extension): skip its declared ULEB operands.
        const n = standardOpcodeLengths[opcode] ?? 0;
        for (let i = 0; i < n; i++) {
          readUleb(c, sectionEnd);
        }
        break;
      }
    }
  }

  if (inSequence) {
    // The program ran to the end of the section with a sequence still open: the
    // tail was not a line program, so drop the rows read past the declared end and
    // stop — everything before the unit end stays.
    if (rowsAtUnitEnd >= 0) {
      rows.length = rowsAtUnitEnd;
    }
    return null;
  }

  const end = Math.max(c.offset, unitEnd);
  return truncated || end > sectionEnd ? null : end;
}

interface FileTables {
  /** The path of file entry `idx`, as the unit numbers its files. */
  resolveFile(idx: number): string;
}

/** DWARF 2–4: NUL-terminated directory and file lists, both 1-based (directory 0 is the compilation directory). */
function readLegacyTables(c: Cursor, programStart: number): FileTables {
  const dirs: string[] = ['']; // index 0 = compilation directory (implicit)
  while (c.offset < programStart) {
    const dir = c.cstr();
    if (dir === '') {
      break;
    }
    dirs.push(dir);
  }

  // file_names: { name, dir_index(uleb), mtime(uleb), size(uleb) }, ended by empty name.
  const files: { name: string; dir: number }[] = [{ name: '', dir: 0 }]; // 1-based; [0] unused
  while (c.offset < programStart) {
    const name = c.cstr();
    if (name === '') {
      break;
    }
    const dir = readUleb(c, programStart);
    readUleb(c, programStart); // mtime
    readUleb(c, programStart); // size
    files.push({ name, dir });
  }

  return {
    resolveFile: (idx) => {
      const f = files[idx];
      if (!f) {
        return `<file ${idx}>`;
      }
      if (f.name.startsWith('/') || f.dir === 0) {
        return f.name;
      }
      const dir = dirs[f.dir];
      return dir ? `${dir}/${f.name}` : f.name;
    },
  };
}

/**
 * DWARF 5: each table is described by an entry format (content type, form) and
 * is 0-based; directory 0 is the compilation directory. Null when an entry uses
 * a form this reader cannot size, since nothing after it could be placed.
 */
function readV5Tables(c: Cursor, programStart: number, strings: LineStringSections): FileTables | null {
  const readTable = (): Array<{ path: string; dir: number }> | null => {
    const formatCount = c.u8();
    const formats: Array<{ content: number; form: number }> = [];
    for (let i = 0; i < formatCount; i++) {
      formats.push({ content: readUleb(c, programStart), form: readUleb(c, programStart) });
    }
    const count = readUleb(c, programStart);
    const out: Array<{ path: string; dir: number }> = [];
    for (let i = 0; i < count && c.offset < programStart; i++) {
      const entry = { path: '', dir: 0 };
      for (const { content, form } of formats) {
        const v = readForm(c, form, programStart, strings);
        if (v === null) {
          return null;
        }
        if (content === DW_LNCT_path && typeof v === 'string') {
          entry.path = v;
        } else if (content === DW_LNCT_directory_index && typeof v === 'number') {
          entry.dir = v;
        }
      }
      out.push(entry);
    }
    return out;
  };
  const dirs = readTable();
  const files = dirs && readTable();
  if (!dirs || !files) {
    return null;
  }
  return {
    resolveFile: (idx) => {
      const f = files[idx];
      if (!f) {
        return `<file ${idx}>`;
      }
      const dir = dirs[f.dir]?.path ?? '';
      return f.path.startsWith('/') || dir === '' || dir === '.' ? f.path : `${dir}/${f.path}`;
    },
  };
}

/** One attribute of a DWARF 5 line-table entry, or null for a form this reader cannot size. */
function readForm(c: Cursor, form: number, limit: number, strings: LineStringSections): string | number | null {
  switch (form) {
    case DW_FORM.string:
      return c.cstr();
    case DW_FORM.line_strp:
      return stringAt(strings.lineStr, c.u32());
    case DW_FORM.strp:
      return stringAt(strings.str, c.u32());
    case DW_FORM.udata:
      return readUleb(c, limit);
    case DW_FORM.data1:
      return c.u8();
    case DW_FORM.data2:
      return c.u16();
    case DW_FORM.data4:
      return c.u32();
    case DW_FORM.data8:
      c.skip(8);
      return 0;
    case DW_FORM.data16:
      c.skip(16); // an MD5
      return 0;
    case DW_FORM.block:
      c.skip(readUleb(c, limit));
      return 0;
    default:
      return null;
  }
}

/** The NUL-terminated string at `offset` of a string section (a `<str N>` placeholder when the section
 * is absent or the offset is past its end). */
function stringAt(section: Uint8Array | undefined, offset: number): string {
  if (!section || offset >= section.length) {
    return `<str ${offset}>`;
  }
  return new Cursor(section, offset).cstr();
}

/**
 * ULEB128 bounded by `limit`: a varint whose continuation bits run past the end
 * of the readable region stops there instead of reading out of bounds.
 */
function readUleb(c: Cursor, limit: number): number {
  let result = 0;
  let shift = 0;
  while (c.offset < limit) {
    const byte = c.u8();
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  return result >>> 0;
}

/** SLEB128 bounded by `limit` (see {@link readUleb}). */
function readSleb(c: Cursor, limit: number): number {
  let result = 0;
  let shift = 0;
  let byte = 0;
  while (c.offset < limit) {
    byte = c.u8();
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      break;
    }
  }
  // Sign-extend if the last byte's sign bit is set.
  if (shift < 32 && byte & 0x40) {
    result |= -(1 << shift);
  }
  return result;
}

/** The row that starts at an address, for stepping: a stop is only right at a statement row. */
export interface LineRowStart {
  file: string;
  line: number;
  /** True when any row starting here is a statement (`is_stmt`). */
  isStmt: boolean;
}

/** Address-sorted line rows with PC→source lookup. */
export class LineTable {
  readonly rows: LineRow[];
  /** normalized file → line → addresses of the rows on that line, ascending (lazy) */
  #byFileLine: Map<string, Map<number, number[]>> | null = null;
  /** address → the label of the row(s) starting there (lazy) */
  #starts: Map<number, LineRowStart> | null = null;

  constructor(rows: LineRow[]) {
    this.rows = rows;
  }

  /** Every file the table has code for, normalized (`./`, `..` and `\\` folded). */
  get files(): string[] {
    return [...this.#index().keys()];
  }

  /**
   * Every address where code for `line` of `file` starts, ascending — a line may
   * have several (a `for` header, an inlined body, a header function used from
   * several units). Empty when the line has no code. `file` is matched normalized.
   */
  sourceToPcs(file: string, line: number): number[] {
    return this.#index().get(normalizePath(file))?.get(line) ?? [];
  }

  /** Every line of `file` that has code, ascending; what `sourceToPcs` answers non-empty for. */
  linesWithCode(file: string): number[] {
    return [...(this.#index().get(normalizePath(file))?.keys() ?? [])].sort((a, b) => a - b);
  }

  /**
   * The first line at or after `line` in `file` that has code, with its addresses —
   * what a breakpoint set on a comment or a declaration slides to. `slack` bounds
   * how far it may slide.
   */
  nearestLineWithCode(file: string, line: number, slack = 8): { line: number; addresses: number[] } | null {
    const byLine = this.#index().get(normalizePath(file));
    if (!byLine) {
      return null;
    }
    for (let l = line; l <= line + slack; l++) {
      const addresses = byLine.get(l);
      if (addresses && addresses.length > 0) {
        return { line: l, addresses };
      }
    }
    return null;
  }

  /**
   * The row starting exactly at `address`, or undefined. Several rows may share an
   * address (GCC emits "view" rows); a statement row wins the label, and `isStmt`
   * is true if any of them is one.
   */
  rowAt(address: number): LineRowStart | undefined {
    if (!this.#starts) {
      this.#starts = new Map();
      for (const row of this.rows) {
        if (row.endSequence) {
          continue;
        }
        const existing = this.#starts.get(row.address);
        if (!existing || row.isStmt || !existing.isStmt) {
          this.#starts.set(row.address, {
            file: normalizePath(row.file),
            line: row.line,
            isStmt: row.isStmt || (existing?.isStmt ?? false),
          });
        }
      }
    }
    return this.#starts.get(address);
  }

  #index(): Map<string, Map<number, number[]>> {
    if (this.#byFileLine) {
      return this.#byFileLine;
    }
    // One location per *run* of rows for a line, at the run's first statement row:
    // a line whose code spans several rows (`x = a + b` as a load, an add, a store)
    // is one breakpoint, but a line the compiler split around another (a loop
    // condition, a hoisted load) is one per piece. Rows without `is_stmt` are not
    // places a debugger should stop, so they neither open a run nor count as code.
    const index = new Map<string, Map<number, number[]>>();
    let prevFile: string | null = null;
    let prevLine = -1;
    for (const row of this.rows) {
      if (row.endSequence) {
        prevFile = null;
        continue;
      }
      const file = normalizePath(row.file);
      const sameRun = file === prevFile && row.line === prevLine;
      prevFile = file;
      prevLine = row.line;
      if (sameRun || !row.isStmt) {
        continue;
      }
      let byLine = index.get(file);
      if (!byLine) {
        byLine = new Map();
        index.set(file, byLine);
      }
      const list = byLine.get(row.line);
      if (!list) {
        byLine.set(row.line, [row.address]);
      } else if (!list.includes(row.address)) {
        list.push(row.address);
      }
    }
    for (const byLine of index.values()) {
      for (const list of byLine.values()) {
        list.sort((a, b) => a - b);
      }
    }
    this.#byFileLine = index;
    return index;
  }

  /**
   * Map a PC to its source row: the row with the largest address <= pc, unless
   * that row is an end_sequence boundary (pc falls in a gap → no mapping).
   */
  pcToSource(pc: number): { file: string; line: number } | null {
    const rows = this.rows;
    if (rows.length === 0 || pc < rows[0]!.address) {
      return null;
    }
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (rows[mid]!.address <= pc) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const row = rows[lo]!;
    if (row.endSequence) {
      return null;
    }
    return { file: row.file, line: row.line };
  }
}

/** Fold `./`, `..` and backslashes so the same file spelled two ways is one key. */
export function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' && out.length > 0) {
      continue;
    }
    if (part === '.') {
      continue;
    }
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..' && out[out.length - 1] !== '') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/') || p;
}
