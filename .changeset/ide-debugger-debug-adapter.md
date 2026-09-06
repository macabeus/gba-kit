---
'@gba-kit/debug-adapter': minor
'@gba-kit/debug-core': minor
---

New package `@gba-kit/debug-adapter`: a Debug Adapter Protocol server for GBA programs. Any editor with a DAP client (VS Code, Neovim, Emacs, Zed, JetBrains) launches `npx @gba-kit/debug-adapter` and gets a source-level debugger for a ROM: breakpoints of every kind (line, function, instruction, conditional, hit count, logpoint, data breakpoints on reads and writes naming the code that touched the range, hardware events as exception filters), stepping by statement or instruction, a call stack with inlined frames, DWARF-typed variables with memory references and evaluate names, writable scalars and registers other than `cpsr`, hover/watch evaluation, disassembly with symbols and labels, memory read and write, loaded sources, restart (which reloads the ROM and ELF from disk, breakpoints carried over), and replay-exact `stepBack` / `reverseContinue`.

Emulator-only operations are `gba-kit/*` custom requests, typed in `@gba-kit/debug-adapter/protocol` (a re-export of `@gba-kit/debug-core/protocol`, where the vocabulary lives so browser clients need no Node package): buttons, frame and scanline steps, rewind by frames, save states (save, list, load, rename, delete), input recordings, the palette / tiles / tilemap / sprite / background views, decoded I/O registers, trace and event logs, labels, memory search, and a frame/audio stream over a pipe the client owns. A `gba-kit/state` event reports every stop, resume and rewind, and every recording start or stop and tracing toggle; `gba-kit/lastRecording` hands out the recording last stopped, whoever stopped it.

`gba-kit-screen` (`npx -p @gba-kit/debug-adapter gba-kit-screen`) is a browser page with the display and a keyboard gamepad for editors that have none, fed by the adapter over the same pipe (which is two-way: the page's button presses come back). `newPipePath()` names a fresh pipe for a client to listen on.

Launch diagnostics refuse an ELF whose loadable bytes differ from the ROM (naming the first mismatching section) unless `allowElfMismatch` is set, and say when no source file was found under `cwd`. Responses always precede the `stopped` they cause, and variable references are dropped whenever the machine moves, so a client expands again at the new stop; one held across a restart is refused as stale.

`@gba-kit/debug-core`: `Program.hasCodeAt` (for `breakpointLocations`), and `SourceMapper.localFiles` keeps the file system's spelling on case-insensitive systems.
