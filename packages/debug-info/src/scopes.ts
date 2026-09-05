/**
 * DwarfScopes — what a source-level debugger asks of the DWARF beyond lines and
 * types: which function and inlined calls contain a PC, what variables are visible
 * there and where they live right now, the frame base and CFA, how to unwind to
 * the caller, and how to show a value of any type.
 *
 * Everything that reads the machine goes through {@link Memory}; this module never
 * touches an emulator directly, so it serves a live session, a snapshot, or a test.
 */
import { DW_AT, DW_TAG } from './dwarf/constants.js';
import { attrFlag, attrNum, EntryIndex, type DwarfSections, type UnitInfo } from './dwarf/entries.js';
import { evaluate, type EvalContext, type Location } from './dwarf/expr.js';
import { FrameTable } from './dwarf/frame.js';
import { describeExpr, entryRanges, locationAt, rangesContain, type Range } from './dwarf/lists.js';
import { formatValue, TypeResolver, type TypeDesc, type ValueReader, type VarNode } from './dwarf/values.js';
import type { ElfFile } from './elf.js';
import type { LineRow } from './debug-line.js';
import type { DwarfEntry } from './types.js';

export interface Memory {
  /** `size` bytes at `address`, or null when any byte is unreadable. */
  read(address: number, size: number): Uint8Array | null;
}

/** A real frame on the machine's stack. */
export interface PhysicalFrame {
  /** where execution is (frame 0) or will resume (callers: the return address) */
  pc: number;
  /** an address inside the call instruction, for line/scope lookups of callers */
  lookupPc: number;
  /** r0–r15 as they were in this frame; undefined where a caller's value could not be recovered */
  regs: Array<number | undefined>;
  fn: DwarfEntry | null;
  /** from call-frame information, as opposed to the one-level LR guess */
  exact: boolean;
}

/** A physical frame, or one of the inlined layers inside it. */
export interface VirtualFrame {
  physical: PhysicalFrame;
  /** the subprogram or inlined_subroutine DIE this frame executes; null without DWARF for it */
  scope: DwarfEntry | null;
  name: string;
  /** where this frame is: the pc for the innermost layer, the call site for the outer ones */
  location: { pc: number } | { file: string; line: number };
  inlined: boolean;
}

export class DwarfScopes {
  readonly index: EntryIndex;
  readonly types: TypeResolver;
  readonly frames: FrameTable;
  readonly #sections: DwarfSections;
  readonly #lineRows: readonly LineRow[];
  readonly #ranges = new Map<DwarfEntry, Range[]>();
  /** every subprogram with code, sorted by low address */
  readonly #functions: Array<{ lo: number; hi: number; entry: DwarfEntry }> = [];
  readonly #fileNames = new Map<UnitInfo, Map<number, string>>();
  #globalsByName: Map<string, DwarfEntry> | null = null;
  #declarationsByName: Map<string, DwarfEntry> | null = null;
  #typesByName: Map<string, DwarfEntry> | null = null;

  constructor(roots: DwarfEntry[], elf: ElfFile, lineRows: readonly LineRow[]) {
    this.index = new EntryIndex(roots);
    this.types = new TypeResolver(this.index);
    this.#sections = {
      addr: elf.sectionData('.debug_addr'),
      loclists: elf.sectionData('.debug_loclists'),
      loc: elf.sectionData('.debug_loc'),
      rnglists: elf.sectionData('.debug_rnglists'),
      ranges: elf.sectionData('.debug_ranges'),
      frame: elf.sectionData('.debug_frame'),
    };
    this.frames = new FrameTable(this.#sections.frame, elf.littleEndian);
    this.#lineRows = lineRows;
    for (const u of this.index.units) {
      this.#collectFunctions(u.root);
    }
    this.#functions.sort((a, b) => a.lo - b.lo);
  }

  get units(): UnitInfo[] {
    return this.index.units;
  }

