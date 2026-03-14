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
  haltedBySWI: boolean;
}
