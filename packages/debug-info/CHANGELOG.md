# @gba-kit/debug-info

## 0.9.0

### Minor Changes

- c736b5d: The emulator runs the GBA's timing, CPU, video, sound and BIOS the way the hardware
  does, measured against jsmolka's gba-tests and the mGBA test suite.

  Every jsmolka ROM passes: arm, thumb, memory, bios, nes, unsafe, and the SRAM, 64 KB
  flash and 128 KB flash save tests. In the mGBA suite, Memory, I/O read, Timing, Timer
  IRQ, Shifter, Carry, Multiply long, BIOS math, DMA and SIO register tests all pass in
  full, and its video tests match the hardware captures, with Layer toggle 2 the one
  exception. Before this, Timing passed 4 of 2020 checks and Timer IRQ none. Klonoa:
  Empire of Dreams draws its world maps the same as mGBA running the real BIOS, and runs
  faster than before: about 480 frames per second headless, against about 355.
  - **Time is counted in ARM7TDMI cycles.** Each instruction costs its N, S and I
    cycles plus the wait states of the memory it touches, priced from WAITCNT and with
    the game pak prefetch buffer. An access at the start of a 128 KB block of the
    cartridge is nonsequential. A DMA takes its own cycles and holds the bus, channel by
    priority. An interrupt reaches the CPU 7 cycles after it is raised. Every subsystem
    (timers, DMA, APU, PPU latches) reads the same clock, which is exact in the middle
    of an instruction. A game now runs as much code per frame as on hardware, where it
    used to run one instruction per cycle.
  - **The CPU runs through its two-stage pipeline.** Self-modifying code sees the
    opcodes already fetched, and so does a debugger: a write over the instruction at
    the stopped PC is what runs next. The core applies the ARMv4 rules for misaligned
    and banked loads and stores, for an empty register list, for a base in the list, for
    `^` transfers, for MSR privilege and for condition NV, and sets the carry after a
    multiply from the multiplier's internal state. The algorithm and its zlib notice
    come from zaydlang and calc84maniac.
  - **I/O has one register path for every access width.** Each register reads through
    its own mask, write-only and unused registers read open bus, the BIOS reads back its
    last fetched opcode from outside, and a DMA's last unit is open bus while it runs.
    The LCD owns DISPSTAT and VCOUNT and compares VCOUNT on every line and on every LYC
    write.
  - **The PPU draws each line at the start of HBlank, from the state it latches.** So a
    raster effect lands on its own line. DISPCNT is latched 40 cycles into the line. All
    six modes share one compositor, so the bitmap modes get sprites, windows, blending
    and the affine transform. The compositor also covers the OBJ window, priority
    between sprites, the window flip-flop, mosaic, 5-bit blending, the OBJ cycle budget
    and Green Swap.
  - **Sound plays at the right pitch.** The PSG channels ran four times too fast. Each
    sound register byte now acts on its own, channel 3 has both wave banks and its 75%
    volume, and the mixer follows SOUNDBIAS. The APU also follows the machine clock, so
    Direct Sound keeps time through DMA.
  - **The BIOS functions return what the real BIOS returns.** ArcTan, ArcTan2, Div,
    Sqrt, BgAffineSet, ObjAffineSet (from the BIOS's sine table), BitUnPack, the
    decompressors and the Diff unfilters are bit-exact, and each charges the cycles of
    the BIOS's own loops. Halt, Stop, IntrWait, VBlankIntrWait and SoftReset run as BIOS
    code entered through the SWI exception, so an interrupt is serviced inside them as
    on hardware. SWI 0x19 is SoundBias and 0x1F is MidiKey2Freq. `Gba` sets up the
    post-BIOS boot state, which every host shares.
  - **A flash cartridge has its flash chip.** It has the command protocol, the chip ID,
    sector and chip erase, and the bank switch of a 128 KB chip. SRAM is 32 KB that
    reads 0xFF erased, and an 8-bit save bus sees every address bit. Flash `.sav` files
    now import and export like SRAM and EEPROM ones. Region 0x0D is EEPROM only on a
    cartridge that has one.
  - **The serial port answers.** A Normal-mode transfer on the internal clock completes
    with its interrupt, reading the idle line's ones, and the SIO registers read as the
    hardware does with nothing connected.

  **The Play page runs at the GBA's 59.73 frames per second on every display.** Its loop ran
  one frame per `requestAnimationFrame`, which is the display's refresh rate, so a game ran
  twice as fast on a 120 Hz screen. `FrameClock` (gba-browser) turns the time between two
  callbacks into the GBA frames it holds, and the script replayer paces by it too.

  The debugger follows the new machine. A read watchpoint fires on data loads and
  executed fetches, and stays quiet on opcodes the CPU prefetched. The call stack
  unwinds through a BIOS service call (`FrameMethod` `'service'`). The browser bridge
  steps through the same run loop as `debug-core`. The inspector reports `cycle` in CPU
  cycles.

  **Older save states still load.** Each new piece of state has a documented default
  when a snapshot predates it, so a state restores and keeps running. Its timing from
  then on is the new model's, so a replay of an old state can drift from what the old
  emulator would have done.

  API changes for code that drives the emulator directly:
  - `MemoryBus` (arm-emulator) has opcode fetches of their own (`fetch16`, `fetch32`) and
    prices accesses (`accessCycles`, `fetchCycles`, `dataCycles`, `idle`).
    `ArmCpu.step()` returns the cycles it took, and `ArmCpu.refused` says when a debugger
    stop refused the instruction.
  - `Gba` sets the boot state itself, so hosts no longer set the stack pointers, CPSR
    and PC after `loadRom`.
  - `BiosEnv` is gone, and `BIOS_SWI_HANDLER` describes the SWI handler for unwinders.
    The APU follows the scheduler's clock, so hosts stop ticking it and only read
    samples. `SerialPort`, `DISPCNT_LATCH_CYCLE` and `HBLANK_START_CYCLE` are exported.

- 8976097: Find the variable behind a feature by capturing RAM and comparing the captures

  The `Memory search` tab becomes `Memory diff`, at the same panel id. Take a capture with
  the menu on item A, move to item B, capture, move back, capture — then draw what the
  value did between them. The captures are a graph: nodes to place, and arrows carrying
  `changed`, `same`, `went up` or `went down`. A new capture arrives joined to the one
  before it, which is the run as it was played.

  An arrow is not obliged to join neighbours, and that is what does the work: between
  neighbours, "changed, then changed again" is what every churning byte does, so the `same`
  arrow back to the first capture is what separates the variable from the churn. Where a
  node sits says one thing only — the order the captures are read in, left to right, which
  is the order of the value columns under the graph.

  A query is a standing description of the run, not a step in a narrowing: it is answered
  against the whole address space every time, so loosening an arrow brings addresses back
  and the answer follows the graph as it is drawn. That is why there is no `Apply`, no
  `Preview` and no `Undo` — a pass over both regions costs tens of milliseconds, which is
  what makes recomputing affordable. A value can also be held against the capture that saw
  it, which is the exact-value search, now sayable for one capture of several. Links that
  cannot all hold — `①` up to `②`, `②` up to `③`, and `③` the same state as `①` — are
  refused by name rather than answered with no rows.

  A capture does not ask the machine to stop first: a run advances one frame per tick of
  the host's clock and a request is answered between them, so a running machine is read
  where it already is and the capture is of a whole frame either way. Looking for
  background noise still needs a stop, since it runs frames of its own and puts the machine
  back.

  A candidate is placed in one of four tiers, and the fourth is the one a decomp needs
  most: memory **a pointer reaches**. `gMenu->cursor` has no symbol of its own — the
  address exists only while `gMenu` holds that value — so no static lookup can ever name
  it. The pointers a program declares are read out of the captures instead, including
  the ones that live inside structs and arrays, and an address one of them covers is walked
  through the pointee's type like any object. A pointer is followed only where every
  capture agrees on its value: one that moved between them names different memory in each
  column, which is a name that is wrong somewhere. Only an object that declares an extent
  covering the address outranks a pointer aimed at it — the nearest symbol below is a
  landmark, which declares nothing about the address and so does not displace a name.

  **Break on write** on a result sets a watch, and the panel lists what is watched. The
  editor's Breakpoints view lists source and function breakpoints only — VS Code's extension
  API has no data breakpoint to add to it — so a watch set from a panel is shown by whoever
  set it or not at all. `gba-kit/watchpoints` answers what is watched and `gba-kit/unwatch`
  stops one, which also makes it visible when a DAP client replaces the list with its own.

  Captures live in the session and nowhere else: they are never written under `.gba-kit/`,
  and the 288 KB of RAM each holds never crosses to a client, which gets the counts, the
  groups and a page of rows. A save state can be adopted as a capture, since a state
  already carries both RAM regions. A session holds twenty of them — as many as there
  are circled numbers, ① to ⑳, to name them — and says so rather than taking a twenty-first.

  Results are grouped by what holds them, in four tiers the panel keeps visually
  distinct: an object the program states an extent for (with its typed member path,
  `gEnemies[3].x`), a pointer that reaches it (`gMenu->cursor`, shown with the address the
  columns were read from, since that name holds only while the pointer holds that value), a
  symbol in the same memory that is only the nearest one below, and an address nothing
  names. `placementAt` in `@gba-kit/debug-info` is the new
  inverse of the expression walk that works those out. The groups are read in the order
  ranking put their rows in, so the one holding the best candidate leads — a larger group
  of rows tied with it is a wider guess, not a better one.

  Background noise is muted by address range and never by name: run three hundred idle
  frames and whatever moves on its own is churn, watch the DMA in the same run and every
  RAM range copied into VRAM, OAM or palette names itself a shadow buffer, and watch the
  stack pointer to see how far below itself the abandoned call frames reach. How long that
  run is worth making is measured in what survives rather than in churn found: state that
  moves only now and then — a sound driver's per-note state, which changes at note
  boundaries — is found only if it moved while the baseline ran, and what it missed
  survives into the results. Three hundred frames is the default, and the panel also offers
  sixty and nine hundred.

  Every mute is a listed, reversible row carrying the bytes it hid, and it hides
  candidates where the result is reported rather than where it is found — so switching one
  on or off changes the result in front of you with no filter to run again.

  A row's own path is what it is _called_, not what it may be _named_: `Add as a label`
  takes the typed path only where the program states an extent covering the address _and
  the object it names begins there_, and turns it into an identifier
  (`gEnemies_3.x`), because a `.sym` line's name is a C identifier and a bracketed
  path would leave the project on export and never come back. Every byte of one `s32`
  carries the same path, so a row at a byte inside an object leads with its address and
  carries the path as a landmark (`0x03002921 in gEnemies[0].x + 0x1`), is
  labelled by its address, and is not formatted through a type that covers four bytes it
  does not — a value read at the object would say a row the filter kept as `same` had
  changed.

  Each row also offers `Watch` and `Break on write`. A watch is the typed path where the
  program names the address and a read of the row's own width (`u8(0x02001234)`) where it
  does not; it is an optional capability of the transport, the way `openText` is, so the
  VS Code host offers it and a host with no watch pane shows no such action.

  `gba-kit/searchMemory` and `gba-kit/filterMemory` are unchanged and still answered; the
  new engine reads values out of the captures rather than out of live memory. The new
  requests are `gba-kit/captures`, `capture`, `retagCapture`, `forgetCapture`,
  `discoverNoise`, `mutes`, `setMute`, `reorderCaptures`, `diffFilter` and `breakOnWrite`.
  `gba-kit/breakOnWrite` refuses an address in ROM, the BIOS or nothing at all, since a
  watch there verifies and then never fires, which reads as proof that nobody writes it.

## 0.8.0

### Minor Changes

- b61449b: The call stack unwinds to the depth the machine's stack actually has, and every
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

- 9cc6253: Expressions read a typed path the way the program writes it: `gEntityInfo[arg0].xPosBg2`,
  `p->pos.x`, `*p`, `(Entity *)x`.

  Typing `gEntityInfo[arg0].xPosBg2` — a line copied straight out of the source
  being decompiled — used to answer `only constant subscripts and .member paths are
supported`, with a hint to work the address out by hand and read it with
  `u32()`. A variable index, an arrow and a dereference are now the grammar's own,
  everywhere an expression is accepted: watches, hovers, the console, breakpoint
  conditions, logpoint messages, data breakpoints, and writes.

  A name is a name again — the tokenizer no longer swallows a whole dotted path
  into one token — and `.`, `->` and `[` are operators over a value that carries
  its DWARF type. One rule makes them all fall out: a subscript, an arrow and a
  dereference take the operand's **word** as the base address, while `&` and `.`
  take its **place**, and an array's word is its own address, as C's decay makes
  it. So `a[i]`, `*a` and `a + 1` treat an array and a pointer alike, and a chain
  like `a[i].b->c[j]` costs one address computation per step.

  **Pointer arithmetic is scaled**, as in C and as in GDB. With a `struct Entity *e`
  of 0x50 bytes, `e + 1` is 0x50 bytes on and `*(e + 1)` is exactly `e[1]`;
  subtracting two pointers of one type counts elements; an array decays, so
  `gEntityInfo + 1` is `&gEntityInfo[1]`. Scaling applies only to `+` and `-`, and
  only where a DWARF type says pointer or array. A register, a literal, a `u32()`
  or `[addr]` read and the machine values have no type at all, so `r3 + 1` and
  `u32(a) + 1` mean what they always meant — and neither does `p & 3` or `p * 2`
  change, which are not pointer arithmetic in C either. `[addr]` and `{addr}` keep
  their byte and halfword meaning; `*` is not a synonym for them, and on a value
  with no type it says so and names `u8()`, `u16()` and `u32()` instead of
  guessing a width.

  **A cast means what it means in C.** `(T *)x` is a pointer value — a hex address
  with the pointee as its one expandable child — and `*(T *)x`, `((T *)x)->m` and
  `((T *)x)[i]` are what read through it. `(T)x` is unchanged: the T at x's
  address. This is a behaviour change for `(T *)x`, which used to ignore the star
  and show the T at x. `*(vu16 *)0x4000006` works, and so does `&x`, which is now a
  pointer rather than a bare number — the same number, shown as an address, with
  what it points at underneath. `&` on a bitfield is refused, as in C: a field of
  four bits has no address of its own.

  **A pointer is a place, so a pointer result offers a memory view.** `&x`,
  `p + 1` and `(T *)x` all hand back a memory reference now, where before only an
  expression that started with `&` did. A value that _names_ storage offers that
  storage instead, and offers nothing while the compiler keeps it in a register, so
  one memory reference cannot mean where `p` lives in one build and where it points
  in the next.

  **Everything the new paths name is writable**, wherever a constant path was:
  `gEntityInfo[i].xPosBg2 = 10`, `p->hp = 0`, and a bitfield through a pointer.

  A literal index outside a sized array is still refused when the expression is
  compiled. Nothing else is: a runtime index is not bounds-checked — GDB does not
  check one either, and a pointer has no count — and neither is an index the reader
  folds in their head, `a[2 + 3]` being arithmetic here like any other. An
  unreadable address still says so at the moment of the read. Subtracting two
  pointers requires the same pointee type, not merely the same pointee size, and
  answers an `int` count.

  Where the debug info gives a pointee no width — a `void`, a struct a header only
  declares — `+` steps by the byte and `-` counts bytes, which is GDB's answer
  under C's own extension. What C refuses, this refuses: there is no value at the
  end of a `void *`, so `*p` on one names `u8()`, `u16()` and `u32()` instead of
  inventing a width, and a pointer to a function is not stepped, since code is not
  an array of values and one byte on is the middle of an instruction.

  A name the debug info does not type is a word and nothing more: `.`, `->` and `[`
  below one are refused, and refused by the name that is actually wrong — `zzz->a`
  says `unknown symbol 'zzz'` exactly where `zzz` does, and only a name that
  resolves is told which cast would reach through it. The refusal says the name has
  no type _here_, because a type is looked up where the expression compiles and a
  local of another function is untyped at this pc however fully the ELF describes
  it elsewhere. A data breakpoint's condition is compiled in the frame the user
  typed it in — a watched address can be written from anywhere, so there is no
  other frame it could belong to — and so reads that frame's locals, as GDB scopes
  a watchpoint to the frame it was set in.

  Types are resolved once, when the expression compiles, and never reach an
  evaluated closure, which carries an offset, a read width and a signedness flag
  and nothing else: a breakpoint condition is address arithmetic and memory reads.
  Where the root _lives_ is asked per evaluation instead, through the new
  `ExprEnv.place`, because a local moves between a stack slot and a register as the
  pc advances — at `-O2` a pointer parameter often never sees memory at all, and
  reading one through its register is how `p->pos.x` answers there. It is asked
  once per root per evaluation: a place is one question with one answer, so
  `p->pos.x` costs the same name lookup as `g_player.pos.x`.

  New exports: `compile` in `@gba-kit/debug-core`, which answers a value, its type
  and the place it names together, with `Compiled`, `ExprPlace`, `ExprLvalue` and
  the `rootType` / `typeByName` hints; `bitfieldPlacement`, `isSignedType`,
  `formatBitfield`, `le32` and `scalarSize` in `@gba-kit/debug-info`, so where a
  bitfield sits, whether a value is signed and how wide a scalar is are each
  decided in one place, and a member reads identically in a watch and in the
  variables tree.

  `ExprHints.symbolSigned` is gone. It could only ever answer where `rootType` had
  already answered — both are driven by the same root lookup, so a name with a
  signedness has a type — and a symbol table, which is all an untyped root has,
  states no signedness at all. An `ExprHints` written against 0.7.0 keeps working;
  one that spells `symbolSigned` out in an object literal no longer type-checks.

  `ExprEnv.symbol` is now asked for a bare name only. An env written against 0.7.0
  still satisfies the interface, and a root the debug info does not type still
  resolves through it, but a dotted path no longer reaches it — the grammar owns
  everything below a name, and measuring a member needs a type a symbol map does
  not have.

  In `@gba-kit/debug-adapter`, every row under a computed value carries an
  `evaluateName` that reads back as the row it came from — a pointee is
  `(*(g_player.counterRef))` and a member below a watch on `p->pos` is `(p->pos).x`
  — so any of them can be dragged into Watch or copied as an expression.

## 0.7.0

### Minor Changes

- 2176949: The queries an IDE debugger needs on top of the parser:
  - `LineTable.sourceToPcs(file, line)`, `nearestLineWithCode`, `rowAt(address)` (statement-aware, for stepping) and `files`; paths are matched normalized. A line's locations are the starts of its statement runs: one per piece of code the compiler emitted for it (a loop condition, a hoisted load), not one per row, and rows without `is_stmt` are not places to stop.
  - `DwarfScopes.inlineCallSitesAt(file, line)` and `entryPc(inlined)`: where a call inlined at a source line is entered (`DW_AT_entry_pc`, else the lowest range). Such a line has no rows of its own, so it is where a breakpoint on it goes.
  - `SymbolIndex` keeps each symbol's binding and section; `globalSymbol(name)` / `DebugInfo.globalSymbolAddress` answer only with a defined global (a file-static of the same spelling never satisfies a C `extern`, and two globals at different addresses are refused as ambiguous). Linker globals placed inside a section (`gFoo = .;`, as a decomp's ldscript does) resolve, not only `SHN_ABS` ones; undefined/common symbols and absolute FUNC placeholders are dropped.
  - `modeAt(address)` reports the instruction set from GNU `$a` / `$t` / `$d` mapping symbols.
  - `checkRomIdentity(rom)` compares the ELF's cartridge-window sections with a ROM and names the first mismatch; `isLinked` distinguishes an image from an object file (`ElfFile.type`).
  - Line rows for code the linker discarded (addresses below every loadable section) are dropped, so a PC in the BIOS stub does not resolve into them.
  - `readDwarfEntries(elf)` exports the DIE trees with attribute forms and unit versions, for scope- and location-level readers.
  - `DebugInfo.scopes` (`DwarfScopes`): the function and inlined calls containing a PC, the variables visible there and where they live at that PC (location lists for DWARF 2–5, a DWARF expression evaluator, frame bases via `.debug_frame` CFA), typed value trees for any DWARF type (structs, both bitfield dialects, arrays, enums, pointers), call-frame unwinding, and "optimized out" answers that say where the compiler did keep the value.

