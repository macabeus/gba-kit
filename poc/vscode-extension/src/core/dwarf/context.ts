/**
 * DwarfContext — what the debugger asks of the DWARF: which function and inlined
 * calls contain a pc, what variables are in scope there and where they live, the
 * frame base and CFA, and how to unwind to the caller.
 */
import { ElfFile } from '@gba-kit/debug-info';

import { type EvalContext, type Location, evaluate } from './expr.js';
import { FrameTable } from './frame.js';
import {
  AT,
  type Die,
  DieIndex,
  type DwarfSections,
  type Range,
  TAG,
  type Unit,
  attrFlag,
  attrNum,
  describeExpr,
  dieRanges,
  locationAt,
  parseUnits,
  rangesContain,
} from './parse.js';
import { type TypeDesc, TypeResolver, type ValueReader, type VarNode, formatValue } from './types.js';

export interface Registers {
  /** r0..r15; undefined when a caller frame could not recover it */
  get(n: number): number | undefined;
}

export interface Memory {
  read(address: number, size: number): Uint8Array | null;
}

export interface PhysicalFrame {
  /** where execution is (frame 0) or will resume (callers) */
  pc: number;
  /** an address inside the call instruction, for line/scope lookups of callers */
  lookupPc: number;
  regs: Array<number | undefined>;
  fn: Die | null;
  /** from CFI, as opposed to the LR guess */
  exact: boolean;
}

export interface VirtualFrame {
  physical: PhysicalFrame;
  /** the subprogram or inlined_subroutine DIE this frame executes */
  scope: Die | null;
  name: string;
  /** where this frame is: pc for the innermost, the call site for the outer inlined layers */
  location: { pc: number } | { file: string; line: number };
  inlined: boolean;
}

export class DwarfContext {
  readonly index: DieIndex;
  readonly types: TypeResolver;
  readonly frames: FrameTable;
  readonly #ranges = new Map<Die, Range[]>();
  /** every subprogram with code, sorted by low address */
  readonly #functions: Array<{ lo: number; hi: number; die: Die }> = [];
  readonly #fileNames = new Map<Unit, Map<number, string>>();
  #globalsByName: Map<string, Die> | null = null;
  #declarationsByName: Map<string, Die> | null = null;
  #typesByName: Map<string, Die> | null = null;

  private constructor(
    readonly sections: DwarfSections,
    readonly units: Unit[],
  ) {
    this.index = new DieIndex(units);
    this.types = new TypeResolver(this.index);
    this.frames = new FrameTable(sections.frame);
    for (const u of units) {
      this.#collectFunctions(u.root);
    }
    this.#functions.sort((a, b) => a.lo - b.lo);
  }

  static fromElf(bytes: Uint8Array): DwarfContext | null {
    const elf = ElfFile.parse(bytes);
    const info = elf.sectionData('.debug_info');
    const abbrev = elf.sectionData('.debug_abbrev');
    if (!info || !abbrev) {
      return null;
    }
    const sections: DwarfSections = {
      info,
      abbrev,
      str: elf.sectionData('.debug_str'),
      lineStr: elf.sectionData('.debug_line_str'),
      strOffsets: elf.sectionData('.debug_str_offsets'),
      addr: elf.sectionData('.debug_addr'),
      loclists: elf.sectionData('.debug_loclists'),
      loc: elf.sectionData('.debug_loc'),
      rnglists: elf.sectionData('.debug_rnglists'),
      ranges: elf.sectionData('.debug_ranges'),
      frame: elf.sectionData('.debug_frame'),
    };
    return new DwarfContext(sections, parseUnits(sections));
  }

  ranges(die: Die): Range[] {
    let r = this.#ranges.get(die);
    if (!r) {
      r = dieRanges(die, this.sections);
      this.#ranges.set(die, r);
    }
    return r;
  }

