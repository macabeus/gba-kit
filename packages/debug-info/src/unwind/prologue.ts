/**
 * Measure a frame by decoding the function's own code, for the frames
 * `.debug_frame` does not describe — on a GBA, most of them: agbcc emits no
 * call-frame information at all, and a devkitARM build's table covers its own C
 * and stops at the edge of libgba, newlib and crt0.
 *
 * The unit of belief is a *measurement*, never a guess: the instructions between
 * the function's entry and the pc are replayed, the frame's size is summed from
 * what they did to sp, and each saved word is attributed to the register whose
 * value it actually holds. Anything that could move sp or lr and is not
 * recognised is a refusal, so a frame is either derived or absent.
 *
 * A call is replayed *through* rather than stopped at, because control comes back
 * to the instruction after it: a function that pushes its stack arguments after
 * calling something has those bytes in its frame, and stopping at the call
 * measures a frame that is short by all of them. What the call takes with it is
 * provenance — r0–r3, r12 and lr belong to the callee under the ABI — so those
 * registers stop holding anything the replay can attribute. A *branch* is the real
 * end of what can be replayed, since past one the instructions that ran are no
 * longer the ones written down; and then a frame is reported only if nothing
 * between the branch and the pc moves sp at all.
 *
 * Register provenance is the part that cannot be skipped. Both toolchains emit
 * prologues that copy a high register into a low one and push the copy
 * (`mov r7, sl; push {r5,r6,r7}`), and one that parks r11 in lr before pushing
 * (`mov lr, fp; push {r5,r6,r7,lr}`) — so "the top slot of a push with the LR bit
 * set holds the return address" is false in real output, and which register a
 * slot holds has to be tracked rather than read off the encoding.
 */
import type { CodeIsa } from '../symbols.js';
import { decode } from './decode.js';
import type { CodeReader, MeasuredFrame } from './types.js';

export type Measurement = { ok: true; frame: MeasuredFrame } | { ok: false; reason: string };

/** A backstop against a pathological function, not a prologue length: the replay follows the straight line to the pc. */
const MAX_REPLAY_STEPS = 512;
/** An epilogue is a short tail of teardowns; beyond this the pc is in the body. */
const MAX_EPILOGUE_STEPS = 8;
/** A function larger than this is not scanned for lr writes; the answer becomes "assume clobbered". */
const MAX_LEAF_SCAN_BYTES = 0x4000;

/** Registers a call certainly overwrites: lr, which the hardware writes, and the ones it passes arguments in. */
const CALL_WRITES = [0, 1, 2, 3, 14];
/** Those, plus the scratch register — a literal in any of them is the callee's to overwrite. */
const CALL_SCRATCH = [...CALL_WRITES, 12];

/**
 * The frame of the function entered at `entry`, as it stands at `pc`.
 *
 * `end` bounds the function, and answers the one question the replay cannot:
 * whether lr still holds the return address at a pc the replay could not reach.
 * A function that contains no call and never writes lr keeps it intact at every
 * one of its addresses, whatever path execution took — which is what lets a leaf
 * stopped after a branch still report its caller.
 */
export function measurePrologue(entry: number, pc: number, end: number, isa: CodeIsa, code: CodeReader): Measurement {
  if (pc < entry || pc > end) {
    return { ok: false, reason: 'the pc is outside the function it was looked up in' };
  }
  const teardown = measureEpilogue(entry, pc, end, isa, code);
  if (teardown) {
    return { ok: true, frame: teardown };
  }
  const replay = replayPrologue(entry, pc, isa, code);
  if (!replay.ok) {
    return replay;
  }
  const { state, stoppedAt } = replay;
  if (stoppedAt < pc && spMovedBetween(stoppedAt, pc, isa, code)) {
    // The replay lost the path at a branch, and sp is moved somewhere between there
    // and the pc: the frame it measured is the frame at the branch, not here.
    return { ok: false, reason: 'sp is moved between the last instruction that could be followed and the pc' };
  }
  return {
    ok: true,
    frame: {
      frameSize: state.frameSize,
      saved: state.saved,
      raLive: returnRegister(state, entry, end, isa, code, stoppedAt === pc),
      teardown: false,
    },
  };
}

