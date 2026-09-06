/**
 * Where a step stops. Every predicate is asked before each instruction (with the
 * one we resume on already skipped) and answers "stop here". Statement rows come
 * from the line table's `is_stmt`; frames are told apart by CFA when the ELF has
 * call-frame information and by function range + SP + LR when it does not.
 *
 * Inlined calls follow gdb's model: a step-over stops at the entry of an inlined
 * body but presents the call-site line, hiding the inlined layer; a step-into
 * reveals one layer without executing.
 */
import type { DwarfEntry } from '@gba-kit/debug-info';

import type { Machine } from './machine.js';
import type { Program } from './program.js';

export type StepPredicate = (pc: number) => boolean;

/** ARM7TDMI modes that are not an exception being handled: user and system. */
const MODE_USR = 0x10;
const MODE_SYS = 0x1f;

/** Whether the CPU is inside an exception handler (IRQ, FIQ, SVC, abort, undefined). */
export function isExceptionMode(mode: number): boolean {
  return mode !== MODE_USR && mode !== MODE_SYS;
}

/** Whether a mode change from `from` to `to` is the handler `from` was in returning to what it interrupted. */
function returnedFromException(from: number, to: number): boolean {
  return isExceptionMode(from) && !isExceptionMode(to);
}

export interface StepContext {
  machine: Machine;
  program: Program;
  /** hidden inlined layers of frame 0 at the start of the step */
  hiddenInline: number;
  /** the call-site line the visible frame shows when layers are hidden */
  visibleLine: { file: string; line: number } | null;
}

export interface StepOutcome {
  predicate: StepPredicate;
  /**
   * How many inlined layers to hide when the predicate stops (set during the
   * step); null lets the session hide the layers that begin at the stop address.
   */
  hidden: () => number | null;
}

/** Inlined subroutines containing `pc`, outermost first; null without DWARF scopes. */
function inlineChain(program: Program, pc: number): DwarfEntry[] | null {
  const di = program.debugInfo;
  if (!di) {
    return null;
  }
  const fn = di.scopes.functionAt(pc);
  return fn ? di.scopes.inlineChain(fn, pc) : [];
}

/**
 * How many inlined layers begin exactly at `pc`, innermost first. A stop there has
 * not executed any of the inlined call, so a debugger shows the call site (the
 * caller's line) until the user steps in — gdb's rule for inline frames.
 */
export function inlineEntriesAt(program: Program, pc: number): number {
  const di = program.debugInfo;
  const chain = inlineChain(program, pc);
  if (!di || !chain) {
    return 0;
  }
  let n = 0;
  for (let i = chain.length - 1; i >= 0 && di.scopes.entryPc(chain[i]!) === pc; i--) {
    n++;
  }
  return n;
}

function isPrefix<T>(prefix: T[], full: T[]): boolean {
  return prefix.length <= full.length && prefix.every((p, i) => p === full[i]);
}

/** One instruction: stop at whatever runs next. */
export function stepInstruction(): StepOutcome {
  return { predicate: () => true, hidden: () => 0 };
}

/**
 * Step into: the start of a different source line, entering calls. Code without
 * line info (asm glue, the BIOS stub) is run through until a C line is reached.
 * An interrupt that preempts the step is not a call: its handler's lines are
 * skipped (a breakpoint there still stops).
 */
export function stepInto(ctx: StepContext): StepOutcome {
  const { program, machine } = ctx;
  const cpu = machine.gba.armCpu;
  const startMode = cpu.getMode();
  const start = ctx.visibleLine ?? program.lineAt(machine.pc);
  if (!start) {
    return stepInstruction();
  }
  const startFile = 'dwarfFile' in start ? start.dwarfFile : start.file;
  return {
    predicate: (pc) => {
      const row = program.rowAt(pc);
      if (!row || !row.isStmt || cpu.getMode() !== startMode) {
        return false; // no statement here, or an interrupt handler
      }
      return row.file !== startFile || row.line !== start.line;
    },
    hidden: () => 0,
  };
}

/**
 * Step over: the next statement of the current function, real calls and inlined
 * calls both treated as one statement. Returning to the caller counts as reaching
 * its next statement.
 */
export function stepOver(ctx: StepContext): StepOutcome {
  return stepOverStatements(ctx, ctx.hiddenInline);
}

/** Step out of an inlined frame: a step-over from its caller's point of view. */
export function stepOutOfInline(ctx: StepContext): StepOutcome {
  return stepOverStatements(ctx, ctx.hiddenInline + 1);
}

