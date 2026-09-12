/**
 * Walking the machine's stack to the depth it actually has, and saying how each
 * frame was recovered.
 *
 * {@link LAYERS} is the order one step is tried in — the teardown a return is
 * already running, call-frame information, the callee's prologue, then a
 * credibility-tested stack word — and a layer declining is never the end of the
 * walk, only the end of that layer's turn. That is the whole difference from
 * unwinding by `.debug_frame` alone, which on a GBA describes a minority of the
 * stack: agbcc emits no such section at all, and a devkitARM build's table stops
 * at the edge of its own C.
 *
 * An exception boundary is not one of the layers and is recognised before the
 * sequence runs: crossing one emits two frames and moves the walk onto another
 * mode's stack, neither of which the shape of a layer can express.
 *
 * The teardown comes before the table because gcc's `.debug_frame` is
 * *synchronous*: its rows track the prologue and stop, so in an epilogue it hands
 * back a CFA a whole frame too high and a return address from a slot that has
 * already been popped. What is left to run is the better evidence there.
 *
 * Every frame records the layer that produced it, so the difference between a
 * described frame, a measured one and an inferred one stays visible instead of
 * being flattened into one confident-looking list; and every walk records why it
 * ended, so "the stack ends here" is a statement rather than a silence.
 */
import type { FrameTable } from '../dwarf/frame.js';
import { hex8 } from '../reader.js';
import type { CodeIsa } from '../symbols.js';
import { callEndingAt, callReaches } from './calls.js';
import { measurePrologue } from './prologue.js';
import { registerSlots } from './registers.js';
import { scanForCaller } from './scan.js';
import {
  type Candidate,
  type Layer,
  type MachineFacts,
  type Measured,
  type MeasuredFrame,
  type Refusal,
  type StackWalk,
  type UnwoundFrame,
  type WalkContext,
  type WalkOptions,
  frameConfidence,
} from './types.js';

/** A backstop against a corrupted stack, not a depth limit: the stack bound is the real one. */
const MAX_FRAMES = 256;

const LAYERS: Layer[] = [fromTeardown, fromCfi, fromPrologue, fromStackWord];

export function unwindStack(
  pc: number,
  liveRegs: ArrayLike<number>,
  facts: MachineFacts,
  cfi: FrameTable,
  options: WalkOptions = {},
): StackWalk {
  const regs: Array<number | undefined> = Array.from(liveRegs);
  const frames: UnwoundFrame[] = [{ pc, lookupPc: pc, regs, cfa: cfi.cfa(pc, regs), method: 'live', doubt: null }];
  const ctx: WalkContext = {
    facts,
    cfi,
    bound: facts.stackBoundFor(facts.mode, regs[13]),
    scan: options.scan !== false,
    measurement: { refused: 'no frame has been measured yet' },
  };
  let floor: number | undefined;
  /** the boundaries already crossed: crossing one twice is a loop, not a nesting */
  const crossed = new Set<number>();
  // Every way out of the loop below states its own reason; exhausting the frame
  // budget is the one that does not, so it is the standing answer.
  let end = `the walk was truncated at ${MAX_FRAMES} frames`;
  while (frames.length < MAX_FRAMES) {
    const top = frames[frames.length - 1]!;
    ctx.measurement = measureFrame(top, ctx.facts);
    const step = advance(top, ctx);
    if (step.cfa !== undefined) {
      // The CFA is a fact about the frame we unwound *from*, and it is only known
      // now — so it is recorded there, where a frame base will look for it.
      if (floor !== undefined && step.cfa <= floor) {
        end = 'the frames stopped moving up the stack, so the chain is not a chain';
        break;
      }
      if (step.cfa > ctx.bound) {
        end = 'the stack pointer reached the top of its region';
        break;
      }
      top.cfa = step.cfa;
      floor = step.cfa;
    }
    const resume = step.crossed === undefined ? undefined : step.frames[step.frames.length - 1]?.pc;
    if (resume !== undefined) {
      // Nested exceptions each have their own boundary; arriving back at one the
      // walk has already crossed means the state it is reading is not a chain of
      // them, which a corrupted stack pointer is enough to produce.
      if (crossed.has(resume)) {
        end = 'the same interrupt boundary was crossed twice, so the chain is not a chain';
        break;
      }
      crossed.add(resume);
    }
    for (const frame of step.frames) {
      // A frame standing on an inferred one is no better established than what it stands on.
      if (frameConfidence(top.method) === 'inferred' && !frame.doubt) {
        frame.doubt = 'the frame below it was inferred rather than derived';
      }
      frames.push(frame);
    }
    if (step.end !== undefined) {
      end = step.end;
      break;
    }
    if (step.crossed !== undefined) {
      // The other side of an exception is another mode's stack, where this stack's
      // addresses say nothing about progress.
      floor = undefined;
      ctx.bound = ctx.facts.stackBoundFor(step.crossed.mode, step.crossed.sp);
    }
  }
  return { frames, end };
}

