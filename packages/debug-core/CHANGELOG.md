# @gba-kit/debug-core

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

- e4b0be4: Import a `.sav` file as a save state, and export the cartridge's save as one.

  A ⋯ button beside `Save state` in the Screen panel opens a menu with
  `Import from a .sav file` and `Export to a .sav file`. An import is a power-on
  machine of this ROM with the file already in its cartridge, at frame 0: loading it
  and pressing continue boots the ROM and the game finds the save, the way VBA-M's
  `Import battery file` and mGBA's `Load alternate save game` work. The state is
  named after the file, a name already taken gets `(2)`, and the machine being
  debugged is not touched — the snapshot is built on a machine of its own. Over DAP
  and in-process the requests are `gba-kit/importSave` and `gba-kit/exportSave`.

  Which chip a file belongs in follows from the save type the ROM declares and the
  file's size together, and a file those two do not account for is refused by a
  message that names both rather than being padded or truncated into the wrong chip.
  A flash cartridge is refused in both directions: gba-kit backs the cartridge with
  plain memory and emulates no flash chip, so a game's identify sequence goes
  unanswered and it never reads the save — while the command bytes it writes land in
  the save as data. That covers 1 Mbit flash too, which would also need bank
  switching the single 64 KB window has no room for.

  An export is the size the cartridge really has: 32768 bytes for SRAM, and 512 or
  8192 for EEPROM according to the width the game addressed with, not the 8 KB the
  array always occupies. An EEPROM the game has not read or written yet has told
  nobody which of the two it is, so exporting one is refused rather than guessed —
  run the game until it touches its save, or import a `.sav` first.

  Three fixes in the emulator come with it:
  - **EEPROM images are now byte-compatible with mGBA, VBA-M and a flash cart.** The
    array was byte-reversed within each 8-byte word against every real `.sav`: a
    64-bit EEPROM word goes out most significant byte first and the GBA is
    little-endian, so the byte a game sends first is the last of the eight in memory.
    **A save state written before this, of a game that uses EEPROM, comes back with
    its in-game save byte-swapped** — the state format is unchanged and still loads,
    but that game's save inside it will not be read. Re-import the `.sav`.
  - **`SRAM_F_V` cartridges get their SRAM.** Detection looked for the literal
    `SRAM_V`, which `SRAM_F_V102` does not contain, so those games had no working
    save at all. It now reads the SDK string the build embeds — word-aligned, with
    three version digits — and keeps it, so a message can name it.
  - **A 64 Kbit EEPROM is read at the right addresses.** The address width was latched
    at 6 bits by the first six bits of any address and never revised, so a 64 Kbit
    cartridge read the wrong words for the rest of the run. The width now comes from the
    length of the read the game makes, which is what carries it. A write carries no
    length — 64 data bits follow the address with nothing to mark where it ended — so it
    still needs a width up front and takes 4 Kbit until a read has said otherwise, as
    before. An imported `.sav` says nothing about the width either: a 4 Kbit save padded
    out to 8 KB is a file some emulators write, so the cartridge's own first read settles
    it and the file's length only answers for how big an export is until then.

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

### Patch Changes

- Updated dependencies [b61449b]
- Updated dependencies [e4b0be4]
- Updated dependencies [9cc6253]
  - @gba-kit/debug-info@0.8.0
  - @gba-kit/arm-emulator@0.8.0
  - @gba-kit/gba-emulator@0.8.0

## 0.7.0

### Minor Changes

