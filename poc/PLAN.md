# gba-kit in the IDE — plan for a VS Code (and beyond) GBA debugger

Status: draft v4, 2026-09-05, after one adversarial review round (§11), a second PoC iteration (§10.1) and a cross-check against an independently built PoC (§12). Companion proof of concept: `poc/vscode-extension`.

## 1. What we are building

A debugger for Game Boy Advance code that lives inside the editor where the code is written or documented. Two people use it:

- **The homebrew developer** (example: `balatro-gba`, devkitARM + libtonc). They compile with `-g`, press F5, and expect what a native C debugger gives them: source breakpoints, step over/into/out, locals and globals, a call stack, plus the things only an emulator can offer: the screen next to the code, frame stepping, rewind, VRAM/OAM viewers, and a scriptable input harness for regression tests.
- **The decomp researcher** (example: `klonoa-empire-of-dreams`, agbcc). Much of the ROM is still assembly with hand-named symbols. They need address-level tools first (disassembly, memory, data watchpoints, "who wrote this byte", execution counts), source level where the DWARF exists, and a way to record what they learn (labels, comments, scripts) in files that live with the project.

The bar is Mesen's debugger, delivered through the editor's own debugging UI instead of a separate window.

## 2. What the study found

### 2.1 gba-kit already has the debugger primitives

| Need                        | gba-kit today                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Stop on an instruction      | `DebugHooks.onInstructionPre` returning `'break'` aborts `Gba.runFrame` mid-frame; `addExecWatchpoint`    |
| Stop on a write             | `GbaSystemBus.addWriteWatchpoint` with CPU/DMA attribution (`WatchpointWrite.dmaOrigin`)                  |
| PC → source, symbols, types | `@gba-kit/debug-info`: `pcToSource`, `pcToFunction`, `symbolToAddress`, `resolveVariable`, `structMember` |
| Save/restore state          | `Gba.serialize/deserialize`: well under 1 ms each, ~610–620 KB per snapshot (balatro-gba, measured twice) |
| Headless speed              | 140–240 fps on this machine depending on the scene (2.4–4x real time); hooks cost ~4%                     |
| Scripting                   | `ScriptingEngine` + `HeadlessRuntime.executeScript` (vm sandbox, documented API)                          |
| Disassembly                 | `disassembleThumb/Arm`                                                                                    |
| Input recording → script    | `apps/webapp/src/scripting/*` (recorder, serializer, replayer)                                            |

### 2.2 Gaps that an IDE debugger exposes

