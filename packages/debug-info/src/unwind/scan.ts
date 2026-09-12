/**
 * The last layer: inferring a caller from a word on the stack, once call-frame
 * information, the exception boundary and the prologue have all declined.
 *
 * A stack word is a candidate, not a fact, so every test applies — and one test
 * carries the layer. Being non-zero, in code, named, in the instruction set the ELF
 * records there and preceded by a genuine call still admits a stale return address
 * sitting in an uninitialised local; what rejects that is asking whether the call it
 * came from could have called the frame below.
 *
 * That question has an answer even when the call went through an interworking
 * veneer, which on a Thumb ROM calling into ARM code is most calls: the trampoline
 * holds its destination in a literal, so it is read one hop further and the test is
 * applied to where it lands. Waving a veneer through instead would leave the layer's
 * one real test doing nothing for the majority of calls.
 *
 * A word that passes every other test and only the chain test is still a return
 * address a real call left on this stack, and the frame it names is really on it —
 * an ancestor rather than the caller, with however many frames nothing could
 * recover in between. That is what it is reported as: kept, because dropping it
 * takes the whole outer stack with it, and carrying the sentence that says the run
 * of frames below it is incomplete.
 *
 * A word that fails the chain test is skipped rather than fatal, because a false
 * candidate sits *between* two real frames and stopping on it costs the rest of the
 * stack; and the search starts at sp, never below it, so words left by dead deeper
 * frames are never examined.
 */
import { callEndingAt, callReaches } from './calls.js';
import { registerSlots } from './registers.js';
import type { Candidate, FunctionRange, MachineFacts, Refusal, UnwoundFrame, WalkContext } from './types.js';

/**
 * How far above the stack pointer a caller is looked for. A frame this many words
 * deep and still not naming its caller is not going to; the cap is what keeps a
 * failed search off a 256KB EWRAM stack from being paid on every stop and step.
 */
const MAX_SCAN_WORDS = 512;

/**
 * The nearest word above `top`'s stack pointer that survives every credibility
 * test, as the frame it would be — or a sentence saying that none did.
 *
 * The word above the candidate's own slot is taken as the caller's stack pointer:
 * lr is the highest-numbered register of a `push`/`stmfd` block, so a return
 * address saved that way sits at the top of the block.
 */
export function scanForCaller(top: UnwoundFrame, ctx: WalkContext): Candidate | Refusal {
  const facts = ctx.facts;
  const sp = top.regs[13] ?? top.cfa;
  if (sp === undefined) {
    return { refused: 'the stack could not be searched: this frame has no stack pointer' };
  }
  const inner = facts.functionBounds(top.lookupPc);
  const from = sp >>> 0;
  const bound = Math.min(ctx.bound, from + MAX_SCAN_WORDS * 4);
  for (let at = from; at < bound; at += 4) {
    const word = facts.read32(at);
    if (word === undefined || word === 0) {
      continue;
    }
    if ((word & ~1) >>> 0 === top.pc) {
      // The frame below already accounts for the address it returns to; the same
      // address found again on its stack is that activation counted twice.
      continue;
    }
    const chain = credible(word, inner, facts);
    if (!chain) {
      continue;
    }
    const cfa = (at + 4) >>> 0;
    return {
      method: 'scan',
      raw: word >>> 0,
      // sp and pc are the only registers a scanned frame establishes; the rest say so.
      regs: registerSlots({ 13: cfa }),
      cfa,
      doubt: chain.doubt ?? 'this frame was inferred from a stack word, not from a described or measured frame',
    };
  }
  return {
    refused:
      bound < ctx.bound
        ? `no stack word in the ${MAX_SCAN_WORDS} above this frame was credible as a return address`
        : 'no stack word was credible as a return address',
  };
}

/**
 * Whether `word` is credible as a return address into the caller of `inner`, and
 * what about it is still open. Null when it is not.
 */
function credible(word: number, inner: FunctionRange | null, facts: MachineFacts): { doubt: string | null } | null {
  const address = (word & ~1) >>> 0;
  if (address < facts.codeFloor || !facts.isCodeRegion(address)) {
    return null;
  }
  // A scanned word gets no benefit of the doubt: it must be code the ELF accounts
  // for, and in the instruction set the ELF says lives there.
  const isa = facts.isaAt(address);
  if (isa === 'data' || isa === null) {
    return null;
  }
  if (isa === 'thumb' ? (word & 1) === 0 : (word & 3) !== 0) {
    return null;
  }
  if (!facts.nameable(address) && !facts.isExecutable(address)) {
    return null;
  }
  const called = callEndingAt(address, facts);
  if (called === null) {
    return null;
  }
  // The chain test, and the only thing that rejects a stale return address a
  // previous activation left inside this frame's uninitialised locals: could the
  // call this address follows have called the frame below it?
  const reaches = inner ? callReaches(called, inner, facts) : null;
  if (reaches === 'directly') {
    return { doubt: null };
  }
  if (reaches === 'via veneer') {
    return { doubt: 'the call this return address follows reaches the frame below through an interworking veneer' };
  }
  // A real call ends here, so this word is a return address of *something* — but
  // the call it follows went somewhere the frame below is not, or somewhere this
  // could not read. That is an ancestor at best, with the frames between it and the
  // frame below unrecovered, and at worst a word an earlier activation left behind.
  // What separates the two as far as anything here can: a sized function covering
  // the address, which is more than the chain-tested cases are asked for, because
  // they have evidence tying the word to this stack and this one does not.
  return facts.nameable(address)
    ? {
        doubt:
          'a real call ends at this address, but nothing shows it called the frame below, so frames between the two are missing',
      }
    : null;
}
