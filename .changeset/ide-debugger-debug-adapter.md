---
'@gba-kit/debug-adapter': minor
'@gba-kit/debug-core': minor
---

New package `@gba-kit/debug-adapter`: a Debug Adapter Protocol server for GBA programs. Any editor with a DAP client (VS Code, Neovim, Emacs, Zed, JetBrains) launches `npx @gba-kit/debug-adapter` and gets a source-level debugger for a ROM: breakpoints of every kind (line, function, instruction, conditional, hit count, logpoint, data breakpoints on reads and writes with the writer named, hardware events as exception filters), stepping by statement or instruction, a call stack with inlined frames, DWARF-typed variables with memory references and evaluate names, writable scalars and registers, hover/watch evaluation, disassembly with symbols and labels, memory read and write, loaded sources, restart, and replay-exact `stepBack` / `reverseContinue`.

Emulator-only operations are `gba-kit/*` custom requests, typed in `@gba-kit/debug-adapter/protocol`: buttons, frame and scanline steps, rewind by frames, save states, input recordings, the palette / tiles / tilemap / sprite / background views, decoded I/O registers, trace and event logs, labels, memory search, and a frame/audio stream over a pipe the client owns. A `gba-kit/state` event reports every stop, resume and rewind.

Launch diagnostics refuse an ELF whose loadable bytes differ from the ROM (naming the first mismatching section) unless `allowElfMismatch` is set, and say when no source file was found under `cwd`. Responses always precede the `stopped` they cause, and variable references from before the machine last moved are refused as stale.

`@gba-kit/debug-core`: `Program.hasCodeAt` (for `breakpointLocations`), and `SourceMapper.localFiles` keeps the file system's spelling on case-insensitive systems.
