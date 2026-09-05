/**
 * User annotations: labels and comments by address, kept apart from what the ELF
 * says (a compiler fact) so a hypothesis never masquerades as evidence. Stored as
 * a reviewable JSON file in the project's `.gba-kit/` directory, importable from
 * the symbol-file formats decomps and emulators already use.
 */

export interface Label {
  address: number;
  /** a C-identifier-like name; empty when only a comment is attached */
  label: string;
  comment?: string;
  /** byte size of the object, when the user stated one */
  size?: number;
  /** who says so: the user, or an imported file */
  source: 'user' | 'import';
}

export interface LabelsFile {
  format: 'gba-kit-labels';
  version: 1;
  romHash?: string;
  labels: Array<Omit<Label, 'source'> & { source?: Label['source'] }>;
}

export class LabelStore {
  readonly #byAddress = new Map<number, Label>();
  readonly #byName = new Map<string, Label>();
  #dirty = false;
  readonly #onChange: (() => void) | undefined;
  /** true while a file or symbol import runs, so it reports one change rather than one per line */
  #importing = false;

  /** `onChange` runs after every edit, import or load: the names shown for addresses are stale. */
  constructor(onChange?: () => void) {
    this.#onChange = onChange;
  }

  #changed(): void {
    if (!this.#importing) {
      this.#onChange?.();
    }
  }

  get size(): number {
    return this.#byAddress.size;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  markSaved(): void {
    this.#dirty = false;
  }

  at(address: number): Label | undefined {
    return this.#byAddress.get(address >>> 0);
  }

  byName(name: string): Label | undefined {
    return this.#byName.get(name);
  }

  all(): Label[] {
    return [...this.#byAddress.values()].sort((a, b) => a.address - b.address);
  }

  /** Set (or clear, with an empty label and no comment) the annotation at `address`. */
  set(entry: Omit<Label, 'source'> & { source?: Label['source'] }): void {
    const address = entry.address >>> 0;
    const existing = this.#byAddress.get(address);
    if (existing) {
      this.#byName.delete(existing.label);
    }
    if (!entry.label && !entry.comment) {
      this.#byAddress.delete(address);
      this.#dirty = true;
      this.#changed();
      return;
    }
    const label: Label = {
      address,
      label: entry.label,
      comment: entry.comment,
      size: entry.size,
      source: entry.source ?? 'user',
    };
    this.#byAddress.set(address, label);
    if (label.label) {
      this.#byName.set(label.label, label);
    }
    this.#dirty = true;
    this.#changed();
  }

  remove(address: number): void {
    this.set({ address, label: '' });
  }

  toFile(romHash?: string): LabelsFile {
    return {
      format: 'gba-kit-labels',
      version: 1,
      romHash,
      labels: this.all().map(({ address, label, comment, size, source }) => ({
        address,
        label,
        comment,
        size,
        source,
      })),
    };
  }

  loadFile(file: LabelsFile): void {
    if (file.format !== 'gba-kit-labels') {
      throw new Error('not a gba-kit labels file');
    }
    this.#importing = true;
    try {
      for (const l of file.labels) {
        this.set(l);
      }
    } finally {
      this.#importing = false;
    }
    this.#dirty = false;
    this.#changed();
  }

  /**
   * Import a symbol file. Understood line shapes:
   *   `08001234 name`            (no$gba / mGBA `.sym`)
   *   `0x08001234 name`          (address first, any prefix)
   *   `name = 0x08001234;`       (ldscript / a decomp's symbols.txt)
   *   `name 0x08001234`          (name first)
   *   `.text 0x08001234 name`    (ignored: a section line)
   * Lines that fit none are skipped; the count of imported labels is returned.
   */
  importSymbols(text: string): number {
    this.#importing = true;
    try {
      return this.#importLines(text);
    } finally {
      this.#importing = false;
      this.#changed();
    }
  }

  #importLines(text: string): number {
    let count = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw
        .replace(/[;#].*$/, '')
        .replace(/\/\/.*$/, '')
        .trim();
      if (!line) {
        continue;
      }
      let m = /^(?:0x)?([0-9a-fA-F]{7,8})\s+([A-Za-z_.$][\w.$]*)\s*(?:,\s*(\d+))?$/.exec(line);
      let name: string | undefined;
      let address: number | undefined;
      let size: number | undefined;
      if (m) {
        address = parseInt(m[1]!, 16);
        name = m[2];
        size = m[3] ? Number(m[3]) : undefined;
      } else if ((m = /^([A-Za-z_.$][\w.$]*)\s*=\s*(?:0x)?([0-9a-fA-F]{7,8})$/.exec(line))) {
        name = m[1];
        address = parseInt(m[2]!, 16);
      } else if ((m = /^([A-Za-z_.$][\w.$]*)\s+(?:0x)?([0-9a-fA-F]{7,8})$/.exec(line))) {
        name = m[1];
        address = parseInt(m[2]!, 16);
      }
      if (name === undefined || address === undefined || name.startsWith('.')) {
        continue;
      }
      this.set({ address, label: name, size, source: 'import' });
      count++;
    }
    return count;
  }

  /** Export in no$gba `.sym` shape: `08001234 name`. */
  exportSymbols(): string {
    return this.all()
      .filter((l) => l.label)
      .map((l) => `${l.address.toString(16).padStart(8, '0')} ${l.label}`)
      .join('\n');
  }
}