## 0.6.0

### Minor Changes

- 7b60394: Refuse ill-posed reads instead of answering them

  The bus answers every address, as the console does: it rounds an unaligned load down
  and reads undecoded space as open bus. Correct for the CPU, and indistinguishable from
  the value you asked for. The bus is unchanged; the analysis surface now refuses.
  - `read16` / `read32` throw on a misaligned address, naming the one the hardware would
    have read, and on space the bus decodes to nothing. `read32` is now unsigned.
  - `readBytes(address, size)` — new: 1–4 bytes at any alignment, byte-assembled.
  - `readMember` / `writeMember` — new: read or write a DWARF `MemberLocation` at a base
    address, for an instance no symbol names.
  - `writeVariable(path, value)` — new: the write counterpart to `readVariable`.
  - `addressToSymbol` reports `exact` — whether `st_size` covered the address, or whether
    containment was inferred from the next symbol's start.

  **Breaking:** `read16` / `read32` throw for misaligned or undecoded addresses, which
  they previously answered. `readBytes` is the replacement.

- d894353: Guard the write side, and bound a subscript by the extent the DWARF states
  - `write8` / `write16` / `write32` / `writeBytes(address, size, value)` — new. The
    scripting surface had no write API, so scripts used the raw bus, which rounds a
    misaligned store down and discards a store to ROM. These carry the read guards.
  - Variable paths take subscripts, bounds-checked against the DWARF extent:
    `readVariable('gLayers[2].width')`, `writeVariable('gGrid[1][3]', 0)`. An index past
    the end throws instead of resolving into whatever the linker placed next. A dimension
    the DWARF leaves unstated is not checked.
  - `symbolExtent(name)` — new: an object's byte size and whether it came from `st_size`
    or the DWARF type. A write starting inside a known extent and running past its end is
    refused, naming what it would have hit.
  - `addressToSymbol` resolves linker-placed globals (`SHN_ABS`/`NOTYPE`), which it
    previously skipped entirely.

