# gba-kit GBA Debugger for VS Code

Debug Game Boy Advance programs where you write them. Set breakpoints in C,
step by statement or instruction, read DWARF-typed variables, watch memory for
reads and writes, step _back_, and keep the screen, the PPU views and the I/O
registers beside the code.

Built on [gba-kit](https://github.com/macabeus/gba-kit): the emulator, the
DWARF reader and the debug adapter are the same packages any other editor uses.

## Getting started

1. Build your ROM with debug info: the `.gba` and the ELF it was made from,
   compiled with `-g` (devkitARM, agbcc and modern GCC all work; `-O2`/`-O3`
   builds debug too, with inlined calls shown as such).
2. Add a launch configuration (the extension offers a snippet, `gba-kit: Debug ROM`):

   ```jsonc
   {
     "type": "gba-kit",
     "request": "launch",
     "name": "Debug GBA ROM",
     "rom": "${workspaceFolder}/build/game.gba",
     "elf": "${workspaceFolder}/build/game.elf",
     "cwd": "${workspaceFolder}",
     "stopOnEntry": true,
   }
   ```

3. Press F5. The machine stops at the entry point; set breakpoints and continue.

`sourceMap` rewrites DWARF path prefixes when the sources were compiled
elsewhere (`{"/build-container/src": "${workspaceFolder}/src"}`), `projectDir`
says where `.gba-kit/` (labels, save states) lives, and `allowElfMismatch`
lets a session start when the ELF is not this ROM's build (the launch refuses
by default, naming the first mismatching section, because breakpoints from a
stale ELF land in the wrong places).

## What you get

- **Breakpoints**: lines (a line without code slides forward), functions,
  instruction addresses (Disassembly view), conditions, hit counts, logpoints;
  **data breakpoints** from the Variables view or by name, for reads, writes
  or both, whose stop names the writer or the DMA that did it; **hardware
  events** as breakpoint filters: VBlank, HBlank, interrupts, DMA, I/O writes,
  halts.
- **Stepping**: Step Over / Into / Out by statement, by instruction from the
  Disassembly view, **Step Back** one instruction (replay-exact) and Reverse
  Continue to the previous breakpoint; `GBA: Step One Frame`, `Step One
Scanline`, `Rewind One Second` from the debug toolbar and the palette.
- **Variables** with structs, unions, bitfields, arrays, enums and pointers
  unfolded; `Locals`, the file's `Globals`, `Registers`, `Machine`; every value
  has a memory reference for the Memory view and an evaluate name for Watch;
  scalars and registers are editable.
- **Hover and Watch** expressions: C operators, `[addr]`, `{addr}`,
  `u32(addr)`, registers, `frame`/`scanline`/`cycle`, symbols, `a.b[3].c`
  paths, `&symbol`, labels.
- **GBA: Show Screen**: the display with keyboard (arrows, Z, X, Enter,
  Backspace, A, S) and gamepad input, audio, run/pause, frame step, rewind and
  input recording.
- **GBA: Show Tools**: I/O registers decoded, palette, tiles, tilemaps, sprites,
  the instruction trace, the hardware event log, memory search, labels (with
  `.sym` import and export), save states, recordings.

## How it runs

The debug adapter runs as its own Node process (`node` on the PATH; set
`gba-kit.adapter` to `inline` to run it inside the extension host instead).
Frames and audio travel over a pipe the extension owns, never through the
debug protocol, so inspection stays responsive while the game runs.

## Develop

```bash
pnpm --filter gba-kit-vscode build        # dist/extension.js, adapter.js, webview.js
pnpm --filter gba-kit-vscode test         # unit tests (host bridge, webview shell)
pnpm --filter gba-kit-vscode test:vscode  # Extension Development Host tests (downloads VS Code once)
pnpm --filter gba-kit-vscode package      # .vsix
```

Open `apps/vscode-extension` in VS Code and press F5 to run the extension in a
development host; the `packages/debug-core/test-fixtures` folder is a ready
workspace with a ROM, its ELF and the C it was built from.