interface ReplayState {
  /** what each machine register holds, as an original register number; -1 when unknown */
  holds: number[];
  frameSize: number;
  saved: Map<number, number>;
  /** literal-pool words loaded into registers, for the `ldr rN, =-728; add sp, rN` idiom */
  constants: Map<number, number>;
}

type Replay = { ok: true; state: ReplayState; stoppedAt: number } | { ok: false; reason: string };

function replayPrologue(entry: number, pc: number, isa: CodeIsa, code: CodeReader): Replay {
  const state: ReplayState = {
    holds: Array.from({ length: 16 }, (_, i) => i),
    frameSize: 0,
    saved: new Map(),
    constants: new Map(),
  };
  let at = entry;
  for (let step = 0; at < pc; step++) {
    if (step >= MAX_REPLAY_STEPS) {
      return { ok: true, state, stoppedAt: at };
    }
    const effect = decode(at, isa, code);
    switch (effect.kind) {
      case 'refuse':
        return { ok: false, reason: effect.reason };
      case 'data':
        return { ok: false, reason: 'the ELF marks an address before the pc as data, not as instructions' };
      case 'return':
        // A conditional return that did not fire is not a transfer of control, and
        // it moves neither sp nor lr, so the replay walks through it. That is the
        // early exit a libgba interrupt dispatcher opens with, and stopping at it
        // means never seeing the push four instructions later.
        if (!effect.conditional) {
          return { ok: true, state, stoppedAt: at };
        }
        break;
      case 'branch':
        return { ok: true, state, stoppedAt: at };
      case 'call':
        // r12 is missing from what a call is taken to overwrite on purpose. A callee
        // may use it as scratch, but a function that returns *through* it
        // (`mov ip, lr … bx ip`, which m4a and hand-written agbcc assembly are full
        // of) is asserting that its own callees do not, or it would never come back
        // — and that assertion is what {@link returnsVia} checks before the register
        // is believed. A literal value is dropped for it all the same, since the
        // frame arithmetic has no such assertion behind it.
        for (const reg of CALL_WRITES) {
          state.holds[reg] = -1;
        }
        for (const reg of CALL_SCRATCH) {
          state.constants.delete(reg);
        }
        break;
      case 'push': {
        state.frameSize += 4 * effect.regs.length;
        effect.regs.forEach((reg, slot) => {
          const original = state.holds[reg]!;
          // First save wins: a register parked in lr and pushed a second time must
          // not displace the return address the first push wrote down.
          if (original >= 0 && !state.saved.has(original)) {
            state.saved.set(original, slot * 4 - state.frameSize);
          }
        });
        break;
      }
      case 'pop':
        return { ok: false, reason: 'the frame is already coming apart at this pc' };
      case 'sp-unknown':
        return { ok: false, reason: 'sp was set from a register whose value this scan does not track' };
      case 'sp-add':
        state.frameSize -= effect.delta;
        if (state.frameSize < 0) {
          return { ok: false, reason: 'the prologue moved sp above the frame it was entered with' };
        }
        break;
      case 'sp-add-reg': {
        const constant = state.constants.get(effect.reg);
        if (constant === undefined) {
          return { ok: false, reason: `sp was adjusted by r${effect.reg}, which holds no literal this scan read` };
        }
        state.frameSize -= constant | 0;
        break;
      }
      case 'move':
        state.holds[effect.to] = state.holds[effect.from]!;
        state.constants.delete(effect.to);
        break;
      case 'literal': {
        const word = code.read32(effect.from);
        if (word === undefined) {
          return { ok: false, reason: 'a literal-pool word the prologue loads is unreadable' };
        }
        state.holds[effect.to] = -1;
        state.constants.set(effect.to, word);
        break;
      }
      case 'clobber':
        for (const reg of effect.regs) {
          state.holds[reg] = -1;
          state.constants.delete(reg);
        }
        break;
    }
    at += effect.size;
  }
  return { ok: true, state, stoppedAt: at };
}

