/**
 * Raw `.symtab` reader for the globals gba-kit's `SymbolIndex` drops: a decomp's
 * linker script writes `gUnk_03005220 = .` inside a section, which lands in the
 * table as `NOTYPE GLOBAL` with a real section index (not `SHN_ABS`). The rule for
 * joining a header's `extern` declaration to one of these is the parallel PoC's:
 * defined, `GLOBAL` or `WEAK`, not `COMMON`, and only one candidate. A file-static
 * of the same spelling never qualifies. Plan item 20 moves this into the library.
 */
import type { ElfFile } from '@gba-kit/debug-info';

export interface LinkerSymbol {
  name: string;
  address: number;
  size: number;
  /** STT_NOTYPE 0, STT_OBJECT 1, STT_FUNC 2 */
  type: number;
  /** STB_LOCAL 0, STB_GLOBAL 1, STB_WEAK 2 */
  bind: number;
  shndx: number;
}

const SHN_UNDEF = 0;
const SHN_COMMON = 0xfff2;
const SHT_SYMTAB = 2;

export class LinkerSymbols {
  readonly #byName = new Map<string, LinkerSymbol[]>();

  constructor(elf: ElfFile) {
    const symtab = elf.sections.find((s) => s.type === SHT_SYMTAB);
    if (!symtab) {
      return;
    }
    const data = elf.sectionData(symtab.name);
    const strtab = elf.sectionDataByIndex(symtab.link);
    if (!data || !strtab) {
      return;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const le = elf.littleEndian;
    const nameAt = (off: number): string => {
      let end = off;
      while (end < strtab.length && strtab[end] !== 0) {
        end++;
      }
      return new TextDecoder().decode(strtab.subarray(off, end));
    };
    for (let off = 0; off + 16 <= data.length; off += 16) {
      const nameOff = view.getUint32(off, le);
      const value = view.getUint32(off + 4, le);
      const size = view.getUint32(off + 8, le);
      const info = data[off + 12]!;
      const shndx = view.getUint16(off + 14, le);
      const name = nameAt(nameOff);
      if (!name) {
        continue;
      }
      const sym: LinkerSymbol = { name, address: value >>> 0, size, type: info & 0xf, bind: info >> 4, shndx };
      const list = this.#byName.get(name) ?? [];
      list.push(sym);
      this.#byName.set(name, list);
    }
  }

  /**
   * The one defined global of that name, or null: undefined/common symbols and
   * file-statics are excluded, and two different defined addresses are ambiguous.
   */
  definedGlobal(name: string): LinkerSymbol | null {
    const candidates = (this.#byName.get(name) ?? []).filter(
      (s) => s.shndx !== SHN_UNDEF && s.shndx !== SHN_COMMON && (s.bind === 1 || s.bind === 2),
    );
    if (candidates.length === 0) {
      return null;
    }
    const first = candidates[0]!;
    return candidates.every((s) => s.address === first.address) ? first : null;
  }
}
