# @gba-kit/debug-adapter

A [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
server for GBA programs, on top of `@gba-kit/debug-core`. Any editor with a DAP
client launches it and debugs a ROM at the source level, with the emulator's own
notions of time (frames, scanlines, rewind) reachable through custom requests.

Standard DAP, as an editor expects it:

- **Breakpoints**: source lines (statement rows, or the entry of a call inlined
  on that line; a line without code slides forward and reports where it went),
  functions, instruction addresses, conditions, hit counts (`3`, `>= 3`, `% 4`),
  logpoints with `{expressions}`; data breakpoints on a variable, a struct member
  picked in the Variables view, a symbol, a label or an address, for reads,
  writes or both, whose stop names the writer (or the DMA channel and the
  instruction that started it); hardware events as **exception filters**
  (VBlank, HBlank, interrupt request and entry, DMA, I/O write, halt).
- **Stepping**: statement or instruction granularity for over, into and out;
  `stepBack` is one instruction back, replay-exact; `reverseContinue` lands on
  the previous breakpoint hit. Responses always precede the `stopped` they
  cause.
- **Call stack** with inlined frames, unwound through `.debug_frame` (a
  link-register guess is marked `subtle`).
- **Scopes and variables**: Locals, the file's Globals, Registers, Machine.
  Values unfold structs, unions, bitfields, arrays, enums and pointers, carry a
  memory reference for the Memory view and an evaluate name for Watch; scalars
  and registers are writable. References from before the machine last moved are
  refused as stale.
- **Evaluate** for hover, Watch and the console: C operators, `[addr]`,
  `{addr}`, `u32(addr)`, registers, `frame`/`scanline`/`cycle`, symbols,
  `a.b[3].c` paths, `&symbol`, labels.
- **Disassembly** with symbols, labels and source lines, in the instruction set
  the ELF's mapping symbols state; **memory** read and write; **loaded sources**;
  **restart**.

Emulator operations are `gba-kit/*` custom requests, typed in
`@gba-kit/debug-adapter/protocol`: buttons, `stepFrame` / `stepScanline`,
`rewind` by frames, save states under `<project>/.gba-kit/states/`, input
recordings (and the `press`/`wait` script they amount to), the palette / tiles /
tilemap / sprites / backgrounds views, decoded I/O registers, the instruction
trace and hardware event log, labels (persisted to `.gba-kit/labels.json`,
importable from `.sym` files), memory search, and a frame/audio stream over a
pipe the client owns. Every stop, resume and rewind is also a `gba-kit/state`
event.

## Launch configuration

```jsonc
{
  "type": "gba-kit",
  "request": "launch",
  "rom": "${workspaceFolder}/build/game.gba",
  "elf": "${workspaceFolder}/build/game.elf", // default: the ROM's sibling .elf
  "cwd": "${workspaceFolder}", // relative DWARF paths resolve here
  "sourceMap": { "/build-container/src": "${workspaceFolder}/src" }, // optional
  "stopOnEntry": true,
  "projectDir": "${workspaceFolder}", // where .gba-kit/ lives (default: cwd)
  "allowElfMismatch": false, // debug an ELF that is not this ROM's build anyway
}
```

The launch fails, with the first mismatching section named, when the ELF's
loadable bytes differ from the ROM: breakpoints from a stale ELF land in the
wrong places, so the adapter says so instead of guessing.

## Any editor

```bash
npx @gba-kit/debug-adapter            # DAP over stdin/stdout
npx @gba-kit/debug-adapter --server=4711
```

Neovim with [nvim-dap](https://github.com/mfussenegger/nvim-dap):

```lua
local dap = require('dap')
dap.adapters['gba-kit'] = { type = 'executable', command = 'npx', args = { '@gba-kit/debug-adapter' } }
dap.configurations.c = {
  { type = 'gba-kit', request = 'launch', name = 'Debug ROM', rom = '${workspaceFolder}/build/game.gba', cwd = '${workspaceFolder}' },
}
```

Then `:lua require('dap').continue()`. The screen is not part of DAP; a client
that wants one connects a pipe with `gba-kit/stream` (see the `STREAM` framing in
`protocol.ts`) or polls `gba-kit/frame`.

## In-process

```ts
import { GbaDebugSession } from '@gba-kit/debug-adapter';

const adapter = new GbaDebugSession();
adapter.start(inputStream, outputStream); // or VS Code's DebugAdapterInlineImplementation
adapter.onSession((session) => session.on({ frame: (rgba) => draw(rgba) }));
```

## Develop

```bash
pnpm --filter @gba-kit/debug-adapter build
pnpm --filter @gba-kit/debug-adapter test
```

The tests drive the adapter with real DAP messages over in-memory streams,
against the committed fixtures of `@gba-kit/debug-core`, and check what an editor
would see: capabilities, breakpoint verification, the order of responses and
events, stale references, and the custom requests.
