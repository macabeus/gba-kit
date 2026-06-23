/** The instruction a data-watchpoint hit is attributed to (pipeline-corrected). */
export interface WriteOrigin {
  /** Raw CPU PC (2 instructions ahead of `instructionAddress`). */
  pc: number;
  /** Address of the instruction (pc-2 in Thumb, pc-4 in ARM). */
  instructionAddress: number;
  thumb: boolean;
}

/** Apply the ARM7TDMI pipeline offset (pc-2 in Thumb, pc-4 in ARM) to a PC + CPSR. */
export function captureOrigin(pc: number, cpsr: number): WriteOrigin {
  const rawPc = pc >>> 0;
  const thumb = (cpsr & 0x20) !== 0; // CPSR T bit
  return { pc: rawPc, instructionAddress: (rawPc - (thumb ? 2 : 4)) >>> 0, thumb };
}
