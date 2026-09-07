# gba-kit debugger — VS Code proof of concept

Throw-away code. It exists to prove the layering, not to be shipped.

```
src/core/        DebugCore + SourceMapper + recorder  — IDE-agnostic, no DAP, no VS Code
src/core/dwarf/  DIE tree, loclists/rnglists, DWARF expressions, .debug_frame unwinder,
                 types + value formatting, frames/scopes (the seed of plan items 6/7/18)
src/dap/         GbaDebugSession (+ adapter-cli.ts)   — Debug Adapter Protocol, no VS Code
src/vscode/      extension.ts + screen-panel.ts       — the only VS Code-specific code
test/            headless.mjs                         — drives the adapter without an editor
```

One change outside this folder: `packages/debug-info` line rows now carry `isStmt`
(uncommitted, tests pass). Stepping stops only at `is_stmt` rows, like gdb.

## Try it

```bash
pnpm install --ignore-workspace   # once
pnpm build                        # bundles to dist/
pnpm test                         # headless DAP run against balatro-gba
pnpm package                      # -> gba-kit-vscode-poc.vsix
code --install-extension gba-kit-vscode-poc.vsix
code sample-workspace/balatro.code-workspace
```

Then: open `source/main.c`, put a breakpoint on the `VBlankIntrWait();` line, press F5,
and:

- **Continue** → the breakpoint hits once per frame. **Step Over** walks the C
  statements of the current function: a real call runs to completion, an inlined
  call (`update()`, `draw()` at `-O3`) is shown at its call-site line; **Step Into**
  on such a line reveals the inlined body; **Step Out** returns to the caller's next
  statement. `Ctrl+Shift+P → "Step Into Instruction"` (or the Disassembly view)
  steps by instruction.
- **Variables** shows **Locals** (parameters and locals of the selected frame, with
  struct/array/pointer expansion and `<optimized out: …>` when the DWARF says so),
  **Globals (this file)**, **Registers** (unwound for caller frames) and **GBA**.
  Scalars in memory can be edited in place. The **Call Stack** is unwound with
  `.debug_frame` and lists inlined frames as their own rows.
- **Step Back** (⏮ in the toolbar) rewinds one keyframe (10 frames), **Reverse
  Continue** one second.
- Right-click the call stack frame → **Open Disassembly View**.
- Hover `sp`, `r0`, `0x03007f00`, or a global like `game_state` in the editor; type
  `readOAM()[0]`, `await press('a')` or `await wait({ frames: 60 })` in the **Debug
  Console** (it is the scripting API).
- Hover or Watch a symbol: a DWARF-typed global unfolds as its struct; an untyped
  one (a decomp's `gUnk_03005220`) unfolds as 32-bit words at their offsets, with
  halfword and byte views; a cast applies any struct the ELF knows to an address:
  `(PlayerState*)0x03005220`, `(struct Entity)gUnk_03005220`, `(u16)0x04000006`.
- Install `ms-vscode.hexeditor` and click the binary icon next to a register or a
  hovered symbol for a live memory view.
- **Watch a global, then right-click it in the Variables/Watch area → Break on Value
  Change** (or type `0x03001234` there) sets a write watchpoint. Registers cannot be
  watched: they are not memory.
- **GBA: Show Screen** (phone icon) opens the screen; click it and play with the
  keyboard. **● Record** turns your inputs into a script; the play icon on a `.js`
  editor runs it.

Known limits of the PoC (all addressed in the plan): no locals, LR-only call stack,
no audio, breakpoints are suspended while a script runs, the emulator runs inside
the extension host.
