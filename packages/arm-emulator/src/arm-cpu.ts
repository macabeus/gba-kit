/**
 * ARM7TDMI Full CPU Emulator
 *
 * Supports both ARM (32-bit) and Thumb (16-bit) instruction sets,
 * CPU modes with banked registers, and HLE BIOS calls via SWI.
 *
 * This class is the full-featured CPU for the GBA emulator.
 *
 * References:
 * - ARM7TDMI TRM (DDI0029G): https://ww1.microchip.com/downloads/en/DeviceDoc/DDI0029G_7TDMI_R3_trm.pdf
 * - GBATEK: http://problemkaputt.de/gbatek.htm
 */
import type { CpuSnapshot } from './cpu-snapshot.js';
import { multiplyCarry, multiplyLongCarry } from './multiply-carry.js';
import type { CpsrFlags, DebugHooks, ExecutionResult, ExternalCall, MemoryBus, MemoryWrite } from './types.js';
import { LR, PC, SENTINEL_ADDR, SP } from './types.js';
import { addWithFlags, asr, bit, bits, isNegative, lsl, lsr, ror, signExtend, subWithFlags } from './utils.js';

// ─── CPSR Bit Positions ──────────────────────────────────────────────

const CPSR_N = 31;
const CPSR_Z = 30;
const CPSR_C = 29;
const CPSR_V = 28;
const CPSR_I = 7;
const CPSR_F = 6;
const CPSR_T = 5;
const CPSR_MODE_MASK = 0x1f;

/** The PSR bits ARMv4T implements: the NZCV flags and the control byte (I, F, T, mode). */
const PSR_FLAGS_MASK = 0xf0000000;
const PSR_CONTROL_MASK = 0x000000ff;

// ─── CPU Mode Constants ──────────────────────────────────────────────

/** CPU mode codes (bits 4-0 of CPSR) */
export const MODE_USR = 0x10;
export const MODE_FIQ = 0x11;
export const MODE_IRQ = 0x12;
export const MODE_SVC = 0x13;
export const MODE_ABT = 0x17;
export const MODE_UND = 0x1b;
export const MODE_SYS = 0x1f;

/**
 * What an exception stub subtracts from its link register to resume the
 * instruction it interrupted. IRQ, FIQ and a prefetch abort return through
 * `subs pc, lr, #4`; a software interrupt and an undefined instruction resume at
 * lr itself. (A data abort's lr is one instruction further still, but nothing on
 * this hardware raises one.)
 */
export function exceptionReturnBias(mode: number): number {
  return mode === MODE_IRQ || mode === MODE_FIQ || mode === MODE_ABT ? -4 : 0;
}

/** Index into banked SP/LR arrays by mode */
const SP_LR_BANK_INDEX: Record<number, number> = {
  [MODE_USR]: 0,
  [MODE_SYS]: 0,
  [MODE_FIQ]: 1,
  [MODE_IRQ]: 2,
  [MODE_SVC]: 3,
  [MODE_ABT]: 4,
  [MODE_UND]: 5,
};

/** Index into SPSR array by mode (only privileged modes have SPSR) */
const SPSR_BANK_INDEX: Record<number, number> = {
  [MODE_FIQ]: 0,
  [MODE_IRQ]: 1,
  [MODE_SVC]: 2,
  [MODE_ABT]: 3,
  [MODE_UND]: 4,
};

/** Stub address range for external function calls */
const STUB_BASE = 0x08f00000;

/** `#pipelineAddress` of a flushed pipeline. Fetch addresses are even, so it never matches a PC. */
const PIPELINE_EMPTY = 0xffffffff;

/** Whether a branch target is the sentinel return address, in either instruction set. */
function isSentinel(address: number): boolean {
  return (address & ~3) >>> 0 === (SENTINEL_ADDR & ~3) >>> 0;
}

/**
 * Check if a CPU mode is valid.
 */
function isValidMode(mode: number): boolean {
  return (
    mode === MODE_USR ||
    mode === MODE_FIQ ||
    mode === MODE_IRQ ||
    mode === MODE_SVC ||
    mode === MODE_ABT ||
    mode === MODE_UND ||
    mode === MODE_SYS
  );
}

// ─── ARM Condition Codes ─────────────────────────────────────────────

/**
 * Evaluate an ARM condition code (bits 31-28 of an ARM instruction).
 */
function checkCondition(cond: number, n: boolean, z: boolean, c: boolean, v: boolean): boolean {
  switch (cond) {
    case 0x0:
      return z; // EQ
    case 0x1:
      return !z; // NE
    case 0x2:
      return c; // CS/HS
    case 0x3:
      return !c; // CC/LO
    case 0x4:
      return n; // MI
    case 0x5:
      return !n; // PL
    case 0x6:
      return v; // VS
    case 0x7:
      return !v; // VC
    case 0x8:
      return c && !z; // HI
    case 0x9:
      return !c || z; // LS
    case 0xa:
      return n === v; // GE
    case 0xb:
      return n !== v; // LT
    case 0xc:
      return !z && n === v; // GT
    case 0xd:
      return z || n !== v; // LE
    case 0xe:
      return true; // AL
    default:
      // NV: ARMv4T executes it as "never" (mGBA src/arm/arm.c conditionLut[0xF] = 0).
      return false;
  }
}

// ─── SWI Handler Type ───────────────────────────────────────────────

/**
 * The internal cycles (m) of a multiply: the multiplier array stops early once the multiplier's
 * remaining top bytes are all zero, or, for a signed multiply, all ones. m is 1 when bits 31-8 are,
 * 2 when bits 31-16 are, 3 when bits 31-24 are, and 4 otherwise (GBATEK "ARM CPU Instruction Cycle
 * Times"; mGBA ARM_WAIT_SMUL / ARM_WAIT_UMUL).
 */
function multiplierCycles(multiplier: number, signed: boolean): number {
  const m = multiplier | 0;
  if (signed) {
    if (m >> 8 === 0 || m >> 8 === -1) {
      return 1;
    }
    if (m >> 16 === 0 || m >> 16 === -1) {
      return 2;
    }
    return m >> 24 === 0 || m >> 24 === -1 ? 3 : 4;
  }
  if (m >>> 8 === 0) {
    return 1;
  }
  if (m >>> 16 === 0) {
    return 2;
  }
  return m >>> 24 === 0 ? 3 : 4;
}

/**
 * Callback for Software Interrupt (SWI) instructions.
 * Platform-specific: on GBA, the SWI number selects a BIOS function.
 * A handler that runs the call itself returns the cycles the call spends between taking the SWI
 * and branching back, which the SWI instruction costs on top of its own fetch and that return
 * branch. A handler that returns null leaves the call to the code at the SWI vector: the CPU takes
 * the exception, as it does for every SWI on hardware.
 * Without a handler, SWI instructions do nothing.
 */
export type SwiHandler = (cpu: ArmCpu, swiNumber: number) => number | null;

// ─── ARM7TDMI Full CPU ──────────────────────────────────────────────

/**
 * Full ARM7TDMI CPU supporting ARM and Thumb instruction sets,
 * with CPU modes and banked registers.
 */
export class ArmCpu {
  /** General-purpose registers r0-r15 (current view, mode-dependent) */
  readonly registers = new Uint32Array(16);

  /**
   * Current Program Status Register (full 32-bit).
   *
   * Bit layout:
   * - 31: N (Negative)
   * - 30: Z (Zero)
   * - 29: C (Carry)
   * - 28: V (Overflow)
   * - 7: I (IRQ disable)
   * - 6: F (FIQ disable)
   * - 5: T (Thumb state: 0=ARM, 1=Thumb)
   * - 4-0: Mode (0x10=USR, 0x11=FIQ, 0x12=IRQ, 0x13=SVC, 0x17=ABT, 0x1B=UND, 0x1F=SYS)
   */
  cpsr: number = MODE_SYS | (1 << CPSR_I) | (1 << CPSR_F);

  /** Memory bus */
  readonly memory: MemoryBus;

  // ─── Banked Registers ────────────────────────────────────────────

  /**
   * Banked SP and LR for each mode.
   * Index: 0=USR/SYS, 1=FIQ, 2=IRQ, 3=SVC, 4=ABT, 5=UND
   */
  readonly #bankedSP = new Uint32Array(6);
  readonly #bankedLR = new Uint32Array(6);

  /**
   * FIQ banked r8-r12 (5 registers). Only FIQ has these extra banked regs.
   */
  readonly #fiqBankedR8to12 = new Uint32Array(5);

  /**
   * USR/SYS r8-r12 saved when switching to FIQ mode.
   */
  readonly #usrBankedR8to12 = new Uint32Array(5);

  /**
   * SPSR for each privileged mode.
   * Index: 0=FIQ, 1=IRQ, 2=SVC, 3=ABT, 4=UND
   */
  readonly #spsr = new Uint32Array(5);

  // ─── Execution State ─────────────────────────────────────────────

  /** Whether the CPU has halted (function returned to sentinel) */
  #halted = false;

  /** Whether the last `step()` ran nothing because a debug hook refused the instruction. */
  #refused = false;

  /** Map of stub addresses to symbol names */
  #stubs = new Map<number, string>();

  /** Next available stub address */
  #nextStub = STUB_BASE;

  /** Recorded external calls */
  #externalCalls: ExternalCall[] = [];

  /** Optional debug hooks */
  #hooks?: DebugHooks;

  /**
   * Execution watchpoints by instruction address. Composable and independent of
   * {@link setDebugHooks}, which is a single slot one owner replaces wholesale — an
   * analysis tool must be able to watch a PC without evicting a debugger's hooks.
   */
  readonly #execWatch = new Map<number, ((address: number) => void)[]>();
  /** Fast path: skip the lookup entirely on the common no-watchpoint case. */
  #execWatchActive = false;

  /** Platform-specific SWI handler */
  #swiHandler?: SwiHandler;

  // ─── Prefetch Pipeline ───────────────────────────────────────────

  /**
   * The ARM7TDMI fetches two instructions ahead of the one it executes. While the instruction at
   * $ executes, the one at $+width sits decoded and the one at $+2*width is fetched in its first
   * cycle, before any of its own data accesses — so a store to either address changes nothing
   * until a branch refills the pipeline (GBATEK "ARM CPU Overview"; mGBA `cpu->prefetch[0..1]`).
   *
   * `#pipelineAddress` is the address of `#decodedOpcode`, the next instruction to execute; the
   * pipeline is valid only while it equals the PC in the state `#pipelineThumb` records, which
   * also catches a PC set from outside (a host, the debugger, an IRQ entry).
   */
  #pipelineAddress = PIPELINE_EMPTY;
  #pipelineThumb = false;
  #decodedOpcode = 0;
  #fetchedOpcode = 0;

