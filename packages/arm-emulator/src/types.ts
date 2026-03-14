/**
 * ARM7TDMI Emulator - Core Types
 */

/** ARM register indices */
export const SP = 13;
export const LR = 14;
export const PC = 15;

/** Sentinel address — execution halts when PC reaches this */
export const SENTINEL_ADDR = 0xdeadbeee;

// ─── Memory Bus Interface ─────────────────────────────────────────────

/**
 * Abstract memory bus that the CPU reads/writes through.
 *
 * The full GBA emulator injects GbaSystemBus (dispatches to PPU, APU, etc.).
 */
export interface MemoryBus {
  read8(address: number): number;
  read16(address: number): number;
  read32(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
}

// ─── Debug Hooks ──────────────────────────────────────────────────────

/** Action the debugger can take after a hook fires */
export type DebugAction = 'continue' | 'break';

/**
 * Optional hooks for debugging instrumentation.
 *
 * When attached to a CPU, these are called during execution.
 * When absent, no overhead — the CPU takes a fast path.
 */
export interface DebugHooks {
  /** Called before executing an instruction. Return 'break' to pause. */
  onInstructionPre?(address: number, instruction: number): DebugAction;
  /** Called after executing an instruction. */
  onInstructionPost?(address: number, instruction: number): void;
  /** Called on every memory read (for memory watchpoints). */
  onMemoryRead?(address: number, size: 1 | 2 | 4, value: number): void;
  /** Called on every memory write (for memory watchpoints). */
  onMemoryWrite?(address: number, size: 1 | 2 | 4, value: number): void;
}

// ─── CPU State Types ──────────────────────────────────────────────────

/** CPSR condition flags */
export interface CpsrFlags {
  n: boolean; // Negative
  z: boolean; // Zero
  c: boolean; // Carry
  v: boolean; // Overflow
}

/** Result of an arithmetic/logic operation with flags */
export interface AluResult {
  value: number;
  n: boolean;
  z: boolean;
  c: boolean;
  v: boolean;
}

/** A recorded memory write during execution */
export interface MemoryWrite {
  address: number;
  size: 1 | 2 | 4;
  value: number;
}

/** A recorded external function call (bl to an unresolved symbol) */
export interface ExternalCall {
  /** Address of the bl instruction */
  callSite: number;
  /** Resolved target address (from relocation) */
  targetAddress: number;
  /** Symbol name from relocation table */
  symbolName: string;
  /** Argument registers at time of call */
  r0: number;
  r1: number;
  r2: number;
  r3: number;
}

/** Full execution trace from running a function */
export interface ExecutionResult {
  /** Final register values (r0-r15) */
  registers: Uint32Array;
  /** Final CPSR flags */
  cpsr: CpsrFlags;
  /** All memory writes performed during execution */
  memoryWrites: MemoryWrite[];
  /** All external function calls made during execution */
  externalCalls: ExternalCall[];
  /** Number of instructions executed */
  instructionsExecuted: number;
  /** Whether execution completed normally (returned) vs hit instruction limit */
  completed: boolean;
}
