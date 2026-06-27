/**
 * Minimal ELF32 little-endian container reader — just enough to pull named
 * sections (symbol tables, DWARF) out of a linked ELF. GBA ELFs are always
 * ELF32 / EM_ARM / little-endian, so we validate and bail otherwise.
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

const ELF_MAGIC = 0x464c457f; // "\x7fELF" little-endian
const ELFCLASS32 = 1;
const ELFDATA2LSB = 1;

export class ElfFile {
  readonly #bytes: Uint8Array;
  readonly sections: ElfSection[];
  readonly #byName = new Map<string, ElfSection>();

  /** Use {@link ElfFile.parse}; this constructor is an internal detail. */
  constructor(bytes: Uint8Array, sections: ElfSection[]) {
    this.#bytes = bytes;
    this.sections = sections;
    for (const s of sections) {
      // First occurrence wins (a name should be unique anyway).
      if (!this.#byName.has(s.name)) {
        this.#byName.set(s.name, s);
      }
    }
  }

  /** Parse an ELF32-LE image. Throws on a non-ELF / unsupported file. */
  static parse(bytes: Uint8Array): ElfFile {
    const c = new Cursor(bytes);
    if (c.u32() !== ELF_MAGIC) {
      throw new Error('Not an ELF file (bad magic)');
    }
    const eiClass = c.u8();
    const eiData = c.u8();
    if (eiClass !== ELFCLASS32) {
      throw new Error(`Unsupported ELF class ${eiClass} (expected ELF32)`);
    }
    if (eiData !== ELFDATA2LSB) {
      throw new Error(`Unsupported ELF endianness ${eiData} (expected little-endian)`);
    }

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
    return new ElfFile(bytes, sections);
  }

  section(name: string): ElfSection | undefined {
    return this.#byName.get(name);
  }

  /** Raw bytes of a named section, or undefined if absent. */
  sectionData(name: string): Uint8Array | undefined {
    const s = this.#byName.get(name);
    if (!s) {
      return undefined;
    }
    return this.#bytes.subarray(s.offset, s.offset + s.size);
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