interface Advance {
  /** the CFA of the frame stepped from, when this step established it */
  cfa?: number;
  frames: UnwoundFrame[];
  /** why nothing beyond these frames can be reached */
  end?: string;
  /** set when the step crossed onto another mode's stack */
  crossed?: { mode: number; sp: number | undefined };
}

/** What reading an exception boundary gives: the interrupted frame, and the stack it is on. */
interface Crossing {
  frames: UnwoundFrame[];
  crossed: { mode: number; sp: number | undefined };
}

function advance(top: UnwoundFrame, ctx: WalkContext): Advance {
  if (top.pc < ctx.facts.codeFloor) {
    // Frame 0 is inside the stub itself — the machine is stopped in the BIOS — so
    // the boundary is right here and the live stack pointer is where the pushed
    // block sits. A stub frame further up crossed in the step that emitted it.
    const crossing = crossException(top.regs[13], undefined, ctx.facts);
    return 'refused' in crossing ? { frames: [], end: crossing.refused } : crossing;
  }
  const sp = top.regs[13];
  if (sp !== undefined && sp >= ctx.bound) {
    // A caller's frame would sit at addresses at or above this one's stack pointer,
    // and there are none: this is the top of the stack. Said before the layers are
    // tried, because what they would report instead is whatever they could not
    // decode about the entry point — true, and no answer to where the stack ends.
    return { frames: [], end: "this frame's stack pointer is at the top of its stack, so nothing called it" };
  }
  const refusals: string[] = [];
  for (const layer of LAYERS) {
    const step = layer(top, ctx);
    if (!('refused' in step)) {
      return frameFor(top, step, ctx);
    }
    refusals.push(step.refused);
  }
  // The last layers to try are the ones whose refusal says something about this
  // frame rather than about the ELF as a whole.
  return { frames: [], end: refusals.slice(-2).join(', and ') };
}

/** A candidate as the frame it names — or as the exception boundary its return address turns out to be. */
function frameFor(top: UnwoundFrame, candidate: Candidate, ctx: WalkContext): Advance {
  const facts = ctx.facts;
  const ra = (candidate.raw & ~1) >>> 0;
  if (ra === 0) {
    return {
      cfa: candidate.cfa,
      frames: [],
      end: "the outermost frame's saved return address reads 0, which is either the root of the stack or a slot the program overwrote",
    };
  }
  if (ra < facts.codeFloor) {
    // An exception stub, not a caller — if the boundary it claims reads. A small
    // stale word looks exactly like a stub address, so the crossing is validated
    // before any of it is reported, and the stub frame is emitted only with the
    // frame it crosses to. It is named by neither DWARF nor the symbol table, both
    // of which will happily claim the BIOS region, so it gets no source.
    const stubSp = facts.bankedSp(facts.exceptionStub.mode);
    const crossing = crossException(stubSp, candidate.cfa, facts);
    if ('refused' in crossing) {
      return {
        cfa: candidate.cfa,
        frames: [],
        end: `the next return address (0x${hex8(ra)}) is below the program, and ${crossing.refused}`,
      };
    }
    const stub: UnwoundFrame = {
      pc: ra,
      lookupPc: ra,
      regs: registerSlots({ 13: stubSp ?? candidate.cfa, 15: ra }),
      cfa: undefined,
      method: 'exception',
      doubt: null,
    };
    return { cfa: candidate.cfa, frames: [stub, ...crossing.frames], crossed: crossing.crossed };
  }
  const gate = gateReturnAddress(ra, facts);
  if (gate.rejected) {
    return {
      cfa: candidate.cfa,
      frames: [],
      end: `the next return address (0x${hex8(ra)}) ${gate.rejected}`,
    };
  }
  const inner = facts.functionBounds(top.lookupPc);
  if (inner && ra >= inner.lo && ra < inner.hi && candidate.cfa === top.regs[13]) {
    // A function does not call itself without moving sp, so a return address in the
    // frame's own function over an unmoved stack pointer is this activation read
    // twice — which is what an lr clobbered by a loop of the function's own making
    // looks like.
    return {
      cfa: candidate.cfa,
      frames: [],
      end: `the next return address (0x${hex8(ra)}) is inside this frame's own function, with no frame between the two`,
    };
  }
  candidate.regs[15] = ra;
  return {
    cfa: candidate.cfa,
    frames: [
      {
        pc: ra,
        lookupPc: (ra - 2) >>> 0,
        regs: candidate.regs,
        cfa: undefined,
        method: candidate.method,
        doubt: candidate.doubt ?? gate.doubt,
      },
    ],
  };
}

