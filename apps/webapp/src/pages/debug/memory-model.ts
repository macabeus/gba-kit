/**
 * Rows of a memory view from a partial read. A read past what is mapped (SRAM
 * on a cartridge without a backup chip, the space after a ROM's last byte)
 * answers zeros the bus made up, and `readable` says where they begin: those
 * cells are drawn as absent, never as `00`.
 */

export interface MemoryCell {
  /** two hex digits, or `--` for a byte nothing maps */
  hex: string;
  /** the printable character, `.` for a byte that is not one, a space for an unmapped byte */
  ascii: string;
  mapped: boolean;
}

export interface MemoryRow {
  address: number;
  cells: MemoryCell[];
}

const UNMAPPED_CELL: MemoryCell = { hex: '--', ascii: ' ', mapped: false };

function mappedCell(byte: number): MemoryCell {
  return {
    hex: byte.toString(16).padStart(2, '0'),
    ascii: byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.',
    mapped: true,
  };
}

/** `rows` rows of `bytesPerRow` cells from `address`, laid over what a read there returned. */
export function memoryRows(
  read: { data: Uint8Array; readable: number },
  address: number,
  bytesPerRow: number,
  rows: number,
): MemoryRow[] {
  return Array.from({ length: rows }, (_, row) => ({
    address: (address + row * bytesPerRow) >>> 0,
    cells: Array.from({ length: bytesPerRow }, (_, column) => {
      const index = row * bytesPerRow + column;
      return index < read.readable && index < read.data.length ? mappedCell(read.data[index]!) : UNMAPPED_CELL;
    }),
  }));
}
