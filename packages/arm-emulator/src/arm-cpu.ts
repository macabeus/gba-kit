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

// ─── CPU Mode Constants ──────────────────────────────────────────────

/** CPU mode codes (bits 4-0 of CPSR) */
export const MODE_USR = 0x10;
export const MODE_FIQ = 0x11;
export const MODE_IRQ = 0x12;
export const MODE_SVC = 0x13;
export const MODE_ABT = 0x17;
export const MODE_UND = 0x1b;
export const MODE_SYS = 0x1f;

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
    case 0xf:
      return true; // Unconditional (ARMv5+, treat as AL)
    default:
      return true;
  }
}

// ─── SWI Handler Type ───────────────────────────────────────────────

/**
 * Callback for Software Interrupt (SWI) instructions.
 * Platform-specific: on GBA, the SWI number selects a BIOS function.
 * If not provided, SWI instructions are silently ignored.
 */
export type SwiHandler = (cpu: ArmCpu, swiNumber: number) => void;

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

  /** Halt flag for SWI 0x02 (Halt) */
  #haltedBySWI = false;

  /** Map of stub addresses to symbol names */
  #stubs = new Map<number, string>();

  /** Next available stub address */
  #nextStub = STUB_BASE;

  /** Recorded external calls */
  #externalCalls: ExternalCall[] = [];

  /** Optional debug hooks */
  #hooks?: DebugHooks;

  /** Platform-specific SWI handler */
  #swiHandler?: SwiHandler;

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

  /** Attach or detach debug hooks */
  setDebugHooks(hooks: DebugHooks | undefined): void {
    this.#hooks = hooks;
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
      haltedBySWI: this.#haltedBySWI,
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
    this.#haltedBySWI = snap.haltedBySWI;
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
    this.#haltedBySWI = false;
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
   * The BIOS stub at 0x18 (installed by Gba.#installBiosStub) handles:
   * - Saving registers to IRQ stack
   * - Calling the user's handler from [0x03007FFC]
   * - Restoring registers and returning from IRQ
   *
   * The BIOS stub at 0x80 handles IE/IF acknowledgment and BIOS IF mirror
   * update before calling the user handler.
   */
  enterIrq(): void {
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

    // Jump to BIOS IRQ vector — the stub handles IE/IF acknowledgment,
    // BIOS IF mirror update, and calling the user handler
    this.registers[PC] = 0x00000018;
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
    this.registers[PC] = 0x00000004; // UND vector
  }

  /**
   * Execute one instruction (ARM or Thumb based on T bit).
   * Returns false if halted.
   */
  step(): boolean {
    if (this.#halted || this.#haltedBySWI) {
      return false;
    }

    const pc = this.registers[PC]!;
    if ((pc & ~1) === SENTINEL_ADDR || (pc & ~1) === (SENTINEL_ADDR & ~1)) {
      this.#halted = true;
      return false;
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
      return true;
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

  // ─── Thumb Execution ─────────────────────────────────────────────

  /** Execute one Thumb instruction */
  #stepThumb(): boolean {
    const pc = this.registers[PC]!;
    const instrAddr = pc & ~1;
    const instr = this.memory.read16(instrAddr);

    if (this.#hooks?.onInstructionPre) {
      const action = this.#hooks.onInstructionPre(instrAddr, instr);
      if (action === 'break') {
        return false;
      }
    }

    this.registers[PC] = (pc + 2) >>> 0;
    this.#executeThumb(instr, instrAddr);

    this.#hooks?.onInstructionPost?.(instrAddr, instr);
    return !this.#halted;
  }

  /** Decode and execute a single 16-bit Thumb instruction. */
  #executeThumb(instr: number, _instrAddr: number): void {
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
      this.registers[PC] = (this.registers[PC]! + 2 + offset11 * 2) >>> 0;
      return;
    }

    // Format 17: SWI
    if ((instr & 0xff00) === 0xdf00) {
      this.#swiHandler?.(this, instr & 0xff);
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
        this.registers[rd] = this.memory.read32(address);
      } else {
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
        this.registers[rd] = this.memory.read16(address);
      } else {
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
      this.registers[rd] = this.memory.read32(address);
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
      case 0x2: {
        const amount = rsVal & 0xff;
        [result, carry] = lsl(rdVal, amount, this.getC());
        break;
      }
      case 0x3: {
        const amount = rsVal & 0xff;
        [result, carry] = lsr(rdVal, amount, this.getC());
        break;
      }
      case 0x4: {
        const amount = rsVal & 0xff;
        [result, carry] = asr(rdVal, amount, this.getC());
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
        result = Math.imul(rdVal, rsVal);
        carry = false;
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
        this.registers[rd] = (rdVal + rsVal) >>> 0;
        if (rd === PC) {
          this.registers[PC] = this.registers[PC]! & ~1;
        }
        break;
      case 1: {
        // CMP
        const alu = subWithFlags(rdVal | 0, rsVal | 0);
        this.setFlags(alu.n, alu.z, alu.c, alu.v);
        break;
      }
      case 2: // MOV
        this.registers[rd] = rsVal;
        if (rd === PC) {
          this.registers[PC] = this.registers[PC]! & ~1;
        }
        break;
      case 3: // BX
        if ((rsVal & ~1) === SENTINEL_ADDR || (rsVal & ~1) === (SENTINEL_ADDR & ~1)) {
          this.#halted = true;
          return;
        }
        // T bit determined by bit 0
        this.setT((rsVal & 1) !== 0);
        this.registers[PC] = rsVal & ~1;
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
    if (l === 1) {
      if (b === 1) {
        this.registers[rd] = this.memory.read8(address);
      } else {
        // ARM7TDMI: unaligned word reads rotate
        const aligned = address & ~3;
        const rotation = (address & 3) * 8;
        let value = this.memory.read32(aligned);
        if (rotation) {
          value = ((value >>> rotation) | (value << (32 - rotation))) >>> 0;
        }
        this.registers[rd] = value;
      }
    } else {
      if (b === 1) {
        this.memory.write8(address, this.registers[rd]!);
      } else {
        this.memory.write32(address & ~3, this.registers[rd]!);
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
      this.memory.write16(address, this.registers[rd]!);
    } else if (s === 0 && h === 1) {
      this.registers[rd] = this.memory.read16(address);
    } else if (s === 1 && h === 0) {
      this.registers[rd] = signExtend(this.memory.read8(address), 8) >>> 0;
    } else {
      if (address & 1) {
        this.registers[rd] = signExtend(this.memory.read8(address), 8) >>> 0;
      } else {
        this.registers[rd] = signExtend(this.memory.read16(address), 16) >>> 0;
      }
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
    if (l === 1) {
      if (b === 1) {
        this.registers[rd] = this.memory.read8(address);
      } else {
        // ARM7TDMI: unaligned word reads rotate
        const aligned = address & ~3;
        const rotation = (address & 3) * 8;
        let value = this.memory.read32(aligned);
        if (rotation) {
          value = ((value >>> rotation) | (value << (32 - rotation))) >>> 0;
        }
        this.registers[rd] = value;
      }
    } else {
      if (b === 1) {
        this.memory.write8(address, this.registers[rd]!);
      } else {
        this.memory.write32(address & ~3, this.registers[rd]!);
      }
    }
  }

  #thumbPushPop(instr: number): void {
    const l = bit(instr, 11);
    const r = bit(instr, 8);
    const rlist = instr & 0xff;

    if (l === 0) {
      // PUSH
      let sp = this.registers[SP]!;
      let count = 0;
      for (let i = 0; i < 8; i++) {
        if (rlist & (1 << i)) {
          count++;
        }
      }
      if (r) {
        count++;
      }
      sp = (sp - count * 4) >>> 0;
      this.registers[SP] = sp;
      let addr = sp;
      for (let i = 0; i < 8; i++) {
        if (rlist & (1 << i)) {
          this.memory.write32(addr, this.registers[i]!);
          addr = (addr + 4) >>> 0;
        }
      }
      if (r) {
        this.memory.write32(addr, this.registers[LR]!);
      }
    } else {
      // POP
      let addr = this.registers[SP]!;
      for (let i = 0; i < 8; i++) {
        if (rlist & (1 << i)) {
          this.registers[i] = this.memory.read32(addr);
          addr = (addr + 4) >>> 0;
        }
      }
      if (r) {
        const val = this.memory.read32(addr);
        addr = (addr + 4) >>> 0;
        if ((val & ~1) === SENTINEL_ADDR || (val & ~1) === (SENTINEL_ADDR & ~1)) {
          this.#halted = true;
          this.registers[SP] = addr;
          return;
        }
        this.registers[PC] = val & ~1;
      }
      this.registers[SP] = addr;
    }
  }

  #thumbBlockTransfer(instr: number): void {
    const l = bit(instr, 11);
    const rb = bits(instr, 10, 8);
    const rlist = instr & 0xff;
    let addr = this.registers[rb]!;
    if (l === 1) {
      // LDMIA
      for (let i = 0; i < 8; i++) {
        if (rlist & (1 << i)) {
          this.registers[i] = this.memory.read32(addr);
          addr = (addr + 4) >>> 0;
        }
      }
      // No writeback if Rb is in the register list (loaded value takes precedence)
      if (!(rlist & (1 << rb))) {
        this.registers[rb] = addr;
      }
    } else {
      // STMIA
      for (let i = 0; i < 8; i++) {
        if (rlist & (1 << i)) {
          this.memory.write32(addr, this.registers[i]!);
          addr = (addr + 4) >>> 0;
        }
      }
      this.registers[rb] = addr;
    }
  }

  #thumbCondBranch(instr: number): void {
    const cond = bits(instr, 11, 8);
    const offset8 = signExtend(instr & 0xff, 8);
    if (!checkCondition(cond, this.getN(), this.getZ(), this.getC(), this.getV())) {
      return;
    }
    // ARM7TDMI pipeline: PC reads as instrAddr+4 in Thumb mode.
    // registers[PC] is instrAddr+2 (pre-incremented), so add +2 for pipeline.
    this.registers[PC] = (this.registers[PC]! + 2 + offset8 * 2) >>> 0;
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
    this.registers[PC] = target & ~1;
  }

  // ─── ARM Execution ───────────────────────────────────────────────

  /** Execute one ARM (32-bit) instruction */
  #stepArm(): boolean {
    const pc = this.registers[PC]!;
    const instrAddr = pc & ~3;
    const instr = this.memory.read32(instrAddr);

    if (this.#hooks?.onInstructionPre) {
      const action = this.#hooks.onInstructionPre(instrAddr, instr);
      if (action === 'break') {
        return false;
      }
    }

    // Advance PC by 4 (ARM instructions are 4 bytes)
    this.registers[PC] = (pc + 4) >>> 0;

    // Check condition code (bits 31-28)
    const cond = (instr >>> 28) & 0xf;
    if (checkCondition(cond, this.getN(), this.getZ(), this.getC(), this.getV())) {
      this.#executeArm(instr, instrAddr);
    }

    this.#hooks?.onInstructionPost?.(instrAddr, instr);
    return !this.#halted;
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
        // Coprocessor — undefined on GBA
        break;
      case 0b111:
        if (bit(instr, 24) === 1) {
          // SWI
          this.#armSwi(instr);
        }
        // else coprocessor operations — undefined on GBA
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
      // Register-specified shift amount (Rs)
      const rsReg = (instr >>> 8) & 0xf;
      amount = this.registers[rsReg]! & 0xff;
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

    if (writeResult) {
      this.registers[rd] = result >>> 0;
    }

    if (setFlags) {
      if (rd === PC) {
        // Data processing with S=1 and Rd=PC: copy SPSR to CPSR (return from exception)
        const spsr = this.getSPSR();
        const newMode = spsr & CPSR_MODE_MASK;
        const oldMode = this.getMode();
        // Must switch mode BEFORE overwriting CPSR, so banked registers are
        // properly saved (old mode) and restored (new mode).
        if (newMode !== oldMode) {
          this.switchMode(newMode);
        }
        this.cpsr = spsr;
      } else {
        this.setN((result & 0x80000000) !== 0);
        this.setZ(result >>> 0 === 0);
        this.setC(carry);
        this.setV(overflow);
      }
    }

    // If Rd is PC and we wrote to it (non-flag instructions), flush pipeline
    if (writeResult && rd === PC) {
      // If the T bit changed, the new mode takes effect on next fetch
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

    let result = Math.imul(this.registers[rm]! | 0, this.registers[rs]! | 0);
    if (accumulate) {
      result = (result + (this.registers[rn]! | 0)) | 0;
    }

    this.registers[rd] = result >>> 0;

    if (setFlags) {
      this.setN((result & 0x80000000) !== 0);
      this.setZ(result >>> 0 === 0);
      // C is unpredictable on ARMv4T, V is unchanged
    }
  }

  /** ARM long multiply: UMULL, UMLAL, SMULL, SMLAL */
  #armMultiplyLong(instr: number): void {
    const isSigned = bit(instr, 22) === 1;
    const accumulate = bit(instr, 21) === 1;
    const setFlags = bit(instr, 20) === 1;
    const rdHi = bits(instr, 19, 16);
    const rdLo = bits(instr, 15, 12);
    const rs = bits(instr, 11, 8);
    const rm = instr & 0xf;

    let resultHi: number;
    let resultLo: number;

    if (isSigned) {
      // SMULL/SMLAL: signed 32x32 -> 64
      const a = this.registers[rm]! | 0;
      const b = this.registers[rs]! | 0;
      // Use BigInt for 64-bit precision
      const product = BigInt(a) * BigInt(b);
      resultLo = Number(product & 0xffffffffn) >>> 0;
      resultHi = Number((product >> 32n) & 0xffffffffn) >>> 0;
    } else {
      // UMULL/UMLAL: unsigned 32x32 -> 64
      const a = this.registers[rm]! >>> 0;
      const b = this.registers[rs]! >>> 0;
      const product = BigInt(a) * BigInt(b);
      resultLo = Number(product & 0xffffffffn) >>> 0;
      resultHi = Number((product >> 32n) & 0xffffffffn) >>> 0;
    }

    if (accumulate) {
      // Add to existing RdHi:RdLo
      const accLo = this.registers[rdLo]! >>> 0;
      const accHi = this.registers[rdHi]! >>> 0;
      const sum = BigInt(resultHi) * 0x100000000n + BigInt(resultLo) + BigInt(accHi) * 0x100000000n + BigInt(accLo);
      resultLo = Number(sum & 0xffffffffn) >>> 0;
      resultHi = Number((sum >> 32n) & 0xffffffffn) >>> 0;
    }

    this.registers[rdLo] = resultLo;
    this.registers[rdHi] = resultHi;

    if (setFlags) {
      this.setN((resultHi & 0x80000000) !== 0);
      this.setZ(resultHi === 0 && resultLo === 0);
      // C, V are unpredictable
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

    if (byteMode) {
      const temp = this.memory.read8(address);
      this.memory.write8(address, this.registers[rm]! & 0xff);
      this.registers[rd] = temp;
    } else {
      // SWP: unaligned word reads rotate (same as LDR)
      const aligned = address & ~3;
      const rotation = (address & 3) * 8;
      let temp = this.memory.read32(aligned);
      if (rotation) {
        temp = ((temp >>> rotation) | (temp << (32 - rotation))) >>> 0;
      }
      this.memory.write32(aligned, this.registers[rm]!);
      this.registers[rd] = temp;
    }
  }

  // ─── ARM Branch Exchange ─────────────────────────────────────────

  /** ARM BX: branch and exchange instruction set */
  #armBx(instr: number): void {
    const rm = instr & 0xf;
    const target = this.registers[rm]!;

    if ((target & ~1) === SENTINEL_ADDR || (target & ~1) === (SENTINEL_ADDR & ~1)) {
      this.#halted = true;
      return;
    }

    this.setT((target & 1) !== 0);
    this.registers[PC] = target & ~1;
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
    this.registers[PC] = (this.registers[PC]! + 4 + offset) >>> 0;
  }

  // ─── ARM Single Data Transfer (Immediate offset) ─────────────────

  /** ARM LDR/STR with immediate offset */
  #armSingleDataTransferImm(instr: number): void {
    const pre = bit(instr, 24) === 1;
    const up = bit(instr, 23) === 1;
    const byteMode = bit(instr, 22) === 1;
    const writeback = bit(instr, 21) === 1;
    const load = bit(instr, 20) === 1;
    const rn = bits(instr, 19, 16);
    const rd = bits(instr, 15, 12);
    const offset = instr & 0xfff;

    let base = this.registers[rn]!;
    if (rn === PC) {
      base = (base + 4) >>> 0; // PC+8 relative to instruction address
    }
    const effectiveOffset = up ? offset : -offset;

    let address: number;
    if (pre) {
      address = (base + effectiveOffset) >>> 0;
    } else {
      address = base;
    }

    if (load) {
      if (byteMode) {
        this.registers[rd] = this.memory.read8(address);
      } else {
        // ARM7TDMI: unaligned word reads rotate the value
        const aligned = address & ~3;
        const rotation = (address & 3) * 8;
        let value = this.memory.read32(aligned);
        if (rotation) {
          value = ((value >>> rotation) | (value << (32 - rotation))) >>> 0;
        }
        this.registers[rd] = value;
      }
      if (rd === PC) {
        this.registers[PC] = this.registers[PC]! & ~3;
      }
    } else {
      let value = this.registers[rd]!;
      if (rd === PC) {
        value = (value + 4) >>> 0; // PC+12
      }
      if (byteMode) {
        this.memory.write8(address, value & 0xff);
      } else {
        this.memory.write32(address & ~3, value);
      }
    }

    // Writeback
    if (pre && writeback) {
      this.registers[rn] = (base + effectiveOffset) >>> 0;
    } else if (!pre) {
      // Post-indexed always writes back
      this.registers[rn] = (base + effectiveOffset) >>> 0;
    }
  }

  /** ARM LDR/STR with register offset */
  #armSingleDataTransferReg(instr: number): void {
    const pre = bit(instr, 24) === 1;
    const up = bit(instr, 23) === 1;
    const byteMode = bit(instr, 22) === 1;
    const writeback = bit(instr, 21) === 1;
    const load = bit(instr, 20) === 1;
    const rn = bits(instr, 19, 16);
    const rd = bits(instr, 15, 12);

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

    let base = this.registers[rn]!;
    if (rn === PC) {
      base = (base + 4) >>> 0;
    }
    const effectiveOffset = up ? offset : -offset | 0;

    let address: number;
    if (pre) {
      address = (base + effectiveOffset) >>> 0;
    } else {
      address = base;
    }

    if (load) {
      if (byteMode) {
        this.registers[rd] = this.memory.read8(address);
      } else {
        // ARM7TDMI: unaligned word reads rotate the value
        const aligned = address & ~3;
        const rotation = (address & 3) * 8;
        let value = this.memory.read32(aligned);
        if (rotation) {
          value = ((value >>> rotation) | (value << (32 - rotation))) >>> 0;
        }
        this.registers[rd] = value;
      }
      if (rd === PC) {
        this.registers[PC] = this.registers[PC]! & ~3;
      }
    } else {
      let value = this.registers[rd]!;
      if (rd === PC) {
        value = (value + 4) >>> 0;
      }
      if (byteMode) {
        this.memory.write8(address, value & 0xff);
      } else {
        this.memory.write32(address & ~3, value);
      }
    }

    if (pre && writeback) {
      this.registers[rn] = (base + effectiveOffset) >>> 0;
    } else if (!pre) {
      this.registers[rn] = (base + effectiveOffset) >>> 0;
    }
  }

  // ─── ARM Halfword / Signed Transfer ──────────────────────────────

  /** ARM LDRH/STRH/LDRSB/LDRSH */
  #armHalfwordTransfer(instr: number): void {
    const pre = bit(instr, 24) === 1;
    const up = bit(instr, 23) === 1;
    const immOffset = bit(instr, 22) === 1;
    const writeback = bit(instr, 21) === 1;
    const load = bit(instr, 20) === 1;
    const rn = bits(instr, 19, 16);
    const rd = bits(instr, 15, 12);
    const sh = bits(instr, 6, 5); // S and H bits: 01=H, 10=SB, 11=SH

    let offset: number;
    if (immOffset) {
      // Immediate: high nibble | low nibble
      offset = ((instr >>> 4) & 0xf0) | (instr & 0xf);
    } else {
      // Register
      const rm = instr & 0xf;
      offset = this.registers[rm]!;
    }

    let base = this.registers[rn]!;
    if (rn === PC) {
      base = (base + 4) >>> 0;
    }
    const effectiveOffset = up ? offset : -offset;

    let address: number;
    if (pre) {
      address = (base + effectiveOffset) >>> 0;
    } else {
      address = base;
    }

    if (load) {
      switch (sh) {
        case 0b01: // LDRH (unsigned halfword)
          // ARM7TDMI: unaligned LDRH reads aligned halfword then rotates by 8
          if (address & 1) {
            const hw = this.memory.read16(address & ~1);
            this.registers[rd] = ((hw >>> 8) | (hw << 24)) >>> 0;
          } else {
            this.registers[rd] = this.memory.read16(address);
          }
          break;
        case 0b10: // LDRSB (signed byte)
          this.registers[rd] = signExtend(this.memory.read8(address), 8) >>> 0;
          break;
        case 0b11: // LDRSH (signed halfword)
          // ARM7TDMI: unaligned LDRSH loads byte and sign-extends (like LDRSB)
          if (address & 1) {
            this.registers[rd] = signExtend(this.memory.read8(address), 8) >>> 0;
          } else {
            this.registers[rd] = signExtend(this.memory.read16(address), 16) >>> 0;
          }
          break;
      }
    } else {
      // STRH (only sh=01 for store) — ignores bit 0 (force halfword alignment)
      if (sh === 0b01) {
        this.memory.write16(address & ~1, this.registers[rd]! & 0xffff);
      }
    }

    if (pre && writeback) {
      this.registers[rn] = (base + effectiveOffset) >>> 0;
    } else if (!pre) {
      this.registers[rn] = (base + effectiveOffset) >>> 0;
    }
  }

  // ─── ARM Block Data Transfer (LDM/STM) ───────────────────────────

  /** ARM LDM/STM */
  #armBlockDataTransfer(instr: number): void {
    const pre = bit(instr, 24) === 1;
    const up = bit(instr, 23) === 1;
    const sBit = bit(instr, 22) === 1; // PSR & force user mode
    const writeback = bit(instr, 21) === 1;
    const load = bit(instr, 20) === 1;
    const rn = bits(instr, 19, 16);
    const rlist = instr & 0xffff;

    let base = this.registers[rn]!;

    // Count registers in the list
    let regCount = 0;
    for (let i = 0; i < 16; i++) {
      if (rlist & (1 << i)) {
        regCount++;
      }
    }

    if (regCount === 0) {
      // Edge case: empty register list
      return;
    }

    // Calculate start address based on direction
    let address: number;
    if (up) {
      address = pre ? (base + 4) >>> 0 : base;
    } else {
      // Down: start from base - regCount*4
      address = pre ? (base - regCount * 4) >>> 0 : (base - regCount * 4 + 4) >>> 0;
    }

    if (load) {
      for (let i = 0; i < 16; i++) {
        if (rlist & (1 << i)) {
          this.registers[i] = this.memory.read32(address);
          address = (address + 4) >>> 0;
        }
      }
      // If PC is in the list and S bit is set, restore CPSR from SPSR
      if (rlist & (1 << PC) && sBit) {
        const spsr = this.getSPSR();
        const newMode = spsr & 0x1f;
        const oldMode = this.getMode();
        if (newMode !== oldMode) {
          this.switchMode(newMode);
        }
        this.cpsr = spsr;
      }
      // If PC was loaded, align it
      if (rlist & (1 << PC)) {
        this.registers[PC] = this.registers[PC]! & ~3;
      }
    } else {
      for (let i = 0; i < 16; i++) {
        if (rlist & (1 << i)) {
          let value = this.registers[i]!;
          if (i === PC) {
            value = (value + 4) >>> 0; // PC+12
          }
          this.memory.write32(address, value);
          address = (address + 4) >>> 0;
        }
      }
    }

    // Writeback (for LDM: no writeback if Rn is in the register list)
    if (writeback && !(load && rlist & (1 << rn))) {
      if (up) {
        this.registers[rn] = (base + regCount * 4) >>> 0;
      } else {
        this.registers[rn] = (base - regCount * 4) >>> 0;
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

  /** Write to PSR based on field mask */
  #writePsr(value: number, useSPSR: boolean, fieldMask: number): void {
    let mask = 0;
    if (fieldMask & 0x1) {
      mask |= 0x000000ff;
    } // control
    if (fieldMask & 0x2) {
      mask |= 0x0000ff00;
    } // extension
    if (fieldMask & 0x4) {
      mask |= 0x00ff0000;
    } // status
    if (fieldMask & 0x8) {
      mask |= 0xff000000;
    } // flags

    if (useSPSR) {
      const current = this.getSPSR();
      this.setSPSR((current & ~mask) | (value & mask));
    } else {
      const oldMode = this.getMode();
      this.cpsr = (this.cpsr & ~mask) | (value & mask);
      const newMode = this.getMode();
      if (newMode !== oldMode) {
        // Need to re-bank registers
        this.#saveBankedRegisters(oldMode);
        this.#restoreBankedRegisters(newMode);
      }
    }
  }

  // ─── ARM SWI ─────────────────────────────────────────────────────

  /** ARM Software Interrupt */
  #armSwi(instr: number): void {
    // The SWI number encoding is platform-specific. On GBA it's bits 23-16.
    // We pass the full 24-bit comment field; the handler extracts what it needs.
    const swiNumber = (instr >>> 16) & 0xff;
    this.#swiHandler?.(this, swiNumber);
  }
}