function fromCfi(top: UnwoundFrame, ctx: WalkContext): Candidate | Refusal {
  const measured = ctx.measurement;
  if (!('refused' in measured) && measured.frame.teardown) {
    // The table describes the frame the prologue built, and this pc has begun
    // taking it apart, so its rows are stale here however they read. The
    // measurement of what is left to run answers instead.
    return { refused: 'the pc is in a teardown that the call-frame table does not describe' };
  }
  const result = ctx.cfi.unwind(top.lookupPc, top.regs, (a) => ctx.facts.read32(a));
  return result
    ? { method: 'cfi', raw: result.returnAddress, regs: result.regs, cfa: result.cfa, doubt: null }
    : { refused: 'there is no call-frame information for this frame' };
}

/**
 * The caller measured from the teardown the function has left to run. Only a pc at
 * a teardown instruction, where the table a compiler wrote for the prologue no
 * longer describes the frame — every other pc is left to {@link fromCfi} first.
 */
function fromTeardown(top: UnwoundFrame, ctx: WalkContext): Candidate | Refusal {
  const measured = ctx.measurement;
  if ('refused' in measured) {
    return measured;
  }
  return measured.frame.teardown
    ? callerFrom(measured.frame, measured.sp, top, ctx)
    : { refused: 'the pc is not at a teardown, so nothing about this frame is left to undo' };
}

/**
 * The caller measured from the callee's own prologue: the frame size gives the
 * CFA, which is the caller's sp, and the slot the prologue put lr in gives the
 * return address. When the prologue proves lr has not been spilled — a leaf, or a
 * stop before the push — lr itself is the return address, and *only* then: an
 * unproven lr is the return of a call this function already made, which reads as
 * a caller and is in fact a function that has already come back.
 */
function fromPrologue(top: UnwoundFrame, ctx: WalkContext): Candidate | Refusal {
  const measured = ctx.measurement;
  return 'refused' in measured ? measured : callerFrom(measured.frame, measured.sp, top, ctx);
}

function fromStackWord(top: UnwoundFrame, ctx: WalkContext): Candidate | Refusal {
  if (!ctx.scan) {
    return { refused: 'the stack was not searched for one' };
  }
  return scanForCaller(top, ctx);
}

/**
 * The function's frame as it stands at this pc, and the stack pointer it was
 * measured against.
 *
 * The function is looked up at `lookupPc`, which for a caller is inside the call
 * so that a `bl` ending a function does not name the next one; the frame is
 * measured at the pc itself, which is where execution stands or will resume and
 * the only address the code decodes from. Measuring at `lookupPc` would land
 * between the halves of a Thumb `bl` — every caller's frame would be measured
 * mid-instruction, and everything its body pushed after that call would be
 * missing from the frame.
 */
function measureFrame(top: UnwoundFrame, facts: MachineFacts): Measured | Refusal {
  const bounds = facts.functionBounds(top.lookupPc);
  if (!bounds) {
    return { refused: 'nothing in the ELF says which function this frame is executing' };
  }
  const sp = top.regs[13];
  if (sp === undefined) {
    return { refused: "this frame's stack pointer was never recovered" };
  }
  const isa = isaOf(bounds.lo, top.pc, facts);
  if (!isa) {
    return { refused: 'the instruction set of this function could not be established' };
  }
  const measured = measurePrologue(bounds.lo, top.pc, bounds.hi, isa, facts);
  return measured.ok
    ? { frame: measured.frame, sp }
    : { refused: `the prologue could not be measured: ${measured.reason}` };
}