/**
 * Which register holds this frame's return address, when no saved slot does.
 *
 * A function that parks its return address in another register returns through
 * that register, and its own return instruction is what says so: `mov ip, lr …
 * bx ip`, which m4a and hand-written agbcc assembly are full of. The copy is
 * preferred over lr itself because while lr is intact the two are the same value,
 * and once a call has overwritten lr only the copy is still the return address.
 *
 * lr is offered last, and only where the decode reached the pc — proving the
 * instructions that ran wrote nothing to it — or where nothing anywhere in the
 * function writes lr at all.
 */
function returnRegister(
  state: ReplayState,
  entry: number,
  end: number,
  isa: CodeIsa,
  code: CodeReader,
  reachedPc: boolean,
): number | undefined {
  for (let reg = 0; reg < 14; reg++) {
    if (state.holds[reg] === 14 && returnsVia(reg, entry, end, isa, code)) {
      return reg;
    }
  }
  return state.holds[14] === 14 && (reachedPc || !lrEverClobbered(entry, end, isa, code)) ? 14 : undefined;
}

/** Whether the function leaves through `bx reg` / `mov pc, reg` unconditionally. */
function returnsVia(reg: number, entry: number, end: number, isa: CodeIsa, code: CodeReader): boolean {
  for (let at = entry; at < end; ) {
    const effect = decode(at, isa, code);
    if (effect.kind === 'refuse') {
      return false;
    }
    if (effect.kind === 'return' && effect.via !== 'lr' && effect.via.reg === reg && !effect.conditional) {
      return true;
    }
    at += effect.size;
  }
  return false;
}

/** Whether anything between two addresses of a function moves sp. */
function spMovedBetween(from: number, to: number, isa: CodeIsa, code: CodeReader): boolean {
  for (let at = from; at < to; ) {
    const effect = decode(at, isa, code);
    switch (effect.kind) {
      case 'push':
      case 'pop':
      case 'sp-add':
      case 'sp-add-reg':
      case 'sp-unknown':
      case 'refuse':
        return true;
      default:
        at += effect.size;
    }
  }
  return false;
}

/**
 * The frame at a pc the function returns from in a straight line, measured from
 * what is still to be undone: every sp movement from `pc` to the return releases
 * part of the frame, so the CFA is sp plus their sum, and the return address is in
 * whichever slot the return reads — or, once the pop that loaded it has run, in
 * the register the return branches through. Null when no straight path to a return
 * is in reach, which is the ordinary body case.
 *
 * This runs before the replay because the replay measures such a pc wrong rather
 * than not at all: it reports the frame the prologue built, which by the return is
 * already gone.
 */
function measureEpilogue(entry: number, pc: number, end: number, isa: CodeIsa, code: CodeReader): MeasuredFrame | null {
  let popped = 0;
  /** machine register → the offset, from sp at `pc`, of the slot holding its caller value */
  const restores = new Map<number, number>();
  /** whether the pc itself is a teardown instruction, so call-frame information's prologue row is already stale */
  let teardown = false;
  let at = pc;
  for (let step = 0; step < MAX_EPILOGUE_STEPS && at < end; step++) {
    const effect = decode(at, isa, code);
    if (step === 0) {
      teardown = effect.kind === 'pop' || effect.kind === 'sp-add' || effect.kind === 'return';
    }
    switch (effect.kind) {
      case 'pop': {
        effect.regs.forEach((reg, slot) => restores.set(reg, popped + slot * 4));
        popped += 4 * effect.regs.length;
        if (effect.toPc) {
          return frameFromTeardown(restores, popped, restores.get(15), undefined, teardown);
        }
        break;
      }
      case 'sp-add':
        if (effect.delta < 0) {
          return null; // sp moving down is a prologue, not a teardown
        }
        popped += effect.delta;
        break;
      case 'move':
        // agbcc restores r8-r10 through low registers: `pop {r3,r4,r5}; mov r8,r3`.
        transfer(restores, effect.to, effect.from);
        break;
      case 'return': {
        if (effect.conditional) {
          // It may not fire, so neither answer is a measurement: the replay, which
          // knows what the instructions before the pc did, measures this pc instead.
          return null;
        }
        // The machine is about to leave through this instruction, so whatever the
        // remaining teardown does not reload is already in the register it branches
        // through — including lr, which an `ldmfd sp!, {fp, lr}` still ahead of the
        // pc would otherwise be read from while it holds the return of a call this
        // function has already made.
        const via = effect.via === 'lr' ? 14 : effect.via.reg;
        const raOffset = restores.get(via);
        if (raOffset !== undefined) {
          return frameFromTeardown(restores, popped, raOffset, undefined, teardown);
        }
        if (via !== 14 && !loadedFromFrame(entry, at, via, isa, code)) {
          // Nothing says this branch is a return: an interworking veneer and a jump
          // table go through a register too, and what they hold is where the call is
          // going rather than where this frame came from.
          return null;
        }
        return frameFromTeardown(restores, popped, undefined, via, teardown);
      }
      default:
        return null;
    }
    at += effect.size;
  }
  return null;
}