## 0.5.0

### Minor Changes

- Report an array's RANK, not just its flattened element count.

  `variableShape()`'s array arm and `struct()`'s array members now carry `dims` — the
  per-dimension extents, outermost first (`u16 g[4][0x400]` → `[4, 1024]`). `length` is
  unchanged: it stays the product, which is what sizes the object.

  The two readings answer different questions, and only `dims` answers the one a consumer
  spelling C needs: `g[i]` on a rank-2 array is a **row**, not an element. A consumer that
  knows only the flat count writes a single subscript, which against the project's own header
  is either a type error or — where the row address flows into an integer context — silently
  the wrong address.

  `null` marks an unbounded dimension. On a `DW_AT_declaration` a leading extent of 1 is
  GCC 2.95's spelling of an unsized outer bound (`extern T x[]`, `extern T x[][4]`) and is
  reported as `null`, mirroring the rule `length` already applies; the inner extents are
  written down and survive. A rank-1 array reports a one-entry `dims`, so an absent key
  always means "not an array", never "rank unknown".

## 0.4.0

### Minor Changes

- 6479b6b: Read what a name is DECLARED as — shapes, signatures and macro names — from either byte order.
  - `variableShape(name)` classifies a global/static as `scalar | pointer | array | struct`,
    resolved through typedef/cv chains: `volatile`/`const`, array `elemSize`/`elemSigned`/`length`,
    and the pointer's `pointee` (the name `struct()` resolves, its size, its own qualifiers).
    A `typedef struct {…} T;` is named by its alias; `null` doubles as the "is this name
    declared in the project headers?" probe.
  - `struct()` members carry the declaration facts layout alone cannot: `signed`, `pointer`,
    `pointeeSize`/`pointeeSigned`, `volatile`/`const`, and array `elemSize`/`elemSigned`/`length`.
    Every key is absent when the DWARF does not determine it.
  - `functionSignature(name)` returns a COMPILED function's return and parameter types
    (`low_pc` is the witness): `null` means "this ELF did not compile it", never "it takes
    no arguments". gcc's abstract/concrete split at `-O1+` resolves to one definition.
  - `DebugInfo.macros` / `parseDebugMacinfo` read the `-g3` macro table (DWARF 2/3
    `.debug_macinfo`, the self-contained form) — the only place an address-cast `#define`
    name survives, since a macro leaves no symbol and no DIE. A truncated stream yields a
    sound prefix, never a corrupted entry.
  - Big-endian ELF/DWARF end to end — bitfields are allocated from the MSB end and reported
    that way — and RELA relocations are applied to `.debug_*` in relocatable objects.
  - `.debug_line` is walked by its own `DW_LNE_end_sequence` terminators: agbcc (GCC 2.95)
    mispredicts `unit_length`, which used to cost every row after the first short unit.
  - Producer-dialect fixes, pinned on committed toolchain output: DWARF 2/3's `DW_FORM_flag`
    decodes as a boolean (every declaration/prototyped test was inert, so a forward-declared
    struct could shadow its own definition by link order); GCC 2.95's `0xffffffff` upper
    bound reads as zero-length, not 2^32 elements; and a DECLARATION's `[1]` array is agbcc's
    unsized-extern spelling, reported as `length: null`.

