# @gba-kit/debug-core

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
