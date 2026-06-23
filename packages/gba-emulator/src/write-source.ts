/** A captured CPU location (pipeline-corrected), used to attribute a write. */
export interface WriteOrigin {
  /** Raw CPU PC (pipeline-ahead of the instruction). */
  pc: number;
  /** Address of the instruction itself (pc-2 in Thumb, pc-4 in ARM). */
  instructionAddress: number;
  /** Whether the CPU was in Thumb state. */
  thumb: boolean;
}

const CPSR_THUMB = 0x20; // CPSR T bit

/**
 * Build a {@link WriteOrigin} from a raw CPU PC and CPSR, applying the ARM7TDMI
 * pipeline offset (PC reads 2 instructions ahead: `pc-2` in Thumb, `pc-4` in ARM).
 * Shared by the CPU and DMA-trigger attribution paths so the correction lives in
 * exactly one place.
 */
export function captureOrigin(pc: number, cpsr: number): WriteOrigin {
  const rawPc = pc >>> 0;
  const thumb = (cpsr & CPSR_THUMB) !== 0;
  return { pc: rawPc, instructionAddress: (rawPc - (thumb ? 2 : 4)) >>> 0, thumb };
}

/**
 * Attribution for a memory write, used by data watchpoints to report *what*
 * performed a store, not just the byte that changed.
 *
 * - `cpu`  — a normal CPU store (the watchpoint's `instructionAddress` is the
 *   writing instruction). HLE-BIOS writes also use this: they run inside a SWI,
 *   so the live PC points at the BIOS caller, which is the actionable site.
 * - `dma`  — a DMA channel transfer. The per-word writes don't come from any
 *   single instruction, so `origin` is the instruction that *started* the DMA
 *   (the store to DMAxCNT_H) — "which function kicked off this copy".
 */
export type WriteSource = { kind: 'cpu' } | { kind: 'dma'; channel: number; origin: WriteOrigin };

export const CPU_WRITE_SOURCE: WriteSource = { kind: 'cpu' };
