/**
 * Minimal ELF32 container reader — just enough to pull named sections (symbol
 * tables, DWARF) out of a linked ELF or relocatable object. Little-endian (ARM
 * GBA) and big-endian (MIPS, PowerPC) are both supported; the byte order is read
 * from e_ident and threaded through every multi-byte read.
 */
import { Cursor, cstrAt } from './reader.js';

export interface ElfSection {
  name: string;
  type: number;
  /** Virtual address (0 for non-loadable sections like .debug_*). */
  addr: number;
  /** Byte offset of the section's data within the file. */
  offset: number;
  size: number;
  link: number;
  entsize: number;
}

const ELF_MAGIC = 0x464c457f; // "\x7fELF" read as an LE u32 (byte-order independent: e_ident is bytes)
const ELFCLASS32 = 1;
const ELFDATA2LSB = 1;
const ELFDATA2MSB = 2;
const SHT_SYMTAB = 2;
const SHT_RELA = 4;

export class ElfFile {
  readonly #bytes: Uint8Array;
  readonly sections: ElfSection[];
  /** Byte order of the container AND of its DWARF payload (they always agree). */
  readonly littleEndian: boolean;
  readonly #byName = new Map<string, ElfSection>();
  /** RELA-patched copies of section data, materialized lazily (see sectionData). */
  readonly #relocated = new Map<string, Uint8Array>();

  /** Use {@link ElfFile.parse}; this constructor is an internal detail. */
  constructor(bytes: Uint8Array, sections: ElfSection[], littleEndian = true) {
    this.#bytes = bytes;
    this.sections = sections;
    this.littleEndian = littleEndian;
    for (const s of sections) {
      // First occurrence wins (a name should be unique anyway).
      if (!this.#byName.has(s.name)) {
        this.#byName.set(s.name, s);
      }
    }
  }

  /** Parse an ELF32 image (either byte order). Throws on a non-ELF / unsupported file. */
  static parse(bytes: Uint8Array): ElfFile {
    const ident = new Cursor(bytes); // e_ident is byte-oriented — endianness not yet known
    if (ident.u32() !== ELF_MAGIC) {
      throw new Error('Not an ELF file (bad magic)');
    }
    const eiClass = ident.u8();
    const eiData = ident.u8();
    if (eiClass !== ELFCLASS32) {
      throw new Error(`Unsupported ELF class ${eiClass} (expected ELF32)`);
    }
    if (eiData !== ELFDATA2LSB && eiData !== ELFDATA2MSB) {
      throw new Error(`Unsupported ELF endianness ${eiData}`);
    }
    const littleEndian = eiData === ELFDATA2LSB;
    const c = new Cursor(bytes, 0, littleEndian);

    // Section header table location lives at fixed offsets in the ELF32 header.
    const shoff = c.u32At(0x20);
    const shentsize = c.u16At(0x2e);
    const shnum = c.u16At(0x30);
    const shstrndx = c.u16At(0x32);
    if (shoff === 0 || shnum === 0) {
      throw new Error('ELF has no section headers');
    }

    // Read raw section headers first; resolve names after we have shstrtab.
    const raw: Omit<ElfSection, 'name'>[] = [];
    for (let i = 0; i < shnum; i++) {
      const base = shoff + i * shentsize;
      raw.push({
        // sh_name is at +0x00 (offset into shstrtab); kept separately below.
        type: c.u32At(base + 0x04),
        addr: c.u32At(base + 0x0c),
        offset: c.u32At(base + 0x10),
        size: c.u32At(base + 0x14),
        link: c.u32At(base + 0x18),
        entsize: c.u32At(base + 0x24),
      });
    }
    const nameOffsets = Array.from({ length: shnum }, (_, i) => c.u32At(shoff + i * shentsize + 0x00));

    const shstr = raw[shstrndx];
    if (!shstr) {
      throw new Error('Invalid section-header string table index');
    }
    const shstrtab = bytes.subarray(shstr.offset, shstr.offset + shstr.size);

    const sections: ElfSection[] = raw.map((s, i) => ({ name: cstrAt(shstrtab, nameOffsets[i]!), ...s }));
    return new ElfFile(bytes, sections, littleEndian);
  }

  section(name: string): ElfSection | undefined {
    return this.#byName.get(name);
  }

  /** Raw bytes of a named section, or undefined if absent. In a RELOCATABLE object whose
   *  relocations are RELA-style (PowerPC, unlike ARM/MIPS REL where the addend already sits in
   *  the field), the raw `.debug_*` bytes carry ZEROS where string/section offsets belong — the
   *  real values live in `.rela.<name>` addends. Those are applied here (into a cached copy),
   *  so DWARF in a raw `.o` parses identically across REL and RELA targets. */
  sectionData(name: string): Uint8Array | undefined {
    const s = this.#byName.get(name);
    if (!s) {
      return undefined;
    }
    const raw = this.#bytes.subarray(s.offset, s.offset + s.size);
    const rela = this.#byName.get(`.rela${name}`);
    if (!rela || rela.type !== SHT_RELA) {
      return raw;
    }
    const cached = this.#relocated.get(name);
    if (cached) {
      return cached;
    }
    const patched = raw.slice();
    const out = new Cursor(patched, 0, this.littleEndian);
    const rc = new Cursor(this.#bytes.subarray(rela.offset, rela.offset + rela.size), 0, this.littleEndian);
    const symtab = this.sections.find((sec) => sec.type === SHT_SYMTAB);
    const symData = symtab ? this.#bytes.subarray(symtab.offset, symtab.offset + symtab.size) : undefined;
    const symCursor = symData ? new Cursor(symData, 0, this.littleEndian) : undefined;
    // Elf32_Rela = { r_offset u32, r_info u32, r_addend s32 } — 12 bytes each.
    for (let off = 0; off + 12 <= rela.size; off += 12) {
      const rOffset = rc.u32At(off);
      const rInfo = rc.u32At(off + 4);
      const rAddend = rc.u32At(off + 8) | 0;
      if (rOffset + 4 > patched.length) {
        continue;
      }
      // field = symbol value + addend (the section symbols debug relocs reference have value 0
      // in a .o, so this is normally just the addend). 32-bit data relocs only — which is all
      // the compiler emits into debug sections.
      const symIndex = rInfo >>> 8;
      const symValue = symCursor && (symIndex + 1) * 16 <= symData!.length ? symCursor.u32At(symIndex * 16 + 4) : 0;
      const value = (symValue + rAddend) >>> 0;
      if (this.littleEndian) {
        out.view.setUint32(rOffset, value, true);
      } else {
        out.view.setUint32(rOffset, value, false);
      }
    }
    this.#relocated.set(name, patched);
    return patched;
  }

  /** Bytes of a section referenced by index (e.g. a symtab's linked strtab). */
  sectionDataByIndex(index: number): Uint8Array | undefined {
    const s = this.sections[index];
    if (!s) {
      return undefined;
    }
    return this.#bytes.subarray(s.offset, s.offset + s.size);
  }
}