  /**
   * Cycles the instruction in progress has used so far: its data accesses, its internal cycles, any
   * refill a branch makes and the opcode fetch that ends it, each priced by the bus as it happens
   * (GBATEK "ARM CPU Instruction Cycle Times"; NanoBoyAdvance arm7tdmi.hh and handlers/).
   */
  #cycles = 0;

  /**
   * Whether the fetch that ends the instruction in progress is an S access: it is unless the bus
   * carried a data access or sat through an internal cycle since the last fetch. A refill leaves
   * it sequential (NanoBoyAdvance `pipe.access`).
   */
  #nextFetchSequential = true;

  constructor(memory: MemoryBus, options?: { hooks?: DebugHooks; swiHandler?: SwiHandler }) {
    this.memory = memory;
    this.#hooks = options?.hooks;
    this.#swiHandler = options?.swiHandler;
  }

  /**
   * Set the banked SP for a given mode without switching modes.
   * Used to initialize stack pointers (e.g. GBA BIOS sets IRQ/SVC stacks).
   */
  setBankedSP(mode: number, value: number): void {
    const bankIdx = SP_LR_BANK_INDEX[mode];
    if (bankIdx !== undefined) {
      this.#bankedSP[bankIdx] = value;
    }
  }

  /**
   * The stack pointer of `mode`: the live register when the CPU is in that mode,
   * else its bank. Undefined for a mode that has no bank.
   *
   * An unwinder crossing an exception boundary needs another mode's sp and lr, and
   * the alternative to reading them is `serialize()`, which copies six arrays.
   */
  getBankedSP(mode: number): number | undefined {
    if (mode === this.getMode()) {
      return this.registers[SP]!;
    }
    const bankIdx = SP_LR_BANK_INDEX[mode];
    return bankIdx === undefined ? undefined : this.#bankedSP[bankIdx]!;
  }

  /** The link register of `mode`, on the same terms as {@link getBankedSP}. */
  getBankedLR(mode: number): number | undefined {
    if (mode === this.getMode()) {
      return this.registers[LR]!;
    }
    const bankIdx = SP_LR_BANK_INDEX[mode];
    return bankIdx === undefined ? undefined : this.#bankedLR[bankIdx]!;
  }

  /** The SPSR of `mode` — what it interrupted — without switching into it. Undefined for USR/SYS. */
  getBankedSPSR(mode: number): number | undefined {
    const idx = SPSR_BANK_INDEX[mode];
    return idx === undefined ? undefined : this.#spsr[idx]!;
  }

  // ─── CPSR Accessors ──────────────────────────────────────────────

  /** Get condition flags from CPSR as a CpsrFlags object */
  get flags(): CpsrFlags {
    return {
      n: this.getN(),
      z: this.getZ(),
      c: this.getC(),
      v: this.getV(),
    };
  }

  /** Get Negative flag */
  getN(): boolean {
    return (this.cpsr & (1 << CPSR_N)) !== 0;
  }

  /** Get Zero flag */
  getZ(): boolean {
    return (this.cpsr & (1 << CPSR_Z)) !== 0;
  }

  /** Get Carry flag */
  getC(): boolean {
    return (this.cpsr & (1 << CPSR_C)) !== 0;
  }

  /** Get Overflow flag */
  getV(): boolean {
    return (this.cpsr & (1 << CPSR_V)) !== 0;
  }

  /** Get Thumb state bit */
  getT(): boolean {
    return (this.cpsr & (1 << CPSR_T)) !== 0;
  }

  /** Get current CPU mode */
  getMode(): number {
    return this.cpsr & CPSR_MODE_MASK;
  }

  /** Set Negative flag */
  setN(val: boolean): void {
    if (val) {
      this.cpsr |= 1 << CPSR_N;
    } else {
      this.cpsr &= ~(1 << CPSR_N);
    }
  }

  /** Set Zero flag */
  setZ(val: boolean): void {
    if (val) {
      this.cpsr |= 1 << CPSR_Z;
    } else {
      this.cpsr &= ~(1 << CPSR_Z);
    }
  }

  /** Set Carry flag */
  setC(val: boolean): void {
    if (val) {
      this.cpsr |= 1 << CPSR_C;
    } else {
      this.cpsr &= ~(1 << CPSR_C);
    }
  }

  /** Set Overflow flag */
  setV(val: boolean): void {
    if (val) {
      this.cpsr |= 1 << CPSR_V;
    } else {
      this.cpsr &= ~(1 << CPSR_V);
    }
  }

  /** Set Thumb state bit */
  setT(val: boolean): void {
    if (val) {
      this.cpsr |= 1 << CPSR_T;
    } else {
      this.cpsr &= ~(1 << CPSR_T);
    }
  }

  /** Set all four condition flags at once from an AluResult */
  setFlags(n: boolean, z: boolean, c: boolean, v: boolean): void {
    this.setN(n);
    this.setZ(z);
    this.setC(c);
    this.setV(v);
  }

  /** Set NZ flags from a result value, leave C and V unchanged */
  setNZ(result: number): void {
    const u = result >>> 0;
    this.setN((u & 0x80000000) !== 0);
    this.setZ(u === 0);
  }

  // ─── SPSR Access ─────────────────────────────────────────────────

  /** Get the SPSR for the current mode. Returns 0 for USR/SYS (no SPSR). */
  getSPSR(): number {
    const mode = this.getMode();
    const idx = SPSR_BANK_INDEX[mode];
    if (idx === undefined) {
      return 0;
    }
    return this.#spsr[idx]!;
  }

  /** Set the SPSR for the current mode. No-op for USR/SYS. */
  setSPSR(value: number): void {
    const mode = this.getMode();
    const idx = SPSR_BANK_INDEX[mode];
    if (idx === undefined) {
      return;
    }
    this.#spsr[idx] = value;
  }

  // ─── Mode Switching ──────────────────────────────────────────────

  /**
   * Switch CPU mode. Saves banked registers from the old mode
   * and restores them for the new mode.
   */
  switchMode(newMode: number): void {
    const oldMode = this.getMode();
    if (oldMode === newMode) {
      return;
    }

    if (!isValidMode(newMode)) {
      return;
    }

    // Save registers for old mode
    this.#saveBankedRegisters(oldMode);

    // Update CPSR mode bits
    this.cpsr = (this.cpsr & ~CPSR_MODE_MASK) | newMode;

    // Restore registers for new mode
    this.#restoreBankedRegisters(newMode);
  }

  /**
   * Save current SP/LR (and r8-r12 for FIQ) into the bank for the given mode.
   */
  #saveBankedRegisters(mode: number): void {
    // Save SP/LR for the old mode
    const bankIdx = SP_LR_BANK_INDEX[mode];
    if (bankIdx !== undefined) {
      this.#bankedSP[bankIdx] = this.registers[SP]!;
      this.#bankedLR[bankIdx] = this.registers[LR]!;
    }