/** A measured frame as its caller: the CFA, the return address, and the registers the callee saved. */
function callerFrom(frame: MeasuredFrame, sp: number, top: UnwoundFrame, ctx: WalkContext): Candidate | Refusal {
  const facts = ctx.facts;
  const cfa = (sp + frame.frameSize) >>> 0;
  const doubt = frame.teardown
    ? 'the frame was measured in the function epilogue, from the teardown left to run'
    : null;
  const regs = registerSlots({ 13: cfa });
  for (let r = 4; r <= 11; r++) {
    // A callee that saved the register hands it back from its slot; one that did
    // not never clobbered it, so the live value already is the caller's. r0–r3 and
    // r12 are neither, and stay undefined rather than showing the callee's.
    const saved = frame.saved.get(r);
    regs[r] = saved === undefined ? top.regs[r] : facts.read32((cfa + saved) >>> 0);
  }
  const slot = frame.saved.get(14);
  if (slot !== undefined) {
    const raw = facts.read32((cfa + slot) >>> 0);
    if (raw === undefined) {
      return { refused: 'the slot holding the return address is unreadable' };
    }
    regs[14] = raw >>> 0;
    return { method: 'prologue', raw: raw >>> 0, regs, cfa, doubt };
  }
  if (frame.raLive === undefined) {
    return (
      corroboratedLr(cfa, regs, top, ctx) ?? {
        refused: 'this function saves no return address and lr has been overwritten since it was entered',
      }
    );
  }
  const live = top.regs[frame.raLive];
  if (live === undefined) {
    return { refused: `r${frame.raLive} holds this frame's return address, and was never recovered` };
  }
  regs[14] = live >>> 0;
  return { method: frame.raLive === 14 ? 'lr' : 'prologue', raw: live >>> 0, regs, cfa, doubt };
}

/**
 * lr where the decode could not prove it is still the return address, but a call
 * into this very function ends at it.
 *
 * That is the same corroboration a stack word has to pass in {@link scanForCaller},
 * available here for free and stronger: the address is in the register the hardware
 * wrote it to rather than in a word that merely looks like one. It is offered
 * before the stack is searched, and flagged — what the decode could not rule out
 * is that a call this function made has overwritten lr since.
 */
function corroboratedLr(
  cfa: number,
  regs: Array<number | undefined>,
  top: UnwoundFrame,
  ctx: WalkContext,
): Candidate | null {
  const lr = top.regs[14];
  const fn = ctx.facts.functionBounds(top.lookupPc);
  if (lr === undefined || !fn) {
    return null;
  }
  const ra = (lr & ~1) >>> 0;
  if (ra === 0 || ra === top.pc) {
    return null;
  }
  const called = callEndingAt(ra, ctx.facts);
  const reaches = called === null ? null : callReaches(called, fn, ctx.facts);
  if (!reaches) {
    return null;
  }
  regs[14] = lr >>> 0;
  return {
    method: 'lr-corroborated',
    raw: lr >>> 0,
    regs,
    cfa,
    doubt:
      reaches === 'via veneer'
        ? 'lr was not proved intact; what corroborates it is a call reaching this function through an interworking veneer'
        : 'lr was not proved intact; what corroborates it is a call to this function ending at it',
  };
}

/**
 * The instruction set to read this frame's code in. Mapping symbols are the only
 * record of it, and they are per-address for a reason: an interworking veneer
 * changes instruction set halfway through itself, so taking the function's entry as
 * the answer decodes the far half as the wrong one. The entry answers only where
 * the ELF says nothing about the pc; where it says nothing about either, a
 * measurement would be a decode of bytes that may not be instructions.
 */
function isaOf(entry: number, pc: number, facts: MachineFacts): CodeIsa | null {
  const stated = facts.isaAt(pc) ?? facts.isaAt(entry);
  return stated === 'arm' || stated === 'thumb' ? stated : null;
}

/**
 * Whether a return address is worth following. A derived address is a fact and
 * only has to be code; a name for it is corroboration, and its absence is worth
 * saying but never worth dropping a real frame over — crt0's `bl main` returns
 * into a NOTYPE symbol of size 0, and that frame is the bottom of every stack. A
 * scanned word has already passed its own mandatory tests in
 * {@link scanForCaller}.
 */
function gateReturnAddress(ra: number, facts: MachineFacts): { rejected?: string; doubt: string | null } {
  if (!facts.isCodeRegion(ra)) {
    return { rejected: 'is not in a region that holds code', doubt: null };
  }
  const named = facts.nameable(ra);
  if (!named && !facts.isExecutable(ra) && callEndingAt(ra, facts) === null) {
    return { rejected: 'lies in no executable section, is named by nothing, and no call ends there', doubt: null };
  }
  // Said against what `nameable` asks, which is whether a sized symbol or a DWARF
  // entry covers the address — not whether anything at all is near it. A row can be
  // labelled from the nearest symbol and still have nothing stating its extent.
  return { doubt: named ? null : `no sized symbol or DWARF entry covers the code at 0x${hex8(ra)}` };
}

