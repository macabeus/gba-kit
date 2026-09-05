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
  `a.b[3].c` paths, enumerators, `&symbol`, labels.
- **Disassembly** with symbols, labels and source lines, in the instruction set
  the ELF's mapping symbols state; **memory** read and write; **loaded sources**;
  **restart**, which reads the ROM and ELF from disk again (so an edit, a rebuild
  and a restart debug the new program) with the breakpoints carried over.

Emulator operations are `gba-kit/*` custom requests, typed in
`@gba-kit/debug-adapter/protocol` (the same module as
`@gba-kit/debug-core/protocol`, where they are defined): buttons, `stepFrame` / `stepScanline`,
`rewind` by frames, save states under `<project>/.gba-kit/states/`, input
recordings (and the `press`/`wait` script they amount to), the palette / tiles /
tilemap / sprites / backgrounds views, decoded I/O registers, the instruction
trace and hardware event log, labels (persisted to `.gba-kit/labels.json`,
importable from `.sym` files), memory search, and a frame/audio stream over a
pipe the client owns. Every stop, resume and rewind is also a `gba-kit/state`
event, as is every recording start or stop and every tracing toggle.

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

Then `:lua require('dap').continue()`.

### The screen outside VS Code

The screen is not part of DAP. `gba-kit-screen` serves a browser page with the
display and a keyboard gamepad, fed by the adapter over a pipe it owns:

```bash
npx -p @gba-kit/debug-adapter gba-kit-screen   # prints http://localhost:4712/ and the pipe path
# or: pnpm --package=@gba-kit/debug-adapter dlx gba-kit-screen
```

then, in the debug session, send the request it prints:

```lua
:lua require('dap').session():request('gba-kit/stream', { path = '/tmp/gba-kit-screen-….sock' })
```

Frames flow to the page, button presses flow back (the pipe is two-way; see the
`STREAM` framing in `protocol.ts`). A client that prefers polling asks
`gba-kit/frame` for a base64 RGBA image.

### Emacs, Zed, JetBrains

Any DAP client works the same way: launch `npx @gba-kit/debug-adapter` on stdio
with a launch configuration of `type: "gba-kit"`, `request: "launch"` and the
`rom` / `elf` / `cwd` fields above. Emacs `dap-mode` registers it with
`dap-register-debug-provider`; Zed's `debug.json` and JetBrains' generic DAP
support (2025.1+) take the same command line and arguments. Exception filters
show up as the hardware events, custom requests are available wherever the
client exposes `request`, and `gba-kit-screen` (installed globally, or through
`npx -p @gba-kit/debug-adapter gba-kit-screen`) provides the display.

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