  /** `[low, high)` code ranges of a scope DIE, cached. */
  ranges(entry: DwarfEntry): Range[] {
    let r = this.#ranges.get(entry);
    if (!r) {
      r = entryRanges(entry, this.index.unit(entry), this.#sections);
      this.#ranges.set(entry, r);
    }
    return r;
  }

  #collectFunctions(entry: DwarfEntry): void {
    if (entry.tag === DW_TAG.subprogram) {
      for (const [lo, hi] of this.ranges(entry)) {
        this.#functions.push({ lo, hi, entry });
      }
    }
    for (const ch of entry.children) {
      this.#collectFunctions(ch);
    }
  }

  /** The subprogram DIE whose code contains `pc`, or null. */
  functionAt(pc: number): DwarfEntry | null {
    let lo = 0;
    let hi = this.#functions.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const f = this.#functions[mid]!;
      if (pc < f.lo) {
        hi = mid - 1;
      } else if (pc >= f.hi) {
        lo = mid + 1;
      } else {
        return f.entry;
      }
    }
    return null;
  }

  name(entry: DwarfEntry): string | undefined {
    return this.index.name(entry);
  }

  /** Inlined subroutines containing `pc` inside `fn`, outermost first. */
  inlineChain(fn: DwarfEntry, pc: number): DwarfEntry[] {
    const chain: DwarfEntry[] = [];
    const walk = (scope: DwarfEntry): void => {
      for (const ch of scope.children) {
        if (ch.tag === DW_TAG.inlined_subroutine) {
          if (rangesContain(this.ranges(ch), pc)) {
            chain.push(ch);
            walk(ch);
            return;
          }
        } else if (ch.tag === DW_TAG.lexical_block) {
          const r = this.ranges(ch);
          if (r.length === 0 || rangesContain(r, pc)) {
            walk(ch);
          }
        }
      }
    };
    walk(fn);
    return chain;
  }

  /**
   * Variables and parameters visible in `scope` at `pc`: the scope's own, plus those
   * of nested lexical blocks that contain `pc`. Nested inlined subroutines are
   * separate frames and are skipped.
   */
  scopeVariables(scope: DwarfEntry, pc: number): DwarfEntry[] {
    const out: DwarfEntry[] = [];
    const walk = (s: DwarfEntry): void => {
      for (const ch of s.children) {
        if (ch.tag === DW_TAG.variable || ch.tag === DW_TAG.formal_parameter) {
          out.push(ch);
        } else if (ch.tag === DW_TAG.lexical_block) {
          const r = this.ranges(ch);
          if (r.length === 0 || rangesContain(r, pc)) {
            walk(ch);
          }
        }
      }
    };
    walk(scope);
    return out;
  }

  /** Top-level variables of a unit that have a location (definitions, not declarations). */
  globals(unit: UnitInfo): DwarfEntry[] {
    return unit.root.children.filter((d) => d.tag === DW_TAG.variable && !attrFlag(d, DW_AT.declaration) && d.attrs.has(DW_AT.location));
  }

  /** A global variable definition by name, from any unit. */
  globalByName(name: string): DwarfEntry | null {
    if (!this.#globalsByName) {
      this.#globalsByName = new Map();
      for (const u of this.units) {
        for (const d of this.globals(u)) {
          const n = this.index.name(d);
          if (n && !this.#globalsByName.has(n)) {
            this.#globalsByName.set(n, d);
          }
        }
      }
    }
    return this.#globalsByName.get(name) ?? null;
  }

  /**
   * A global *declaration* by name (`extern struct Foo gBar;` from a header): a
   * type, no location. A decomp keeps most storage in assembly, so this plus the
   * symbol table's address is how such a global gets a shape.
   */
  declarationByName(name: string): DwarfEntry | null {
    if (!this.#declarationsByName) {
      this.#declarationsByName = new Map();
      for (const u of this.units) {
        for (const d of u.root.children) {
          if (d.tag !== DW_TAG.variable || d.attrs.has(DW_AT.location)) {
            continue;
          }
          const n = this.index.name(d);
          if (n && this.index.typeOf(d) && !this.#declarationsByName.has(n)) {
            this.#declarationsByName.set(n, d);
          }
        }
      }
    }
    return this.#declarationsByName.get(name) ?? null;
  }

  /**
   * A type by its C name — `Card`, `struct Card`, `enum Suit`, `u16` — from any
   * unit. A complete definition wins over a declaration.
   */
  typeByName(name: string): DwarfEntry | null {
    if (!this.#typesByName) {
      this.#typesByName = new Map();
      const keyOf = (d: DwarfEntry): string | null => {
        const n = this.index.name(d);
        if (!n) {
          return null;
        }
        switch (d.tag) {
          case DW_TAG.structure_type:
            return `struct ${n}`;
          case DW_TAG.union_type:
            return `union ${n}`;
          case DW_TAG.enumeration_type:
            return `enum ${n}`;
          case DW_TAG.typedef:
          case DW_TAG.base_type:
            return n;
          default:
            return null;
        }
      };
      for (const u of this.units) {
        for (const d of u.root.children) {
          const key = keyOf(d);
          if (!key) {
            continue;
          }
          const complete =
            !attrFlag(d, DW_AT.declaration) && (d.tag === DW_TAG.typedef || d.tag === DW_TAG.base_type || d.attrs.has(DW_AT.byte_size));
          const existing = this.#typesByName.get(key);
          if (!existing || (complete && attrFlag(existing, DW_AT.declaration))) {
            this.#typesByName.set(key, d);
          }
        }
      }
    }
    const trimmed = name.replace(/\s+/g, ' ').trim();
    return (
      this.#typesByName.get(trimmed) ??
      this.#typesByName.get(`struct ${trimmed}`) ??
      this.#typesByName.get(`union ${trimmed}`) ??
      this.#typesByName.get(`enum ${trimmed}`) ??
      null
    );
  }

  /** The unit whose code contains `pc`, or null. */
  unitContaining(pc: number): UnitInfo | null {
    const fn = this.functionAt(pc);
    if (fn) {
      return this.index.unit(fn);
    }
    for (const u of this.units) {
      if (rangesContain(this.ranges(u.root), pc)) {
        return u;
      }
    }
    return null;
  }

  /** Where an inlined call was made from: `DW_AT_call_file` resolved through the unit's line-table files. */
  callSite(inlined: DwarfEntry): { file: string; line: number } | null {
    const fileIndex = attrNum(inlined, DW_AT.call_file);
    const line = attrNum(inlined, DW_AT.call_line);
    if (fileIndex === undefined || line === undefined) {
      return null;
    }
    const unit = this.index.unit(inlined);
    let names = this.#fileNames.get(unit);
    if (!names) {
      names = new Map();
      const ranges = this.ranges(unit.root);
      for (const row of this.#lineRows) {
        // An end_sequence row's address is the END of the previous unit's code, which
        // can be the first byte of this one, and it carries the other unit's numbering.
        if (!row.endSequence && rangesContain(ranges, row.address) && !names.has(row.fileIndex)) {
          names.set(row.fileIndex, row.file);
        }
      }
      this.#fileNames.set(unit, names);
    }
    const file = names.get(fileIndex);
    return file ? { file, line } : null;
  }

  // ─── locations and values ──────────────────────────────────────────

  #evalContext(frame: PhysicalFrame, memory: Memory): EvalContext {
    const fn = frame.fn;
    let frameBaseCache: number | undefined | null = null;
    const ctx: EvalContext = {
      reg: (n) => frame.regs[n],
      readMem: (address, size) => {
        const b = memory.read(address, size);
        if (!b || b.length < size) {
          return undefined;
        }
        let v = 0;
        for (let i = size - 1; i >= 0; i--) {
          v = v * 256 + b[i]!;
        }
        return v >>> 0;
      },
      cfa: () => this.frames.cfa(frame.lookupPc, frame.regs),
      frameBase: () => {
        if (frameBaseCache !== null) {
          return frameBaseCache;
        }
        frameBaseCache = undefined;
        if (fn) {
          const fb = locationAt(fn, DW_AT.frame_base, frame.lookupPc, this.index.unit(fn), this.#sections);
          if (fb.kind === 'expr') {
            const loc = evaluate(fb.expr, { ...ctx, frameBase: () => undefined });
            if (loc.kind === 'memory') {
              frameBaseCache = loc.address;
            } else if (loc.kind === 'register') {
              frameBaseCache = frame.regs[loc.reg];
            } else if (loc.kind === 'value') {
              frameBaseCache = loc.value;
            }
          }
        }
        return frameBaseCache;
      },
    };
    return ctx;
  }

  /** Where `variable` lives in `frame` right now. */
  location(variable: DwarfEntry, frame: PhysicalFrame, memory: Memory): Location {
    const attr = locationAt(variable, DW_AT.location, frame.lookupPc, this.index.unit(variable), this.#sections);
    switch (attr.kind) {
      case 'expr':
        return evaluate(attr.expr, this.#evalContext(frame, memory));
      case 'none': {
        const cv = variable.attrs.get(DW_AT.const_value);
        if (typeof cv === 'number') {
          return { kind: 'value', value: cv >>> 0 };
        }
        if (cv instanceof Uint8Array) {
          return { kind: 'implicit', bytes: cv };
        }
        return { kind: 'optimized-out', reason: 'the compiler recorded no location' };
      }
      case 'not-here': {
        // Say where the compiler DID keep it: the difference between "gone" and "GCC
        // split it into registers it never described" is visible in the ranges.
        const where = attr.entries
          .slice(0, 3)
          .map((e) => `${describeExpr(e.expr)} for 0x${e.lo.toString(16).padStart(8, '0')}–0x${e.hi.toString(16).padStart(8, '0')}`)
          .join(', ');
        const more = attr.entries.length > 3 ? `, +${attr.entries.length - 3} more` : '';
        return {
          kind: 'optimized-out',
          reason: where ? `no location at this pc; the compiler recorded ${where}${more}` : 'no location at this pc',
        };
      }
      default:
        return { kind: 'optimized-out', reason: attr.reason };
    }
  }

  /** The variable as a tree node: name, formatted value, expandable children. */
  variableNode(variable: DwarfEntry, frame: PhysicalFrame, memory: Memory): VarNode {
    const name = this.index.name(variable) ?? `<anon@${variable.offset.toString(16)}>`;
    const type = this.types.describe(this.index.typeOf(variable));
    const loc = this.location(variable, frame, memory);
    const node = this.#nodeFor(name, type, loc, frame, { read: (a, s) => memory.read(a, s) });
    if (variable.tag === DW_TAG.formal_parameter) {
      node.type = `${node.type} (param)`;
    }
    return node;
  }

  /** `name` typed as `typeEntry`, read from `address`: the cast operator. */
  castNode(name: string, typeEntry: DwarfEntry, address: number, memory: Memory): VarNode {
    const type = this.types.describe(typeEntry);
    const size = type.size || 4;
    return formatValue(name, type, memory.read(address, size), address, { read: (a, s) => memory.read(a, s) });
  }

  /** A frame standing for "right here, live registers": for evaluating outside the call stack. */
  liveFrame(pc: number, regs: ArrayLike<number>): PhysicalFrame {
    return { pc, lookupPc: pc, regs: Array.from(regs), fn: this.functionAt(pc), exact: true };
  }

  #nodeFor(name: string, type: TypeDesc, loc: Location, frame: PhysicalFrame, reader: ValueReader): VarNode {
    const size = type.size || 4;
    switch (loc.kind) {
      case 'memory':
        return formatValue(name, type, reader.read(loc.address, size), loc.address, reader);
      case 'register': {
        const v = frame.regs[loc.reg];
        if (v === undefined) {
          return { name, value: `<r${loc.reg} not recoverable in this frame>`, type: type.name };
        }
        if (size > 4) {
          // A wide value in one 32-bit register: showing the low half would look valid and be wrong.
          return { name, value: `<${size}-byte value in r${loc.reg} only; upper bytes unknown>`, type: type.name };
        }
        const node = formatValue(name, type, le32(v).subarray(0, size), undefined, reader);
        node.type = `${type.name} @r${loc.reg}`;
        return node;
      }
      case 'value': {
        if (size > 4) {
          return { name, value: `<${size}-byte computed value; only 32 bits known>`, type: type.name };
        }
        const node = formatValue(name, type, le32(loc.value).subarray(0, size), undefined, reader);
        node.type = `${type.name} (computed)`;
        return node;
      }
      case 'implicit':
        return formatValue(name, type, loc.bytes, undefined, reader);
      case 'composite': {
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const piece of loc.pieces) {
          const n = piece.size || size - at;
          let src: Uint8Array | null = null;
          if (piece.loc.kind === 'memory') {
            src = reader.read(piece.loc.address, n);
          } else if (piece.loc.kind === 'register') {
            const v = frame.regs[piece.loc.reg];
            src = v === undefined ? null : le32(v);
          } else if (piece.loc.kind === 'value') {
            src = le32(piece.loc.value);
          } else if (piece.loc.kind === 'implicit') {
            src = piece.loc.bytes;
          }
          if (!src || src.length < n) {
            return { name, value: `<partially optimized out: ${piece.loc.kind}>`, type: type.name };
          }
          bytes.set(src.subarray(0, n), at);
          at += n;
          if (at >= size) {
            break;
          }
        }
        const node = formatValue(name, type, bytes, undefined, reader);
        node.type = `${type.name} (pieces)`;
        return node;
      }
      default:
        return { name, value: `<optimized out: ${loc.reason}>`, type: type.name };
    }
  }

  // ─── frames ────────────────────────────────────────────────────────

  /**
   * Physical frames from the live registers outward: call-frame information where
   * the ELF has it; otherwise a single LR guess for frame 1, flagged `exact: false`.
   * `isCode` says whether a return address is worth following (mapped, named).
   */
  physicalFrames(pc: number, liveRegs: ArrayLike<number>, memory: Memory, isCode: (a: number) => boolean, maxDepth = 32): PhysicalFrame[] {
    const regs: Array<number | undefined> = Array.from(liveRegs);
    const frames: PhysicalFrame[] = [{ pc, lookupPc: pc, regs, fn: this.functionAt(pc), exact: true }];
    const readWord = (address: number): number | undefined => {
      const b = memory.read(address, 4);
      return b && b.length === 4 ? (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0 : undefined;
    };
    const seen = new Set<string>();
    for (let depth = 0; depth < maxDepth; depth++) {
      const top = frames[frames.length - 1]!;
      const result = this.frames.unwind(top.lookupPc, top.regs, readWord);
      if (!result) {
        if (depth === 0) {
          const lr = (Number(liveRegs[14]) & ~1) >>> 0;
          if (isCode(lr) && lr !== pc) {
            const lookupPc = (lr - 2) >>> 0;
            frames.push({
              pc: lr,
              lookupPc,
              regs: [...regs.slice(0, 13), undefined, undefined, lr],
              fn: this.functionAt(lookupPc),
              exact: false,
            });
          }
        }
        break;
      }
      const ra = (result.returnAddress & ~1) >>> 0;
      if (ra === 0 || !isCode(ra)) {
        break;
      }
      const key = `${ra}:${result.cfa}`;
      if (seen.has(key)) {
        break;
      }
      seen.add(key);
      const lookupPc = (ra - 2) >>> 0;
      result.regs[15] = ra;
      frames.push({ pc: ra, lookupPc, regs: result.regs, fn: this.functionAt(lookupPc), exact: true });
    }
    return frames;
  }

  /** Expand each physical frame into its inlined layers, innermost first. */
  virtualFrames(physical: PhysicalFrame[], fallbackName: (pc: number) => string): VirtualFrame[] {
    const out: VirtualFrame[] = [];
    for (const pf of physical) {
      if (!pf.fn) {
        out.push({ physical: pf, scope: null, name: fallbackName(pf.pc), location: { pc: pf.pc }, inlined: false });
        continue;
      }
      const layers = [...this.inlineChain(pf.fn, pf.lookupPc)].reverse(); // innermost first
      layers.push(pf.fn);
      for (let i = 0; i < layers.length; i++) {
        const scope = layers[i]!;
        const inner = i > 0 ? layers[i - 1]! : null;
        const name = this.index.name(scope) ?? fallbackName(pf.pc);
        const location: VirtualFrame['location'] = inner ? (this.callSite(inner) ?? { pc: pf.pc }) : { pc: pf.pc };
        out.push({ physical: pf, scope, name, location, inlined: scope.tag === DW_TAG.inlined_subroutine });
      }
    }
    return out;
  }
}

function le32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}
