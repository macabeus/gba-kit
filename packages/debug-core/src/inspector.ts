/**
 * Everything the debugger shows about a stopped machine: the call stack (with
 * inlined layers as their own rows), scopes and variables per frame, expression
 * evaluation, register and memory views, disassembly. Reads only; the one write
 * path (`setScalar`) goes through the machine's poke.
 */
import { disassembleArmAt, disassembleThumbAt } from '@gba-kit/arm-emulator/disassembler';
import type { Memory, VarNode, VirtualFrame } from '@gba-kit/debug-info';
import { DW_TAG } from '@gba-kit/debug-info';

import { type ExprEnv, compileExpression } from './expression.js';
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
  /** true when the expression named memory the user can open in a memory view */
  address?: number;
}

export class Inspector {
  constructor(
    readonly machine: Machine,
    readonly program: Program,
    readonly labels: LabelStore,
  ) {}

  readonly memory: Memory = {
    read: (address, size) => (size > 0 && size <= 0x10000 ? this.machine.peek(address, size) : null),
  };

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
    const live = this.machine.registers;
    const regs = frame?.virtual ? frame.virtual.physical.regs : Array.from(live);
    const nodes: VarNode[] = REGISTER_NAMES.map((name, i) => {
      const v = regs[i];
      if (v === undefined) {
        return { name, value: '<not recovered in this frame>', type: 'u32' };
      }
      const node: VarNode = { name, value: `0x${hex8(v)}`, type: 'u32' };
      if (regionOf(v) !== null && i !== 15) {
        node.address = v;
      }
      const sym = i === 15 || i === 14 ? this.program.symbolize(v & ~1) : null;
      if (sym) {
        node.value += `  ${sym}`;
      }
      return node;
    });
    nodes.push({ name: 'cpsr', value: `0x${hex8(this.machine.cpsr)}  ${this.cpsrDescription()}`, type: 'u32' });
    return nodes;
  }

  machineNodes(): VarNode[] {
    const gba = this.machine.gba;
    const fn = this.program.functionRange(this.machine.pc);
    return [
      { name: 'frame', value: String(this.machine.frame), type: 'frames' },
      { name: 'scanline', value: String(this.machine.scanline), type: 'line' },
      { name: 'cycle', value: String(this.machine.cycle), type: 'instruction count' },
      { name: 'function', value: fn ? fn.name : '?', type: 'symbol' },
      { name: 'halted', value: String(gba.interrupts.halted), type: 'bool' },
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

  // ─── evaluation ────────────────────────────────────────────────────

  /**
   * A watch / hover / REPL expression. Typed answers first (a local, a global, a
   * cast, a symbol, a register, an address), then the numeric expression grammar.
   * Throws with a message the user can act on.
   */
  evaluate(expression: string, frames: StackFrame[], frameIndex = 0): EvaluateResult {
    const expr = expression.trim();
    if (!expr) {
      throw new Error('empty expression');
    }
    const frame = frames[frameIndex];
    const di = this.program.debugInfo;

    // 1. A local, parameter or file global of the selected frame (innermost inlined layer outward).
    if (/^[A-Za-z_]\w*$/.test(expr) && frame?.virtual && di) {
      const node = this.#variableInFrame(expr, frames, frameIndex);
      if (node) {
        return { node, address: node.address };
      }
    }
    // 2. A cast: `(Card*)0x0300243c`, `(struct PlayerState)gUnk_03005220`, `(u16)0x04000006`.
    const cast = /^\(\s*((?:struct|union|enum)\s+)?([A-Za-z_]\w*)\s*(\*?)\s*\)\s*(.+)$/.exec(expr);
    if (cast && di) {
      const typeEntry = di.scopes.typeByName(`${cast[1] ?? ''}${cast[2]}`);
      if (!typeEntry) {
        throw new Error(`unknown type '${cast[1] ?? ''}${cast[2]}' (the ELF has no DWARF for it)`);
      }
      const target = this.#addressOf(cast[4]!.trim());
      const node = di.scopes.castNode(expr, typeEntry, target, this.memory);
      return { node, address: target };
    }
    // 3. A DWARF-typed global from any unit, or a declaration joined to a linker symbol.
    if (/^[A-Za-z_]\w*$/.test(expr) && di) {
      const global = di.scopes.globalByName(expr);
      if (global) {
        const node = di.scopes.variableNode(
          global,
          di.scopes.liveFrame(this.machine.pc, this.machine.registers),
          this.memory,
        );
        return { node, address: node.address };
      }
      const decl = di.scopes.declarationByName(expr);
      const address = this.program.globalAddress(expr);
      const typeEntry = decl ? di.scopes.index.typeOf(decl) : undefined;
      if (decl && typeEntry && address !== null) {
        const node = di.scopes.castNode(expr, typeEntry, address, this.memory);
        node.type = `${node.type} (declared in a header, placed by the linker)`;
        return { node, address };
      }
    }
    // 4. A register.
    const regIndex = REGISTER_NAMES.indexOf(expr.toLowerCase() as (typeof REGISTER_NAMES)[number]);
    if (regIndex >= 0) {
      const regs = frame?.virtual ? frame.virtual.physical.regs : Array.from(this.machine.registers);
      const v = regs[regIndex];
      if (v === undefined) {
        return { node: { name: expr, value: '<not recovered in this frame>', type: 'u32' } };
      }
      const sym = this.program.symbolize(v & ~1);
      return {
        node: {
          name: expr,
          value: `0x${hex8(v)}${sym ? `  ${sym}` : ''}`,
          type: 'u32',
          address: regionOf(v) ? v : undefined,
        },
        address: regionOf(v) ? v : undefined,
      };
    }
    if (expr.toLowerCase() === 'cpsr') {
      return { node: { name: 'cpsr', value: `0x${hex8(this.machine.cpsr)}  ${this.cpsrDescription()}`, type: 'u32' } };
    }
    // 5. A bare address: raw memory there, unfoldable.
    if (/^(0x[0-9a-f]+|\d+)$/i.test(expr)) {
      const address = Number(expr) >>> 0;
      if (regionOf(address) === null) {
        return { node: { name: expr, value: `0x${hex8(address)} (unmapped)`, type: 'address' } };
      }
      return { node: this.rawNode(expr, address, 64, `0x${hex8(address)}`), address };
    }
    // 6. A `symbol.field[3]` path through the DWARF (bitfields decoded).
    if (/^[A-Za-z_]\w*(\.\w+|\[\d+\])+$/.test(expr) && di) {
      const loc = di.resolveVariable(expr);
      if (loc) {
        const raw = this.machine.peekUnsigned(loc.address, loc.size);
        if (raw === undefined) {
          return {
            node: { name: expr, value: `<unreadable at 0x${hex8(loc.address)}>`, type: `${loc.size}-byte` },
            address: loc.address,
          };
        }
        const v = loc.bitWidth !== undefined ? (raw >>> (loc.bitOffset ?? 0)) & ((1 << loc.bitWidth) - 1) : raw;
        return {
          node: {
            name: expr,
            value: `${v} (0x${v.toString(16)})`,
            type: `${loc.size}-byte${loc.bitWidth ? ` bitfield:${loc.bitWidth}` : ''}`,
            address: loc.address,
          },
          address: loc.address,
        };
      }
    }
    // 7. A symbol the ELF names but does not type (a decomp's `gUnk_*`), or a user label.
    if (/^[A-Za-z_]\w*$/.test(expr)) {
      const address = this.program.symbolAddress(expr) ?? this.labels.byName(expr)?.address ?? null;
      if (address !== null) {
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
    // 8. The numeric expression grammar.
    const compiled = compileExpression(expr);
    const v = compiled(this.exprEnv(frame));
    return {
      node: { name: expr, value: `${v} (0x${v.toString(16)})`, type: 'u32' },
      address: regionOf(v) && expr.startsWith('&') ? v : undefined,
    };
  }

  #variableInFrame(name: string, frames: StackFrame[], frameIndex: number): VarNode | null {
    const di = this.program.debugInfo!;
    const frame = frames[frameIndex]!;
    const physical = frame.virtual!.physical;
    for (let i = frameIndex; i < frames.length; i++) {
      const vf = frames[i]!.virtual;
      if (!vf || vf.physical !== physical) {
        break;
      }
      if (vf.scope) {
        for (const v of di.scopes.scopeVariables(vf.scope, physical.lookupPc)) {
          if (di.scopes.name(v) === name) {
            return di.scopes.variableNode(v, physical, this.memory);
          }
        }
      }
    }
    const unit = frame.virtual!.scope
      ? di.scopes.index.unit(frame.virtual!.scope)
      : di.scopes.unitContaining(physical.lookupPc);
    const g = unit ? di.scopes.globals(unit).find((d) => di.scopes.name(d) === name) : undefined;
    return g ? di.scopes.variableNode(g, physical, this.memory) : null;
  }

  /** The address an expression names: a number, a register, `&symbol`, a symbol, or any numeric expression. */
  #addressOf(text: string): number {
    const t = text.replace(/^&/, '').trim();
    if (/^(0x[0-9a-f]+|\d+)$/i.test(t)) {
      return Number(t) >>> 0;
    }
    const sym = this.program.symbolAddress(t) ?? this.labels.byName(t)?.address;
    if (sym !== null && sym !== undefined) {
      return sym;
    }
    return compileExpression(t)(this.exprEnv(undefined)) >>> 0;
  }

  /** The environment breakpoint conditions and watches evaluate in. */
  exprEnv(frame: StackFrame | undefined): ExprEnv {
    const regs = frame?.virtual ? frame.virtual.physical.regs : undefined;
    const di = this.program.debugInfo;
    return {
      reg: (i) => (regs ? (regs[i] ?? 0) : this.machine.registers[i]!) >>> 0,
      cpsr: () => this.machine.cpsr,
      read: (address, size) => this.machine.peekUnsigned(address, size),
      symbol: (path) => {
        if (di) {
          const loc = di.resolveVariable(path);
          if (loc) {
            const raw = this.machine.peekUnsigned(loc.address, loc.size);
            if (raw === undefined) {
              return undefined;
            }
            return loc.bitWidth !== undefined ? (raw >>> (loc.bitOffset ?? 0)) & ((1 << loc.bitWidth) - 1) : raw;
          }
        }
        const address = this.program.symbolAddress(path) ?? this.labels.byName(path)?.address;
        if (address === null || address === undefined) {
          return undefined;
        }
        const size = di?.symbolExtent(path)?.size;
        return this.machine.peekUnsigned(address, size === 1 || size === 2 ? size : 4);
      },
      symbolAddress: (name) => this.program.symbolAddress(name) ?? this.labels.byName(name)?.address,
      frame: () => this.machine.frame,
      scanline: () => this.machine.scanline,
      cycle: () => this.machine.cycle,
    };
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
        for (let off = 0; off + width <= d.length && out.length < 512; off += width) {
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
        for (let off = 0; off + 4 <= d.length && words.length < 256; off += 4) {
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

  /** Write a scalar back. `text` is decimal, hex, true/false, a quoted char, or an enumerator name. */
  setScalar(target: { address: number; size: number }, text: string, enumerators?: Map<number, string>): number {
    const t = text.trim();
    let v: number | undefined;
    if (t === 'true') {
      v = 1;
    } else if (t === 'false') {
      v = 0;
    } else if (/^'.'$/.test(t)) {
      v = t.charCodeAt(1);
    } else if (/^-?(0x[0-9a-f]+|\d+)$/i.test(t)) {
      v = Number(t);
    } else if (enumerators) {
      for (const [k, name] of enumerators) {
        if (name === t) {
          v = k;
        }
      }
    }
    if (v === undefined) {
      throw new Error(`cannot parse '${text}' as a value`);
    }
    const bytes = new Uint8Array(target.size);
    for (let i = 0; i < target.size; i++) {
      bytes[i] = (v >>> (i * 8)) & 0xff;
    }
    if (this.machine.poke(target.address, bytes) !== target.size) {
      throw new Error(`address 0x${hex8(target.address)} is not writable`);
    }
    return v >>> 0;
  }

  // ─── disassembly ───────────────────────────────────────────────────

  /**
   * `count` instructions from `address`. The instruction set comes from the ELF's
   * mapping symbols when it has them, else from the CPU's mode when `address` is
   * where it stopped, else Thumb (what nearly all GBA code is).
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

export { DW_TAG };
