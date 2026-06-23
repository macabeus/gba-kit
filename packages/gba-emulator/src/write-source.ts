/**
 * A captured CPU location (pipeline-corrected), used by data watchpoints to
 * attribute a write to the instruction responsible for it. For a CPU store
 * that's the store itself; for a DMA transfer it's the instruction that
 * *started* the DMA (the store to DMAxCNT_H).
 */
export interface WriteOrigin {
  /** Raw CPU PC (pipeline-ahead of the instruction). */
  pc: number;
  /** Address of the instruction itself (pc-2 in Thumb, pc-4 in ARM). */
  instructionAddress: number;
  /** Whether the CPU was in Thumb state. */
  thumb: boolean;
}

/**
 * Build a {@link WriteOrigin} from a raw CPU PC and CPSR, applying the ARM7TDMI
 * pipeline offset (PC reads 2 instructions ahead: `pc-2` in Thumb, `pc-4` in ARM).
 * Shared by the CPU and DMA-trigger attribution paths so the correction lives in
 * one place.
 */
export function captureOrigin(pc: number, cpsr: number): WriteOrigin {
  const rawPc = pc >>> 0;
  const thumb = (cpsr & 0x20) !== 0; // CPSR T bit
  return { pc: rawPc, instructionAddress: (rawPc - (thumb ? 2 : 4)) >>> 0, thumb };
}
