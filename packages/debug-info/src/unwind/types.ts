/**
 * What a stack walk is made of: the frames it produces, the candidate each layer
 * hands it, and the facts it is allowed to ask for.
 *
 * The facts are split by who owns them — the program image, the CPU, the target —
 * so a caller can see which half of the port it is answering for, and so no layer
 * has to import the walker to name its own result.
 */
import type { FrameTable } from '../dwarf/frame.js';
import type { IsaMode } from '../symbols.js';

/** Code as the unwinder reads it: through the bus, so ROM, IWRAM overlays and EWRAM all decode. */
export interface CodeAccess {
  read16(address: number): number | undefined;
  read32(address: number): number | undefined;
}

/** What the ELF says about an address. */
export interface ProgramFacts {
  /** inside a section the ELF marked executable */
  isExecutable(address: number): boolean;
  /** the ELF names this address: a DWARF function, or a symbol whose extent covers it */
  nameable(address: number): boolean;
  isaAt(address: number): IsaMode | null;
  /** `[lo, hi)` of the function containing `pc` */
  functionBounds(pc: number): FunctionRange | null;
}

export interface FunctionRange {
  lo: number;
  hi: number;
}

/**
 * Code, and the instruction set the ELF records for each address of it. Mapping
 * symbols are per-address, and a function can change instruction set in its middle
 * — an interworking veneer does — so every instruction is decoded as what the ELF
 * says lives at *its* address, falling back to the function's own encoding where
 * the ELF says nothing.
 */
export interface CodeReader extends CodeAccess, Pick<ProgramFacts, 'isaAt'> {}

/** The CPU beyond the registers of the frame being unwound: its mode, and the banks. */
export interface CpuState {
  /** the CPU's mode right now */
  mode: number;
  /** the stack pointer of `mode`: the live register when the CPU is in it, else its bank */
  bankedSp(mode: number): number | undefined;
  bankedLr(mode: number): number | undefined;
  /** the saved status register of `mode`, which says what it interrupted */
  spsr(mode: number): number | undefined;
}

/**
 * What is true of the machine rather than of this program: where its stacks live,
 * where its code begins, and how its exception stub is shaped. All of it is
 * injected, so the walk holds no constant that is true of one console only.
 */
export interface TargetPolicy {
  /** the lowest address program code can have; below it lie the BIOS and its exception stubs */
  codeFloor: number;
  /** mapped, and in a region that can hold code */
  isCodeRegion(address: number): boolean;
  /** the top of the stack `mode` grows down from, given where its pointer is now */
  stackBoundFor(mode: number, sp: number | undefined): number;
  /** what an exception stub subtracts from its lr to resume the instruction it interrupted */
  exceptionReturnBias(mode: number): number;
  /** the stub the walk crosses: the mode it runs in, and where its pushed block keeps the interrupted lr */
  exceptionStub: { mode: number; lrOffset: number };
}

/** Everything the walk needs to know about the machine, and nothing about an emulator. */
export interface MachineFacts extends CodeReader, ProgramFacts, CpuState, TargetPolicy {}

/** How a frame was recovered. */
export type FrameMethod =
  /** the innermost frame: the machine's own registers */
  | 'live'
  | 'cfi'
  /** read off an exception boundary: the stub's pushed block and the banked state */
  | 'exception'
  /** measured from the callee's own prologue, or from the teardown its epilogue has left to run */
  | 'prologue'
  /** a link register the decode proved still holds this frame's return address */
  | 'lr'
  /** a link register the decode could not prove, but which a call into this function ends at */
  | 'lr-corroborated'
  /** inferred from a credibility-tested stack word */
  | 'scan'
  /** lr with nothing confirming it: all there is when the program has no ELF at all */
  | 'guess';

/**
 * What each method claims, declared where the method is: whether it established a
 * frame or inferred one, and whether a step-out may run to the address it produced.
 *
 * Both answers belong to the method rather than to the code that reads them, so a
 * new layer has to say here what its frames are worth instead of arriving with
 * whatever the readers downstream default to.
 */
