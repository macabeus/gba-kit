---
'@gba-kit/debug-info': minor
'@gba-kit/debug-core': minor
'@gba-kit/debug-adapter': minor
'@gba-kit/arm-emulator': minor
'@gba-kit/gba-emulator': minor
---

The call stack unwinds to the depth the machine's stack actually has, and every
frame says how it was recovered.

Unwinding used to be `.debug_frame` plus one guess. On a GBA that is a minority of
the stack: agbcc emits no call-frame information at all, and a devkitARM build's
table covers its own C and stops at the edge of libgba, newlib and crt0. So the
answer was always exactly two frames — the innermost one, and a caller inferred
from the link register with nothing confirming it.

Now the walk tries an ordered sequence of layers per frame, and a layer declining
ends that layer's turn rather than the walk:

- **the teardown the function has left to run**, at a pc that has begun taking its
  frame apart. This comes first because gcc's `.debug_frame` is _synchronous_: its
  rows track the prologue and stop, so from the first `pop` onward the table gives
  a CFA a whole frame too high and reads a return address out of a slot that has
  already been popped — which drops the frame above and misplaces the locals of the
  frame below. What is left to undo is measured instead, and at the `bx` that ends
  an agbcc function nothing is: the CFA is the stack pointer itself, and the return
  address is in the register the branch goes through, which the pop just behind the
  pc is what names;
- **call-frame information**, everywhere else;
- **an exception boundary** — a handler whose return address is a BIOS address is
  not a caller, so the interrupt stub's pushed block, the saved status register and
  the interrupted mode's banked stack pointer are read to continue onto the stack
  the interrupted code was using — and at the vector itself, where the stub has
  pushed nothing yet, its own link register is that record. An interrupt handler
  used to be one frame with nothing above it;
- **the callee's own prologue**, decoded to measure its frame: each saved word is
  attributed to the register whose value it holds, which is what makes both
  toolchains' real prologues work — one copies a high register into a low one
  before pushing it (`mov r7, sl; push {r5,r6,r7}`), and one parks r11 in lr
  (`mov lr, fp; push {r5,r6,r7,lr}`), so the top slot of a push with the LR bit set
  is not always the return address. A conditional return the prologue opens with —
  libgba's interrupt dispatcher does — is walked through rather than taken as the
  end of what can be measured, and so is a call, because control comes back from
  one: a function that pushes its stack arguments after calling something has those
  bytes in its frame. A _branch_ is where a replay really ends, and past one a frame
  is measured only when nothing between the branch and the pc moves the stack
  pointer at all — otherwise the size is not established and the layer says so.
  Every instruction is read in the instruction set the ELF records at its own
  address, since a function can change instruction set in its middle: an
  interworking veneer does, and reading its far half as the wrong one turns a frame
  into a refusal;
- **the link register**, but only where the decode proves it has not been spilled —
  a function with no call in it, or a stop before the push. An unproven lr is the
  return of a call the function already made, which reads as a caller and is in
  fact a function that has already returned. Where the function parked its return
  address in another register and leaves through it (`mov ip, lr … bx ip`, which m4a
  and hand-written agbcc assembly are full of) that copy is preferred, because it is
  the same value while lr is intact and the only one left once a call has overwritten
  lr. And where the decode cannot prove lr but a call _into this function_ ends
  exactly at it, lr is offered flagged rather than discarded — the same corroboration
  a stack word has to pass;
- **a stack word**, last, and only one that is in an executable section, agrees
  with the instruction set the ELF records there, and has a real call ending exactly
  at it. Whether that call could have reached the frame below is the test that
  carries the layer, and it is asked even when the call went through an interworking
  veneer — most calls do on a Thumb ROM calling into ARM code — by reading the
  trampoline's own destination out of its literal. A word that fails a test is
  skipped rather than fatal, because a false candidate sits between two real frames;
  a word repeating the frame below is skipped too, being that activation counted
  twice rather than a caller of it. A word that passes everything _except_ the chain
  test is still a return address a real call left on this stack, so it is reported as
  the ancestor it is — carrying the sentence that says the frames between it and the
  frame below are missing — and only where a sized symbol covers it, which is more
  than the chain-tested cases are asked for because they have evidence tying them to
  this stack and it does not. The search stops 512 words above the frame and says so,
  rather than reading a quarter of a megabyte of EWRAM on every stop.

