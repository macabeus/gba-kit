/**
 * Everything the debugger shows about a stopped machine: the call stack (with
 * inlined layers as their own rows), scopes and variables per frame, expression
 * evaluation, register and memory views, disassembly. Reads only; the one write
 * path (`setScalar`) goes through the machine's poke.
 *
 * A name is resolved one way everywhere — the variables tree, a hover, a watch,
 * a breakpoint condition: the selected frame's locals (innermost inlined layer
 * outward), its file's globals, any unit's globals, a declaration joined to a
 * linker symbol, then enumerators. A `a.b[3].c` path walks the same typed nodes,
 * so a member reads the same in a watch as in the tree.
 */
import { disassembleArmAt, disassembleThumbAt } from '@gba-kit/arm-emulator/disassembler';
import type {
  DwarfEntry,
  Memory,
  PhysicalFrame,
  UnitInfo,
  VarNode,
  VirtualFrame,
  WritableScalar,
} from '@gba-kit/debug-info';
import { formatValue } from '@gba-kit/debug-info';

import { type ExprEnv, type ExprHints, compileExpression, formatNumber, parseU32Literal } from './expression.js';
import type { LabelStore } from './labels.js';
import { Machine, REGISTER_NAMES, isCodeAddress, regionOf } from './machine.js';
import type { Program } from './program.js';

export interface StackFrame {
  index: number;
  /** the pc for frame 0, the return address for callers */
  address: number;
  name: string;
  source: { path: string; line: number } | null;
  /** an inlined layer of the physical frame below it */
  inlined: boolean;
  /** guessed from lr rather than unwound */
  heuristic: boolean;
  virtual: VirtualFrame | null;
}

export interface Scope {
  name: string;
  kind: 'locals' | 'globals' | 'registers' | 'machine';
  nodes: VarNode[];
  expensive: boolean;
}

export interface DisassembledLine {
  address: number;
  bytes: string;
  text: string;
  size: 2 | 4;
  symbol?: string;
  label?: string;
  source?: { path: string; line: number };
  target?: number;
}

export interface EvaluateResult {
  node: VarNode;
  /** the address the expression named, present only when it names memory the user can open in a memory view */
  address?: number;
}

/** Where names resolve: a frame's registers, and its scopes innermost first. */
interface NameScope {
  physical: PhysicalFrame;
  /** the subprogram / inlined_subroutine DIEs whose variables are visible, innermost first */
  scopes: DwarfEntry[];
  unit: UnitInfo | null;
}

/** Whether a data breakpoint's address came from a DWARF variable, an ELF symbol, a literal, or a computed value. */
type AddressSource = 'literal' | 'symbol' | 'value';

const IDENT = /^[A-Za-z_]\w*$/;
const PATH = /^[A-Za-z_]\w*(\.\w+|\[\d+\])+$/;
/** `(Card*)0x0300243c`, `(struct PlayerState)gUnk_03005220`, `(u16)0x04000006`: `(T*)x` and `(T)x` both mean "the T at address x". */
const CAST = /^\(\s*((?:struct|union|enum)\s+)?([A-Za-z_]\w*)\s*\*?\s*\)\s*(.+)$/;
/** The largest read the memory tree answers in one go. */
const MAX_PEEK = 0x10000;
/** Row caps of the untyped memory views. */
const MAX_RAW_WORDS = 256;
const MAX_RAW_ROWS = 512;

export class Inspector {
  constructor(
    readonly machine: Machine,
    readonly program: Program,
    readonly labels: LabelStore,
  ) {}

  readonly memory: Memory = {
    read: (address, size) => (size > 0 && size <= MAX_PEEK ? this.machine.peek(address, size) : null),
    symbolize: (address) => this.program.symbolize(address),
  };

  /** per unit: its file-scope globals by name */
  readonly #unitGlobals = new Map<UnitInfo, Map<string, DwarfEntry>>();

  // ─── call stack ────────────────────────────────────────────────────