function stepOverStatements(ctx: StepContext, hiddenLayers: number): StepOutcome {
  const { program, machine } = ctx;
  const cpu = machine.gba.armCpu;
  const pc = machine.pc;
  const startSp = cpu.registers[13]!;
  const startMode = cpu.getMode();
  const fnRange = program.functionRange(pc);
  const inFn = (a: number): boolean => !!fnRange && a >= fnRange.lo && a < fnRange.hi;
  const di = program.debugInfo;
  const startCfa = di ? di.scopes.frames.cfa(pc, Array.from(cpu.registers)) : undefined;

  const fullChain = inlineChain(program, pc);
  const hidden = Math.min(hiddenLayers, fullChain?.length ?? 0);
  const visibleChain = fullChain ? fullChain.slice(0, fullChain.length - hidden) : null;
  const enteredHidden = fullChain && hidden > 0 ? fullChain[visibleChain!.length]! : null;

  let startLine: { file: string; line: number } | null = null;
  if (hidden > 0 && ctx.visibleLine) {
    startLine = ctx.visibleLine;
  } else if (hidden > 0 && enteredHidden && di) {
    startLine = di.scopes.callSite(enteredHidden);
  }
  if (!startLine) {
    const loc = program.lineAt(pc);
    startLine = loc ? { file: loc.dwarfFile, line: loc.line } : null;
  }
  if (!startLine) {
    // No line info here: one instruction, but a call as a unit.
    return {
      predicate: (a) => {
        const mode = cpu.getMode();
        if (mode !== startMode) {
          return returnedFromException(startMode, mode); // the handler returned: the interrupted code; else a nested handler
        }
        return cpu.registers[13]! >= startSp && (!fnRange || inFn(a) || cpu.registers[13]! > startSp);
      },
      hidden: () => 0,
    };
  }
  let hideOnStop: number | null = 0;
  const predicate: StepPredicate = (a) => {
    const row = program.rowAt(a);
    if (!row || !row.isStmt) {
      return false; // only a statement row is a place to stop
    }
    const mode = cpu.getMode();
    if (mode !== startMode) {
      if (returnedFromException(startMode, mode)) {
        // The handler we were stepping in returned: its "next statement" is the
        // interrupted code's, whatever inlined layers begin there.
        hideOnStop = null;
        return true;
      }
      return false; // an interrupt handler preempted the step
    }
    const sp = cpu.registers[13]!;
    // Frame identity: CFA when CFI knows it (exact, recursion-safe), else SP outside the function.
    if (startCfa !== undefined && di) {
      const cfa = di.scopes.frames.cfa(a, Array.from(cpu.registers));
      if (cfa !== undefined && cfa < startCfa) {
        return false; // a deeper frame
      }
      if (cfa !== undefined && cfa > startCfa) {
        hideOnStop = 0;
        return true; // returned to the caller: its next statement
      }
    } else if (fnRange && !inFn(a)) {
      if (sp < startSp) {
        return false; // inside a callee that has pushed its frame
      }
      const lr = (cpu.registers[14]! & ~1) >>> 0;
      if (sp === startSp && inFn(lr)) {
        return false; // a callee before its prologue (or a leaf that never pushes)
      }
      hideOnStop = 0;
      return true; // returned to the caller (or tail-called away)
    } else if (!fnRange && sp < startSp) {
      return false;
    }
    const sameLine = row.file === startLine.file && row.line === startLine.line;
    if (!visibleChain) {
      return !sameLine;
    }
    const chain = inlineChain(program, a) ?? [];
    if (isPrefix(chain, visibleChain)) {
      if (sameLine) {
        return false;
      }
      hideOnStop = 0;
      return true; // back at our own inline depth (or shallower): a new statement of ours
    }
    if (isPrefix(visibleChain, chain)) {
      const entered = chain[visibleChain.length]!;
      if (entered === enteredHidden) {
        return false; // still inside the inlined call we are stepping over
      }
      hideOnStop = chain.length - visibleChain.length; // the entry of another inlined call
      return true;
    }
    return false; // a sibling inline body reached by a jump: not a statement of ours
  };
  return { predicate, hidden: () => hideOnStop };
}

/** Step out of a physical frame: run to its return address, in the caller's frame. */
export function stepOutTo(ctx: StepContext, returnAddress: number, callerSp: number | undefined): StepOutcome {
  const cpu = ctx.machine.gba.armCpu;
  const target = (returnAddress & ~1) >>> 0;
  const startMode = cpu.getMode();
  const startSp = cpu.registers[13]!;
  return {
    predicate: (a) => a === target && cpu.getMode() === startMode && cpu.registers[13]! >= (callerSp ?? startSp),
    hidden: () => null,
  };
}

/**
 * Step out of an exception handler: run until the CPU is back in the mode the
 * exception interrupted (the SPSR's), i.e. the first instruction of the
 * interrupted code after the handler's return. The BIOS stub in between has no
 * symbol, so a return address would not do.
 */
export function stepOutOfException(ctx: StepContext): StepOutcome {
  const cpu = ctx.machine.gba.armCpu;
  const interrupted = cpu.getSPSR() & 0x1f;
  return {
    predicate: () => cpu.getMode() === interrupted,
    hidden: () => null,
  };
}

export function runToAddress(address: number): StepOutcome {
  const target = (address & ~1) >>> 0;
  return { predicate: (a) => a === target, hidden: () => null };
}
