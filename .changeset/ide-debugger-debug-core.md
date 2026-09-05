---
'@gba-kit/debug-core': minor
---

New package: an IDE-agnostic debugging session for GBA programs, the layer a Debug
Adapter Protocol server, a browser page or a test drives the same way.

- **A `Session` owns one machine** and answers in addresses, frames, symbols and typed values. It runs frame by frame under a stop predicate, so every stop lands on an exact (frame, instruction) position and the hardware frame grid never drifts.
- **Breakpoints of every kind**: source lines (statement rows, or the entry of a call inlined at that line; a line without code slides forward), instruction addresses, function names, conditions, hit counts (`3`, `>= 3`, `% 4`) and logpoints with `{expressions}`; data breakpoints on a typed variable path, a symbol's whole extent, a label or a hex address, for writes, reads or both, naming the writer (or the DMA channel and the instruction that started it); event breakpoints on VBlank, HBlank, IRQ request/entry, DMA, I/O writes and halts.
- **Stepping the way gdb steps**: instruction, statement (over, into, out), frame and scanline. Frames are told apart by their CFA, so recursion and leaf functions step correctly; inlined calls are hidden layers a step-over walks past and a step-into reveals, and a stop at the entry of an inlined call shows the call site until stepped into.
- **Call stacks, scopes and values from the DWARF**: physical frames unwound through `.debug_frame` with a link-register fallback, inlined frames in between, locals and parameters with their location at this PC (or where the compiler did keep an optimized-out value), globals, registers and machine state; values unfold structs, unions, bitfields, arrays, enums and pointers, and scalars in memory or registers are writable.
- **A Mesen-style expression grammar** for conditions, logpoints and the watch view: C operators, `[addr]` / `{addr}` / `u32(addr)` reads, registers, `frame` / `scanline` / `cycle`, symbols and `a.b[3].c` paths, `&symbol`, labels.
- **Replay-exact rewind**: keyframes (XOR + run-length deltas, a full snapshot every N) plus a per-frame input log put the machine back at any earlier (frame, instruction) by replaying it; `stepBack`, `reverseContinue` (to the previous breakpoint hit) and `rewindFrames` are built on it, and re-running from a rewound point reproduces the original run byte for byte.
- **Tracing and events**: an instruction trace ring and a hardware event log with frame, scanline and cycle stamps.
- **Labels** for addresses the ELF does not name (a decomp's `gUnk_...`), persisted per project and importable from `.sym` files, usable in expressions and shown in disassembly.
- **Input recording and replay**, save states bound to the ROM's hash, memory search with narrowing, and the emulator views: palette, tiles, tilemaps, sprites, backgrounds and decoded I/O registers.
- **Shares a machine with a player**: a session can wrap an existing `Gba` (`SessionOptions.machine`) and `resync()` after someone else drove it (a play mode, a state loaded outside), so a page plays a ROM and debugs it in turns.
- Tested against small C programs built for Thumb (-O0 and -O2) and ARM, whose ROM/ELF pairs are committed under `test-fixtures/` and rebuilt on CI.
