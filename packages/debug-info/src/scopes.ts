/**
 * DwarfScopes — what a source-level debugger asks of the DWARF beyond lines and
 * types: which function and inlined calls contain a PC, what variables are visible
 * there and where they live right now, the frame base and CFA, how to unwind to
 * the caller, and how to show a value of any type.
 *
 * Everything that reads the machine goes through {@link Memory}; this module never
 * touches an emulator directly, so it serves a live session, a snapshot, or a test.
 */
import { type LineRow, normalizePath } from './debug-line.js';
import { DW_AT, DW_TAG } from './dwarf/constants.js';
import { type DwarfSections, EntryIndex, type UnitInfo, attrAddress, attrFlag, attrNum } from './dwarf/entries.js';
import { type EvalContext, type Location, evaluate } from './dwarf/expr.js';
import { FrameTable } from './dwarf/frame.js';
import { type Range, describeExpr, entryRanges, isLinkedRange, locationAt, rangesContain } from './dwarf/lists.js';
import {
  type TypeDesc,
  TypeResolver,
  type ValueReader,
  type VarNode,
  formatValue,
  le32,
  toInt,
} from './dwarf/values.js';
import type { ElfFile } from './elf.js';
import { hex8 } from './reader.js';
import type { DwarfEntry } from './types.js';
import { type MachineFacts, type UnwoundFrame, type WalkOptions } from './unwind/types.js';
import { unwindStack } from './unwind/walker.js';

/** What the machine answers with: `size` bytes at `address`, or null when any byte is unreadable. */
export type Memory = ValueReader;

/** An enumerator constant, with the enumeration type that declares it. */
export interface Enumerator {
  value: number;
  type: DwarfEntry;
}

/** A frame the unwinder produced, with the DWARF subprogram executing in it. */
export interface PhysicalFrame extends UnwoundFrame {
  fn: DwarfEntry | null;
}

/** The machine's stack as {@link DwarfScopes.physicalFrames} reports it. */
export interface PhysicalStack {
  frames: PhysicalFrame[];
  /** why the walk stopped where it did */
  end: string;
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
  #callSites: Map<string, number[]> | null = null;
  #enumerators: Map<string, Enumerator> | null = null;
  #inlineEntries: Map<string, number[]> | null = null;