  /**
   * The call stack, `hiddenInline` innermost inlined layers of frame 0 removed
   * (a step-over that stopped at an inlined call shows the call site instead).
   */
  callStack(hiddenInline = 0): StackFrame[] {
    const di = this.program.debugInfo;
    const cpu = this.machine.gba.armCpu;
    const pc = this.machine.pc;
    if (!di || !this.program.sources) {
      const frames: StackFrame[] = [this.#plainFrame(0, pc, false)];
      const lr = (cpu.registers[14]! & ~1) >>> 0;
      if (lr !== pc && isCodeAddress(lr)) {
        frames.push(this.#plainFrame(1, lr, true));
      }
      return frames;
    }
    const physical = di.scopes.physicalFrames(
      pc,
      cpu.registers,
      this.memory,
      (a) => isCodeAddress(a) && this.program.isNamedCode(a),
    );
    let virtual = di.scopes.virtualFrames(physical, (a) => this.program.symbolName(a));
    if (hiddenInline > 0) {
      let drop = 0;
      while (drop < hiddenInline && virtual[drop]?.inlined && virtual[drop]?.physical === physical[0]) {
        drop++;
      }
      virtual = virtual.slice(drop);
    }
    return virtual.map((vf, i) => {
      let source: StackFrame['source'] = null;
      if ('pc' in vf.location) {
        const loc = this.program.lineAt(vf.physical.lookupPc);
        source = loc?.path ? { path: loc.path, line: loc.line } : null;
      } else {
        const local = this.program.sources!.toLocal(vf.location.file);
        source = local ? { path: local, line: vf.location.line } : null;
      }
      return {
        index: i,
        address: vf.physical.pc,
        name: vf.inlined ? `${vf.name} (inlined)` : vf.name,
        source,
        inlined: vf.inlined,
        heuristic: !vf.physical.exact,
        virtual: vf,
      };
    });
  }

  #plainFrame(index: number, address: number, heuristic: boolean): StackFrame {
    const loc = this.program.lineAt(address);
    return {
      index,
      address,
      name: this.program.symbolName(address) + (heuristic ? ' (from lr, unverified)' : ''),
      source: loc?.path ? { path: loc.path, line: loc.line } : null,
      inlined: false,
      heuristic,
      virtual: null,
    };
  }

  // ─── scopes and variables ──────────────────────────────────────────

  scopes(frame: StackFrame | undefined): Scope[] {
    const out: Scope[] = [];
    const di = this.program.debugInfo;
    if (frame?.virtual && di) {
      const vf = frame.virtual;
      const locals: VarNode[] = vf.scope
        ? di.scopes
            .scopeVariables(vf.scope, vf.physical.lookupPc)
            .map((v) => di.scopes.variableNode(v, vf.physical, this.memory))
        : [];
      out.push({ name: 'Locals', kind: 'locals', nodes: locals, expensive: false });
      const unit = vf.scope ? di.scopes.index.unit(vf.scope) : di.scopes.unitContaining(vf.physical.lookupPc);
      const globals = unit
        ? di.scopes.globals(unit).map((g) => di.scopes.variableNode(g, vf.physical, this.memory))
        : [];
      globals.sort((a, b) => a.name.localeCompare(b.name));
      out.push({ name: 'Globals (this file)', kind: 'globals', nodes: globals, expensive: true });
    }
    out.push({ name: 'Registers', kind: 'registers', nodes: this.registerNodes(frame), expensive: false });
    out.push({ name: 'Machine', kind: 'machine', nodes: this.machineNodes(), expensive: true });
    return out;
  }

  registerNodes(frame: StackFrame | undefined): VarNode[] {
    const regs = this.#registersOf(frame);
    const nodes: VarNode[] = REGISTER_NAMES.map((name, i) => this.#registerNode(name, i, regs));
    nodes.push(this.#cpsrNode());
    return nodes;
  }

  #registersOf(frame: StackFrame | undefined): Array<number | undefined> {
    return frame?.virtual ? frame.virtual.physical.regs : Array.from(this.machine.registers);
  }

  /** One register as a node: the word, what it points at, and an address for the memory view (not for pc: that is code). */
  #registerNode(name: string, index: number, regs: Array<number | undefined>): VarNode {
    const v = regs[index];
    if (v === undefined) {
      return { name, value: '<not recovered in this frame>', type: 'u32' };
    }
    const node: VarNode = { name, value: `0x${hex8(v)}`, type: 'u32', scalar: { value: v >>> 0, signed: false } };
    if (regionOf(v) !== null && index !== 15) {
      node.address = v;
    }
    const sym = index === 15 || index === 14 ? this.program.symbolize(v & ~1) : null;
    if (sym) {
      node.value += `  ${sym}`;
    }
    return node;
  }

  #cpsrNode(): VarNode {
    return { name: 'cpsr', value: `0x${hex8(this.machine.cpsr)}  ${this.cpsrDescription()}`, type: 'u32' };
  }

