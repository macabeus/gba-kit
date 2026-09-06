/**
 * Instruction breakpoints as the session holds them. The session outlives the
 * Debug page (Play and Debug take turns over one machine), so it is the only
 * owner: a view derives the list from it on every render and toggles through
 * it, and a remount shows whatever was set before.
 */
import type { Session } from '@gba-kit/debug-core';

/** Every instruction breakpoint's address, ascending. */
export function instructionAddresses(session: Session): number[] {
  return session.breakpoints
    .all()
    .filter((bp) => bp.kind === 'instruction')
    .flatMap((bp) => bp.addresses)
    .sort((a, b) => a - b);
}

/**
 * Clear the instruction breakpoint at `address` when there is one, else set one;
 * returns the new list. `address` is aligned down to a halfword first.
 */
export function toggleInstructionBreakpoint(session: Session, address: number): number[] {
  const aligned = (address & ~1) >>> 0;
  const current = instructionAddresses(session);
  const next = current.includes(aligned) ? current.filter((a) => a !== aligned) : [...current, aligned];
  session.setInstructionBreakpoints(next.map((a) => ({ address: a })));
  return instructionAddresses(session);
}
