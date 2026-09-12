/**
 * Finding the call that a return address returns from, and where that call was
 * going.
 *
 * This is the test that tells a real return address from a word that merely looks
 * like one — nothing returns to an address no call precedes — and, once a call is
 * found, the only evidence that says which function it entered: its target is
 * written in the instruction.
 *
 * ARMv4T has no `blx`, so every call is a direct `bl`. An indirect call goes
 * through an interworking veneer, which is itself reached by a `bl`, so a call that
 * lands on a trampoline is followed one hop to the function it jumps to rather than
 * being waved through as unknowable.
 */
import type { CodeIsa } from '../symbols.js';
import { decode } from './decode.js';
import type { CodeReader, FunctionRange, MachineFacts, ProgramFacts } from './types.js';

/** Both call encodings this hardware has are four bytes long, so a call ends four bytes back. */
const CALL_SIZE = 4;

/** An interworking veneer is a couple of instructions; past this a function is doing work of its own. */
const MAX_VENEER_BYTES = 16;

/** How many instructions of a trampoline are read before giving up on where it goes. */
const MAX_VENEER_STEPS = 6;

/** The target of the call whose last byte ends just before `address`, or null when no call does. */
export function callEndingAt(address: number, program: ProgramFacts & CodeReader): number | null {
  const at = (address - CALL_SIZE) >>> 0;
  const isa = program.isaAt(address);
  if (isa !== 'arm' && isa !== 'thumb') {
    return null;
  }
  const effect = decode(at, isa, program);
  return effect.kind === 'call' && effect.size === CALL_SIZE ? (effect.target ?? null) : null;
}

/**
 * How the call to `called` could have reached `fn`: by naming it, or by naming a
 * trampoline that jumps to it. Null when it reached neither, which is evidence
 * that the call went somewhere else entirely.
 */
export function callReaches(called: number, fn: FunctionRange, facts: MachineFacts): 'directly' | 'via veneer' | null {
  if (called >= fn.lo && called < fn.hi) {
    return 'directly';
  }
  const hop = veneerTarget(called, facts);
  return hop !== null && hop >= fn.lo && hop < fn.hi ? 'via veneer' : null;
}

/**
 * Where a trampoline at `entry` ends up: a veneer holds its destination in a
 * literal and branches through the register it loaded it into, switching
 * instruction set with `bx pc` on the way when the two halves differ. Null when
 * the function at `entry` is too long to be one, or does something this cannot read.
 */
function veneerTarget(entry: number, facts: MachineFacts): number | null {
  const bounds = facts.functionBounds(entry);
  if (!bounds || bounds.hi - bounds.lo > MAX_VENEER_BYTES) {
    return null;
  }
  const isa = facts.isaAt(entry);
  if (isa !== 'arm' && isa !== 'thumb') {
    return null;
  }
  return followTrampoline(entry, bounds, isa, facts);
}

function followTrampoline(entry: number, bounds: FunctionRange, isa: CodeIsa, code: CodeReader): number | null {
  const constants = new Map<number, number>();
  let at = entry;
  for (let step = 0; step < MAX_VENEER_STEPS && at >= bounds.lo && at < bounds.hi; step++) {
    const effect = decode(at, isa, code);
    switch (effect.kind) {
      case 'literal': {
        const word = code.read32(effect.from);
        if (word === undefined) {
          return null;
        }
        constants.set(effect.to, word);
        break;
      }
      case 'branch':
      case 'call':
        return effect.target ?? null;
      case 'return': {
        if (effect.via === 'lr') {
          return null; // a return, not a trampoline
        }
        if (effect.via.reg === 15) {
          // `bx pc`: the instruction-set switch of a Thumb veneer, which lands on
          // the word-aligned halfword after the one it skips.
          at = ((at + 4) & ~3) >>> 0;
          continue;
        }
        const held = constants.get(effect.via.reg);
        return held === undefined ? null : (held & ~1) >>> 0;
      }
      default:
        break;
    }
    at = (at + effect.size) >>> 0;
  }
  return null;
}
