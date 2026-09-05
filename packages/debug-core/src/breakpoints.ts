/**
 * Breakpoints of every kind the session honors, resolved to what the machine can
 * check cheaply: a map from instruction address to the breakpoints there, bus
 * watchpoints for data, and a set of hardware events to stop on.
 */
import type { HardwareEvent } from '@gba-kit/gba-emulator';

import {
  type CompiledExpr,
  type ExprEnv,
  compileExpression,
  compileHitCondition,
  compileLogMessage,
} from './expression.js';

export type BreakpointKind = 'source' | 'instruction' | 'function';

export interface BreakpointSpec {
  /** a source line (local path), an instruction address, or a function name */
  kind: BreakpointKind;
  path?: string;
  line?: number;
  address?: number;
  functionName?: string;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface Breakpoint {
  id: number;
  kind: BreakpointKind;
  /** every instruction address this breakpoint arms (a line can have several) */
  addresses: number[];
  verified: boolean;
  /** why it is unverified, for the UI */
  message?: string;
  /** the line actually used (a breakpoint on a comment slides forward) */
  line?: number;
  path?: string;
  condition?: CompiledExpr;
  conditionText?: string;
  hitCondition?: (hits: number) => boolean;
  logMessage?: (env: ExprEnv) => string;
  hits: number;
}

export type DataAccess = 'write' | 'read' | 'readWrite';

export interface DataBreakpointSpec {
  address: number;
  length: number;
  name: string;
  access: DataAccess;
  condition?: string;
  hitCondition?: string;
}

export interface DataBreakpoint extends DataBreakpointSpec {
  id: number;
  compiledCondition?: CompiledExpr;
  compiledHit?: (hits: number) => boolean;
  hits: number;
}

/** Hardware events a breakpoint can be set on. */
export type EventBreakpointKind = 'vblank' | 'hblank' | 'irq' | 'irq-enter' | 'dma' | 'halt' | 'mmio-write';

export const EVENT_BREAKPOINT_KINDS: ReadonlyArray<{ kind: EventBreakpointKind; label: string; description: string }> =
  [
    { kind: 'vblank', label: 'VBlank', description: 'Stop when the display enters vertical blank (once per frame)' },
    { kind: 'hblank', label: 'HBlank', description: 'Stop at every horizontal blank (228 per frame)' },
    { kind: 'irq', label: 'Interrupt requested', description: 'Stop when any interrupt flag is raised' },
    { kind: 'irq-enter', label: 'Interrupt taken', description: 'Stop when the CPU enters the IRQ handler' },
    { kind: 'dma', label: 'DMA transfer', description: 'Stop when a DMA channel starts a transfer' },
    { kind: 'halt', label: 'CPU halted', description: 'Stop when the CPU halts waiting for an interrupt' },
    { kind: 'mmio-write', label: 'I/O register write', description: 'Stop on every write to an I/O register' },
  ];

export interface ResolvedAddresses {
  addresses: number[];
  line?: number;
  message?: string;
}

/** Resolves a breakpoint spec to instruction addresses; provided by the session (needs the program). */
export type BreakpointResolver = (spec: BreakpointSpec) => ResolvedAddresses;

export class BreakpointStore {
  #nextId = 1;
  /** by owner: a source file path, 'instruction', or 'function' */
  readonly #groups = new Map<string, Breakpoint[]>();
  #byAddress = new Map<number, Breakpoint[]>();
  #data: DataBreakpoint[] = [];
  #events = new Set<EventBreakpointKind>();

  /** Replace every breakpoint of `owner` (a file path, 'instruction' or 'function'). */
  replace(owner: string, specs: BreakpointSpec[], resolve: BreakpointResolver): Breakpoint[] {
    const list = specs.map((spec): Breakpoint => {
      const id = this.#nextId++;
      const bp: Breakpoint = {
        id,
        kind: spec.kind,
        addresses: [],
        verified: false,
        hits: 0,
        path: spec.path,
        line: spec.line,
      };
      try {
        if (spec.condition?.trim()) {
          bp.condition = compileExpression(spec.condition);
          bp.conditionText = spec.condition;
        }
        if (spec.hitCondition?.trim()) {
          bp.hitCondition = compileHitCondition(spec.hitCondition);
        }
        if (spec.logMessage?.trim()) {
          bp.logMessage = compileLogMessage(spec.logMessage);
        }
      } catch (err) {
        bp.message = (err as Error).message;
        return bp;
      }
      const resolved = resolve(spec);
      bp.addresses = resolved.addresses;
      bp.verified = resolved.addresses.length > 0;
      if (resolved.line !== undefined) {
        bp.line = resolved.line;
      }
      if (resolved.message) {
        bp.message = resolved.message;
      }
      return bp;
    });
    this.#groups.set(owner, list);
    this.#rebuild();
    return list;
  }

  /** Breakpoints at an address (empty when none). */
  at(address: number): Breakpoint[] | undefined {
    return this.#byAddress.get(address);
  }

  get hasInstructionBreakpoints(): boolean {
    return this.#byAddress.size > 0;
  }

  /** Every breakpoint of every group. */
  all(): Breakpoint[] {
    return [...this.#groups.values()].flat();
  }

  #rebuild(): void {
    this.#byAddress = new Map();
    for (const list of this.#groups.values()) {
      for (const bp of list) {
        for (const a of bp.addresses) {
          const existing = this.#byAddress.get(a);
          if (existing) {
            existing.push(bp);
          } else {
            this.#byAddress.set(a, [bp]);
          }
        }
      }
    }
  }

  // ─── data breakpoints ───────────────────────────────────────────────

  replaceData(specs: DataBreakpointSpec[]): DataBreakpoint[] {
    this.#data = specs.map((spec) => {
      const bp: DataBreakpoint = { ...spec, id: this.#nextId++, hits: 0 };
      if (spec.condition?.trim()) {
        bp.compiledCondition = compileExpression(spec.condition);
      }
      if (spec.hitCondition?.trim()) {
        bp.compiledHit = compileHitCondition(spec.hitCondition);
      }
      return bp;
    });
    return this.#data;
  }

  get data(): readonly DataBreakpoint[] {
    return this.#data;
  }

  // ─── event breakpoints ──────────────────────────────────────────────

  setEvents(kinds: EventBreakpointKind[]): void {
    this.#events = new Set(kinds);
  }

  get events(): ReadonlySet<EventBreakpointKind> {
    return this.#events;
  }

  /** The event breakpoint kind an event satisfies, or null. */
  eventKindOf(event: HardwareEvent): EventBreakpointKind | null {
    const kind: EventBreakpointKind = event.kind === 'irq-request' ? 'irq' : event.kind;
    return this.#events.has(kind) ? kind : null;
  }
}
