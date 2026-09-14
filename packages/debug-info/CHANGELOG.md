# @gba-kit/debug-info

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
