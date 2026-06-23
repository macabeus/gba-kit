/**
 * Attribution for a memory write, used by data watchpoints to report *what*
 * performed a store, not just the byte that changed.
 *
 * - `cpu`  — a normal CPU store (the watchpoint's `instructionAddress` is the
 *   writing instruction).
 * - `dma`  — a DMA channel transfer. The per-word writes don't come from any
 *   single instruction, so `originPc` is the PC of the code that *started* the
 *   DMA (the store to DMAxCNT_H that set the enable bit) — i.e. the actionable
 *   "which function kicked off this copy".
 * - `bios` — a write performed by an HLE BIOS routine (CpuSet, LZ77, …). These
 *   run inside a SWI, so the live PC already points at the BIOS caller.
 */
/** A captured CPU location (pipeline-corrected), used to attribute a write. */
export interface WriteOrigin {
  /** Raw CPU PC (pipeline-ahead of the instruction). */
  pc: number;
  /** Address of the instruction itself (pc-2 in Thumb, pc-4 in ARM). */
  instructionAddress: number;
  /** Whether the CPU was in Thumb state. */
  thumb: boolean;
}

export type WriteSource =
  | { kind: 'cpu' }
  // `origin` is the instruction that *started* the DMA (the store to DMAxCNT_H).
  | { kind: 'dma'; channel: number; origin: WriteOrigin }
  | { kind: 'bios' };

export const CPU_WRITE_SOURCE: WriteSource = { kind: 'cpu' };
