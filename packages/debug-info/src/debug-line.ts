/**
 * DWARF `.debug_line` line-number program parser (DWARF 2/3/4).
 *
 * Produces a flat, address-sorted table of rows so a runtime PC can be mapped to
 * a source `file:line`. Handles the traditional line-program header (DWARF 2/3/4)
 * emitted by both old (GCC 2.95) and modern (GCC 14 / devkitARM) toolchains.
 */
import { Cursor } from './reader.js';

export interface LineRow {
  /** Absolute address (VMA) of the first byte this row covers. */
  address: number;
  /** 1-based file index into the unit's file table. */
  fileIndex: number;
  /** Resolved file path (dir + name) for convenience. */
  file: string;
  line: number;
  /** True for the DW_LNE_end_sequence marker that bounds a run of addresses. */
  endSequence: boolean;
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

/** Parse all compilation units in a `.debug_line` section into a sorted table. */
export function parseDebugLine(section: Uint8Array): LineTable {
  const rows: LineRow[] = [];
  const c = new Cursor(section);

  while (c.remaining >= 4) {
    parseUnit(c, rows);
  }

  // Sort by address; at a shared address put an end_sequence boundary BEFORE a
  // real row, so a PC there maps to the row that actually starts at it (the next
  // function's first line) rather than the previous sequence's terminator.
  rows.sort((a, b) => a.address - b.address || Number(b.endSequence) - Number(a.endSequence));
  return new LineTable(rows);
}

function parseUnit(c: Cursor, rows: LineRow[]): void {
  const unitStart = c.offset;
  const unitLength = c.u32();
  if (unitLength === 0 || unitLength === 0xffffffff) {
    // 0 = padding; 0xffffffff = 64-bit DWARF (unsupported here). Stop this unit.
    c.seek(c.bytes.length);
    return;
  }
  const unitEnd = c.offset + unitLength;

  const version = c.u16();
  const headerLength = c.u32();
  const programStart = c.offset + headerLength;

  const minInstLength = c.u8();
  if (version >= 4) {
    c.u8(); // maximum_operations_per_instruction (unused for ARM)
  }
  const defaultIsStmt = c.u8() !== 0;
  const lineBase = c.s8();
  const lineRange = c.u8();
  const opcodeBase = c.u8();

  const standardOpcodeLengths: number[] = [0]; // 1-indexed
  for (let i = 1; i < opcodeBase; i++) {
    standardOpcodeLengths.push(c.u8());
  }

  // include_directories: NUL-terminated strings, ended by an empty string.
  const dirs: string[] = ['']; // index 0 = compilation directory (implicit)
  for (;;) {
    const dir = c.cstr();
    if (dir === '') {
      break;
    }
    dirs.push(dir);
  }

  // file_names: { name, dir_index(uleb), mtime(uleb), size(uleb) }, ended by empty name.
  const files: { name: string; dir: number }[] = [{ name: '', dir: 0 }]; // 1-based; [0] unused
  for (;;) {
    const name = c.cstr();
    if (name === '') {
      break;
    }
    const dir = c.uleb();
    c.uleb(); // mtime
    c.uleb(); // size
    files.push({ name, dir });
  }

  const resolveFile = (idx: number): string => {
    const f = files[idx];
    if (!f) {
      return `<file ${idx}>`;
    }
    if (f.name.startsWith('/') || f.dir === 0) {
      return f.name;
    }
    const dir = dirs[f.dir];
    return dir ? `${dir}/${f.name}` : f.name;
  };

  // Run the program.
  c.seek(programStart);
  let address = 0;
  let file = 1;
  let line = 1;
  let isStmt = defaultIsStmt;
  let endSequence = false;

  const emit = () => rows.push({ address: address >>> 0, fileIndex: file, file: resolveFile(file), line, endSequence });
  const reset = () => {
    address = 0;
    file = 1;
    line = 1;
    isStmt = defaultIsStmt;
    endSequence = false;
  };

  while (c.offset < unitEnd) {
    const opcode = c.u8();

    if (opcode >= opcodeBase) {
      // Special opcode: advance address + line and emit a row.
      const adjusted = opcode - opcodeBase;
      address += Math.floor(adjusted / lineRange) * minInstLength;
      line += lineBase + (adjusted % lineRange);
      emit();
      continue;
    }

    switch (opcode) {
      case 0: {
        // Extended opcode.
        const len = c.uleb();
        const extStart = c.offset;
        const sub = c.u8();
        switch (sub) {
          case DW_LNE_end_sequence:
            endSequence = true;
            emit();
            reset();
            break;
          case DW_LNE_set_address:
            address = c.u32(); // 32-bit target
            break;
          case DW_LNE_define_file:
            // name, dir, mtime, size — rarely used; skip via len.
            break;
          default:
            break;
        }
        c.seek(extStart + len);
        break;
      }
      case DW_LNS_copy:
        emit();
        break;
      case DW_LNS_advance_pc:
        address += c.uleb() * minInstLength;
        break;
      case DW_LNS_advance_line:
        line += c.sleb();
        break;
      case DW_LNS_set_file:
        file = c.uleb();
        break;
      case DW_LNS_set_column:
        c.uleb();
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
        address += c.u16();
        break;
      default: {
        // Unknown standard opcode: skip its ULEB operands.
        const n = standardOpcodeLengths[opcode] ?? 0;
        for (let i = 0; i < n; i++) {
          c.uleb();
        }
        break;
      }
    }
  }

  c.seek(unitEnd);
  // Parsed while running the program but not surfaced: rows carry only
  // address/file/line/endSequence.
  void isStmt;
  void unitStart;
  void version;
}

/** Address-sorted line rows with PC→source lookup. */
export class LineTable {
  readonly rows: LineRow[];

  constructor(rows: LineRow[]) {
    this.rows = rows;
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