/** How far behind a register return the pop that loaded it may sit. */
const MAX_RETURN_LOOKBACK = 3;

/**
 * Whether the register a return branches through was loaded off this frame's stack
 * just before it — the instructions the pc has already run, and the difference
 * between `pop {r0}; bx r0` ending a function and a veneer's `bx r3` entering one.
 *
 * Reading backwards is exact here: both instruction sets are fixed-width, and no
 * `pop` encoding is also the second half of a Thumb `bl`.
 */
function loadedFromFrame(entry: number, at: number, reg: number, isa: CodeIsa, code: CodeReader): boolean {
  const width = isa === 'arm' ? 4 : 2;
  for (let back = 1; back <= MAX_RETURN_LOOKBACK; back++) {
    const before = at - width * back;
    if (before < entry) {
      return false;
    }
    const effect = decode(before, isa, code);
    if (effect.kind === 'pop') {
      return effect.regs.includes(reg);
    }
    if (effect.kind !== 'sp-add' && effect.kind !== 'move' && effect.kind !== 'clobber') {
      return false;
    }
  }
  return false;
}

/**
 * sp-relative restore offsets as CFA-relative saved slots.
 *
 * A register the remaining teardown still has to pop is read from that slot; one
 * it does not name is the caller's already, because the callee either never
 * clobbered it or has restored it by now. So nothing here is a guess.
 */
function frameFromTeardown(
  restores: Map<number, number>,
  popped: number,
  raOffset: number | undefined,
  raLive: number | undefined,
  teardown: boolean,
): MeasuredFrame {
  const saved = new Map<number, number>();
  for (const [reg, offset] of restores) {
    if (reg < 14) {
      saved.set(reg, offset - popped);
    }
  }
  if (raOffset !== undefined) {
    saved.set(14, raOffset - popped);
  }
  return { frameSize: popped, saved, raLive, teardown };
}

function transfer(restores: Map<number, number>, to: number, from: number): void {
  const offset = restores.get(from);
  if (offset === undefined) {
    restores.delete(to);
  } else {
    restores.set(to, offset);
  }
}

/**
 * Whether anything in `[entry, end)` calls or writes lr. False means lr holds the
 * return address at every address of the function, however execution got there —
 * the only sound way to trust lr at a pc the replay could not reach.
 *
 * A software interrupt is not a call here: on this hardware it banks its return
 * address in svc mode and leaves the interrupted mode's lr alone, which is what
 * makes a `swi`-only wrapper still report its caller.
 */
function lrEverClobbered(entry: number, end: number, isa: CodeIsa, code: CodeReader): boolean {
  if (end <= entry || end - entry > MAX_LEAF_SCAN_BYTES) {
    return true;
  }
  for (let at = entry; at < end; ) {
    const effect = decode(at, isa, code);
    if (effect.kind === 'refuse' || effect.kind === 'call') {
      return true;
    }
    if (effect.kind === 'move' && effect.to === 14) {
      return true;
    }
    if (effect.kind === 'clobber' && effect.regs.includes(14)) {
      return true;
    }
    at += effect.size;
  }
  return false;
}