1. **No source line → PC index.** `LineTable` only answers PC → source. Source breakpoints need the reverse (the PoC builds it from `LineTable.rows`).
2. **No locals, no unwinding.** `TypeIndex` reads globals and types but not `DW_TAG_subprogram` children (`DW_AT_location` with `fbreg`/`reg`), lexical blocks, or `.debug_frame` CFI. So no Locals scope and no real call stack.
3. **Breakpoints stall scripts.** `ScriptingEngine.wait()` loops `gba.runFrame()` synchronously. When a breakpoint fires inside, `runFrame` returns early every iteration and the script silently burns its timeout. The engine needs a yield point.
4. **Stepping in `EmulatorBridge` bypasses the system.** `stepInstruction` calls `cpu.step()` directly and ignores IRQ delivery and the halted CPU (a game parked in `VBlankIntrWait` cannot be stepped). The PoC steps through the hook instead, which is correct.
5. **Resume granularity is the frame.** After a mid-frame stop, `runFrame` runs a whole new frame's worth of cycles, so frame counting drifts. Need "run to end of current frame" (scheduler-cycle based) and scanline stepping.
6. **Thumb/ARM mode per address is unknown.** Symbols have the Thumb bit cleared; `$t`/`$a` mapping symbols are dropped. Disassembly away from the PC guesses.
7. **Disassembler cosmetics.** Thumb `bl` is shown as two halves (`bl (prefix)`, `bl (suffix)`); branch targets are not symbolized.
8. **No read watchpoints, no conditions.** `DebugHooks.onMemoryRead` is declared but nothing drives it; watchpoints are write-only and unconditional.
9. **No event log** (IRQ, DMA, MMIO writes with scanline/cycle) for a Mesen-style Event Viewer, and no trace logger.
10. **ESM packages vs the extension host.** VS Code loads extensions as CommonJS; everything gets bundled (esbuild, done in the PoC).
11. **Snapshot restore is not bit-exact.** `Gba.deserialize` re-derives timer overflow events from the counter (`timers.reconstructEvents`) instead of restoring their `fireCycle`, so `serialize → deserialize → run` diverges from the original run (timers, scheduler, and IWRAM bytes differ within 50 frames; found by the review). Boot-twice determinism does hold. Replay-based rewind depends on fixing this.
12. **A breakpoint stop costs a phantom cycle.** `Gba.#runCpuCycles` counts a cycle and ticks the scheduler even when the hook refused the instruction. Every stop shifts timing by one cycle, so a stopped run cannot be replayed against an unstopped one.
13. **Time is counted in instructions, not cycles.** `#runCpuCycles` adds 1 per instruction; `CYCLES_PER_SCANLINE = 1232` is effectively 1232 instructions. Any "cycle" figure the debugger shows (trace stamps, profiler) is an instruction count until gba-kit gains a timing model. The plan labels them as such.
14. **Symbol and line-table hygiene.** `SymbolIndex` keeps `SHN_ABS` FUNC symbols (balatro's `__sync_synchronize` at address 0), and the line table keeps rows for garbage-collected sections below `0x02000000`, so a PC in the BIOS stub resolves to a bogus function and line. The HLE BIOS stub at `0x18–0x94` is real code the IRQ/SWI path executes and must be mapped as such.
15. **`DebugHooks.onMemoryWrite` is as undriven as `onMemoryRead`.** Write watchpoints live in the bus; the CPU-level hooks are dead declarations.

### 2.3 What the reference debuggers offer

- **Mesen 2** ([debugger](https://www.mesen.ca/docs/debugging/debugger.html), [tools](https://www.mesen.ca/docs/debugging.html)): exec/read/write breakpoints with C-like conditions, watch expressions with `[addr]`/`{addr}` memory reads and format suffixes, labels and comments saved per ROM, call stack, step into/over/out + "run to cursor" + "set next statement", trace logger, event viewer (register accesses, IRQ, NMI on a scanline/dot grid), memory tools (hex editor, search, profiler), PPU viewers, Lua script window, assembler.
- **mGBA**: CLI debugger and a GDB stub ([VS Code via GDB](https://felixjones.co.uk/mgba_gdb/vscode.html)); conditional breakpoints/watchpoints, tracing, rewind implemented as periodic save states diffed on a worker thread ([rewind.c](https://github.com/mgba-emu/mgba/blob/master/src/core/rewind.c)).
- **BizHawk**: frame advance, input recording/TAS, rewind, Lua, memory viewers per bus.
- **NO$GBA**: I/O register map, tile/map/OAM viewers, symbol files.
- **Today's VS Code + GBA workflow** is mGBA's GDB stub driven by `cppdbg`/`cortex-debug`. It gives source stepping and nothing emulator-specific: no screen in the editor, no rewind, no scripting, no PPU views, GDB's stepping quirks on Thumb.
- **Debug Adapter Protocol** ([spec](https://microsoft.github.io/debug-adapter-protocol/specification), [extension guide](https://code.visualstudio.com/api/extension-guides/debugger-extension)): breakpoints (source, instruction, data, conditional, hit-count, logpoints), stepping with `granularity: 'instruction'`, `stepBack`/`reverseContinue`, `disassemble` (VS Code's Disassembly view), `readMemory`/`writeMemory` (VS Code's Memory view through the Hex Editor extension), `evaluate` for hover/watch/REPL, `gotoTargets` ("set next statement"), custom requests and events. VS Code, Neovim (nvim-dap), Emacs (dap-mode), Zed and JetBrains (2025+) all speak it.

**Conclusion:** DAP is the seam. Everything a debugger does goes through DAP so every editor gets it; everything only an emulator does goes through DAP _custom_ requests/events and a small per-editor UI layer.

## 3. Architecture

Layers, bottom to top. Each is a package; each depends only on the one below.

```
┌───────────────────────────────────────────────────────────────────────┐
│ L4  IDE clients                                                       │
│     vscode-gba-kit (thin)  ·  nvim recipe  ·  JetBrains  ·  Zed       │
├───────────────────────────────────────────────────────────────────────┤
│ L3  @gba-kit/debug-ui   webview panels (Screen+pad, Memory, I/O regs, │
│     Palette/Tiles/Map/OAM, Trace, Events, Script editor+recorder)     │
│     framework: React, shared with apps/webapp; talks over a Transport │
├───────────────────────────────────────────────────────────────────────┤
│ L2  @gba-kit/debug-adapter   DAP (stdio process or in-process) +      │
│     gba-kit/* custom requests/events + stream side-channel (frames,   │
│     audio) over a local WebSocket announced in an event               │
├───────────────────────────────────────────────────────────────────────┤
│ L1  @gba-kit/debug-core   IDE-agnostic session service: run loop,     │
│     breakpoints, stepping, rewind, trace/event log, labels, scripts,  │
│     recorder, persistence. Typed command/event API, no I/O framework  │
├───────────────────────────────────────────────────────────────────────┤
│ L0  gba-kit as it exists: arm-emulator · gba-emulator · debug-info ·  │
│     gba-node  (+ the upstream changes listed in §4)                   │
└───────────────────────────────────────────────────────────────────────┘
```

### 3.1 L1 — `@gba-kit/debug-core`

The PoC's `DebugCore` grown up. Responsibilities:

- **Execution**: continue/pause; step instruction, line (into/over/out), frame, scanline; run to address; "set next statement". Every stop is decided in `onInstructionPre` (sound); no sampling.
- **Breakpoints**: exec (source line or address), data (read/write/both, length), conditional (expression evaluated on hit), hit count, logpoints. Expression language: a small Mesen-compatible grammar (`r0`, `[0x03001234]`, `{addr}` 16-bit, symbol paths via DWARF) rather than JavaScript, so a condition is cheap to evaluate a million times a second.
- **Rewind**: keyframe ring + per-frame input log (§5). Step back at instruction granularity by replaying from the nearest keyframe with an instruction counter.
- **Trace logger**: ring of `{cycle, pc, instr, regs}` with a filter; export to file.
- **Event log**: IRQ raised/served, DMA start/end, MMIO write, VBlank/HBlank, with `{frame, scanline, cycle}` stamps for the Event Viewer.
- **Symbols & annotations**: DWARF plus user labels/comments (persisted, §7), exported to the decomp's own symbol formats.
- **Scripts**: run a script file, record inputs into one, pause the script at a breakpoint and resume it, cancel it.
- **Process placement**: the core runs in a `worker_threads` Worker (in-process adapter) or its own process (stdio adapter). The extension host never blocks. Frames are handed over as transferred `ArrayBuffer`s; audio as PCM chunks.
- **Lifecycle and identity** (adopted from the parallel PoC, §12): explicit states `idle → loading → stopped ⇄ running | replaying | scripting → faulted | disposed`; one serialized command queue, so a script loop, a UI Continue and a replay can never drive the machine at once; a session id, an _epoch_ that increments on ROM reload, and a _revision_ that increments on every state change. Every inspection result and variable handle is stamped with the revision and refused after it moves. Rewind and resume invalidate handles.

Public API is a `Command` union in, `Event` union out, both JSON-serializable, so the same core drives a worker, a child process, or a test.

### 3.2 L2 — `@gba-kit/debug-adapter`

`GbaDebugSession extends DebugSession` from `@vscode/debugadapter` (the library is editor-neutral). Standard DAP maps as in the PoC. Custom surface, all namespaced `gba-kit/`:

| Request / event                                                     | Purpose                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------- |
| `gba-kit/input`                                                     | button down/up                                            |
| `gba-kit/stepFrame`, `/stepScanline`                                | emulator-time stepping                                    |
| `gba-kit/rewind {frames}`                                           | rewind by frames (DAP `stepBack` = one instruction)       |
| `gba-kit/runScript`, `/cancelScript`, `/recordStart`, `/recordStop` | scripting                                                 |
| `gba-kit/saveState`, `/loadState`, `/listStates`                    | save states                                               |
| `gba-kit/ppu {kind}`                                                | palette / tiles / tilemap / OAM snapshots for the viewers |
| `gba-kit/ioRegisters`                                               | decoded MMIO                                              |
| `gba-kit/trace`, `/events`                                          | trace/event log pages                                     |
| `gba-kit/labels` (get/set)                                          | user labels and comments                                  |
| event `gba-kit/state`                                               | `{state, frame, pc}` on every change                      |
| event `gba-kit/stream`                                              | `{wsUrl}` where frames and audio are served               |

Two hosting modes from one class: `adapter-cli.js` (stdio, for any editor) and `DebugAdapterInlineImplementation` (VS Code, same process, lets the webview subscribe to frames without a socket).

Capability honesty (from §12): advertise `supportsStepBack` only once step-back is replay-exact (Phase 3); until then rewind is a `gba-kit/rewind` command with its own UI, because DAP's Step Back means "one statement back" and a 10-frame keyframe jump is not that. Data breakpoints are advertised with their semantics documented: a _write_ breakpoint stops before the instruction after the write; hit reports name the writer (CPU instruction, or DMA channel plus the instruction that started it).

Stream transport: for the out-of-process adapter the extension spawns the child itself, so frames and audio travel over an extra pipe it owns (`child_process` IPC channel or an inherited fd), never over a network socket. One pending frame at a time, frame ids, stale frames dropped, and stopped-state inspection never waits behind a screen backlog. The earlier "WebSocket announced in an event" wording is withdrawn.

### 3.3 L3 — `@gba-kit/debug-ui`

Panels the editor has no native view for, built once and hosted twice: Screen + gamepad (canvas, keyboard, gamepad API, audio via `AudioWorklet`), I/O registers, Palette, Tiles, Tilemap, OAM, Trace, Events, Script recorder. They depend on a `Transport` interface; the webapp implements it with direct calls, VS Code with `postMessage` ↔ `customRequest`. Honest accounting of reuse: of the webapp's existing debug views only `IoRegisterView` and the screen carry over — `DisassemblyView`, `MemoryViewer`, `RegisterView` and `SourceView` are exactly what VS Code renders natively, and the PPU viewers do not exist yet on either side. React is kept because the webapp is React; a VS Code webview hosts a React bundle without trouble.

VS Code-native views are preferred where they exist: Variables, Watch, Call Stack, Breakpoints, Disassembly, Memory, Debug Console. Custom panels only for what VS Code has no UI for.

### 3.4 L4 — editors

- **VS Code** (`vscode-gba-kit`): debugger contribution, descriptor factory, webview panels hosting L3, commands, a "GBA" view container in the sidebar (labels, save states, scripts).
- **Neovim**: `adapter-cli.js` under nvim-dap; the screen is a browser tab served by the adapter's WebSocket side-channel (same L3 bundle, standalone page).
- **JetBrains / Zed**: DAP client + the same standalone screen page; a native plugin later if demand exists.

## 4. Changes to gba-kit itself

Ordered by how early they are needed.

| #   | Package      | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Needed for                                             |
| --- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | debug-info   | `LineTable.sourceToPcs(file, line)`; ~~keep `is_stmt`~~ (done, uncommitted); per-file index; path normalization                                                                                                                                                                                                                                                                                                                                                                                                                                     | source breakpoints (P1)                                |
| 2   | gba-emulator | `Gba.runUntilFrameEnd()` / `runScanline()` (scheduler-cycle based); resume from mid-frame without drift                                                                                                                                                                                                                                                                                                                                                                                                                                             | frame/scanline step (P1)                               |
| 3   | arm-emulator | Disassembler: merge Thumb `bl` pairs, symbolize branch/`ldr =` targets via a callback                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Disassembly view (P1)                                  |
| 4   | debug-info   | Keep `$t`/`$a` mapping symbols → `modeAt(address)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | correct disassembly (P1)                               |
| 5   | gba-emulator | `ScriptingEngine` async frame loop with a `shouldYield()`/`onStop` hook so a breakpoint pauses the script                                                                                                                                                                                                                                                                                                                                                                                                                                           | scripts + bps (P2)                                     |
| 6   | debug-info   | Locals: `DW_TAG_subprogram` params/vars, `DW_AT_location` (`fbreg`, `reg`, `addr`), lexical blocks, `DW_AT_frame_base`. Base: the parallel PoC's `readDwarfEntries()` export (the library's own DIE walker, with forms and unit version kept); on top: this PoC's `src/core/dwarf/` (DWARF 5 lists, expressions, CFI, types)                                                                                                                                                                                                                        | Locals scope (P2)                                      |
| 7   | debug-info   | `.debug_frame` CFI unwinder (prototyped in the PoC); prologue-scan fallback for agbcc/asm                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Call stack (P2)                                        |
| 8   | arm-emulator | Drive `onMemoryRead`; bus read watchpoints; per-watchpoint `size` and `condition`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | read/data bps (P2)                                     |
| 9   | gba-emulator | Input log + determinism test (run twice, compare state hashes every frame)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | replay rewind (P3)                                     |
| 10  | gba-emulator | Event log hooks (IRQ, DMA, MMIO write, VBlank/HBlank) with `{frame, scanline, cycle}`; trace hook                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Event Viewer, Trace (P3)                               |
| 11  | gba-node     | Export the vm context factory (`createScriptContext(engine, host)`) and script cancellation                                                                                                                                                                                                                                                                                                                                                                                                                                                         | scripts in core (P2)                                   |
| 12  | gba-emulator | Snapshot delta encoder (XOR + RLE against previous keyframe; exclude the PPU framebuffer, re-render instead)                                                                                                                                                                                                                                                                                                                                                                                                                                        | rewind memory (P3)                                     |
| 13  | gba-emulator | Snapshot fidelity: restore every scheduled event's `fireCycle` verbatim and only re-attach callbacks (HBlank, VBlank, DMA, timers); round-trip test `snapshot → run K → compare`                                                                                                                                                                                                                                                                                                                                                                    | replay rewind (P1, blocks §5)                          |
| 14  | gba-emulator | Do not count a cycle for an instruction the hook refused; bound `runFrame` to the frame grid after a mid-frame stop. The parallel PoC already implements the first half as `Gba.runFrame(shouldStop?)` — a predicate checked before each instruction and while halted — with regression tests; adopt it                                                                                                                                                                                                                                             | exact replay (P1)                                      |
| 15  | debug-info   | Drop `SHN_ABS`/`SHN_UNDEF` FUNC symbols and line rows outside loadable sections; expose the BIOS stub as a synthetic symbol                                                                                                                                                                                                                                                                                                                                                                                                                         | sane call stack (P1)                                   |
| 16  | arm-emulator | Cycle-accurate timing model (waitstates, prefetch, instruction cycles) — large; until then every "cycle" is labelled "instruction"                                                                                                                                                                                                                                                                                                                                                                                                                  | profiler, event viewer (P4, optional)                  |
| 17  | arm-emulator | Drive or delete `onMemoryRead`/`onMemoryWrite`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | clean-up (P2)                                          |
| 18  | debug-info   | Location lists (`.debug_loclists`, `DW_FORM_loclistx`), `DW_OP_entry_value`, `DW_OP_piece`, `DW_OP_stack_value`, `DW_AT_frame_base = DW_OP_call_frame_cfa` — balatro's `-O3` build has 1,989 location lists vs 185 plain `fbreg` locals                                                                                                                                                                                                                                                                                                             | Locals that are not "optimized out" (P2, after item 7) |
| 19  | gba-emulator | Side-effect-free inspection API (`peek`/`poke` on the backing arrays; MMIO decoded without touching latches; EEPROM/flash protocol state untouched; mirrors resolved; unmapped reported). Both PoCs read through the live bus or hand-picked arrays; neither is the production answer                                                                                                                                                                                                                                                               | every memory view (P1)                                 |
| 20  | debug-info   | `SymbolIndex` keeps binding, type and section (`STB_LOCAL` vs `GLOBAL`/`WEAK`, `SHN_UNDEF`/`COMMON`) so an `extern` declaration is joined only to a defined global of that name — a file-static with the same spelling must not satisfy it. Evidence from a third project (`kleod`): its linker script writes `gUnk_03005220 = .` inside a section, producing 1,173 `NOTYPE GLOBAL` symbols with a real section index that today's index drops (it admits linker globals only as `SHN_ABS`), so every one of them is invisible to `symbolToAddress` | decomp globals (P1)                                    |
| 21  | gba-emulator | `InputController.deserialize` restores held buttons; snapshot includes everything replay needs (with item 13)                                                                                                                                                                                                                                                                                                                                                                                                                                       | replay rewind (P1)                                     |
| 22  | gba-emulator | `bios.ts` `setIntrWaitCallback` is module-global state; make it per-instance so two sessions (or a test and a session) in one process cannot cross-talk                                                                                                                                                                                                                                                                                                                                                                                             | multi-session, tests (P1)                              |
| 23  | debug-info   | ROM/ELF identity: require `ET_EXEC`, compare the ELF's loadable ROM-window sections with the ROM bytes, report the first mismatching section; never auto-pick a same-basename `.elf` silently (a decomp's `baserom.elf` is an `ET_REL` wrapper with no DWARF)                                                                                                                                                                                                                                                                                       | launch diagnostics (P1)                                |

## 5. Rewind design

Measured: 620 KB per snapshot, 0.45 ms to take. Per-frame snapshots would be 37 MB/s; not viable beyond a few seconds.

- **Keyframes** every 10 frames (6/s), delta-encoded against the previous keyframe (XOR + run-length; RAM changes little between frames, so tens of KB typical; the first keyframe and any VRAM-heavy transitions cost more). Budget 30 s of history at roughly 10 MB, 5 minutes under 100 MB.
- **Input log** per frame (10 bits). The emulator is deterministic from boot (verified by the review: 300 frames with inputs, identical hashes), but not yet across a snapshot restore (gap 11) or across a breakpoint stop (gap 12). Items 13 and 14 are prerequisites; item 9's test must be "snapshot at N, run K, compare" rather than "boot twice".
- **Rewind to frame N**: load the newest keyframe ≤ N, replay the input log forward to N (at 140 fps replaying 10 frames costs ~70 ms).
- **Step back one instruction**: same, with an instruction counter stopping one short of the current count. Exact, no reverse execution needed.
- **Reverse-continue to a breakpoint**: replay forward from successive earlier keyframes with the breakpoint armed and record the last hit before "now". Bounded by history depth.
- **After a rewind** the future is discarded (the ring is truncated), as in mGBA and BizHawk.

The PoC does the simplest version: full keyframes, no replay, `stepBack` = previous keyframe. It proves the plumbing, not the budget. Measured delta size between keyframes 10 frames apart at balatro's title screen: 991 bytes in 824 runs, once the 150 KB PPU framebuffer is excluded; gameplay will be larger.

## 6. Scripts and recording

- **Run**: a `.js` file in the workspace runs through `HeadlessRuntime.executeScript` with the session's emulator; `console.log` goes to the Debug Console; screenshots/save states to `outputDir`. The Debug Console REPL _is_ the scripting API (`await press('a')`, `readOAM()`), as in the PoC.
- **Record**: the screen panel's Record button (or a command) captures input segments. Two outputs from one capture: a machine-readable input log bound to the ROM hash and to the snapshot it started from (replayable to identical state; the parallel PoC's JSON format is a good start), and the human-readable `press`/`wait`/`pressSequence` script the existing serializer emits, which opens as an untitled script to edit. Saving is transactional: export, write, then clear.
- **Breakpoints during scripts** (needs change 5): the engine awaits between frames; when the debugger stops, the script's promise stays pending; Continue resumes it; Stop cancels it with an error the script can catch.
- **Assertions as tests**: `assert()` failures surface as DAP `output` + a stopped event with reason `exception` and `exceptionInfo`, so a failing regression script stops at the frame that failed with the state inspectable. Headless CI keeps running the same scripts through `gba-node`.
- **REPL semantics**: an evaluation that advances no frame is silent (no `continued`/`stopped`, breakpoints untouched); one that does (`await press('a')`) reports a stop so every view refreshes. Objects print as JSON.

## 7. Persistence (per project, in `.gba-kit/`)

- `labels.json`: user labels and comments by address (and by symbol for DWARF-backed ones). Export to the decomp's symbol/`.cfg` files is a command, not automatic.
- `states/`: named save states (JSON via `serializeSnapshot`, thumbnail PNG).
- `scripts/`: recorded and hand-written scripts.
- `saves/<rom-hash>.sav`: battery saves (SRAM/EEPROM/Flash) so a developer testing save code keeps it across sessions; off by default for the decomp case.
- `symbols/`: imported external symbol files (`.sym`, `.map`, a decomp's `symbols.txt`) for ROMs whose DWARF is thin.
- Breakpoints, watches and launch configs are VS Code's own. Data breakpoints are _not_ persisted by id (an id bakes in an address that moves on every rebuild); they are re-resolved by name.

## 8. Feature matrix against Mesen

| Mesen feature                                                  | gba-kit IDE debugger                                                     | Phase |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ | ----- |
| Exec breakpoints                                               | DAP source + instruction breakpoints                                     | 1     |
| Read/write breakpoints + range                                 | DAP data breakpoints (write P1, read P2)                                 | 1–2   |
| Conditional breakpoints                                        | Mesen-style expression grammar                                           | 2     |
| Watch window with expressions                                  | DAP Watch + hover; same grammar + symbol paths                           | 1–2   |
| Labels and comments                                            | `.gba-kit/labels.json`, shown in disassembly                             | 3     |
| Call stack                                                     | LR heuristic (P1) → CFI unwinder (P2)                                    | 1–2   |
| Step into/over/out, run to cursor                              | DAP stepping + `gotoTargets`                                             | 1     |
| Frame / scanline step                                          | custom requests                                                          | 1 / 3 |
| Rewind / step back                                             | keyframes (P1) → replay-based exact (P3)                                 | 1–3   |
| Trace logger                                                   | custom panel + file export                                               | 3     |
| Event viewer                                                   | custom panel                                                             | 3     |
| Memory tools: hex editor                                       | VS Code Memory view (hexeditor) via `readMemory`                         | 1     |
| Memory tools: search / cheats                                  | custom panel on `searchMemory`/`filterMemory`                            | 3     |
| Profiler                                                       | per-function cycle counts from the trace hook                            | 4     |
| PPU viewer (palette/tiles/maps/OAM)                            | custom panels                                                            | 3     |
| Script window (Lua)                                            | JS scripts, REPL, recorder                                               | 1 / 4 |
| Assembler / code editing                                       | out of scope (hex edit via `writeMemory` only)                           | –     |
| Event breakpoints (VBlank, IRQ n, DMA n, SWI, unmapped access) | DAP `exceptionBreakpointFilters`                                         | 2     |
| Restart / reload ROM after rebuild                             | DAP `restart` keeping breakpoints, watches, labels; ELF change detection | 1     |
| Hex/decimal toggle in Variables                                | `supportsValueFormattingOptions`; register writes via `setVariable`      | 1     |

## 9. Phases

**Phase 0 — proof of concept (done, throw-away).** See §10.

**Phase 1 — foundation (6–8 weeks).** New packages `debug-core`, `debug-adapter`, extension `vscode-gba-kit`. Core in a worker thread from day one (the parallel PoC ran the emulator in a child process from its first version; this PoC did not, and its synchronous steps show why). Upstream items 1–4, 13–15, 19–23, merging the three uncommitted seams that already exist across the two checkouts (`runFrame(shouldStop)`, `readDwarfEntries`, `isStmt`). Session states, epoch and revision. ROM/ELF identity diagnostics. Owned, redistributable ARM and Thumb test fixtures (the parallel PoC's `demo/` builds them from C with a linker script; gba-kit's `test-projects` only produce ELFs). Restart/reload on rebuild, `setVariable` for registers, value formatting. Audio design: worker → host → webview `AudioWorklet` with a ring buffer, latency budget 100 ms. VS Code integration tests with `@vscode/test-electron` on top of the headless DAP suite (the review found a DAP ordering race the headless suite cannot see). Source/instruction breakpoints, stepping (instruction, line, over, out, frame), registers, LR call stack, hover/watch for registers, addresses and DWARF paths, Disassembly view, Memory view (hexeditor), write data breakpoints, screen panel with keyboard + gamepad + audio, keyframe rewind, run script / record script, REPL. Sample launch configs for devkitARM and agbcc projects. Headless DAP test suite (the PoC's `test/headless.mjs` grown into vitest cases against balatro-gba and Klonoa).

**Phase 2 — source-level depth (4 weeks).** Items 5–8, 11, 17, 18, in that order: the CFI unwinder comes _before_ locals, because optimized DWARF-5 locals need `DW_OP_call_frame_cfa`. Expect "optimized out" for many `-O3` locals even then; say so in the UI. Event breakpoints. Locals scope with struct/array/pointer expansion through `TypeIndex`, `setVariable`, CFI call stack, conditional + hit-count breakpoints, logpoints, read watchpoints, scripts that pause on breakpoints, assertion failures as exceptions.

**Phase 3 — emulator tooling (4 weeks).** Items 9, 10, 12. Symbol file import. Replay-based exact rewind and reverse-continue, scanline step, trace logger, event viewer, PPU viewers, I/O register panel, memory search, labels/comments with persistence and export. `debug-ui` shared with the webapp.

**Phase 4 — scripting & profiling (2 weeks, +N for item 16).** Script library view, script cancellation, profiler (instruction counts unless item 16 lands), `record()` sprite-sheet playback in the panel, CI documentation.

**Phase 5 — other editors (2 weeks).** `npx @gba-kit/debug-adapter` packaging, a generic stdio DAP harness as the first "second client" (it catches VS Code-only assumptions before a real editor does), a standalone screen page fed by the adapter's pipe, Neovim/nvim-dap recipe, JetBrains DAP config, docs.

Total: roughly 20–24 weeks for one engineer, in line with the parallel plan's 18–30 range; emulator-correctness discoveries can stretch it.

## 10. The proof of concept

`poc/vscode-extension` (about 1,400 lines, untracked, throw-away). Layering mirrors §3: `src/core` (no DAP, no VS Code), `src/dap` (no VS Code; also builds a stdio `adapter-cli.js`), `src/vscode` (extension + screen webview). Everything is bundled with esbuild into CommonJS for the extension host.

**Verified headlessly** (`pnpm test`, a DAP client driving the adapter against balatro-gba + ELF; the same thing nvim-dap would do):

```
ok  : source breakpoint at main.c:122 resolved to 0x08008aca (line 122)
ok  : stopped on entry at 0x08000000
ok  : hit breakpoint after 102 ms: main main.c:122 at 0x08008aca
ok  : registers scope agrees with the frame
ok  : stepped one instruction to 0x08008acc
ok  : step over moved to line 123 (main)
ok  : disassembly: bl (prefix) #0xb000 | bl (suffix) #0x7b6 | ...
ok  : readMemory 0x03007f00 -> 0000...
ok  : evaluate sp -> 0x03007ef0
ok  : repl evaluate readDisplayControl() -> {"mode":1,"bg":[true,true,true,false],...}
ok  : script output: hello from script, pc=30011e4 / script inline finished at frame 33
ok  : stepBack rewound from frame 33 to 30
ok  : recorded script: await press('start', { hold: 2 }); await wait({ frames: 1 });
```

**Installed** in VS Code as `macabeus.gba-kit-vscode-poc`. To try: `code poc/vscode-extension/sample-workspace/balatro.code-workspace` (or `klonoa.code-workspace`), open `source/main.c`, breakpoint on `VBlankIntrWait();`, F5.

### 10.1 Second iteration: source-level stepping and variables

Asked for after a first hands-on test ("step over following the C code; show all variables in the context"). What changed, and what it proved about the plan:

- **Statement-aware stepping.** gba-kit's line rows now carry `is_stmt` (a one-field change in `packages/debug-info/src/debug-line.ts`, tests pass; the first piece of item 1). Step-into stops only at `is_stmt` row starts of a different line. Step-over additionally treats a real call as one statement (frame detected by SP + the return address landing inside the current function) and an _inlined_ call as one statement too: it stops at the inlined body's entry but presents the caller's call-site line, and Step Into reveals the inlined layer without executing — gdb's model. Step Out of an inlined frame is the same walk from the caller's side. Verified on `main`'s loop at `-O3`: `122 → 123 → 124 → 125 → 126 → 120 → 122`, with `update()`/`draw()` inlined.
- **Locals and globals.** The PoC carries its own DWARF reader (`src/core/dwarf/`, ~1,300 lines): DIE tree for DWARF 2–5, `.debug_loclists`/`.debug_loc`, `.debug_rnglists`/`.debug_ranges`, a DWARF expression evaluator (`fbreg`, `breg`, `reg`, `call_frame_cfa`, `stack_value`, `piece`, `entry_value` → "optimized out"), a `.debug_frame` CFA unwinder, and a type describer/formatter (base types, enums, pointers with deref and C-string preview, structs with both bitfield dialects, arrays). Frames: physical frames from CFI plus one virtual frame per inlined layer; Locals per frame from the scope's DIEs and the lexical blocks containing the pc; Globals of the frame's compilation unit; caller frames show unwound registers; scalars in memory are editable (`setVariable`). Verified in `card_new`: `suit=3, rank=12, card=0x0300243c` with `*card` expandable, a 9-deep stack up to `main`.
- **What the exercise taught the plan.** Items 6, 7 and 18 are one piece of work, not three: the `-O3` build needs location lists, CFA-based frame bases and the unwinder together before any local resolves. The PoC's `dwarf/` directory is the working prototype to lift into `@gba-kit/debug-info`, where it replaces the private DIE walker rather than sitting next to it. Two upstream details surfaced: `SymbolIndex` gap inference names main's caller in crt0 `__irq_flags+0x4ff818e` (item 15 covers it; the PoC stops unwinding at such addresses), and DWARF 5 `DW_AT_call_file` indices must be resolved against the CU's own file table, which a merged line table only allows by address range.
- **"Optimized out" is a compiler fact, and the UI must prove it.** First hands-on question: `pos` in `print_desc_red_deck` reads as optimized out at a line that clearly uses it. The DWARF has one entry for it, `r0` over `0x08001a38–0x08001a4c`; GCC then split the struct into r4/r5 halves it never described (scalar replacement of aggregates). gdb prints `<optimized out>` there too. The PoC now says _where_ the compiler recorded the variable (`no location at this pc; the compiler recorded r0 for 0x08001a38–0x08001a4c`). Plan consequences: the homebrew launch config should offer a debug build profile (`-Og -g3`, or `-O2 -fno-tree-sra` when speed matters) and the docs must explain this failure mode; the debugger can also offer the _last known_ location as an explicit, clearly-labelled guess, never as the value.
- **The decomp case is not address-level after all.** A first read of Klonoa's agbcc ELF found 12 subprogram DIEs and 21 located variables and this plan said Locals was "empty by construction". Wrong: agbcc (GCC 2.95) emits abbreviation tables that abut without a 0-code terminator, which gba-kit's own parser already bounds by the next unit's offset and readelf, like the PoC's first reader, does not. With the same bound applied the ELF yields 263 subprograms and 1,963 located variables: `InitLevelGameplay` shows `arg0` and `var_r4`, and `gUnk_03005220` unfolds into its declared struct with named bitfields (`hearts: 3 (2 bits)`, `stars`, `dreamStones`, `keys`, …). The join that makes this work is typical of a decomp: the header declares `extern struct X gUnk_03005220;` (a typed DWARF declaration with no location, storage in assembly), and the symbol table supplies the address. Anything still untyped unfolds as 32-bit words with offsets (pointers annotated with their symbol), halfwords and bytes, and a C-style cast (`(PlayerState*)0x03005220`, `(struct Entity)gUnk_03005220`) applies any struct the ELF knows to any address — the decomp researcher's daily move, and the natural home for the labels/comments store of §7. Lesson for item 6: test the lifted reader against the agbcc fixtures first; gba-kit's `producer-quirks.spec.ts` already pins this.

**Known limits of the PoC** (all covered above): emulator runs inside the extension host; locals for `-O3` code are whatever the compiler kept (register-only values read correctly, `entry_value` ranges show as optimized out); no `.eh_frame`; struct assignment and bitfield writes are read-only; no audio; breakpoints are suspended while a script runs; `stepBack` is one keyframe (10 frames), not one instruction; disassembly mode is guessed; `bl` shows as two halves; no conditions on breakpoints; no persistence; a step that never satisfies its predicate blocks the host for up to 1.5 s.

## 11. Adversarial review (round 1)

A second agent was asked to break the plan and the PoC: verify every claim against the gba-kit sources, probe the emulator and the adapter with throwaway scripts, and rank what it found. 21 findings, 2 blockers. All §2.1/§2.2 claims held up except the numbers (they were conservative). What changed:

**Plan-level findings (folded into §2.2 gaps 11–15, items 13–18, §5, §7, §8, §9):**

- Blocker: snapshot restore is not bit-exact, so the replay-based rewind of §5 was unsound as written. Now a Phase-1 prerequisite (item 13) with a round-trip test.
- A breakpoint stop shifts timing by one cycle (item 14); "cycles" are instruction counts (item 16).
- Locals were under-scoped for an `-O3` DWARF-5 build: location lists, entry values and CFA-based frame bases (item 18), which puts the unwinder ahead of locals in Phase 2.
- Omissions Mesen users would miss: restart/reload on rebuild, event breakpoints, battery saves, symbol import, hex formatting, register writes, an audio design, VS Code integration tests. Phase 1 grew from 3–4 to 5–6 weeks.
- `debug-ui` reuse is smaller than it read: the webapp's debug views are exactly the ones VS Code renders natively; what is actually shared is the screen, the I/O register view and PPU viewers that do not exist yet (§3.3 amended).

**PoC bugs fixed and covered by new headless checks:**

- Blocker: the frame counter, recorder and rewind ring froze while a breakpoint fired every frame (the README's own scenario). Frames are now derived from emulated time.
- Data breakpoints corrupted scripts (each "frame" became a few instructions) and left a stale stop that fired after the breakpoint was removed. All breakpoint kinds are now suspended during scripts; stale stops are cleared on every resume.
- `stepOut` from a leaf function never completed and blocked the host for ~1.5 s; wall-clock budget added and the `sp` test relaxed.
- `stopped` was sent before the step's response (a DAP ordering race that VS Code's simulated `continued` can expose); responses now go first.
- `writeMemory` reported success for bytes the bus dropped (OAM) or duplicated (VRAM); pokes go to the backing arrays now.
- The screen panel bound its callbacks to the first session forever and subscribed to frames once per click; it now follows the live session.
- "Break on Value Change" on a register was advertised but impossible; data breakpoint ids were persisted across rebuilds.
- Every Debug Console evaluation was a full "script run" that suspended breakpoints and flashed the views; objects printed as `[object Object]`.
- Rewinding discarded the keyframe it landed on, so the next step back skipped one.
- Stepping into `swi` landed in "unmapped" memory named `__sync_synchronize`; the BIOS stub is now readable and labelled.
- Two breakpoints at one address collapsed into one; resuming while halted skipped the wrong instruction.

**Left open on purpose (PoC is throw-away):** the 300-frame/1.5 s synchronous step budget, single-location breakpoints for lines with several ranges, VCOUNT showing 228 at frame boundaries.

## 12. Cross-check with the parallel PoC

A second proof of concept was built independently at the same time (`~/ApenasMeu/temp/gba-kit/experiments/vscode-gba-poc`, v0.0.3, with its own plan, two review rounds and a 745-line learnings document). Its emulator runs in an adapter child process with a hand-rolled stdio DAP; it has C source breakpoints, Step Over/Into, lexically scoped locals with lazy expansion, address breakpoints, a 120-checkpoint rewind, JSON input recordings, real Extension Development Host tests, and a Klonoa integration test. It stops short of Step Out, a call stack, inlining, DWARF 5, scripts, audio and data breakpoints. Reading it against this plan:

**Independently confirmed (both PoCs found the same thing).** DAP as the seam with a thin VS Code edge and rich views needing their own client shell; the session as the sole owner of machine mutation; the phantom cycle on a hook-refused instruction (item 14); a frame counter must come from emulated time, not from "runFrame returned"; snapshot fidelity is not guaranteed by a `serialize` method (their finding: `InputController.deserialize` clears held buttons, item 21; ours: timer events re-derived, item 13); old decomp toolchains type globals in headers and place them with the linker, so the debugger must join declaration and symbol table; "optimized out" must be shown, never guessed; a step needs a wall-clock budget, not only an instruction budget.

**Adopted from it.**

- `Gba.runFrame(shouldStop?)` with its stop-timing tests: a cleaner seam than a hook that returns `'break'`, and it can stop a _halted_ CPU (item 14).
- `readDwarfEntries()` exporting the library's own DIE walker with attribute forms and unit version (item 6). This PoC wrote a parallel walker and rediscovered the agbcc abbrev quirk the library already handles; the export removes that whole class of bug.
- A side-effect-free inspection API: reading EEPROM through the bus advances its protocol, and MMIO reads can latch. This PoC's memory view reads the live bus for every region; theirs allow-lists backing arrays. Neither is right; item 19 is.
- Symbol-binding safety for the extern-declaration join (item 20): this PoC's `symbolToAddress` cannot tell a file-static from a global of the same name.
- ROM/ELF identity diagnostics (item 23): their user launched with `baserom.elf`, an `ET_REL` wrapper around the ROM bytes with no DWARF, and got silence. This plan had no such check.
- Per-instance BIOS state (item 22).
- Session states, epoch and revision (§3.1); stale handles refused after any resume or rewind (this PoC only resets handles on the next stack trace).
- Capability honesty: no `supportsStepBack` for keyframe jumps (§3.2).
- Frames over an extension-owned pipe rather than a WebSocket (§3.2).
- Redistributable ARM/Thumb fixtures built from owned C with a linker script, and real Extension Development Host tests from the start (Phase 1).
- A wide value in one 32-bit register must show as unavailable, not as its low half: this PoC's formatter truncated an 8-byte value to 4 bytes in that case, exactly the "plausible but wrong" failure their review calls out. Fixed in the PoC's current build.
- A recording bound to a ROM hash and a starting snapshot, saved transactionally (§6).

**Where this plan stays put, with reasons.**

- Step Over: theirs recognizes `bl` pairs and tracks the return address; this PoC uses function ranges plus SP and LR, and adds inline-call handling, `is_stmt` rows, Step Out and a CFI call stack. Both are heuristics; the production answer in both plans is CFA-based frame identity (gdb's model), so the difference does not change the roadmap.
- Data breakpoints: their plan defers them until "write provenance and stop timing are defined"; gba-kit's bus watchpoints already carry CPU/DMA attribution and this PoC stops before the next instruction, so the semantics are definable now and are written down in §3.2.
- Recordings that can only start at boot and are cancelled by a breakpoint are a limitation of their PoC, not a design goal; this plan's input log starts from any snapshot.
- Scripts: their plan treats the existing JS scripting as future work; here it is Phase 1, through the same session command queue, and the Debug Console is the script API. Their point stands that watches and breakpoint conditions must not run scripts, which is why §3.1 specifies a small expression grammar for those.
- Screen: their 100 ms polling through DAP custom requests is what the transport paragraph in §3.2 replaces; their arithmetic (9.2 MB/s raw at 60 fps) matches ours and argues for the pipe.

**What it changes in the numbers.** Phase 1 grows to 6–8 weeks and the total to roughly 20–24 weeks; their 18–30 range brackets it. Their first phase, "execution correctness before features", is the conclusion this plan reached through the adversarial review (items 13 and 14 first).

**Merge path.** Three small library changes now live in two checkouts, all uncommitted: `runFrame(shouldStop)` and `readDwarfEntries` in `~/ApenasMeu/temp/gba-kit`, `isStmt` on `LineRow` here. Landing them together is the natural first pull request of the real project; both PoCs then remain throw-away.

## 13. Risks and open questions

- **Determinism across restore** is load-bearing for replay rewind and is currently broken (gap 11). Items 13–14 come first in Phase 1; if they slip, rewind stays keyframe-only and instruction-level step back is dropped from Phase 3.
- **Path mapping** across Docker builds, relative DWARF paths and case-insensitive file systems. The PoC's prefix + suffix strategy worked for both sample projects; keep it configurable.
- **VS Code's Disassembly view** assumes it can walk backwards by instruction count from a reference. Mixed ARM/Thumb needs `modeAt` (item 4); until then, walk in Thumb.
- **Streaming frames** through DAP JSON is 4–5 MB/s at 30 fps. In-process the webview subscribes directly; out-of-process use the WebSocket side-channel. Audio goes the same way.
- **Extension host blocking**: a synchronous 300-frame step is ~2 s. Phase 1 moves the core to a worker.
- **agbcc DWARF-2** has no CFI and older line-program quirks; the unwinder needs the prologue-scan fallback from day one for the decomp case.
- **Open**: package names; whether `debug-ui` is React (sharing the webapp) or vanilla; whether JetBrains is worth a native plugin; how labels should round-trip with a decomp's `symbols.txt`/`.cfg`.