  constructor(roots: DwarfEntry[], elf: ElfFile, lineRows: readonly LineRow[]) {
    this.index = new EntryIndex(roots);
    this.types = new TypeResolver(this.index);
    this.#sections = {
      littleEndian: elf.littleEndian,
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
        if (isLinkedRange(lo)) {
          this.#functions.push({ lo, hi, entry });
        }
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
    return unit.root.children.filter(
      (d) => d.tag === DW_TAG.variable && !attrFlag(d, DW_AT.declaration) && d.attrs.has(DW_AT.location),
    );
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
            !attrFlag(d, DW_AT.declaration) &&
            (d.tag === DW_TAG.typedef || d.tag === DW_TAG.base_type || d.attrs.has(DW_AT.byte_size));
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

  /**
   * An enumerator by its C name (`MODE_PLAY`), from any enum of any unit, nested
   * ones included; the first definition wins. The value is in the enum's storage
   * domain, so a negative enumerator reads as negative whichever form encoded it.
   */
  enumeratorByName(name: string): Enumerator | null {
    if (!this.#enumerators) {
      const found = new Map<string, Enumerator>();
      const visit = (entry: DwarfEntry): void => {
        if (entry.tag === DW_TAG.enumeration_type) {
          const desc = this.types.describe(entry);
          for (const [value, n] of desc.enumerators ?? []) {
            if (!found.has(n)) {
              found.set(n, { value, type: entry });
            }
          }
        }
        for (const ch of entry.children) {
          visit(ch);
        }
      };
      for (const u of this.units) {
        visit(u.root);
      }
      this.#enumerators = found;
    }
    return this.#enumerators.get(name) ?? null;
  }

  /**
   * Every address where a call to `name` is entered inlined. An optimizer folds a
   * small function into its callers and emits no symbol for it; these entries are
   * where a breakpoint on its name goes.
   */
  inlineEntriesByName(name: string): number[] {
    if (!this.#inlineEntries) {
      const entries = new Map<string, number[]>();
      const visit = (entry: DwarfEntry): void => {
        if (entry.tag === DW_TAG.inlined_subroutine) {
          const n = this.index.name(entry);
          const pc = this.entryPc(entry);
          if (n && pc !== undefined) {
            const list = entries.get(n);
            if (!list) {
              entries.set(n, [pc]);
            } else if (!list.includes(pc)) {
              list.push(pc);
            }
          }
        }
        for (const ch of entry.children) {
          visit(ch);
        }
      };
      for (const f of this.#functions) {
        visit(f.entry);
      }
      this.#inlineEntries = entries;
    }
    return this.#inlineEntries.get(name) ?? [];
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

  /**
   * The address an inlined call is entered at: `DW_AT_entry_pc` when the compiler
   * states it, else the lowest range start. The two differ when the optimizer
   * hoists part of the callee (a load of a constant address) above the call.
   */
  entryPc(inlined: DwarfEntry): number | undefined {
    const stated = attrAddress(inlined, DW_AT.entry_pc, this.index.unit(inlined), this.#sections);
    if (stated !== undefined) {
      return stated;
    }
    const r = this.ranges(inlined);
    return r.length > 0 ? Math.min(...r.map(([lo]) => lo)) : undefined;
  }

  /**
   * Entry addresses of the calls inlined at `file:line`. A line that only calls an
   * inlined function has no line-table row of its own (its code carries the
   * callee's lines), so this is where a breakpoint on that line goes.
   */
  inlineCallSitesAt(file: string, line: number): number[] {
    if (!this.#callSites) {
      const sites = new Map<string, number[]>();
      const visit = (entry: DwarfEntry): void => {
        if (entry.tag === DW_TAG.inlined_subroutine) {
          const site = this.callSite(entry);
          const pc = this.entryPc(entry);
          if (site && pc !== undefined) {
            const key = `${normalizePath(site.file)}:${site.line}`;
            const list = sites.get(key);
            if (!list) {
              sites.set(key, [pc]);
            } else if (!list.includes(pc)) {
              list.push(pc);
            }
          }
        }
        for (const ch of entry.children) {
          visit(ch);
        }
      };
      for (const f of this.#functions) {
        visit(f.entry);
      }
      this.#callSites = sites;
    }
    return this.#callSites.get(`${normalizePath(file)}:${line}`) ?? [];
  }

  /** Every line of `file` from which a call was inlined, ascending. */
  inlineCallSiteLines(file: string): number[] {
    this.inlineCallSitesAt(file, 0); // builds the call-site map
    const prefix = `${normalizePath(file)}:`;
    const lines: number[] = [];
    for (const key of this.#callSites!.keys()) {
      if (key.startsWith(prefix)) {
        lines.push(Number(key.slice(prefix.length)));
      }
    }
    return lines.sort((a, b) => a - b);
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
        return !b || b.length < size ? undefined : toInt(b, false) >>> 0;
      },
      // A frame the walk unwound from carries the CFA that step established;
      // call-frame information answers for the outermost frame, which nothing was
      // unwound from.
      cfa: () => frame.cfa ?? this.frames.cfa(frame.lookupPc, frame.regs),
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
          .map((e) => `${describeExpr(e.expr)} for 0x${hex8(e.lo)}–0x${hex8(e.hi)}`)
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
    const type = this.types.describeDeclared(variable);
    const loc = this.location(variable, frame, memory);
    const node = this.#nodeFor(name, type, loc, frame, memory);
    if (variable.tag === DW_TAG.formal_parameter) {
      node.type = `${node.type} (param)`;
    }
    return node;
  }

  /**
   * `name` typed as `typeEntry`, read from `address`: a type imposed on storage from
   * outside, as a declaration (`extern`) joined to storage the linker placed is —
   * pass the declaration as `declaredBy` so an unsized array stays unsized.
   */
  castNode(name: string, typeEntry: DwarfEntry, address: number, memory: Memory, declaredBy?: DwarfEntry): VarNode {
    const type = declaredBy ? this.types.describeDeclared(declaredBy) : this.types.describe(typeEntry);
    const size = type.size || 4;
    return formatValue(name, type, memory.read(address, size), address, memory);
  }

  /** A frame standing for "right here, live registers": for evaluating outside the call stack. */
  liveFrame(pc: number, regs: ArrayLike<number>): PhysicalFrame {
    return {
      pc,
      lookupPc: pc,
      regs: Array.from(regs),
      fn: this.functionAt(pc),
      method: 'live',
      cfa: undefined,
      doubt: null,
    };
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
   * Physical frames from the live registers outward, as deep as the machine's
   * stack goes, each saying which layer of {@link unwindStack} recovered it — and
   * why the walk ended where it did, so a short stack is a statement rather than
   * a silence.
   */
  physicalFrames(pc: number, liveRegs: ArrayLike<number>, facts: MachineFacts, options?: WalkOptions): PhysicalStack {
    const walk = unwindStack(pc, liveRegs, facts, this.frames, options);
    return {
      frames: walk.frames.map((f) => ({ ...f, fn: this.functionAt(f.lookupPc) })),
      end: walk.end,
    };
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