Each frame carries the layer that produced it (`StackFrame.method`) and a sentence
about what in it is not established (`StackFrame.doubt`), and a walk carries why it
ended (`Session.stack().end`), which the adapter shows as a final label row. The
depth bound is the top of the stack the mode is on — the modes are stacked on each
other at the top of IWRAM, so searching past a SYS stack's top reads the IRQ stack
above it — falling back to the region a relocated stack pointer is in, the mirror it
is in, since IWRAM and EWRAM repeat. Neither is a constant 32. A frame nothing could
establish ends the walk with a sentence instead of a plausible caller: on
balatro-gba's interrupt dispatcher, which pushes its block across a mode switch and
so has no frame a stack pointer can measure, that is one frame and a reason, where a
link register would have named the interrupted code as the dispatcher's caller.

**A caller's registers are the caller's.** They used to be copied verbatim from the
callee, so r0–r12 showed the callee's values as facts and no caller's stack-resident
local was readable at all. Now r4–r11 come out of the slots the callee saved them
in, r13 is the frame's own address, and r0–r3 and r12 — which belong to the callee
under the ABI — report that they were not recovered instead of showing a plausible
number. Selecting any frame gives that frame's variables, and a variable whose
location needs a register that was not recovered says so rather than reading a
wrong address.

Three claims the BIOS region could make are refused now: an entry the linker
discarded keeps its size with its address zeroed, so both a subprogram DIE and an
FDE claimed a range over the exception stubs — the interrupt dispatcher resolved to
a deleted function complete with source lines, and a stop in the stub was handed a
canonical frame address out of a table entry for nothing — and `Program.isNamedCode`
vouched for addresses below 0x4000. A name, on the other hand, is no longer required
of a return address the unwinder derived: crt0's `bl main` returns into a NOTYPE
symbol of size 0, and dropping that frame loses the bottom of every stack, so a name
is corroboration and its absence is stated on the frame instead.

Step-out runs to a caller whose address and stack pointer are both established, and
leaves an exception handler by its mode changing back only where that is the caller
it found — so stepping out of a function called inside an interrupt handler stops in
the handler rather than outside it. Where nothing above the frame could be
established at all it falls back to lr, under the test that already guarded the
fallback — lr still pointing outside this function, and at program code — rather than
refusing outright: the frames that reach that point are the hand-written ones where
lr is the only record there is, and a division helper was refusing a step-out that
works.

New, all additive: `ElfSection.flags`, `SymbolIndex.isExecutable` and
`SymbolIndex.symbolRangeAt`, which bounds an address the ELF names but never typed a
function — a hand-written entry point carries no `.type`, and without bounds the
frame at the bottom of every stack can be neither measured nor explained;
`frameConfidence`, `FRAME_METHODS` — where each way of recovering a frame declares
what it is worth, so a new one cannot default to being presented as fact — and the
`MachineFacts` port, split into what the program image, the CPU and the target answer
for, in `@gba-kit/debug-info`; `Session.stack()`, the frames and the reason together;
`ArmCpu.getBankedSP` / `getBankedLR` / `getBankedSPSR`, so another mode's state can be
read without serializing the CPU, and `exceptionReturnBias`, what an exception stub
subtracts from its lr to resume what it interrupted; and in `@gba-kit/gba-emulator`
`BOOT_STACK_POINTERS`, the boot sequence as `[mode, sp]` pairs, with `BIOS_IRQ_STUB`
and the one `BIOS_IRQ_STUB_PUSH` word it is counted off — so the stub the emulator
installs and the pushed block an unwinder reads back cannot drift apart — now the one
place the post-boot machine's shape is written down.