    // FIQ also saves r8-r12
    if (mode === MODE_FIQ) {
      for (let i = 0; i < 5; i++) {
        this.#fiqBankedR8to12[i] = this.registers[8 + i]!;
      }
    } else {
      // Non-FIQ modes share USR r8-r12
      for (let i = 0; i < 5; i++) {
        this.#usrBankedR8to12[i] = this.registers[8 + i]!;
      }
    }
  }

  /**
   * Restore SP/LR (and r8-r12 for FIQ) from the bank for the given mode.
   */
  #restoreBankedRegisters(mode: number): void {
    // Restore SP/LR for the new mode
    const bankIdx = SP_LR_BANK_INDEX[mode];
    if (bankIdx !== undefined) {
      this.registers[SP] = this.#bankedSP[bankIdx]!;
      this.registers[LR] = this.#bankedLR[bankIdx]!;
    }

    // FIQ restores its own r8-r12
    if (mode === MODE_FIQ) {
      for (let i = 0; i < 5; i++) {
        this.registers[8 + i] = this.#fiqBankedR8to12[i]!;
      }
    } else {
      // Non-FIQ modes restore USR r8-r12
      for (let i = 0; i < 5; i++) {
        this.registers[8 + i] = this.#usrBankedR8to12[i]!;
      }
    }
  }

  // ─── Public API ──────────────────────────────────────────────────

  /**
   * Whether `step()` refuses to run because the CPU stopped itself at the sentinel return
   * address, as opposed to a debug hook having refused one instruction.
   */
  get halted(): boolean {
    return this.#halted;
  }

  /** Whether the last `step()` ran nothing because a debug hook refused the instruction at PC. */
  get refused(): boolean {
    return this.#refused;
  }

  /** Attach or detach debug hooks */
  setDebugHooks(hooks: DebugHooks | undefined): void {
    this.#hooks = hooks;
  }

  /**
   * Call `onExecute` every time the instruction at `address` is about to run, and
   * return a disposer. Several watchpoints may share an address, and registering one
   * does not disturb {@link setDebugHooks}.
   *
   * This is the only way to observe execution soundly. Sampling the PC between frames
   * sees whatever the CPU happens to be doing at a frame boundary — on a game that
   * idles in a BIOS wait loop, that is one address out of the thousands executed, so
   * every other address reads as "never reached".
   */
  addExecWatchpoint(address: number, onExecute: (address: number) => void): () => void {
    const key = address >>> 0;
    const list = this.#execWatch.get(key) ?? [];
    list.push(onExecute);
    this.#execWatch.set(key, list);
    this.#execWatchActive = true;
    return () => {
      const current = this.#execWatch.get(key);
      if (!current) {
        return;
      }
      const i = current.indexOf(onExecute);
      if (i >= 0) {
        current.splice(i, 1);
      }
      if (current.length === 0) {
        this.#execWatch.delete(key);
      }
      this.#execWatchActive = this.#execWatch.size > 0;
    };
  }

  /** Fire any execution watchpoints registered at `address`. */
  #fireExecWatch(address: number): void {
    const list = this.#execWatch.get(address);
    if (!list) {
      return;
    }
    // Copy: a callback may dispose itself (a one-shot wait is exactly that).
    for (const cb of list.slice()) {
      cb(address);
    }
  }

  /** Register a stub for an external function call */
  registerStub(symbolName: string): number {
    const addr = this.#nextStub;
    this.#stubs.set(addr, symbolName);
    // Write a "bx lr" (Thumb) at the stub
    this.memory.write16(addr, 0x4770);
    this.#nextStub += 4;
    return addr;
  }

  /** Serialize to a plain snapshot. */
  serialize(): CpuSnapshot {
    return {
      registers: new Uint32Array(this.registers),
      cpsr: this.cpsr,
      bankedSP: new Uint32Array(this.#bankedSP),
      bankedLR: new Uint32Array(this.#bankedLR),
      fiqBankedR8to12: new Uint32Array(this.#fiqBankedR8to12),
      usrBankedR8to12: new Uint32Array(this.#usrBankedR8to12),
      spsr: new Uint32Array(this.#spsr),
      halted: this.#halted,
      pipeline: Uint32Array.of(
        this.#pipelineAddress,
        this.#decodedOpcode,
        this.#fetchedOpcode,
        this.#pipelineThumb ? 1 : 0,
      ),
    };
  }

  /** Restore from a snapshot. */
  deserialize(snap: CpuSnapshot): void {
    this.registers.set(snap.registers);
    this.cpsr = snap.cpsr;
    this.#bankedSP.set(snap.bankedSP);
    this.#bankedLR.set(snap.bankedLR);
    this.#fiqBankedR8to12.set(snap.fiqBankedR8to12);
    this.#usrBankedR8to12.set(snap.usrBankedR8to12);
    this.#spsr.set(snap.spsr);
    this.#halted = snap.halted;
    // A snapshot from before the pipeline was modelled refills it from memory at the next step.
    const pipeline = snap.pipeline;
    this.#pipelineAddress = pipeline ? pipeline[0]! : PIPELINE_EMPTY;
    this.#decodedOpcode = pipeline ? pipeline[1]! : 0;
    this.#fetchedOpcode = pipeline ? pipeline[2]! : 0;
    this.#pipelineThumb = pipeline ? pipeline[3] === 1 : false;
  }

  /** Reset CPU state for a new execution */
  resetState(): void {
    this.registers.fill(0);
    this.cpsr = MODE_SYS | (1 << CPSR_I) | (1 << CPSR_F);
    this.#spsr.fill(0);
    this.#fiqBankedR8to12.fill(0);
    this.#usrBankedR8to12.fill(0);
    this.#bankedSP.fill(0);
    this.#bankedLR.fill(0);
    this.#externalCalls = [];
    this.#halted = false;
    this.#pipelineAddress = PIPELINE_EMPTY;
  }

  /**
   * The opcode the pipeline fetched last: [$+8] in ARM state and [$+4] in Thumb state while the
   * instruction at $ executes. It is the value an open-bus read returns (GBATEK "GBA Unpredictable
   * Things"; mGBA `cpu->prefetch[1]`).
   */
  get prefetchedOpcode(): number {
    return this.#fetchedOpcode;
  }

  /** The opcode in the decode stage: [$+4] in ARM state, [$+2] in Thumb state (mGBA `cpu->prefetch[0]`). */
  get decodedOpcode(): number {
    return this.#decodedOpcode;
  }

  /** Check if IRQs are disabled (CPSR I bit set) */
  irqDisabled(): boolean {
    return (this.cpsr & (1 << CPSR_I)) !== 0;
  }

  /**
   * Enter IRQ exception.
   *
   * Standard ARM7TDMI exception entry:
   * 1. Save CPSR to SPSR_irq
   * 2. Switch to IRQ mode
   * 3. Set LR_irq to return address (next instruction + 4)
   * 4. Set I bit (disable further IRQs)
   * 5. Clear T bit (enter ARM state)
   * 6. Set PC to IRQ vector (0x00000018)
   *
   * On the GBA the BIOS code at 0x18 (gba-emulator bios-image.ts) handles:
   * - Saving registers to IRQ stack
   * - Calling the user's handler from [0x03007FFC]
   * - Restoring registers and returning from IRQ
   *
   * Returns the cycles the entry takes: the N+S refill at the vector. With the S fetch the
   * interrupted instruction ended with, that is GBATEK's 2S+1N for an exception. The handler's
   * first instruction starts without a fetch of its own, which gives the time from a request to
   * the handler that mgba-suite's "Timer IRQ" tests measure on hardware.
   */
  enterIrq(): number {
    this.#cycles = 0;

    // Save current CPSR as SPSR_irq
    const savedCpsr = this.cpsr;

    // LR_irq = address of next instruction + 4
    // The CPU checks for IRQ between instructions, so PC points to the next instruction.
    // ARM7TDMI: LR_irq = PC + 4 (return via SUBS PC, LR, #4)
    const returnAddr = (this.registers[PC]! + 4) >>> 0;

    // Switch to IRQ mode (saves current SP/LR, restores IRQ SP/LR)
    this.switchMode(MODE_IRQ);

    // Set LR_irq to return address
    this.registers[LR] = returnAddr;

    // Set SPSR_irq
    this.setSPSR(savedCpsr);

    // Disable IRQs and enter ARM state
    this.cpsr |= 1 << CPSR_I; // Disable IRQs
    this.cpsr &= ~(1 << CPSR_T); // Enter ARM state

    // Jump to the BIOS IRQ vector; its stub calls the user handler.
    this.#branchTo(0x00000018);
    return this.#cycles;
  }

  /**
   * Enter the Software Interrupt exception: SVC mode with LR_svc the address of the instruction
   * after the SWI and SPSR_svc the CPSR it ran under, IRQs disabled, ARM state, PC at the 0x08
   * vector (GBATEK "ARM CPU Exceptions"). Called while the SWI executes, when registers[PC] already
   * holds that next address.
   */
  #enterSwi(): void {
    const savedCpsr = this.cpsr;
    const returnAddr = this.registers[PC]!;
    this.switchMode(MODE_SVC);
    this.registers[LR] = returnAddr;
    this.setSPSR(savedCpsr);
    this.cpsr |= 1 << CPSR_I;
    this.cpsr &= ~(1 << CPSR_T);
    this.#branchTo(0x00000008);
  }

  /** Enter Undefined Instruction exception */
  enterUnd(instrAddr: number): void {
    const savedCpsr = this.cpsr;
    const isThumb = !!(this.cpsr & (1 << CPSR_T));
    // LR_und = address of undefined instruction + 2 (Thumb) or + 4 (ARM)
    const returnAddr = isThumb ? (instrAddr + 2) >>> 0 : (instrAddr + 4) >>> 0;

    this.switchMode(MODE_UND);
    this.registers[LR] = returnAddr;
    this.setSPSR(savedCpsr);
    this.cpsr |= 1 << CPSR_I; // Disable IRQs
    this.cpsr &= ~(1 << CPSR_T); // Enter ARM state
    this.#branchTo(0x00000004); // UND vector
  }

  /**
   * Execute one instruction (ARM or Thumb based on T bit) and return the cycles it took: its data
   * accesses, internal cycles and branch refill, then the opcode fetch the next instruction begins
   * with. Returns 0 when nothing ran: the CPU is halted (`halted`), a debug hook refused the
   * instruction (`refused`), or the instruction halted the CPU at the sentinel return address.
   *
   * A PC set from outside (a host, the debugger, a snapshot) refills the pipeline here at no cost,
   * the first instruction's fetch included: only a branch the program takes pays for its refill.
   */
  step(): number {
    this.#refused = false;
    if (this.#halted) {
      return 0;
    }

    const pc = this.registers[PC]!;
    if (isSentinel(pc)) {
      this.#halted = true;
      return 0;
    }

    // Check stubs
    const pcAligned = this.getT() ? pc & ~1 : pc & ~3;
    const stubName = this.#stubs.get(pcAligned);
    if (stubName !== undefined) {
      this.#externalCalls.push({
        callSite: pcAligned,
        targetAddress: pcAligned,
        symbolName: stubName,
        r0: this.registers[0]!,
        r1: this.registers[1]!,
        r2: this.registers[2]!,
        r3: this.registers[3]!,
      });
      this.registers[0] = 0;
      const returnAddr = this.registers[LR]!;
      this.registers[PC] = returnAddr & ~1;
      return 1;
    }

    if (this.getT()) {
      return this.#stepThumb();
    } else {
      return this.#stepArm();
    }
  }

  /** Run until halt or instruction limit */
  run(maxInstructions: number): ExecutionResult {
    const trackable = this.memory as {
      resetWriteLog?: () => void;
      getWriteLog?: () => MemoryWrite[];
    };
    trackable.resetWriteLog?.();
    this.#externalCalls = [];

    let count = 0;
    while (count < maxInstructions && this.step()) {
      count++;
    }

    return {
      registers: new Uint32Array(this.registers),
      cpsr: this.flags,
      memoryWrites: trackable.getWriteLog?.() ?? [],
      externalCalls: [...this.#externalCalls],
      instructionsExecuted: count,
      completed: this.#halted,
    };
  }

  // ─── Pipeline and Register Helpers ───────────────────────────────

  /** Refill the pipeline from `address`: what a branch does in its two refill cycles. */
  #fillPipeline(address: number, thumb: boolean): void {
    if (thumb) {
      this.#decodedOpcode = this.memory.fetch16(address);
      this.#fetchedOpcode = this.memory.fetch16((address + 2) >>> 0);
    } else {
      this.#decodedOpcode = this.memory.fetch32(address);
      this.#fetchedOpcode = this.memory.fetch32((address + 4) >>> 0);
    }
    this.#pipelineAddress = address;
    this.#pipelineThumb = thumb;
    this.#nextFetchSequential = true;
  }

  /**
   * Write the PC as a branch does: aligned for the current instruction set (mGBA ARM_WRITE_PC and
   * THUMB_WRITE_PC mask with -WORD_SIZE), with the pipeline refilled from the target. The refill
   * is an N fetch of the target and an S fetch of the opcode after it, the 1N+1S every branch adds
   * to the instruction's own fetch (GBATEK: B 2S+1N).
   */
  #branchTo(target: number): void {
    const thumb = this.getT();
    const width = thumb ? 2 : 4;
    const address = (thumb ? target & ~1 : target & ~3) >>> 0;
    this.registers[PC] = address;
    this.#cycles +=
      this.memory.fetchCycles(address, width, false) + this.memory.fetchCycles((address + width) >>> 0, width, true);
    this.#fillPipeline(address, thumb);
  }

  // ─── Cycle Accounting ────────────────────────────────────────────

  /**
   * The opcode fetch that ends an instruction: the one the next instruction's first cycle makes,
   * [$+8] in ARM state and [$+4] in Thumb state of that instruction. Counting it here puts the
   * clock, between two instructions, after that fetch, at the cycle the next instruction's first
   * data access happens, which is when its I/O sees the hardware.
   */
  #chargeNextFetch(): void {
    const width = this.#pipelineThumb ? 2 : 4;
    const address = (this.#pipelineAddress + 2 * width) >>> 0;
    this.#cycles += this.memory.fetchCycles(address, width, this.#nextFetchSequential);
  }

  /** A data access, in its place among the instruction's cycles; the next fetch is nonsequential. */
  #chargeAccess(address: number, width: 1 | 2 | 4, sequential: boolean): void {
    this.#cycles += this.memory.dataCycles(address, width, sequential);
    this.#nextFetchSequential = false;
  }

  /** Internal cycles, which leave the bus alone; the next fetch is nonsequential. */
  #chargeInternal(cycles: number): void {
    this.memory.idle(cycles);
    this.#cycles += cycles;
    this.#nextFetchSequential = false;
  }

  /** A load: its N data cycle, then the I cycle that writes the register (GBATEK LDR: 1S+1N+1I). */
  #chargeLoad(address: number, width: 1 | 2 | 4): void {
    this.#chargeAccess(address, width, false);
    this.#chargeInternal(1);
  }

  /** A store: its N data cycle (GBATEK STR: 2N, the store and the nonsequential fetch after it). */
  #chargeStore(address: number, width: 1 | 2 | 4): void {
    this.#chargeAccess(address, width, false);
  }

  /**
   * Restore the CPSR from the current mode's SPSR, the return from an exception. USR and SYS have
   * no SPSR, and there the CPSR stays as it is (mGBA `_ARMModeHasSPSR`). Returns whether it did.
   */
  #restoreCpsrFromSpsr(): boolean {
    const idx = SPSR_BANK_INDEX[this.getMode()];
    if (idx === undefined) {
      return false;
    }
    const spsr = this.#spsr[idx]!;
    // Switch first, so the banked registers of the old mode are saved and the new mode's restored.
    this.switchMode(spsr & CPSR_MODE_MASK);
    this.cpsr = spsr;
    return true;
  }

  /** Register `index` as User mode sees it, whatever the current mode (LDM/STM with the S bit). */
  #readUserRegister(index: number): number {
    const mode = this.getMode();
    if (index >= 8 && index <= 12 && mode === MODE_FIQ) {
      return this.#usrBankedR8to12[index - 8]!;
    }
    if ((index === SP || index === LR) && mode !== MODE_USR && mode !== MODE_SYS) {
      return index === SP ? this.#bankedSP[0]! : this.#bankedLR[0]!;
    }
    return this.registers[index]!;
  }

  /** Write register `index` of the User mode bank, whatever the current mode. */
  #writeUserRegister(index: number, value: number): void {
    const mode = this.getMode();
    if (index >= 8 && index <= 12 && mode === MODE_FIQ) {
      this.#usrBankedR8to12[index - 8] = value;
    } else if ((index === SP || index === LR) && mode !== MODE_USR && mode !== MODE_SYS) {
      if (index === SP) {
        this.#bankedSP[0] = value;
      } else {
        this.#bankedLR[0] = value;
      }
    } else {
      this.registers[index] = value;
    }
  }

  // The bus returns the aligned word or halfword (see MemoryBus); the CPU applies the ARM7TDMI
  // rules for a misaligned load (GBATEK "ARM.9 Single Data Transfer", "ARM.10 Halfword Transfer").

  /** LDR: a misaligned word load reads the aligned word rotated right by 8 per byte of offset. */
  #loadWord(address: number): number {
    const value = this.memory.read32(address);
    const rotation = (address & 3) * 8;
    return rotation === 0 ? value >>> 0 : ((value >>> rotation) | (value << (32 - rotation))) >>> 0;
  }

  /** LDRH: a misaligned halfword load reads the aligned halfword rotated right by 8. */
  #loadHalfword(address: number): number {
    const value = this.memory.read16(address);
    return address & 1 ? ((value >>> 8) | (value << 24)) >>> 0 : value;
  }

  /** LDRSH: a misaligned signed halfword load sign-extends the byte at the odd address. */
  #loadSignedHalfword(address: number): number {
    const value = this.memory.read16(address);
    return (address & 1 ? signExtend(value >>> 8, 8) : signExtend(value, 16)) >>> 0;
  }

  /** The value a load writes into `rd`. Loading the PC is a branch; ARMv4 keeps the state (no interworking). */
  #writeLoaded(rd: number, value: number): void {
    if (rd === PC) {
      this.#branchTo(value);
    } else {
      this.registers[rd] = value;
    }
  }

  // ─── Thumb Execution ─────────────────────────────────────────────

  /** Execute one Thumb instruction; returns its cycles, or 0 when nothing ran. */
  #stepThumb(): number {
    const instrAddr = (this.registers[PC]! & ~1) >>> 0;
    if (instrAddr !== this.#pipelineAddress || !this.#pipelineThumb) {
      this.#fillPipeline(instrAddr, true);
    }
    const instr = this.#decodedOpcode;

    if (this.#execWatchActive) {
      this.#fireExecWatch(instrAddr);
    }

    if (this.#hooks?.onInstructionPre) {
      const action = this.#hooks.onInstructionPre(instrAddr, instr);
      if (action === 'break') {
        this.#refused = true;
        return 0;
      }
    }

    // Fetch stage: [$+4] enters the pipeline before this instruction touches memory. The
    // instruction before paid for the fetch (#chargeNextFetch).
    const fetchAddress = (instrAddr + 4) >>> 0;
    this.#decodedOpcode = this.#fetchedOpcode;
    this.#fetchedOpcode = this.memory.fetch16(fetchAddress);
    this.#cycles = 0;
    this.#nextFetchSequential = true;
    this.#pipelineAddress = (instrAddr + 2) >>> 0;
    this.registers[PC] = (instrAddr + 2) >>> 0;
    this.#executeThumb(instr, instrAddr);

    if (!this.#halted) {
      this.#chargeNextFetch();
    }
    this.#hooks?.onInstructionPost?.(instrAddr, instr);
    return this.#halted ? 0 : this.#cycles;
  }

  /** Decode and execute a single 16-bit Thumb instruction. */
  #executeThumb(instr: number, instrAddr: number): void {
    const op = instr >>> 8;

    // Format 19: Long Branch with Link (BL) — two-part
    if ((instr & 0xf800) === 0xf000) {
      this.#thumbBlPrefix(instr);
      return;
    }
    if ((instr & 0xf800) === 0xf800) {
      this.#thumbBlSuffix(instr);
      return;
    }

    // Format 18: Unconditional Branch
    if ((instr & 0xf800) === 0xe000) {
      const offset11 = signExtend(instr & 0x7ff, 11);
      // ARM7TDMI pipeline: PC = instrAddr+4. registers[PC] = instrAddr+2, so add +2.
      this.#branchTo(this.registers[PC]! + 2 + offset11 * 2);
      return;
    }

    // ARMv4T leaves 0xE800-0xEFFF (BLX suffix on ARMv5) and 0xDE00-0xDEFF (B with condition AL)
    // undefined (mGBA src/arm/isa-thumb.c: ILL).
    if ((instr & 0xf800) === 0xe800 || (instr & 0xff00) === 0xde00) {
      this.enterUnd(instrAddr);
      return;
    }

    // Format 17: SWI
    if ((instr & 0xff00) === 0xdf00) {
      this.#softwareInterrupt(instr & 0xff);
      return;
    }

    // Format 16: Conditional Branch
    if ((instr & 0xf000) === 0xd000) {
      this.#thumbCondBranch(instr);
      return;
    }

    // Format 14: Push/Pop
    if ((instr & 0xf600) === 0xb400) {
      this.#thumbPushPop(instr);
      return;
    }

    // Format 13: Add offset to SP
    if ((op & 0xff) === 0xb0) {
      const s = bit(instr, 7);
      const offset7 = (instr & 0x7f) << 2;
      if (s === 0) {
        this.registers[SP] = (this.registers[SP]! + offset7) >>> 0;
      } else {
        this.registers[SP] = (this.registers[SP]! - offset7) >>> 0;
      }
      return;
    }

    // Format 11: SP-relative Load/Store
    if ((instr & 0xf000) === 0x9000) {
      const l = bit(instr, 11);
      const rd = bits(instr, 10, 8);
      const offset8 = (instr & 0xff) << 2;
      const address = (this.registers[SP]! + offset8) >>> 0;
      if (l === 1) {
        this.#chargeLoad(address, 4);
        this.registers[rd] = this.#loadWord(address);
      } else {
        this.#chargeStore(address, 4);
        this.memory.write32(address, this.registers[rd]!);
      }
      return;
    }

    // Format 12: Load Address
    if ((instr & 0xf000) === 0xa000) {
      const sp = bit(instr, 11);
      const rd = bits(instr, 10, 8);
      const offset8 = (instr & 0xff) << 2;
      if (sp === 0) {
        const base = ((this.registers[PC]! + 2) & ~3) >>> 0;
        this.registers[rd] = (base + offset8) >>> 0;
      } else {
        this.registers[rd] = (this.registers[SP]! + offset8) >>> 0;
      }
      return;
    }

    // Format 10: Load/Store Halfword Imm
    if ((instr & 0xf000) === 0x8000) {
      const l = bit(instr, 11);
      const offset5 = bits(instr, 10, 6);
      const rb = bits(instr, 5, 3);
      const rd = bits(instr, 2, 0);
      const address = (this.registers[rb]! + (offset5 << 1)) >>> 0;
      if (l === 1) {
        this.#chargeLoad(address, 2);
        this.registers[rd] = this.#loadHalfword(address);
      } else {
        this.#chargeStore(address, 2);
        this.memory.write16(address, this.registers[rd]!);
      }
      return;
    }

    // Format 9: Load/Store Imm Offset
    if ((instr & 0xe000) === 0x6000) {
      this.#thumbImmOffsetLoadStore(instr);
      return;
    }

    // Format 8: Load/Store Sign-Extended
    if ((instr & 0xf200) === 0x5200) {
      this.#thumbSignExtLoadStore(instr);
      return;
    }

    // Format 7: Load/Store Register Offset
    if ((instr & 0xf200) === 0x5000) {
      this.#thumbRegOffsetLoadStore(instr);
      return;
    }

    // Format 6: PC-Relative Load
    if ((instr & 0xf800) === 0x4800) {
      const rd = bits(instr, 10, 8);
      const offset8 = (instr & 0xff) << 2;
      const base = ((this.registers[PC]! + 2) & ~3) >>> 0;
      const address = (base + offset8) >>> 0;
      this.#chargeLoad(address, 4);
      this.registers[rd] = this.#loadWord(address);
      return;
    }

    // Format 5: Hi Register Ops / BX
    if ((instr & 0xfc00) === 0x4400) {
      this.#thumbHiRegBx(instr);
      return;
    }

    // Format 4: ALU Operations
    if ((instr & 0xfc00) === 0x4000) {
      this.#thumbAluOp(instr);
      return;
    }

    // Format 3: Move/Compare/Add/Sub Immediate
    if ((instr & 0xe000) === 0x2000) {
      this.#thumbImmOp(instr);
      return;
    }

    // Format 2: Add/Subtract
    if ((instr & 0xf800) === 0x1800) {
      this.#thumbAddSub(instr);
      return;
    }

    // Format 1: Move Shifted Register
    if ((instr & 0xe000) === 0x0000) {
      this.#thumbShifted(instr);
      return;
    }

    // Format 15: Multiple Load/Store
    if ((instr & 0xf000) === 0xc000) {
      this.#thumbBlockTransfer(instr);
      return;
    }
  }

  // ── Thumb instruction implementations ─────────────────────────────

  #thumbShifted(instr: number): void {
    const op = bits(instr, 12, 11);
    const offset5 = bits(instr, 10, 6);
    const rs = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const rsVal = this.registers[rs]! | 0;
    let result: number;
    let carry: boolean;
    switch (op) {
      case 0:
        [result, carry] = lsl(rsVal, offset5, this.getC());
        break;
      case 1:
        [result, carry] = lsr(rsVal, offset5, this.getC(), true);
        break;
      case 2:
        [result, carry] = asr(rsVal, offset5, this.getC(), true);
        break;
      default:
        return;
    }
    this.registers[rd] = result >>> 0;
    this.setN((result & 0x80000000) !== 0);
    this.setZ(result >>> 0 === 0);
    this.setC(carry);
  }

  #thumbAddSub(instr: number): void {
    const i = bit(instr, 10);
    const op = bit(instr, 9);
    const rnImm = bits(instr, 8, 6);
    const rs = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const rsVal = this.registers[rs]!;
    const operand = i === 1 ? rnImm : this.registers[rnImm]!;
    const alu = op === 0 ? addWithFlags(rsVal | 0, operand | 0) : subWithFlags(rsVal | 0, operand | 0);
    this.registers[rd] = alu.value >>> 0;
    this.setFlags(alu.n, alu.z, alu.c, alu.v);
  }

  #thumbImmOp(instr: number): void {
    const op = bits(instr, 12, 11);
    const rd = bits(instr, 10, 8);
    const imm8 = instr & 0xff;
    const rdVal = this.registers[rd]!;
    switch (op) {
      case 0: // MOV
        this.registers[rd] = imm8;
        this.setN(false);
        this.setZ(imm8 === 0);
        return;
      case 1: {
        // CMP
        const alu = subWithFlags(rdVal | 0, imm8);
        this.setFlags(alu.n, alu.z, alu.c, alu.v);
        return;
      }
      case 2: {
        // ADD
        const alu = addWithFlags(rdVal | 0, imm8);
        this.registers[rd] = alu.value >>> 0;
        this.setFlags(alu.n, alu.z, alu.c, alu.v);
        return;
      }
      case 3: {
        // SUB
        const alu = subWithFlags(rdVal | 0, imm8);
        this.registers[rd] = alu.value >>> 0;
        this.setFlags(alu.n, alu.z, alu.c, alu.v);
        return;
      }
    }
  }

  #thumbAluOp(instr: number): void {
    const op = bits(instr, 9, 6);
    const rs = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const rdVal = this.registers[rd]! | 0;
    const rsVal = this.registers[rs]! | 0;
    let result: number;
    let carry = this.getC();
    let overflow = this.getV();
    let writeResult = true;

    switch (op) {
      case 0x0:
        result = rdVal & rsVal;
        break;
      case 0x1:
        result = rdVal ^ rsVal;
        break;
      // A shift by a register spends an I cycle reading the amount (GBATEK THUMB.4: 1S+1I).
      case 0x2: {
        const amount = rsVal & 0xff;
        [result, carry] = lsl(rdVal, amount, this.getC());
        this.#chargeInternal(1);
        break;
      }
      case 0x3: {
        const amount = rsVal & 0xff;
        [result, carry] = lsr(rdVal, amount, this.getC());
        this.#chargeInternal(1);
        break;
      }
      case 0x4: {
        const amount = rsVal & 0xff;
        [result, carry] = asr(rdVal, amount, this.getC());
        this.#chargeInternal(1);
        break;
      }
      case 0x5: {
        const alu = addWithFlags(rdVal, rsVal, this.getC() ? 1 : 0);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        break;
      }
      case 0x6: {
        const alu = subWithFlags(rdVal, rsVal, this.getC() ? 1 : 0);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        break;
      }
      case 0x7: {
        const amount = rsVal & 0xff;
        [result, carry] = ror(rdVal, amount, this.getC());
        this.#chargeInternal(1);
        break;
      }
      case 0x8:
        result = rdVal & rsVal;
        writeResult = false;
        break;
      case 0x9: {
        const alu = subWithFlags(0, rsVal);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        break;
      }
      case 0xa: {
        const alu = subWithFlags(rdVal, rsVal);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        writeResult = false;
        break;
      }
      case 0xb: {
        const alu = addWithFlags(rdVal, rsVal);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        writeResult = false;
        break;
      }
      case 0xc:
        result = rdVal | rsVal;
        break;
      case 0xd:
        // MUL Rd, Rs is MULS Rd, Rs, Rd: Rd is the multiplier.
        result = Math.imul(rdVal, rsVal);
        carry = multiplyCarry(rsVal, rdVal, 0);
        this.#chargeInternal(multiplierCycles(rdVal, true));
        break;
      case 0xe:
        result = rdVal & ~rsVal;
        break;
      case 0xf:
        result = ~rsVal;
        break;
      default:
        return;
    }

    if (writeResult) {
      this.registers[rd] = result >>> 0;
    }
    this.setN((result & 0x80000000) !== 0);
    this.setZ(result >>> 0 === 0);
    this.setC(carry);
    this.setV(overflow);
  }

  #thumbHiRegBx(instr: number): void {
    const op = bits(instr, 9, 8);
    const hd = bit(instr, 7);
    const hs = bit(instr, 6);
    const rs = bits(instr, 5, 3) | (hs << 3);
    const rd = bits(instr, 2, 0) | (hd << 3);
    let rsVal = this.registers[rs]!;
    // Pipeline correction: PC reads as instrAddr + 4 in Thumb mode
    if (rs === PC) {
      rsVal = (rsVal + 2) >>> 0;
    }

    // Pipeline correction for Rd=PC (reads as instrAddr + 4)
    let rdVal = this.registers[rd]!;
    if (rd === PC) {
      rdVal = (rdVal + 2) >>> 0;
    }

    switch (op) {
      case 0: // ADD
        if (rd === PC) {
          this.#branchTo(rdVal + rsVal);
        } else {
          this.registers[rd] = (rdVal + rsVal) >>> 0;
        }
        break;
      case 1: {
        // CMP
        const alu = subWithFlags(rdVal | 0, rsVal | 0);
        this.setFlags(alu.n, alu.z, alu.c, alu.v);
        break;
      }
      case 2: // MOV
        if (rd === PC) {
          this.#branchTo(rsVal);
        } else {
          this.registers[rd] = rsVal;
        }
        break;
      case 3: // BX
        if (isSentinel(rsVal)) {
          this.#halted = true;
          return;
        }
        // T bit determined by bit 0; an ARM target is word-aligned.
        this.setT((rsVal & 1) !== 0);
        this.#branchTo(rsVal);
        break;
    }
  }

  #thumbRegOffsetLoadStore(instr: number): void {
    const l = bit(instr, 11);
    const b = bit(instr, 10);
    const ro = bits(instr, 8, 6);
    const rb = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const address = (this.registers[rb]! + this.registers[ro]!) >>> 0;
    const width = b === 1 ? 1 : 4;
    if (l === 1) {
      this.#chargeLoad(address, width);
      this.registers[rd] = b === 1 ? this.memory.read8(address) : this.#loadWord(address);
    } else {
      this.#chargeStore(address, width);
      if (b === 1) {
        this.memory.write8(address, this.registers[rd]!);
      } else {
        this.memory.write32(address, this.registers[rd]!);
      }
    }
  }

  #thumbSignExtLoadStore(instr: number): void {
    const h = bit(instr, 11);
    const s = bit(instr, 10);
    const ro = bits(instr, 8, 6);
    const rb = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const address = (this.registers[rb]! + this.registers[ro]!) >>> 0;
    if (s === 0 && h === 0) {
      this.#chargeStore(address, 2);
      this.memory.write16(address, this.registers[rd]!);
      return;
    }
    // LDRSB reads a byte, LDRH and LDRSH a halfword.
    this.#chargeLoad(address, s === 1 && h === 0 ? 1 : 2);
    if (s === 0) {
      this.registers[rd] = this.#loadHalfword(address);
    } else if (h === 0) {
      this.registers[rd] = signExtend(this.memory.read8(address), 8) >>> 0;
    } else {
      this.registers[rd] = this.#loadSignedHalfword(address);
    }
  }

  #thumbImmOffsetLoadStore(instr: number): void {
    const b = bit(instr, 12);
    const l = bit(instr, 11);
    const offset5 = bits(instr, 10, 6);
    const rb = bits(instr, 5, 3);
    const rd = bits(instr, 2, 0);
    const base = this.registers[rb]!;
    const offset = b === 0 ? offset5 << 2 : offset5;
    const address = (base + offset) >>> 0;
    const width = b === 1 ? 1 : 4;
    if (l === 1) {
      this.#chargeLoad(address, width);
      this.registers[rd] = b === 1 ? this.memory.read8(address) : this.#loadWord(address);
    } else {
      this.#chargeStore(address, width);
      if (b === 1) {
        this.memory.write8(address, this.registers[rd]!);
      } else {
        this.memory.write32(address, this.registers[rd]!);
      }
    }
  }

  /** Format 14: PUSH is STMDB SP! with LR as bit 14; POP is LDMIA SP! with PC as bit 15. */
  #thumbPushPop(instr: number): void {
    const load = bit(instr, 11) === 1;
    const extra = bit(instr, 8) === 1 ? (load ? 1 << PC : 1 << LR) : 0;
    const rlist = (instr & 0xff) | extra;
    // A stored PC (empty list) is instrAddr+6: registers[PC] is instrAddr+2.
    this.#blockTransfer(SP, rlist, load, !load, load, true, false, (this.registers[PC]! + 4) >>> 0);
  }

  /** Format 15: LDMIA/STMIA Rb!, {Rlist}. */
  #thumbBlockTransfer(instr: number): void {
    const load = bit(instr, 11) === 1;
    const rb = bits(instr, 10, 8);
    this.#blockTransfer(rb, instr & 0xff, load, false, true, true, false, (this.registers[PC]! + 4) >>> 0);
  }

  #thumbCondBranch(instr: number): void {
    const cond = bits(instr, 11, 8);
    const offset8 = signExtend(instr & 0xff, 8);
    if (!checkCondition(cond, this.getN(), this.getZ(), this.getC(), this.getV())) {
      return;
    }
    // ARM7TDMI pipeline: PC reads as instrAddr+4 in Thumb mode.
    // registers[PC] is instrAddr+2 (pre-incremented), so add +2 for pipeline.
    this.#branchTo(this.registers[PC]! + 2 + offset8 * 2);
  }

  #thumbBlPrefix(instr: number): void {
    const offset11 = signExtend(instr & 0x7ff, 11);
    // ARM7TDMI pipeline: PC = instrAddr+4. registers[PC] = instrAddr+2, so add +2.
    this.registers[LR] = (this.registers[PC]! + 2 + (offset11 << 12)) >>> 0;
  }

  #thumbBlSuffix(instr: number): void {
    const offset11 = (instr & 0x7ff) << 1;
    const target = (this.registers[LR]! + offset11) >>> 0;
    this.registers[LR] = (this.registers[PC]! | 1) >>> 0;
    this.#branchTo(target);
  }

  // ─── ARM Execution ───────────────────────────────────────────────

  /** Execute one ARM (32-bit) instruction; returns its cycles, or 0 when nothing ran. */
  #stepArm(): number {
    const instrAddr = (this.registers[PC]! & ~3) >>> 0;
    if (instrAddr !== this.#pipelineAddress || this.#pipelineThumb) {
      this.#fillPipeline(instrAddr, false);
    }
    const instr = this.#decodedOpcode;

    if (this.#execWatchActive) {
      this.#fireExecWatch(instrAddr);
    }

    if (this.#hooks?.onInstructionPre) {
      const action = this.#hooks.onInstructionPre(instrAddr, instr);
      if (action === 'break') {
        this.#refused = true;
        return 0;
      }
    }

    // Fetch stage: [$+8] enters the pipeline before this instruction touches memory, one whose
    // condition fails included. The instruction before paid for the fetch (#chargeNextFetch).
    const fetchAddress = (instrAddr + 8) >>> 0;
    this.#decodedOpcode = this.#fetchedOpcode;
    this.#fetchedOpcode = this.memory.fetch32(fetchAddress);
    this.#cycles = 0;
    this.#nextFetchSequential = true;
    this.#pipelineAddress = (instrAddr + 4) >>> 0;
    this.registers[PC] = (instrAddr + 4) >>> 0;

    // Check condition code (bits 31-28)
    const cond = (instr >>> 28) & 0xf;
    if (checkCondition(cond, this.getN(), this.getZ(), this.getC(), this.getV())) {
      this.#executeArm(instr, instrAddr);
    }

    if (!this.#halted) {
      this.#chargeNextFetch();
    }
    this.#hooks?.onInstructionPost?.(instrAddr, instr);
    return this.#halted ? 0 : this.#cycles;
  }

  /**
   * Decode and execute a single 32-bit ARM instruction.
   *
   * ARM instruction categories by bits 27-25:
   * - 00x: Data Processing / Multiply / Misc
   * - 010: Load/Store Word/Byte (immediate offset)
   * - 011: Load/Store Word/Byte (register offset)
   * - 100: Block Data Transfer (LDM/STM)
   * - 101: Branch (B/BL)
   * - 110: Coprocessor (undefined for GBA)
   * - 111: SWI / Coprocessor
   */
  #executeArm(instr: number, instrAddr: number): void {
    const bits27_25 = bits(instr, 27, 25);

    switch (bits27_25) {
      case 0b000:
      case 0b001:
        this.#armDataProcessingOrMisc(instr, instrAddr);
        break;
      case 0b010:
        this.#armSingleDataTransferImm(instr);
        break;
      case 0b011:
        if (bit(instr, 4) === 0) {
          this.#armSingleDataTransferReg(instr);
        } else {
          // Undefined instruction on ARM7TDMI
          this.enterUnd(instrAddr);
        }
        break;
      case 0b100:
        this.#armBlockDataTransfer(instr);
        break;
      case 0b101:
        this.#armBranch(instr, instrAddr);
        break;
      case 0b110:
      case 0b111:
        if (bits27_25 === 0b111 && bit(instr, 24) === 1) {
          this.#armSwi(instr);
        } else {
          // Coprocessor transfers and operations: the GBA has no coprocessor to answer them, so
          // they take the undefined instruction trap (mGBA ARM_ILL raises the UND exception).
          this.enterUnd(instrAddr);
        }
        break;
    }
  }

  // ─── ARM Data Processing / Misc ──────────────────────────────────

  /**
   * Handle ARM data processing instructions and miscellaneous instructions
   * that share the same top bits (27-25 = 00x).
   */
  #armDataProcessingOrMisc(instr: number, _instrAddr: number): void {
    // Check for multiplies: bits 27-22=000000, bits 7-4=1001
    if ((instr & 0x0fc000f0) === 0x00000090) {
      this.#armMultiply(instr);
      return;
    }

    // Check for long multiplies: bits 27-23=00001, bits 7-4=1001
    if ((instr & 0x0f8000f0) === 0x00800090) {
      this.#armMultiplyLong(instr);
      return;
    }

    // Check for single data swap: bits 27-23=00010, bits 11-4=00001001
    if ((instr & 0x0fb00ff0) === 0x01000090) {
      this.#armSwap(instr);
      return;
    }

    // Check for BX: 0001_0010_1111_1111_1111_0001
    if ((instr & 0x0ffffff0) === 0x012fff10) {
      this.#armBx(instr);
      return;
    }

    // Check for halfword/signed transfers: bits 27-25=000, bit7=1, bit4=1
    // But NOT multiply (already checked above)
    if ((instr & 0x0e000090) === 0x00000090 && (instr & 0x00000060) !== 0) {
      this.#armHalfwordTransfer(instr);
      return;
    }

    // Check for MRS: bits 27-23=00010, bits 21-20=00, bits 11-0=0000_0000_0000
    if ((instr & 0x0fbf0fff) === 0x010f0000) {
      this.#armMrs(instr);
      return;
    }

    // Check for MSR (register): bits 27-25=000, bits 24-23=10, bit 21=1, bit 20=0,
    // bits 15-12=1111, bits 11-4=00000000. Field mask (bits 19-16) varies.
    if ((instr & 0x0fb0fff0) === 0x0120f000) {
      this.#armMsrReg(instr);
      return;
    }

    // Check for MSR (immediate): bits 27-25=001, bits 24-23=10, bit 21=1, bit 20=0,
    // bits 15-12=1111. Field mask (bits 19-16) varies.
    if ((instr & 0x0fb0f000) === 0x0320f000) {
      this.#armMsrImm(instr);
      return;
    }

    // Data Processing instruction
    this.#armDataProcessing(instr);
  }

  /** ARM barrel shifter: compute the shifter operand and carry out */
  #armBarrelShifter(instr: number, isImmediate: boolean): [number, boolean] {
    if (isImmediate) {
      // Immediate: 8-bit value rotated right by 2*rotate4
      const imm8 = instr & 0xff;
      const rotate = ((instr >>> 8) & 0xf) * 2;
      if (rotate === 0) {
        return [imm8, this.getC()];
      }
      const result = (imm8 >>> rotate) | (imm8 << (32 - rotate)) | 0;
      return [result, ((result >>> 31) & 1) !== 0];
    }

    // Register operand
    const rm = instr & 0xf;
    let rmVal = this.registers[rm]!;
    const shiftType = (instr >>> 5) & 0x3;
    const regShift = bit(instr, 4);

    // ARM7TDMI pipeline: PC reads as instrAddr+8 normally, instrAddr+12 with register shift.
    // registers[PC] = instrAddr+4, so add +4 or +8 respectively.
    if (rm === PC) {
      rmVal = (rmVal + (regShift ? 8 : 4)) >>> 0;
    }

    let amount: number;
    if (regShift) {
      // Register-specified shift amount (Rs), read in an I cycle (GBATEK ARM.5: +1I).
      const rsReg = (instr >>> 8) & 0xf;
      amount = this.registers[rsReg]! & 0xff;
      this.#chargeInternal(1);
    } else {
      // Immediate-specified shift amount
      amount = (instr >>> 7) & 0x1f;
    }

    switch (shiftType) {
      case 0: // LSL
        return lsl(rmVal | 0, amount, this.getC());
      case 1: // LSR
        return lsr(rmVal | 0, amount, this.getC(), !regShift);
      case 2: // ASR
        return asr(rmVal | 0, amount, this.getC(), !regShift);
      case 3: // ROR
        if (!regShift && amount === 0) {
          // RRX (rotate right extended): shift right by 1, carry in from CPSR.C
          const carry = (rmVal & 1) !== 0;
          const result = (this.getC() ? 0x80000000 : 0) | (rmVal >>> 1) | 0;
          return [result, carry];
        }
        return ror(rmVal | 0, amount, this.getC());
      default:
        return [rmVal, this.getC()];
    }
  }

  /** ARM data processing instructions */
  #armDataProcessing(instr: number): void {
    const isImm = bit(instr, 25);
    const opcode = bits(instr, 24, 21);
    const setFlags = bit(instr, 20) === 1;
    const rn = bits(instr, 19, 16);
    const rd = bits(instr, 15, 12);

    const [op2, shifterCarry] = this.#armBarrelShifter(instr, isImm === 1);

    // ARM7TDMI pipeline: PC reads as instrAddr+8 for data processing.
    // registers[PC] = instrAddr+4, so add +4 for Rn=PC.
    // For register-shifted: PC reads as instrAddr+12, so add +8.
    const regShift = isImm === 0 && bit(instr, 4) === 1;
    let rnVal = this.registers[rn]!;
    if (rn === PC) {
      rnVal = (rnVal + (regShift ? 8 : 4)) >>> 0;
    }

    let result: number;
    let carry = shifterCarry;
    let overflow = this.getV();
    let writeResult = true;

    switch (opcode) {
      case 0x0: // AND
        result = rnVal & op2;
        break;
      case 0x1: // EOR
        result = rnVal ^ op2;
        break;
      case 0x2: {
        // SUB
        const alu = subWithFlags(rnVal | 0, op2 | 0);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        break;
      }
      case 0x3: {
        // RSB
        const alu = subWithFlags(op2 | 0, rnVal | 0);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        break;
      }
      case 0x4: {
        // ADD
        const alu = addWithFlags(rnVal | 0, op2 | 0);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        break;
      }
      case 0x5: {
        // ADC
        const alu = addWithFlags(rnVal | 0, op2 | 0, this.getC() ? 1 : 0);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        break;
      }
      case 0x6: {
        // SBC
        const alu = subWithFlags(rnVal | 0, op2 | 0, this.getC() ? 1 : 0);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        break;
      }
      case 0x7: {
        // RSC
        const alu = subWithFlags(op2 | 0, rnVal | 0, this.getC() ? 1 : 0);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        break;
      }
      case 0x8: // TST
        result = rnVal & op2;
        writeResult = false;
        break;
      case 0x9: // TEQ
        result = rnVal ^ op2;
        writeResult = false;
        break;
      case 0xa: {
        // CMP
        const alu = subWithFlags(rnVal | 0, op2 | 0);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        writeResult = false;
        break;
      }
      case 0xb: {
        // CMN
        const alu = addWithFlags(rnVal | 0, op2 | 0);
        result = alu.value;
        carry = alu.c;
        overflow = alu.v;
        writeResult = false;
        break;
      }
      case 0xc: // ORR
        result = rnVal | op2;
        break;
      case 0xd: // MOV
        result = op2;
        break;
      case 0xe: // BIC
        result = rnVal & ~op2;
        break;
      case 0xf: // MVN
        result = ~op2;
        break;
      default:
        return;
    }

    // With S=1 and Rd=PC the instruction returns from an exception: the CPSR comes back from the
    // SPSR. A mode without an SPSR sets the flags as usual instead (mGBA ARM_ADDITION_S etc.).
    const restoredCpsr = setFlags && rd === PC && this.#restoreCpsrFromSpsr();
    if (setFlags && !restoredCpsr) {
      this.setN((result & 0x80000000) !== 0);
      this.setZ(result >>> 0 === 0);
      this.setC(carry);
      this.setV(overflow);
    }

    if (writeResult) {
      if (rd === PC) {
        // A branch in the state the CPSR now holds.
        this.#branchTo(result);
      } else {
        this.registers[rd] = result >>> 0;
      }
    }
  }

  // ─── ARM Multiply ────────────────────────────────────────────────

  /** ARM multiply: MUL, MLA */
  #armMultiply(instr: number): void {
    const accumulate = bit(instr, 21) === 1;
    const setFlags = bit(instr, 20) === 1;
    const rd = bits(instr, 19, 16);
    const rn = bits(instr, 15, 12);
    const rs = bits(instr, 11, 8);
    const rm = instr & 0xf;

    const multiplicand = this.registers[rm]!;
    const multiplier = this.registers[rs]!;
    const accumulator = accumulate ? this.registers[rn]! : 0;
    const result = (Math.imul(multiplicand, multiplier) + accumulator) | 0;
    this.#chargeInternal(multiplierCycles(multiplier, true) + (accumulate ? 1 : 0));

    this.registers[rd] = result >>> 0;

    if (setFlags) {
      this.setN((result & 0x80000000) !== 0);
      this.setZ(result >>> 0 === 0);
      // C is the multiplier's internal carry (multiply-carry.ts); V is unchanged.
      this.setC(multiplyCarry(multiplicand, multiplier, accumulator));
    }
  }

  /** ARM long multiply: UMULL, UMLAL, SMULL, SMLAL */
  #armMultiplyLong(instr: number): void {
    const isSigned = bit(instr, 22) === 1;
    const accumulate = bit(instr, 21) === 1;
    const setFlags = bit(instr, 20) === 1;
    const rdHi = bits(instr, 19, 16);
    const rdLo = bits(instr, 15, 12);
    const multiplicand = this.registers[instr & 0xf]!;
    const multiplier = this.registers[bits(instr, 11, 8)]!;
    const accLo = accumulate ? this.registers[rdLo]! : 0;
    const accHi = accumulate ? this.registers[rdHi]! : 0;
    this.#chargeInternal(multiplierCycles(multiplier, isSigned) + (accumulate ? 2 : 1));

    // 32x32 -> 64 with BigInt for 64-bit precision, plus RdHi:RdLo for UMLAL/SMLAL.
    const product = isSigned
      ? BigInt(multiplicand | 0) * BigInt(multiplier | 0)
      : BigInt(multiplicand >>> 0) * BigInt(multiplier >>> 0);
    const sum = product + ((BigInt(accHi >>> 0) << 32n) | BigInt(accLo >>> 0));
    const resultLo = Number(sum & 0xffffffffn) >>> 0;
    const resultHi = Number((sum >> 32n) & 0xffffffffn) >>> 0;

    this.registers[rdLo] = resultLo;
    this.registers[rdHi] = resultHi;

    if (setFlags) {
      this.setN((resultHi & 0x80000000) !== 0);
      this.setZ(resultHi === 0 && resultLo === 0);
      // C is the multiplier's internal carry (multiply-carry.ts); V is unchanged.
      this.setC(multiplyLongCarry(multiplicand, multiplier, accLo, accHi, isSigned));
    }
  }

  // ─── ARM Swap ────────────────────────────────────────────────────

  /** ARM SWP/SWPB: atomic swap */
  #armSwap(instr: number): void {
    const byteMode = bit(instr, 22) === 1;
    const rn = bits(instr, 19, 16);
    const rd = bits(instr, 15, 12);
    const rm = instr & 0xf;
    const address = this.registers[rn]!;

    // A load and a store to the same address, each N, then the I cycle that writes Rd: GBATEK SWP
    // 1S+2N+1I.
    const width = byteMode ? 1 : 4;
    this.#chargeAccess(address, width, false);
    this.#chargeAccess(address, width, false);
    this.#chargeInternal(1);

    if (byteMode) {
      const temp = this.memory.read8(address);
      this.memory.write8(address, this.registers[rm]! & 0xff);
      this.registers[rd] = temp;
    } else {
      // SWP: the load rotates a misaligned word like LDR does.
      const temp = this.#loadWord(address);
      this.memory.write32(address, this.registers[rm]!);
      this.registers[rd] = temp;
    }
  }

  // ─── ARM Branch Exchange ─────────────────────────────────────────

  /** ARM BX: branch and exchange instruction set */
  #armBx(instr: number): void {
    const rm = instr & 0xf;
    const target = this.registers[rm]!;

    if (isSentinel(target)) {
      this.#halted = true;
      return;
    }

    this.setT((target & 1) !== 0);
    this.#branchTo(target);
  }

  // ─── ARM Branch ──────────────────────────────────────────────────

  /** ARM B/BL: branch (with optional link) */
  #armBranch(instr: number, instrAddr: number): void {
    const link = bit(instr, 24) === 1;
    const offset = signExtend(instr & 0x00ffffff, 24) << 2;

    if (link) {
      // LR = address of instruction after this one
      this.registers[LR] = (instrAddr + 4) >>> 0;
    }

    // ARM7TDMI pipeline: PC = instrAddr+8. registers[PC] = instrAddr+4, so add +4.
    this.#branchTo(this.registers[PC]! + 4 + offset);
  }

  // ─── ARM Single Data Transfer (LDR/STR) ─────────────────────────

  /** ARM LDR/STR with immediate offset */
  #armSingleDataTransferImm(instr: number): void {
    this.#armSingleDataTransfer(instr, instr & 0xfff);
  }

  /** ARM LDR/STR with register offset */
  #armSingleDataTransferReg(instr: number): void {
    // Compute shifted register offset
    const rm = instr & 0xf;
    const shiftType = bits(instr, 6, 5);
    const shiftAmount = bits(instr, 11, 7);
    let offset: number;

    const rmVal = this.registers[rm]!;
    switch (shiftType) {
      case 0: // LSL
        offset = shiftAmount === 0 ? rmVal : (rmVal << shiftAmount) >>> 0;
        break;
      case 1: // LSR
        offset = shiftAmount === 0 ? 0 : rmVal >>> shiftAmount;
        break;
      case 2: // ASR
        offset = shiftAmount === 0 ? (isNegative(rmVal) ? 0xffffffff : 0) : (rmVal | 0) >> shiftAmount;
        break;
      case 3: // ROR/RRX
        if (shiftAmount === 0) {
          // RRX
          offset = ((this.getC() ? 0x80000000 : 0) | (rmVal >>> 1)) >>> 0;
        } else {
          offset = ((rmVal >>> shiftAmount) | (rmVal << (32 - shiftAmount))) >>> 0;
        }
        break;
      default:
        offset = rmVal;
    }
    this.#armSingleDataTransfer(instr, offset);
  }

  /** LDR/STR/LDRB/STRB once the offset is known. */
  #armSingleDataTransfer(instr: number, offset: number): void {
    const pre = bit(instr, 24) === 1;
    const up = bit(instr, 23) === 1;
    const byteMode = bit(instr, 22) === 1;
    const writeback = !pre || bit(instr, 21) === 1; // post-indexed always writes back
    const load = bit(instr, 20) === 1;
    const rn = bits(instr, 19, 16);
    const rd = bits(instr, 15, 12);

    // Rn=PC reads instrAddr+8; registers[PC] is instrAddr+4.
    const base = rn === PC ? (this.registers[PC]! + 4) >>> 0 : this.registers[rn]!;
    const indexed = (up ? base + offset : base - offset) >>> 0;
    const address = pre ? indexed : base;

    if (load) {
      this.#chargeLoad(address, byteMode ? 1 : 4);
      const value = byteMode ? this.memory.read8(address) : this.#loadWord(address);
      // The base is written back before the loaded value, so `ldr r0, [r0], #4` keeps the data.
      if (writeback) {
        this.registers[rn] = indexed;
      }
      this.#writeLoaded(rd, value);
    } else {
      // A stored R15 is instrAddr+12 (GBATEK "ARM.9"; mGBA adds WORD_SIZE_ARM to PC+8).
      const value = rd === PC ? (this.registers[PC]! + 8) >>> 0 : this.registers[rd]!;
      this.#chargeStore(address, byteMode ? 1 : 4);
      if (byteMode) {
        this.memory.write8(address, value & 0xff);
      } else {
        this.memory.write32(address, value);
      }
      if (writeback) {
        this.registers[rn] = indexed;
      }
    }
  }

  // ─── ARM Halfword / Signed Transfer ──────────────────────────────

  /** ARM LDRH/STRH/LDRSB/LDRSH */
  #armHalfwordTransfer(instr: number): void {
    const pre = bit(instr, 24) === 1;
    const up = bit(instr, 23) === 1;
    const immOffset = bit(instr, 22) === 1;
    const writeback = !pre || bit(instr, 21) === 1; // post-indexed always writes back
    const load = bit(instr, 20) === 1;
    const rn = bits(instr, 19, 16);
    const rd = bits(instr, 15, 12);
    const sh = bits(instr, 6, 5); // S and H bits: 01=H, 10=SB, 11=SH

    // Immediate: high nibble | low nibble; register: Rm.
    const offset = immOffset ? ((instr >>> 4) & 0xf0) | (instr & 0xf) : this.registers[instr & 0xf]!;

    // Rn=PC reads instrAddr+8; registers[PC] is instrAddr+4.
    const base = rn === PC ? (this.registers[PC]! + 4) >>> 0 : this.registers[rn]!;
    const indexed = (up ? base + offset : base - offset) >>> 0;
    const address = pre ? indexed : base;

    if (load) {
      this.#chargeLoad(address, sh === 0b10 ? 1 : 2);
      let value: number;
      switch (sh) {
        case 0b01: // LDRH
          value = this.#loadHalfword(address);
          break;
        case 0b10: // LDRSB
          value = signExtend(this.memory.read8(address), 8) >>> 0;
          break;
        default: // LDRSH
          value = this.#loadSignedHalfword(address);
          break;
      }
      // The base is written back before the loaded value, so a load into Rn keeps the data.
      if (writeback) {
        this.registers[rn] = indexed;
      }
      this.#writeLoaded(rd, value);
    } else {
      // STRH (sh=01; the signed forms have no store on ARMv4). A stored R15 is instrAddr+12.
      if (sh === 0b01) {
        const value = rd === PC ? (this.registers[PC]! + 8) >>> 0 : this.registers[rd]!;
        this.#chargeStore(address, 2);
        this.memory.write16(address, value & 0xffff);
      }
      if (writeback) {
        this.registers[rn] = indexed;
      }
    }
  }

  // ─── ARM Block Data Transfer (LDM/STM) ───────────────────────────

  /** ARM LDM/STM */
  #armBlockDataTransfer(instr: number): void {
    const pre = bit(instr, 24) === 1;
    const up = bit(instr, 23) === 1;
    const sBit = bit(instr, 22) === 1;
    const writeback = bit(instr, 21) === 1;
    const load = bit(instr, 20) === 1;
    const rn = bits(instr, 19, 16);
    const rlist = instr & 0xffff;
    // A stored R15 is instrAddr+12: registers[PC] is instrAddr+4.
    this.#blockTransfer(rn, rlist, load, pre, up, writeback, sBit, (this.registers[PC]! + 8) >>> 0);
  }

  /**
   * The block transfer shared by ARM LDM/STM and Thumb PUSH/POP/LDMIA/STMIA (GBATEK "ARM.11 Block
   * Data Transfer", "THUMB.14", "THUMB.15"):
   * - Registers go lowest first to the lowest address. An empty list transfers R15 alone and
   *   moves the base by 0x40 (ARMv4).
   * - STM writes the base back after its first transfer, so a base that is not the first entry
   *   is stored as the new value. LDM writes it back before loading, so a loaded base wins.
   * - With the S bit, an LDM that loads R15 also restores the CPSR from the SPSR; any other S-bit
   *   transfer uses the User bank registers whatever the current mode.
   */
  #blockTransfer(
    rn: number,
    rlist: number,
    load: boolean,
    pre: boolean,
    up: boolean,
    writeback: boolean,
    sBit: boolean,
    storedPc: number,
  ): void {
    let list = rlist;
    let span = 0;
    for (let i = 0; i < 16; i++) {
      if (list & (1 << i)) {
        span += 4;
      }
    }
    if (list === 0) {
      list = 1 << PC;
      span = 0x40;
    }

    const base = this.registers[rn]!;
    const newBase = (up ? base + span : base - span) >>> 0;
    let address = (up ? (pre ? base + 4 : base) : pre ? base - span : base - span + 4) >>> 0;
    const loadsPc = load && (list & (1 << PC)) !== 0;
    const userBank = sBit && !loadsPc;
    // The first word is an N cycle and the rest S cycles; an LDM adds the I cycle that writes the
    // last register (GBATEK LDM: nS+1N+1I, STM: (n-1)S+2N).
    const firstAddress = address;

    if (load) {
      if (writeback) {
        this.registers[rn] = newBase;
      }
      let pcValue = 0;
      for (let i = 0; i < 16; i++) {
        if (list & (1 << i)) {
          this.#chargeAccess(address, 4, address !== firstAddress);
          const value = this.memory.read32(address);
          if (i === PC) {
            pcValue = value;
          } else if (userBank) {
            this.#writeUserRegister(i, value);
          } else {
            this.registers[i] = value;
          }
          address = (address + 4) >>> 0;
        }
      }
      this.#chargeInternal(1);
      if (loadsPc) {
        if (sBit) {
          this.#restoreCpsrFromSpsr();
        }
        if (isSentinel(pcValue)) {
          this.#halted = true;
          this.registers[PC] = pcValue;
        } else {
          // ARMv4 loads R15 without interworking: the PC aligns for the state the CPU is in.
          this.#branchTo(pcValue);
        }
      }
    } else {
      let first = true;
      for (let i = 0; i < 16; i++) {
        if (list & (1 << i)) {
          let value: number;
          if (i === PC) {
            value = storedPc;
          } else {
            value = userBank ? this.#readUserRegister(i) : this.registers[i]!;
          }
          this.#chargeAccess(address, 4, !first);
          this.memory.write32(address, value);
          address = (address + 4) >>> 0;
          if (first && writeback) {
            this.registers[rn] = newBase;
          }
          first = false;
        }
      }
    }
  }

  // ─── ARM MRS/MSR ─────────────────────────────────────────────────

  /** MRS: Move PSR to register */
  #armMrs(instr: number): void {
    const useSPSR = bit(instr, 22) === 1;
    const rd = bits(instr, 15, 12);
    this.registers[rd] = useSPSR ? this.getSPSR() : this.cpsr;
  }

  /** MSR (register): Move register to PSR */
  #armMsrReg(instr: number): void {
    const useSPSR = bit(instr, 22) === 1;
    const rm = instr & 0xf;
    const value = this.registers[rm]!;
    this.#writePsr(value, useSPSR, bits(instr, 19, 16));
  }

  /** MSR (immediate): Move immediate to PSR flags */
  #armMsrImm(instr: number): void {
    const useSPSR = bit(instr, 22) === 1;
    const imm8 = instr & 0xff;
    const rotate = ((instr >>> 8) & 0xf) * 2;
    let value: number;
    if (rotate === 0) {
      value = imm8;
    } else {
      value = ((imm8 >>> rotate) | (imm8 << (32 - rotate))) >>> 0;
    }
    this.#writePsr(value, useSPSR, bits(instr, 19, 16));
  }

  /**
   * Write to a PSR through MSR's field mask. ARMv4T implements the flags (bits 31-28) and the
   * control byte (bits 7-0); the bits between read as zero. User mode writes the flags only
   * (GBATEK "ARM.6 PSR Transfer"; mGBA MSR: PSR_USER_MASK, PSR_PRIV_MASK under `privilegeMode !=
   * MODE_USER`).
   */
  #writePsr(value: number, useSPSR: boolean, fieldMask: number): void {
    let mask = 0;
    if (fieldMask & 0x8) {
      mask |= PSR_FLAGS_MASK;
    }
    if (fieldMask & 0x1 && this.getMode() !== MODE_USR) {
      mask |= PSR_CONTROL_MASK;
    }

    if (useSPSR) {
      this.setSPSR(((this.getSPSR() & ~mask) | (value & mask)) >>> 0);
      return;
    }
    const newCpsr = ((this.cpsr & ~mask) | (value & mask)) >>> 0;
    // Switch first, so the banked registers of the old mode are saved and the new mode's restored.
    this.switchMode(newCpsr & CPSR_MODE_MASK);
    this.cpsr = newCpsr;
  }

  // ─── Software Interrupt ──────────────────────────────────────────

  /**
   * SWI: an HLE handler runs the call in place of the BIOS code at the 0x08 vector and says how
   * many cycles that code takes. On hardware the BIOS returns with `movs pc, lr`, which refills the
   * pipeline at the return address, so code the call wrote right after the SWI is what runs next.
   * A call the handler leaves to the BIOS code takes the exception into it.
   */
  #softwareInterrupt(swiNumber: number): void {
    const cycles = this.#swiHandler ? this.#swiHandler(this, swiNumber) : 0;
    if (cycles === null) {
      this.#enterSwi();
      return;
    }
    this.#chargeInternal(cycles);
    if (!this.#halted) {
      this.#branchTo(this.registers[PC]!);
    }
  }

  // ─── ARM SWI ─────────────────────────────────────────────────────

  /** ARM Software Interrupt */
  #armSwi(instr: number): void {
    // The SWI number encoding is platform-specific. On GBA it's bits 23-16.
    // We pass the full 24-bit comment field; the handler extracts what it needs.
    const swiNumber = (instr >>> 16) & 0xff;
    this.#softwareInterrupt(swiNumber);
  }
}
