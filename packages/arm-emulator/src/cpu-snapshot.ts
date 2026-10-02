/**
 * CPU Snapshot — Serializable CPU state
 *
 * Extracted into arm-emulator to avoid circular dependency
 * between arm-emulator and gba-emulator packages.
 */
export interface CpuSnapshot {
  registers: Uint32Array;
  cpsr: number;
  bankedSP: Uint32Array;
  bankedLR: Uint32Array;
  fiqBankedR8to12: Uint32Array;
  usrBankedR8to12: Uint32Array;
  spsr: Uint32Array;
  halted: boolean;
  /**
   * The prefetch pipeline: [address of the decoded opcode (0xFFFFFFFF when flushed), decoded
   * opcode, fetched opcode, 1 in Thumb state]. Snapshots taken before the pipeline was modelled
   * lack it and restore with a flushed pipeline, which refills from memory at the next step.
   */
  pipeline?: Uint32Array;
}