  machineNodes(): VarNode[] {
    const gba = this.machine.gba;
    const fn = this.program.functionRange(this.machine.pc);
    return [
      { name: 'frame', value: String(this.machine.frame), type: 'frames' },
      { name: 'scanline', value: String(this.machine.scanline), type: 'line' },
      { name: 'cycle', value: String(this.machine.cycle), type: 'instruction count' },
      { name: 'function', value: fn ? fn.name : '?', type: 'symbol' },
      { name: 'halted', value: String(this.machine.halted), type: 'bool' },
      { name: 'IME', value: String(gba.interrupts.ime & 1), type: 'u16', address: 0x04000208 },
      { name: 'IE', value: `0x${gba.interrupts.ie.toString(16).padStart(4, '0')}`, type: 'u16', address: 0x04000200 },
      { name: 'IF', value: `0x${gba.interrupts.if_.toString(16).padStart(4, '0')}`, type: 'u16', address: 0x04000202 },
      {
        name: 'DISPCNT',
        value: `0x${(this.machine.peekUnsigned(0x04000000, 2) ?? 0).toString(16).padStart(4, '0')}`,
        type: 'u16',
        address: 0x04000000,
      },
      { name: 'buttons', value: `0x${this.machine.buttons.toString(16).padStart(3, '0')}`, type: 'mask' },
    ];
  }

  cpsrDescription(): string {
    const cpu = this.machine.gba.armCpu;
    const flags = [cpu.getN() ? 'N' : '-', cpu.getZ() ? 'Z' : '-', cpu.getC() ? 'C' : '-', cpu.getV() ? 'V' : '-'].join(
      '',
    );
    const modes: Record<number, string> = {
      0x10: 'usr',
      0x11: 'fiq',
      0x12: 'irq',
      0x13: 'svc',
      0x17: 'abt',
      0x1b: 'und',
      0x1f: 'sys',
    };
    return `${flags} ${cpu.getT() ? 'Thumb' : 'ARM'} ${modes[cpu.getMode()] ?? 'mode?'}${cpu.irqDisabled() ? ' I' : ''}`;
  }

  // ─── names ─────────────────────────────────────────────────────────