export const FRAME_METHODS: Record<FrameMethod, { confidence: 'derived' | 'inferred'; runnable: boolean }> = {
  live: { confidence: 'derived', runnable: true },
  cfi: { confidence: 'derived', runnable: true },
  // A BIOS address the program never branches to itself, so there is nothing to run to.
  exception: { confidence: 'derived', runnable: false },
  prologue: { confidence: 'derived', runnable: true },
  lr: { confidence: 'derived', runnable: true },
  // Corroborated by a call that ends at it, and its stack pointer is measured, so
  // it is an address execution will really arrive at even though lr was not proved.
  'lr-corroborated': { confidence: 'inferred', runnable: true },
  scan: { confidence: 'inferred', runnable: false },
  guess: { confidence: 'inferred', runnable: false },
};

/**
 * Whether a method established a frame or inferred one. This is the distinction a
 * reader needs in order to decide whether to trust the frame's variables, and it
 * is derived from `method` rather than stored beside it so that there is one
 * answer rather than two that can disagree.
 */
export function frameConfidence(method: FrameMethod): 'derived' | 'inferred' {
  return FRAME_METHODS[method].confidence;
}

export interface UnwoundFrame {
  /** where execution is (frame 0) or will resume (a caller: its return address) */
  pc: number;
  /** the address to look lines and scopes up at: inside the call for a caller, the pc itself otherwise */
  lookupPc: number;
  /** r0–r15 in this frame; undefined where a value could not be recovered rather than guessed */
  regs: Array<number | undefined>;
  /**
   * This frame's canonical frame address — sp as it was on entry — which is what a
   * `DW_OP_call_frame_cfa` frame base resolves against. It becomes known when the
   * frame is unwound *from*, so the outermost frame has one only where
   * call-frame information supplied it.
   */
  cfa: number | undefined;
  method: FrameMethod;
  /** one sentence about what in this frame is not established, or null when nothing is */
  doubt: string | null;
}

export interface StackWalk {
  frames: UnwoundFrame[];
  /** why the walk stopped where it did */
  end: string;
}

/** What every layer is given, and what the walk carries from frame to frame. */
export interface WalkContext {
  facts: MachineFacts;
  cfi: FrameTable;
  /** the top of the stack region the walk is currently on */
  bound: number;
  /** whether the stack may be searched once every derived layer has declined */
  scan: boolean;
  /**
   * The frame measured from the code of the function the current frame is
   * executing, measured once for it: three of the layers turn on the same
   * measurement, including the one that reads the call-frame table, which has to
   * know whether the pc is somewhere the table stopped describing.
   */
  measurement: Measured | Refusal;
}

/** A measured frame, with the stack pointer it was measured against. */
export interface Measured {
  frame: MeasuredFrame;
  sp: number;
}

/** One way of stepping from a frame to its caller: an answer, or a sentence saying why not. */
export type Layer = (top: UnwoundFrame, ctx: WalkContext) => Candidate | Refusal;

export interface MeasuredFrame {
  /** bytes between sp at the pc and the CFA: `cfa = sp + frameSize` */
  frameSize: number;
  /**
   * Original register number → the offset of its saved slot from the CFA (negative).
   * Register 14 is the return-address column, as in DWARF: the slot holding the
   * address this frame returns to, wherever the epilogue means to pop it from.
   */
  saved: ReadonlyMap<number, number>;
  /**
   * The register that holds this frame's return address right now, when no saved
   * slot holds it: lr in a function that has not spilled it, and the register a
   * `bx rN` return branches through once the pop that loaded it has run.
   */
  raLive: number | undefined;
  /** the pc is at a teardown instruction, so the frame was measured from what is left to undo */
  teardown: boolean;
}

/** The caller a layer found, before the walk has decided what it is. */
export interface Candidate {
  method: FrameMethod;
  /** the return address as the machine stored it: bit 0 is the instruction set of the return site */
  raw: number;
  regs: Array<number | undefined>;
  cfa: number;
  doubt: string | null;
}

/** A layer declining, with the sentence the walk says if it was the last to try. */
export interface Refusal {
  refused: string;
}

export interface WalkOptions {
  /**
   * Whether to infer frames from credibility-tested stack words once every derived
   * layer has declined. On by default, which is how a session walks: turning it off
   * asks for derived frames only.
   */
  scan?: boolean;
}
