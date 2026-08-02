/**
 * Byte cursor to walk ELF tables and DWARF programs. Little-endian by default
 * (ARM GBA); big-endian for MSB-first targets (MIPS, PowerPC) — the DWARF
 * payload's byte order always matches its ELF container's.
 */
export class Cursor {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  readonly littleEndian: boolean;
  offset: number;

  constructor(bytes: Uint8Array, offset = 0, littleEndian = true) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
    this.littleEndian = littleEndian;
  }

  get eof(): boolean {
    return this.offset >= this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  seek(offset: number): void {
    this.offset = offset;
  }

  skip(n: number): void {
    this.offset += n;
  }

  u8(): number {
    return this.view.getUint8(this.offset++);
  }

  s8(): number {
    return this.view.getInt8(this.offset++);
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, this.littleEndian);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, this.littleEndian);
    this.offset += 4;
    return v >>> 0;
  }

  /** Absolute reads that don't move `offset` (for fixed-layout tables). */
  u8At(offset: number): number {
    return this.view.getUint8(offset);
  }

  u16At(offset: number): number {
    return this.view.getUint16(offset, this.littleEndian);
  }

  u32At(offset: number): number {
    return this.view.getUint32(offset, this.littleEndian) >>> 0;
  }

  /** Unsigned LEB128 */
  uleb(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
    }
    return result >>> 0;
  }

  /** Signed LEB128 */
  sleb(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.u8();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    // Sign-extend if the last continuation byte's sign bit is set.
    if (shift < 32 && byte & 0x40) {
      result |= -(1 << shift);
    }
    return result;
  }

  /** NUL-terminated string from the current position. */
  cstr(): string {
    const start = this.offset;
    while (this.offset < this.bytes.length && this.bytes[this.offset] !== 0) {
      this.offset++;
    }
    const str = utf8(this.bytes.subarray(start, this.offset));
    this.offset++; // consume the NUL
    return str;
  }
}

/** Read a NUL-terminated string at an absolute offset (e.g. into a string table). */
export function cstrAt(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) {
    end++;
  }
  return utf8(bytes.subarray(offset, end));
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}