## 0.3.0

### Minor Changes

- bf00bbd: Parse struct/union layouts, bitfields, and enum constants from DWARF `.debug_info`.

  `DebugInfo` gains:
  - `struct(name)` — members with byte offsets and sizes.
  - `structMember(name, path)` — resolve a dotted/array nested field path to its offset + size, descending through anonymous unions/structs.
  - `enumValues(name)` — `{ enumeratorName: value }`, including explicit/continued values.
  - `variableMember(varName, path)` — like `structMember`, but rooted at a global/static variable; its type is read from the variable's own DWARF DIE, so no type name is needed.
  - `resolveVariable("symbol.field.subfield")` — resolve a path to an absolute `ResolvedLocation` in one call: address from `.symtab`, layout from the variable's DWARF type.
  - `hasTypeInfo`, plus the new exported `TypeIndex`.

  Bitfield members also report `bitOffset`/`bitWidth`, normalized across the DWARF 2/3 and 4+ encodings. Members whose byte size can't be determined (incomplete type, flexible array) report `size: null`.

  Handles DWARF 2–5 from agbcc and modern GCC, including typedef/qualifier chains and multi-CU abbrev tables.

  `symbolToAddress` now also resolves linker-defined absolute (`SHN_ABS`) globals — the `gFoo = 0x...;` ldscript symbols that place data at fixed RAM addresses — while keeping section-relative markers like `_end`/`__bss_start` excluded.

## 0.2.0

### Minor Changes

- Add `@gba-kit/debug-info`: parse ELF symbols + DWARF line tables to map a PC to its
  function and C source (`pcToFunction`, `pcToSource`, `symbolToAddress`,
  `addressToSymbol`). Wire source-level debugging into the scripting engine
  (`loadDebugInfo`, `watchSymbol` — which now defaults its watch length to the
  symbol's size) and the Node runtime (`elfPath` option), and add a Source panel to
  the webapp that follows execution in C alongside the disassembly.
