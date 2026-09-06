/**
 * Helpers over the raw DIE tree (`DwarfEntry`): typed attribute access, reference
 * following (with `abstract_origin` / `specification` inheritance), and the
 * per-unit facts (the CU low_pc, the `.debug_addr`/loclists/rnglists bases) that list
 * and address forms depend on.
 */
import type { AttrValue, DwarfEntry } from '../types.js';
import { DW_AT, DW_FORM, formClass } from './constants.js';

/** What a compilation unit's header and root DIE establish for everything inside it. */
export interface UnitInfo {
  /** Offset of the unit header in `.debug_info` (matches `DwarfEntry.unitOffset`). */
  offset: number;
  version: number;
  root: DwarfEntry;
  /** `DW_AT_low_pc` of the CU DIE: the base for offset-pair range/location entries. */
  lowPc: number;
  addrBase: number;
  loclistsBase: number;
  rnglistsBase: number;
}

/** The DWARF sections the readers consult, as raw bytes (absent when the ELF lacks them). */
export interface DwarfSections {
  addr?: Uint8Array;
  loclists?: Uint8Array;
  loc?: Uint8Array;
  rnglists?: Uint8Array;
  ranges?: Uint8Array;
  frame?: Uint8Array;
}

export function attrNum(entry: DwarfEntry, at: number): number | undefined {
  const v = entry.attrs.get(at);
  return typeof v === 'number' ? v : undefined;
}

export function attrStr(entry: DwarfEntry, at: number): string | undefined {
  const v = entry.attrs.get(at);
  return typeof v === 'string' ? v : undefined;
}

export function attrFlag(entry: DwarfEntry, at: number): boolean {
  const v = entry.attrs.get(at);
  return v === true || v === 1;
}

/**
 * An address-class attribute (`low_pc`, `entry_pc`), resolving `DW_FORM_addrx`
 * through `.debug_addr` when the unit uses it. Undefined when absent or unresolvable.
 */
export function attrAddress(
  entry: DwarfEntry,
  at: number,
  unit: UnitInfo,
  sections: DwarfSections,
): number | undefined {
  const v = entry.attrs.get(at);
  if (typeof v !== 'number') {
    return undefined;
  }
  const form = entry.forms.get(at) ?? DW_FORM.addr;
  if (formClass(form) !== 'addrx') {
    return v >>> 0;
  }
  return addrxValue(v, unit, sections);
}

/** Resolve an index into `.debug_addr` (DWARF 5 `addrx` forms and `DW_LLE_*x` entries). */
export function addrxValue(index: number, unit: UnitInfo, sections: DwarfSections): number | undefined {
  const table = sections.addr;
  if (!table) {
    return undefined;
  }
  const at = unit.addrBase + index * 4;
  if (at + 4 > table.length) {
    return undefined;
  }
  return new DataView(table.buffer, table.byteOffset, table.byteLength).getUint32(at, true);
}

/** Index of every DIE by offset, with reference following and origin inheritance. */
export class EntryIndex {
  readonly #byOffset = new Map<number, DwarfEntry>();
  readonly #parents = new Map<DwarfEntry, DwarfEntry | null>();
  readonly units: UnitInfo[];
  readonly #unitByOffset = new Map<number, UnitInfo>();

  constructor(roots: DwarfEntry[]) {
    this.units = roots.map((root) => this.#unitOf(root));
    for (const u of this.units) {
      this.#unitByOffset.set(u.offset, u);
    }
    const visit = (d: DwarfEntry, parent: DwarfEntry | null): void => {
      this.#byOffset.set(d.offset, d);
      this.#parents.set(d, parent);
      for (const ch of d.children) {
        visit(ch, d);
      }
    };
    for (const root of roots) {
      visit(root, null);
    }
  }

  #unitOf(root: DwarfEntry): UnitInfo {
    return {
      offset: root.unitOffset,
      version: root.version,
      root,
      lowPc: attrNum(root, DW_AT.low_pc) ?? 0,
      // DWARF 5 defaults: the first entry sits right after each table's header.
      addrBase: attrNum(root, DW_AT.addr_base) ?? 8,
      loclistsBase: attrNum(root, DW_AT.loclists_base) ?? 12,
      rnglistsBase: attrNum(root, DW_AT.rnglists_base) ?? 12,
    };
  }

  /** The unit an entry belongs to; the first unit when its `unitOffset` is unknown. */
  unit(entry: DwarfEntry): UnitInfo {
    return this.#unitByOffset.get(entry.unitOffset) ?? this.units[0]!;
  }

  at(offset: number | undefined): DwarfEntry | undefined {
    return offset === undefined ? undefined : this.#byOffset.get(offset);
  }

  parent(entry: DwarfEntry): DwarfEntry | null {
    return this.#parents.get(entry) ?? null;
  }

  /** The DIE an attribute references (`DW_AT_type`, `DW_AT_abstract_origin`, …). */
  ref(entry: DwarfEntry, at: number): DwarfEntry | undefined {
    const form = entry.forms.get(at);
    if (form === undefined || formClass(form) !== 'reference') {
      return undefined;
    }
    const v = entry.attrs.get(at);
    return typeof v === 'number' ? this.#byOffset.get(v) : undefined;
  }

  /** `at` on the entry itself, else inherited through `abstract_origin` / `specification`. */
  inherited(entry: DwarfEntry, at: number, depth = 0): AttrValue | undefined {
    const own = entry.attrs.get(at);
    if (own !== undefined || depth > 4) {
      return own;
    }
    const origin = this.ref(entry, DW_AT.abstract_origin) ?? this.ref(entry, DW_AT.specification);
    return origin ? this.inherited(origin, at, depth + 1) : undefined;
  }

  name(entry: DwarfEntry): string | undefined {
    const v = this.inherited(entry, DW_AT.name);
    return typeof v === 'string' ? v : undefined;
  }

  typeOf(entry: DwarfEntry): DwarfEntry | undefined {
    let e: DwarfEntry | undefined = entry;
    for (let depth = 0; e && depth < 5; depth++) {
      const t = this.ref(e, DW_AT.type);
      if (t) {
        return t;
      }
      e = this.ref(e, DW_AT.abstract_origin) ?? this.ref(e, DW_AT.specification);
    }
    return undefined;
  }
}