  #collectFunctions(die: Die): void {
    if (die.tag === TAG.subprogram) {
      for (const [lo, hi] of this.ranges(die)) {
        if (hi > lo) {
          this.#functions.push({ lo, hi, die });
        }
      }
    }
    for (const ch of die.children) {
      if (ch.tag !== TAG.subprogram || die.tag === TAG.compile_unit || die.tag === TAG.partial_unit) {
        this.#collectFunctions(ch);
      } else {
        this.#collectFunctions(ch); // nested functions are rare in C but harmless
      }
    }
  }

  /** The subprogram DIE whose code contains `pc`. */
  functionAt(pc: number): Die | null {
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
        return f.die;
      }
    }
    return null;
  }

  unitOf(die: Die): Unit {
    return die.unit;
  }

  name(die: Die): string | undefined {
    return this.index.name(die);
  }

  /** Inlined subroutines containing `pc` inside `fn`, outermost first. */
  inlineChain(fn: Die, pc: number): Die[] {
    const chain: Die[] = [];
    const walk = (scope: Die): void => {
      for (const ch of scope.children) {
        if (ch.tag === TAG.inlined_subroutine) {
          if (rangesContain(this.ranges(ch), pc)) {
            chain.push(ch);
            walk(ch);
            return;
          }
        } else if (ch.tag === TAG.lexical_block) {
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
   * Variables and parameters visible in `scope` at `pc`: the scope's own, plus
   * those of nested lexical blocks that contain `pc`. Nested inlined subroutines
   * are separate frames and are skipped.
   */
  scopeVariables(scope: Die, pc: number): Die[] {
    const out: Die[] = [];
    const walk = (s: Die): void => {
      for (const ch of s.children) {
        if (ch.tag === TAG.variable || ch.tag === TAG.formal_parameter) {
          out.push(ch);
        } else if (ch.tag === TAG.lexical_block) {
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

  /** Top-level variables of a CU that have an address (definitions, not declarations). */
  globals(unit: Unit): Die[] {
    return unit.root.children.filter(
      (d) => d.tag === TAG.variable && !attrFlag(d, AT.declaration) && d.attrs.has(AT.location),
    );
  }

  /** A global variable definition by name, from any compilation unit. */
  globalByName(name: string): Die | null {
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
   * A global *declaration* by name (`extern struct Foo gBar;` from a header): no
   * location, but a type. A decomp keeps most storage in assembly, so this plus the
   * symbol table's address is how such a global gets a shape.
   */
  declarationByName(name: string): Die | null {
    if (!this.#declarationsByName) {
      this.#declarationsByName = new Map();
      for (const u of this.units) {
        for (const d of u.root.children) {
          if (d.tag !== TAG.variable || d.attrs.has(AT.location)) {
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
   * unit. Definitions win over declarations, and the first complete one is kept.
   */
  typeByName(name: string): Die | null {
    if (!this.#typesByName) {
      this.#typesByName = new Map();
      const keyOf = (d: Die): string | null => {
        const n = this.index.name(d);
        if (!n) {
          return null;
        }
        switch (d.tag) {
          case TAG.structure_type:
            return `struct ${n}`;
          case TAG.union_type:
            return `union ${n}`;
          case TAG.enumeration_type:
            return `enum ${n}`;
          case TAG.typedef:
          case TAG.base_type:
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
            !attrFlag(d, AT.declaration) &&
            (d.tag === TAG.typedef || d.tag === TAG.base_type || d.attrs.has(AT.byte_size));
          const existing = this.#typesByName.get(key);
          if (!existing || (complete && attrFlag(existing, AT.declaration))) {
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

  /** `name` typed as `typeDie`, read from `address`: the cast operator. */
  castNode(name: string, typeDie: Die, address: number, memory: Memory): VarNode {
    const type = this.types.describe(typeDie);
    const size = type.size || 4;
    return formatValue(name, type, memory.read(address, size), address, { read: (a, s) => memory.read(a, s) });
  }

  /** A frame standing for "right here, live registers": for evaluating outside the call stack. */
  liveFrame(pc: number, regs: Uint32Array): PhysicalFrame {
    return { pc, lookupPc: pc, regs: Array.from(regs), fn: this.functionAt(pc), exact: true };
  }

  unitContaining(pc: number): Unit | null {
    const fn = this.functionAt(pc);
    if (fn) {
      return fn.unit;
    }
    for (const u of this.units) {
      if (rangesContain(this.ranges(u.root), pc)) {
        return u;
      }
    }
    return null;
  }

  /** Resolve a DW_AT_call_file index through the CU's line-table file list. */
  callSite(
    inlined: Die,
    lineRows: ReadonlyArray<{ address: number; fileIndex: number; file: string; endSequence: boolean }>,
  ): { file: string; line: number } | null {
    const fileIndex = attrNum(inlined, AT.call_file);
    const line = attrNum(inlined, AT.call_line);
    if (fileIndex === undefined || line === undefined) {
      return null;
    }
    const unit = inlined.unit;
    let names = this.#fileNames.get(unit);
    if (!names) {
      names = new Map();
      const ranges = this.ranges(unit.root);
      for (const row of lineRows) {
        // An end_sequence row's address is the *end* of the previous CU's code, which
        // can be the first byte of this one; it carries the other CU's file numbering.
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
          const fb = locationAt(fn, AT.frame_base, frame.lookupPc, this.sections);
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
  location(variable: Die, frame: PhysicalFrame, memory: Memory): Location {
    const attr = locationAt(variable, AT.location, frame.lookupPc, this.sections);
    switch (attr.kind) {
      case 'expr':
        return evaluate(attr.expr, this.#evalContext(frame, memory));
      case 'none': {
        const cv = variable.attrs.get(AT.const_value);
        if (cv && typeof cv.value === 'number') {
          return { kind: 'value', value: cv.value >>> 0 };
        }
        if (cv && cv.value instanceof Uint8Array) {
          return { kind: 'implicit', bytes: cv.value };
        }
        return { kind: 'optimized-out', reason: 'no location' };
      }
      case 'not-here': {
        // Say where the compiler *did* keep it: the difference between "gone" and
        // "GCC split it into registers it never described" is visible in the ranges.
        const where = attr.entries
          .slice(0, 3)
          .map(
            (e) =>
              `${describeExpr(e.expr)} for 0x${e.lo.toString(16).padStart(8, '0')}–0x${e.hi.toString(16).padStart(8, '0')}`,
          )
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
  variableNode(variable: Die, frame: PhysicalFrame, memory: Memory): VarNode {
    const name = this.index.name(variable) ?? `<anon@${variable.offset.toString(16)}>`;
    const type = this.types.describe(this.index.typeOf(variable));
    const loc = this.location(variable, frame, memory);
    const reader: ValueReader = { read: (a, s) => memory.read(a, s) };
    const node = this.#nodeFor(name, type, loc, frame, reader);
    if (variable.tag === TAG.formal_parameter) {
      node.type = `${node.type} (param)`;
    }
    return node;
  }

  #nodeFor(name: string, type: TypeDesc, loc: Location, frame: PhysicalFrame, reader: ValueReader): VarNode {
    const size = type.size || (type.kind === 'pointer' ? 4 : 4);
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
          if (!src) {
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
   * Physical frames from the live registers outward. CFI when the ELF has it; a
   * one-level LR guess otherwise, flagged as such.
   */
  physicalFrames(
    pc: number,
    liveRegs: Uint32Array,
    memory: Memory,
    isCode: (a: number) => boolean,
    maxDepth = 24,
  ): PhysicalFrame[] {
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
          const lr = (liveRegs[14]! & ~1) >>> 0;
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
  virtualFrames(
    physical: PhysicalFrame[],
    lineRows: ReadonlyArray<{ address: number; fileIndex: number; file: string; endSequence: boolean }>,
    fallbackName: (pc: number) => string,
  ): VirtualFrame[] {
    const out: VirtualFrame[] = [];
    for (const pf of physical) {
      if (!pf.fn) {
        out.push({ physical: pf, scope: null, name: fallbackName(pf.pc), location: { pc: pf.pc }, inlined: false });
        continue;
      }
      const chain = this.inlineChain(pf.fn, pf.lookupPc);
      const layers: Die[] = [...chain].reverse(); // innermost first
      layers.push(pf.fn);
      for (let i = 0; i < layers.length; i++) {
        const scope = layers[i]!;
        const inner = i > 0 ? layers[i - 1]! : null;
        const name = this.index.name(scope) ?? fallbackName(pf.pc);
        const location: VirtualFrame['location'] = inner
          ? (this.callSite(inner, lineRows) ?? { pc: pf.pc })
          : { pc: pf.pc };
        out.push({ physical: pf, scope, name, location, inlined: scope.tag === TAG.inlined_subroutine });
      }
    }
    return out;
  }
}

function le32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}