  /** The scopes of `frames[frameIndex]`: its own inlined layers outward, within its physical frame. */
  #scopeOfFrame(frames: StackFrame[], frameIndex: number): NameScope | null {
    const di = this.program.debugInfo;
    const frame = frames[frameIndex];
    if (!di || !frame?.virtual) {
      return null;
    }
    const physical = frame.virtual.physical;
    const scopes: DwarfEntry[] = [];
    for (let i = frameIndex; i < frames.length; i++) {
      const vf = frames[i]!.virtual;
      if (!vf || vf.physical !== physical) {
        break;
      }
      if (vf.scope) {
        scopes.push(vf.scope);
      }
    }
    const unit = frame.virtual.scope
      ? di.scopes.index.unit(frame.virtual.scope)
      : di.scopes.unitContaining(physical.lookupPc);
    return { physical, scopes, unit };
  }

  /** The scopes at `pc` with the live registers: what a breakpoint condition sees without unwinding the stack. */
  #scopeAt(pc: number): NameScope | null {
    const di = this.program.debugInfo;
    if (!di) {
      return null;
    }
    const physical = di.scopes.liveFrame(pc, this.machine.registers);
    const fn = physical.fn;
    const scopes = fn ? [...di.scopes.inlineChain(fn, pc).reverse(), fn] : [];
    return { physical, scopes, unit: fn ? di.scopes.index.unit(fn) : di.scopes.unitContaining(pc) };
  }

  #globalsOf(unit: UnitInfo): Map<string, DwarfEntry> {
    const di = this.program.debugInfo!;
    let byName = this.#unitGlobals.get(unit);
    if (!byName) {
      byName = new Map();
      for (const g of di.scopes.globals(unit)) {
        const n = di.scopes.name(g);
        if (n && !byName.has(n)) {
          byName.set(n, g);
        }
      }
      this.#unitGlobals.set(unit, byName);
    }
    return byName;
  }

  /**
   * The variable `name` denotes: a local or parameter of the scope (innermost
   * inlined layer outward), a global of its file, a global of any unit, or a
   * declaration (`extern`) joined to the linker symbol of the same name.
   */
  #rootNode(name: string, scope: NameScope | null): VarNode | null {
    const di = this.program.debugInfo;
    if (!di) {
      return null;
    }
    if (scope) {
      for (const s of scope.scopes) {
        for (const v of di.scopes.scopeVariables(s, scope.physical.lookupPc)) {
          if (di.scopes.name(v) === name) {
            return di.scopes.variableNode(v, scope.physical, this.memory);
          }
        }
      }
      const fileGlobal = scope.unit ? this.#globalsOf(scope.unit).get(name) : undefined;
      if (fileGlobal) {
        return di.scopes.variableNode(fileGlobal, scope.physical, this.memory);
      }
    }
    const physical = scope?.physical ?? di.scopes.liveFrame(this.machine.pc, this.machine.registers);
    const global = di.scopes.globalByName(name);
    if (global) {
      return di.scopes.variableNode(global, physical, this.memory);
    }
    const decl = di.scopes.declarationByName(name);
    const address = this.program.globalAddress(name);
    const typeEntry = decl ? di.scopes.index.typeOf(decl) : undefined;
    if (decl && typeEntry && address !== null) {
      const node = di.scopes.castNode(name, typeEntry, address, this.memory, decl);
      node.type = `${node.type} (declared in a header, placed by the linker)`;
      return node;
    }
    return null;
  }

  /** An enumerator constant as a node, or null. */
  #enumeratorNode(name: string): VarNode | null {
    const di = this.program.debugInfo;
    const e = di?.scopes.enumeratorByName(name);
    if (!di || !e) {
      return null;
    }
    const type = di.scopes.types.describe(e.type);
    return {
      name,
      value: `${name} (${e.value})`,
      type: `${type.name} (constant)`,
      scalar: { value: e.value, signed: type.signed === true },
    };
  }

  /**
   * `root.member[3].field` walked through the typed tree, so a member reads exactly
   * as the variables view shows it. Null when the root is unknown; throws when the
   * root is known and the path is not.
   */
  #pathNode(path: string, scope: NameScope | null): VarNode | null {
    const segments: string[] = [];
    const re = /\.(\w+)|\[(\d+)\]/g;
    const rootEnd = path.search(/[.[]/);
    const root = rootEnd < 0 ? path : path.slice(0, rootEnd);
    for (const m of path.slice(rootEnd < 0 ? path.length : rootEnd).matchAll(re)) {
      segments.push(m[1] ?? `[${m[2]}]`);
    }
    let node = this.#rootNode(root, scope);
    if (!node) {
      return null;
    }
    let sofar = root;
    for (const seg of segments) {
      const index = /^\[(\d+)\]$/.exec(seg);
      const current: VarNode = node;
      let next: VarNode | null | undefined;
      if (index && current.element) {
        next = current.element(Number(index[1]));
        if (!next) {
          throw new Error(`index ${index[1]} is out of range for '${sofar}' (${current.type})`);
        }
      } else {
        const kids: VarNode[] | undefined = current.children?.();
        if (!kids) {
          throw new Error(`'${sofar}' (${current.type}) has no members`);
        }
        next = kids.find((k) => k.name === seg);
        if (!next) {
          throw new Error(`'${sofar}' (${current.type}) has no member '${seg}'`);
        }
      }
      node = next;
      sofar += index ? seg : `.${seg}`;
    }
    return node;
  }

  /** A typed node for a bare name or a member path, resolved in `scope`; null when unknown. */
  #namedNode(text: string, scope: NameScope | null): VarNode | null {
    if (IDENT.test(text)) {
      return this.#rootNode(text, scope) ?? this.#enumeratorNode(text);
    }
    return PATH.test(text) ? this.#pathNode(text, scope) : null;
  }

  // ─── evaluation ────────────────────────────────────────────────────

  /**
   * A watch / hover / REPL expression. Typed answers first (a variable, a cast, a
   * member path, an enumerator, a register, an address, a symbol), then the numeric
   * expression grammar. Throws with a message the user can act on.
   */
  evaluate(expression: string, frames: StackFrame[], frameIndex = 0): EvaluateResult {
    const expr = expression.trim();
    if (!expr) {
      throw new Error('empty expression');
    }
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || (frames.length > 0 && frameIndex >= frames.length)) {
      throw new Error(`no frame ${frameIndex} (the stack has ${frames.length})`);
    }
    const frame = frames[frameIndex];
    const di = this.program.debugInfo;
    const scope = this.#scopeOfFrame(frames, frameIndex);

    // 1. A variable of the selected frame, a global, a linker-placed declaration, an enumerator.
    if (IDENT.test(expr)) {
      const node = this.#namedNode(expr, scope);
      if (node) {
        return { node, address: node.address };
      }
    }
    // 2. A cast: the T at the operand's address.
    const cast = CAST.exec(expr);
    if (cast && di) {
      const typeName = `${cast[1] ?? ''}${cast[2]}`;
      const typeEntry = di.scopes.typeByName(typeName);
      if (!typeEntry) {
        throw new Error(`unknown type '${typeName}' (the ELF has no DWARF for it)`);
      }
      const operand = cast[3]!.trim();
      const { address, from } = this.#addressOf(operand, scope);
      if (from === 'value' && regionOf(address) === null) {
        throw new Error(
          `'${operand}' evaluates to 0x${hex8(address)}, which is not a readable address — a cast reinterprets memory ` +
            `at the operand; use (${typeName})&${operand} to read the variable, or drop the cast to see its value`,
        );
      }
      const node = di.scopes.castNode(expr, typeEntry, address, this.memory);
      return { node, address };
    }
    // 3. A register.
    const regIndex = REGISTER_NAMES.indexOf(expr.toLowerCase() as (typeof REGISTER_NAMES)[number]);
    if (regIndex >= 0) {
      const node = this.#registerNode(expr, regIndex, this.#registersOf(frame));
      return { node, address: node.address };
    }
    if (expr.toLowerCase() === 'cpsr') {
      return { node: this.#cpsrNode() };
    }
    // 4. A bare address: raw memory there, unfoldable.
    if (/^(0x[0-9a-f]+|\d+)$/i.test(expr)) {
      const address = parseU32Literal(expr);
      if (regionOf(address) === null) {
        return { node: { name: expr, value: `0x${hex8(address)} (unmapped)`, type: 'address' } };
      }
      return { node: this.rawNode(expr, address, 64, `0x${hex8(address)}`), address };
    }
    // 5. A `symbol.field[3]` path through the typed tree.
    if (PATH.test(expr)) {
      const node = this.#pathNode(expr, scope);
      if (node) {
        return { node, address: node.address };
      }
    }
    // 6. A symbol the ELF names but does not type (a decomp's `gUnk_*`), a function, or a user label.
    if (IDENT.test(expr)) {
      const address = this.program.symbolAddress(expr) ?? this.labels.byName(expr)?.address ?? null;
      if (address !== null) {
        const fn = this.program.functionRange(address);
        if (fn && fn.lo === (address & ~1) >>> 0) {
          return {
            node: {
              name: expr,
              value: `${expr} @ 0x${hex8(address)} (${fn.hi - fn.lo} bytes of code)`,
              type: 'function',
            },
            address,
          };
        }
        const size = di?.symbolExtent(expr)?.size ?? this.labels.byName(expr)?.size ?? 4;
        return {
          node: this.rawNode(
            expr,
            address,
            size,
            `${expr} @ 0x${hex8(address)} (${size} bytes, no type — try (StructName*)${expr})`,
          ),
          address,
        };
      }
    }
    // 7. The numeric expression grammar.
    const v = compileExpression(expr, this.hints(scope))(this.#env(scope));
    return {
      node: { name: expr, value: formatNumber(v), type: 'u32', scalar: { value: v, signed: v < 0 } },
      address: regionOf(v >>> 0) && expr.startsWith('&') ? v >>> 0 : undefined,
    };
  }

  /**
   * The address an expression names: a literal, `&variable`, `&path`, a symbol, a
   * label, or the value of any numeric expression — and which of those it was.
   */
  #addressOf(text: string, scope: NameScope | null): { address: number; from: AddressSource } {
    const reference = text.startsWith('&');
    const t = text.replace(/^&/, '').trim();
    if (/^(0x[0-9a-f]+|\d+)$/i.test(t)) {
      return { address: parseU32Literal(t), from: 'literal' };
    }
    const named = this.#namedNode(t, scope);
    if (named?.address !== undefined) {
      return { address: named.address, from: 'symbol' };
    }
    const sym = this.program.symbolAddress(t) ?? this.labels.byName(t)?.address;
    if (sym !== null && sym !== undefined) {
      return { address: sym, from: 'symbol' };
    }
    if (reference) {
      throw new Error(`unknown symbol '${t}'`);
    }
    return { address: compileExpression(t, this.hints(scope))(this.#env(scope)) >>> 0, from: 'value' };
  }

  /** The environment a watch evaluates in: the selected frame's registers and scopes. */
  exprEnv(frames: StackFrame[], frameIndex: number): ExprEnv {
    return this.#env(this.#scopeOfFrame(frames, frameIndex));
  }

  /** The environment a breakpoint condition or logpoint evaluates in: the live registers, the scopes at the pc. */
  liveEnv(): ExprEnv {
    return this.#env(this.#scopeAt(this.machine.pc));
  }

  /** What the expression compiler may assume about names at `pc` (the live pc when omitted). */
  hintsAt(pc?: number): ExprHints {
    return this.hints(pc === undefined ? null : this.#scopeAt(pc));
  }

  hints(scope: NameScope | null): ExprHints {
    return {
      symbolSigned: (path) => {
        try {
          return this.#namedNode(path, scope)?.scalar?.signed;
        } catch {
          return undefined;
        }
      },
    };
  }

  #env(scope: NameScope | null): ExprEnv {
    const regs = scope?.physical.regs;
    const di = this.program.debugInfo;
    return {
      reg: (i) => (regs ? (regs[i] ?? 0) : this.machine.registers[i]!) >>> 0,
      cpsr: () => this.machine.cpsr,
      read: (address, size) => this.machine.peekUnsigned(address, size),
      symbol: (path) => {
        const node = this.#namedNode(path, scope);
        if (node) {
          if (node.scalar) {
            return node.scalar.value >>> 0;
          }
          throw new Error(node.children ? `'${path}' is a ${node.type}, not a scalar` : `'${path}': ${node.value}`);
        }
        const address = this.program.symbolAddress(path) ?? this.labels.byName(path)?.address;
        if (address === null || address === undefined) {
          return undefined;
        }
        const size = di?.symbolExtent(path)?.size;
        return this.machine.peekUnsigned(address, size === 1 || size === 2 ? size : 4);
      },
      symbolAddress: (name) => {
        const node = this.#namedNode(name, scope);
        return node?.address ?? this.program.symbolAddress(name) ?? this.labels.byName(name)?.address;
      },
      frame: () => this.machine.frame,
      scanline: () => this.machine.scanline,
      cycle: () => this.machine.cycle,
    };
  }

  /**
   * What a data breakpoint on `name` would watch when `name` is a typed variable
   * or member path visible from `frames[frameIndex]` (a local's stack slot
   * included): its address and size. Null when it is not, or lives in a register.
   */
  variableTarget(name: string, frames: StackFrame[], frameIndex: number): { address: number; length: number } | null {
    const node = this.#namedNode(name, this.#scopeOfFrame(frames, frameIndex));
    if (!node) {
      return null;
    }
    if (node.writable) {
      return { address: node.writable.address, length: node.writable.size };
    }
    return node.address === undefined ? null : { address: node.address, length: 4 };
  }

  /**
   * Untyped memory as a tree: 32-bit words at their offsets (pointers annotated
   * with what they point at), halfwords and a byte dump.
   */
  rawNode(name: string, address: number, size: number, summary: string): VarNode {
    const read = (): Uint8Array => this.machine.peekPartial(address, size).data;
    const word = (d: Uint8Array, off: number, width: number): number => {
      let v = 0;
      for (let i = width - 1; i >= 0; i--) {
        v = v * 256 + (d[off + i] ?? 0);
      }
      return v >>> 0;
    };
    const view = (width: number, label: string): VarNode => ({
      name: label,
      value: `${Math.floor(size / width)} × ${width * 8}-bit`,
      type: `u${width * 8}[${Math.floor(size / width)}]`,
      address,
      children: () => {
        const d = read();
        const out: VarNode[] = [];
        for (let off = 0; off + width <= d.length && out.length < MAX_RAW_ROWS; off += width) {
          const v = word(d, off, width);
          out.push({
            name: `+0x${off.toString(16).padStart(2, '0')}`,
            value: `0x${v.toString(16).padStart(width * 2, '0')} (${v})`,
            type: `u${width * 8}`,
            address: address + off,
            writable: { address: address + off, size: width, kind: 'uint' },
          });
        }
        return out;
      },
    });
    return {
      name,
      value: summary,
      type: 'untyped memory',
      address,
      children: () => {
        const d = read();
        const words: VarNode[] = [];
        for (let off = 0; off + 4 <= d.length && words.length < MAX_RAW_WORDS; off += 4) {
          const v = word(d, off, 4);
          const sym = regionOf(v) && v >= 0x02000000 ? this.program.symbolize(v) : null;
          words.push({
            name: `+0x${off.toString(16).padStart(2, '0')}`,
            value: `0x${hex8(v)} (${v})${sym ? `  → ${sym}` : ''}`,
            type: 'u32',
            address: address + off,
            writable: { address: address + off, size: 4, kind: 'uint' },
          });
        }
        const bytes: VarNode = {
          name: 'bytes',
          value: `${d.length} bytes`,
          type: `u8[${d.length}]`,
          address,
          children: () => {
            const rows: VarNode[] = [];
            for (let off = 0; off < d.length; off += 16) {
              rows.push({
                name: `+0x${off.toString(16).padStart(2, '0')}`,
                value: Array.from(d.subarray(off, off + 16))
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join(' '),
                type: 'u8[16]',
                address: address + off,
              });
            }
            return rows;
          },
        };
        return [...words, view(2, 'halfwords'), bytes];
      },
    };
  }

  // ─── writes ────────────────────────────────────────────────────────

  /**
   * Write a scalar back and return how it now reads. `text` is true/false, a
   * quoted char, an enumerator name (or the tree's `NAME (n)` form), or any
   * expression of the grammar; a value the target cannot hold is refused rather
   * than truncated, and a bitfield is merged into its storage.
   */
  setScalar(target: WritableScalar, text: string): string {
    const v = this.#parseScalar(target, text);
    const bits = target.bitSize ?? target.size * 8;
    const signed = target.kind === 'int' || target.kind === 'char';
    const lo = target.kind === 'bool' ? 0n : signed ? -(1n << BigInt(bits - 1)) : 0n;
    const hi = target.kind === 'bool' ? 1n : (1n << BigInt(bits)) - 1n;
    if (v < lo || v > hi) {
      throw new Error(`'${text.trim()}' is out of range for a ${bits}-bit ${target.kind} (${lo}..${hi})`);
    }
    const mask = (1n << BigInt(bits)) - 1n;
    let word = v & mask;
    if (target.bitSize !== undefined) {
      const current = this.machine.peek(target.address, target.size);
      if (!current) {
        throw new Error(`address 0x${hex8(target.address)} is not readable`);
      }
      const shift = BigInt(target.bitOffset ?? 0);
      word = (fromBytes(current) & ~(mask << shift)) | (word << shift);
    }
    const bytes = new Uint8Array(target.size);
    for (let i = 0; i < target.size; i++) {
      bytes[i] = Number((word >> BigInt(i * 8)) & 0xffn);
    }
    if (this.machine.poke(target.address, bytes) !== target.size) {
      throw new Error(`address 0x${hex8(target.address)} is not writable`);
    }
    return this.#display(target, v);
  }

  #parseScalar(target: WritableScalar, text: string): bigint {
    const t = text.trim();
    if (t === 'true') {
      return 1n;
    }
    if (t === 'false') {
      return 0n;
    }
    if (/^'.'$/.test(t)) {
      return BigInt(t.charCodeAt(1));
    }
    // The tree shows an enum as `NAME (n)` and a bitfield as `n (k bits)`: either form writes back as typed.
    const shown = /^(.*?)\s*\([^()]*\)$/.exec(t);
    const bare = shown ? shown[1]!.trim() : t;
    if (target.enumerators) {
      for (const [k, name] of target.enumerators) {
        if (name === bare) {
          return BigInt(k);
        }
      }
    }
    const literal = /^(-?)(0x[0-9a-f]+|\d+)$/i.exec(bare);
    if (literal) {
      const magnitude = BigInt(literal[2]!);
      return literal[1] ? -magnitude : magnitude;
    }
    try {
      return BigInt(compileExpression(bare, this.hintsAt(this.machine.pc))(this.liveEnv()));
    } catch (err) {
      throw new Error(`cannot parse '${text}' as a value: ${(err as Error).message}`);
    }
  }

  /** How the tree will show `v` once written: the same formatter as the read side. */
  #display(target: WritableScalar, v: bigint): string {
    if (target.bitSize !== undefined) {
      const label = target.enumerators?.get(Number(v));
      return `${label ? `${label} (${v})` : target.kind === 'bool' ? (v ? 'true' : 'false') : v} (${target.bitSize} bits)`;
    }
    const bytes = new Uint8Array(target.size);
    const word = v & ((1n << BigInt(target.size * 8)) - 1n);
    for (let i = 0; i < target.size; i++) {
      bytes[i] = Number((word >> BigInt(i * 8)) & 0xffn);
    }
    const kind = target.enumerators ? 'enum' : target.kind;
    return formatValue(
      '',
      { kind, name: kind, size: target.size, enumerators: target.enumerators, signed: target.kind === 'int' },
      bytes,
      target.address,
      this.memory,
    ).value;
  }

  // ─── disassembly ───────────────────────────────────────────────────

  /**
   * `count` instructions from `address`. The instruction set is, in order: the
   * explicit `mode`; the ELF's mapping symbols; ARM below 0x4000 (the BIOS stub);
   * the CPU's mode when `address` lies in the function the CPU is stopped in, or
   * when there is no ELF to say otherwise; else Thumb (what nearly all GBA code is).
   */
  disassemble(address: number, count: number, mode?: 'arm' | 'thumb'): DisassembledLine[] {
    const lines: DisassembledLine[] = [];
    let addr = address >>> 0;
    let lastLine = '';
    const symbolize = (a: number): string | null => this.labels.at(a)?.label ?? this.program.symbolize(a);
    for (let i = 0; i < count; i++) {
      const region = regionOf(addr);
      if (region === null || region === 'mmio' || region === 'palette' || region === 'oam') {
        lines.push({ address: addr, bytes: '', text: '<unmapped>', size: 2 });
        addr = (addr + 2) >>> 0;
        continue;
      }
      const thumb = this.#isThumb(addr, mode);
      const aligned = thumb ? addr & ~1 : addr & ~3;
      const ins = thumb
        ? disassembleThumbAt((a) => this.machine.peekUnsigned(a, 2) ?? 0, aligned, { symbolize })
        : disassembleArmAt((a) => this.machine.peekUnsigned(a, 4) ?? 0, aligned, { symbolize });
      const raw = this.machine.peekPartial(aligned, ins.size).data;
      const line: DisassembledLine = {
        address: aligned,
        bytes: Array.from(raw)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' '),
        text: ins.text,
        size: ins.size,
        target: ins.target,
      };
      const label = this.labels.at(aligned);
      if (label?.label) {
        line.label = label.label;
      }
      const symbol = this.program.symbolize(aligned);
      if (symbol) {
        line.symbol = symbol;
      }
      const src = this.program.lineAt(aligned);
      if (src?.path) {
        const key = `${src.path}:${src.line}`;
        if (key !== lastLine) {
          line.source = { path: src.path, line: src.line };
          lastLine = key;
        }
      }
      lines.push(line);
      addr = (aligned + ins.size) >>> 0;
    }
    return lines;
  }

  #isThumb(address: number, mode?: 'arm' | 'thumb'): boolean {
    if (mode) {
      return mode === 'thumb';
    }
    const mapped = this.program.modeAt(address);
    if (mapped === 'arm') {
      return false;
    }
    if (mapped === 'thumb') {
      return true;
    }
    if (address < 0x4000) {
      return false; // the BIOS stub is ARM
    }
    if (!this.program.hasSymbols) {
      return this.machine.thumb; // nothing else to go on: the CPU's own state
    }
    const fn = this.program.functionRange(this.machine.pc);
    if (fn && address >= fn.lo && address < fn.hi) {
      return this.machine.thumb;
    }
    return true;
  }
}

export function hex8(v: number): string {
  return (v >>> 0).toString(16).padStart(8, '0');
}

function fromBytes(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  return v;
}