/**
 * Crossing out of an exception stub into the code it interrupted.
 *
 * The GBA's IRQ stub pushes r0–r3, r12 and lr and enters the handler with lr
 * pointing at its own return path, so the handler's return address is a BIOS
 * address rather than a caller — that is the boundary. What it interrupted is
 * written down in three places: the pushed block holds the scratch registers and
 * the interrupted lr, the SPSR holds the mode and instruction set, and that mode's
 * banked stack pointer holds where its stack was.
 *
 * The block is found rather than assumed. The stub bank's stack pointer still
 * holds the post-push value, since the stub has not popped; the handler's own CFA
 * answers when the bank cannot be read. A fixed `0x03007fa0` gets the first case
 * wrong for a game that relocated `sp_irq`, and a handler-relative CFA gets it
 * wrong for a handler that switched modes, so both are tried and validated. Before
 * the stub has pushed anything there is no block at all, and its own lr is then
 * the only record of what it interrupted. A ROM whose dispatcher has another shape
 * ends the walk with a reason instead of a fabricated frame.
 */
function crossException(
  stubSp: number | undefined,
  handlerCfa: number | undefined,
  facts: MachineFacts,
): Crossing | Refusal {
  const stub = facts.exceptionStub;
  const spsr = facts.spsr(stub.mode);
  if (spsr === undefined) {
    return { refused: 'the interrupt boundary could not be read: it has no saved status register' };
  }
  const interrupted = spsr & 0x1f;
  const bias = facts.exceptionReturnBias(stub.mode);
  for (const base of [stubSp, handlerCfa]) {
    if (base === undefined) {
      continue;
    }
    const lr = facts.read32((base + stub.lrOffset) >>> 0);
    const resume = resumeAddress(lr, bias, facts);
    if (resume === null) {
      continue;
    }
    const regs = registerSlots({ 15: resume });
    for (let r = 0; r <= 3; r++) {
      regs[r] = facts.read32((base + r * 4) >>> 0);
    }
    regs[12] = facts.read32((base + 16) >>> 0);
    // A handler that switched into the mode it interrupted shares its stack, so
    // where that stack was is the handler's own CFA, not the live pointer.
    regs[13] = interrupted === facts.mode ? (handlerCfa ?? facts.bankedSp(interrupted)) : facts.bankedSp(interrupted);
    regs[14] = facts.bankedLr(interrupted);
    return interruptedFrame(
      regs,
      resume,
      interrupted,
      // r4–r11 are not banked, so what the handler has done with them is unknown.
      'r4–r11 were not recovered across the interrupt: they are not banked, so the handler may hold them',
    );
  }
  // Inside the stub before its push: nothing is on its stack yet, and its lr still
  // holds the address the interrupt struck. Once the stub has called the handler
  // that lr is the stub's own return path, a BIOS address, which is why following
  // it can only ever land in the interrupted code.
  const early = resumeAddress(facts.bankedLr(stub.mode), bias, facts);
  if (early === null) {
    return { refused: 'the interrupt boundary could not be read: no pushed stub frame matched' };
  }
  const regs = registerSlots({
    13: facts.bankedSp(interrupted),
    14: facts.bankedLr(interrupted),
    15: early,
  });
  return interruptedFrame(
    regs,
    early,
    interrupted,
    'the interrupt stub had not pushed its block yet, so only the interrupted pc, sp and lr were recovered',
  );
}

/** The interrupted instruction's address, or null when what was read cannot be one. */
function resumeAddress(lr: number | undefined, bias: number, facts: MachineFacts): number | null {
  if (lr === undefined) {
    return null;
  }
  // What `subs pc, lr, #4` does, which is right for an ARM and a Thumb
  // interruption alike.
  const resume = ((lr + bias) & ~1) >>> 0;
  return resume >= facts.codeFloor && facts.isCodeRegion(resume) && facts.functionBounds(resume) ? resume : null;
}

function interruptedFrame(regs: Array<number | undefined>, resume: number, mode: number, doubt: string): Crossing {
  return {
    frames: [
      {
        pc: resume,
        // The interrupted pc is the next instruction rather than a return address,
        // so it is looked up as itself instead of being backed into a call.
        lookupPc: resume,
        regs,
        cfa: undefined,
        method: 'exception',
        doubt,
      },
    ],
    crossed: { mode, sp: regs[13] },
  };
}
