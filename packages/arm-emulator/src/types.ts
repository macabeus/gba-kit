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
 * Every access carries the address the CPU (or DMA) drives, misaligned ones included, and the bus
 * aligns it the way the addressed memory does: a 16- or 32-bit memory ignores the low address
 * bits of a halfword or word access, while an 8-bit memory (GBA SRAM) uses them to pick the byte.
 * Reads return the aligned data unrotated; the CPU applies the ARM7TDMI rules for misaligned
 * loads (rotation, LDRSH sign extension).
 *
 * The bus also prices each access, because the wait states belong to the memory the address
 * selects: the CPU adds up these prices, plus its internal cycles, as the cost of an instruction
 * (GBATEK "ARM CPU Instruction Cycle Times"). A price counts the access's own cycle, so a zero-wait
 * memory answers 1.
 *
 * The full GBA emulator injects GbaSystemBus (dispatches to PPU, APU, etc.).
 */
export interface MemoryBus {
  read8(address: number): number;
  read16(address: number): number;
  read32(address: number): number;
  /**
   * The CPU's opcode fetches into its pipeline. They read what `read16`/`read32` read, and a bus
   * that reports loads to a debugger leaves them out: the pipeline also fetches the opcodes after a
   * branch, which never execute.
   */
  fetch16(address: number): number;
  fetch32(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;

  /**
   * Cycles one access of `width` bytes at `address` takes. `sequential` marks an S cycle, the
   * address after the previous access (an LDM/STM past its first word); otherwise it is an N cycle.
   * It only prices the access and leaves the bus state as it is.
   */
  accessCycles(address: number, width: 1 | 2 | 4, sequential: boolean): number;

  /**
   * The CPU fetches the opcode at `address` now, and this returns the cycles the fetch takes. The
   * CPU reports its accesses and internal cycles in the order they happen, so a bus with a prefetch
   * unit can serve the fetch from what it read ahead during the cycles before.
   */
  fetchCycles(address: number, width: 2 | 4, sequential: boolean): number;

  /** The CPU makes the data access at `address` now; returns the cycles it takes. */
  dataCycles(address: number, width: 1 | 2 | 4, sequential: boolean): number;

  /** `cycles` cycles pass now with no access on the bus (the CPU's internal cycles), free for a prefetch unit. */
  idle(cycles: number): void;
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