- 2176949: New package `@gba-kit/debug-adapter`: a Debug Adapter Protocol server for GBA programs. Any editor with a DAP client (VS Code, Neovim, Emacs, Zed, JetBrains) launches `npx @gba-kit/debug-adapter` and gets a source-level debugger for a ROM: breakpoints of every kind (line, function, instruction, conditional, hit count, logpoint, data breakpoints on reads and writes naming the code that touched the range, hardware events as exception filters), stepping by statement or instruction, a call stack with inlined frames, DWARF-typed variables with memory references and evaluate names, writable scalars and registers other than `cpsr`, hover/watch evaluation, disassembly with symbols and labels, memory read and write, loaded sources, restart (which reloads the ROM and ELF from disk, breakpoints carried over), and replay-exact `stepBack` / `reverseContinue`.

  Emulator-only operations are `gba-kit/*` custom requests, typed in `@gba-kit/debug-adapter/protocol` (a re-export of `@gba-kit/debug-core/protocol`, where the vocabulary lives so browser clients need no Node package): buttons, frame and scanline steps, rewind by frames, save states (save, list, load, rename, delete), input recordings (kept under the project and listed again in the next session, replayable from where each was recorded, with delete), the palette / tiles / tilemap / sprite / background views, decoded I/O registers, trace and event logs, labels, memory search, and a frame/audio stream over a pipe the client owns. A `gba-kit/state` event reports every stop, resume and rewind, and every recording start or stop and tracing toggle; `gba-kit/lastRecording` hands out the recording last stopped, whoever stopped it.

  `gba-kit-screen` (`npx -p @gba-kit/debug-adapter gba-kit-screen`) is a browser page with the display and a keyboard gamepad for editors that have none, fed by the adapter over the same pipe (which is two-way: the page's button presses come back). `newPipePath()` names a fresh pipe for a client to listen on.

  Launch diagnostics refuse an ELF whose loadable bytes differ from the ROM (naming the first mismatching section) unless `allowElfMismatch` is set, and say when no source file was found under `cwd`. Responses always precede the `stopped` they cause, and variable references are dropped whenever the machine moves, so a client expands again at the new stop; one held across a restart is refused as stale.

  `@gba-kit/debug-core`: `Program.hasCodeAt` (for `breakpointLocations`), and `SourceMapper.localFiles` keeps the file system's spelling on case-insensitive systems.

- 2176949: New package: an IDE-agnostic debugging session for GBA programs, the layer a Debug
  Adapter Protocol server, a browser page or a test drives the same way.
  - **A `Session` owns one machine** and answers in addresses, frames, symbols and typed values. It runs frame by frame under a stop predicate, so every stop lands on an exact (frame, instruction) position and the hardware frame grid never drifts.
  - **Breakpoints of every kind**: source lines (statement rows, or the entry of a call inlined at that line; a line without code slides forward), instruction addresses, function names, conditions, hit counts (`3`, `>= 3`, `% 4`) and logpoints with `{expressions}`; data breakpoints on a typed variable path, a symbol's whole extent, a label or a hex address, for writes, reads or both, naming the code that touched it (or the DMA channel and the instruction that started it); event breakpoints on VBlank, HBlank, IRQ request/entry, DMA, I/O writes and halts.
  - **Stepping the way gdb steps**: instruction, statement (over, into, out), frame and scanline. Frames are told apart by their CFA, so recursion and leaf functions step correctly; inlined calls are hidden layers a step-over walks past and a step-into reveals, and a stop at the entry of an inlined call shows the call site until stepped into.
  - **Call stacks, scopes and values from the DWARF**: physical frames unwound through `.debug_frame` with a link-register fallback, inlined frames in between, locals and parameters with their location at this PC (or where the compiler did keep an optimized-out value), globals, registers and machine state; values unfold structs, unions, bitfields, arrays, enums and pointers, and a scalar that lives in memory is writable, as are the registers of the Registers scope.
  - **A Mesen-style expression grammar** for conditions, logpoints and the watch view: C operators, `[addr]` / `{addr}` / `u32(addr)` reads, registers, `frame` / `scanline` / `cycle`, symbols and `a.b[3].c` paths, `&symbol`, labels.
  - **Replay-exact rewind**: keyframes (XOR + run-length deltas, a full snapshot every N) plus a per-frame input log put the machine back at any earlier (frame, instruction) by replaying it; `stepBack`, `reverseContinue` (to the previous breakpoint hit) and `rewindFrames` are built on it, and re-running from a rewound point reproduces the original run byte for byte.
  - **Tracing and events**: an instruction trace ring and a hardware event log with frame, scanline and cycle stamps.
  - **Labels** for addresses the ELF does not name (a decomp's `gUnk_...`), persisted per project and importable from `.sym` files, usable in expressions and shown in disassembly; a `labels` session event says when they change.
  - **Input recording and replay** (`recording` and `tracing` session events say when one starts or stops, `recordingStart` and `lastRecording` say where it began and what it produced; a finished take carries the screen and the machine it began on, packed, and reads and writes as a file, so a project keeps its recordings and replays one from where it was recorded in a session that never ran those frames), save states bound to the ROM's hash (each keeping the screen it was saved on, so a view can list them by sight), memory search with narrowing, and the emulator views: palette, tiles, tilemaps, sprites, backgrounds and decoded I/O registers.
  - **`@gba-kit/debug-core/protocol`**: the `gba-kit/*` request and event vocabulary a debug adapter answers and every client speaks, with the argument helpers (entry counts, rewind frames, tile counts), the body builders for a saved state and a take, and the audio sample rate both hosts share, so the two implementations of the protocol agree without either restating it.
  - **Shares a machine with a player**: a session can wrap an existing `Gba` (`SessionOptions.machine`) and `resync()` after someone else drove it (a play mode, a state loaded outside), so a page plays a ROM and debugs it in turns.
  - Tested against one small C program built three ways (Thumb -O0, Thumb -O2, ARM -O0), whose ROM/ELF pairs are committed under `test-fixtures/` and rebuilt on CI.

### Patch Changes

- Updated dependencies [2176949]
- Updated dependencies [2176949]
  - @gba-kit/debug-info@0.7.0
  - @gba-kit/gba-emulator@0.7.0
  - @gba-kit/arm-emulator@0.7.0
