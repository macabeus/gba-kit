/**
 * What the toolbar says about the ELF beside the PC. The ELF loaded can
 * describe another ROM — the dev server's sidecar is fetched again after a ROM
 * change, a picked one can simply be the wrong file — so a program whose ELF
 * does not describe the ROM must say so where every other readout is.
 */
import type { Program } from '@gba-kit/debug-core';

export interface ProgramStatus {
  text: string;
  /** the reason, for a tooltip */
  detail?: string;
}

/** Nothing when the ELF matches the ROM (or no contradiction was found). */
export function programStatus(program: Program): ProgramStatus | null {
  if (!program.hasSymbols) {
    return { text: 'no ELF' };
  }
  if (program.identity && !program.identity.ok) {
    return { text: 'ELF does not match ROM', detail: program.identity.reason };
  }
  return null;
}
