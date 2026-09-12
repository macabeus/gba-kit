# @gba-kit/debug-core

An IDE-agnostic debugging session for GBA programs. A `Session` owns one emulated
machine (from `@gba-kit/gba-emulator`) and its program's debug info (from
`@gba-kit/debug-info`), and answers in the terms a debugger UI speaks: source
lines, call frames, typed variables, frames and scanlines. A Debug Adapter
Protocol server, a browser page and a test drive it the same way; nothing here
knows about VS Code or the DOM.

What a session does:

- **Runs under a stop predicate.** The machine advances one hardware frame at a
  time, checking the predicate before every instruction, so a stop lands on an
  exact `(frame, instruction)` position and frames stay on the hardware grid no
  matter how often the debugger interrupts them.
- **Breakpoints of every kind.** Source lines (the statement rows of the line,
  or the entry of a call inlined there; a line without code slides forward),
  instruction addresses, function names, conditions, hit counts (`3`, `>= 3`,
  `% 4`) and logpoints with `{expressions}`. Data breakpoints on a variable path,
  a symbol, a label or an address, for writes, reads or both, which name the
  code that touched it (or the DMA channel and the instruction that started it).
  Event breakpoints on VBlank, HBlank, interrupt request/entry, DMA, I/O writes
  and halts.
- **Steps like gdb.** By instruction, statement (over, into, out), frame and
  scanline. Frames are told apart by their canonical frame address, so recursion
  and leaf functions step correctly. Inlined calls are hidden layers: a step-over
  walks past them, a step-into reveals one, and a stop at the entry of an inlined
  call shows the call site until stepped into.
- **Reads frames, scopes and values from the DWARF.** Physical frames unwound as
  deep as the stack goes — through `.debug_frame` where the ELF has it and the pc
  is not in a teardown it stopped describing, across an interrupt boundary into the
  code it interrupted, by measuring the callee's own prologue or the teardown left
  to run, and last by testing a stack word for credibility — with inlined frames in
  between, locals and parameters with their location at this PC, globals, registers
  and machine state. Each frame says which of those recovered it, and a register the
  frame did not establish says so instead of showing the callee's value. Values
  unfold structs, unions, bitfields, arrays, enums and pointers; a scalar that lives
  in memory is writable, as are the `r0`–`r15` rows of the Registers scope, while a
  local the compiler kept in a register is shown rather than written.
- **Evaluates a Mesen-style expression grammar** for conditions, logpoints and
  watches: C operators, `[addr]` / `{addr}` / `u32(addr)` reads, registers,
  `frame` / `scanline` / `cycle`, enumerators, labels, and C's own paths through
  the DWARF — `a.b[i].c`, `p->m`, `*p`, `&x`, `(T)x` and `(T *)x` (locals of the
  frame included, signed as their C type). A pointer or an array steps by its
  element in `+` and `-`, as in C, so `e + 1` is one `Entity` on and `p - q` is a
  count; a register, a literal or a `u32()` read has no type and keeps its raw
  32-bit word. Anything the expression names is writable if the program could
  write it: `gEntityInfo[i].xPos = 10`, `p->hp = 0`.
- **Rewinds exactly.** Keyframes (XOR + run-length deltas, a full snapshot every
  N) plus a per-frame input log put the machine back at any earlier position by
  replaying it. `stepBack`, `reverseContinue` (to the previous breakpoint hit) and
  `rewindFrames` build on that, and re-running from a rewound point reproduces
  the original run byte for byte.
- **Keeps a trace ring and a hardware event log**, stamped with frame, scanline
  and cycle.
- **Names what the ELF does not.** Labels for addresses (a decomp's `gUnk_...`)
  are persisted per project under `.gba-kit/labels.json`, importable from `.sym`
  files, usable in expressions and shown in disassembly.
- **Records and replays input**, saves and loads states bound to the ROM's hash,
  searches memory with narrowing, and decodes the display: palette, tiles,
  tilemaps, sprites, backgrounds and I/O registers.

## Usage

```ts
import { Session } from '@gba-kit/debug-core';
import { createNodeHost, fileExists } from '@gba-kit/debug-core/node';

const session = await Session.create(createNodeHost(), {
  rom: await readFile('game.gba'),
  elf: await readFile('game.elf'),
  cwd: '/home/me/game', // where the ELF's relative source paths resolve
  exists: fileExists,
});

session.on({
  stopped: (info) => console.log(info.reason, info.description),
  output: (text, category) => process.stdout.write(`[${category}] ${text}`),
});

session.setSourceBreakpoints('/home/me/game/source/main.c', [{ line: 76, condition: 'g_frame == 3' }]);
session.continue(); // runs on the host's timer until a stop

// once stopped:
session.callStack(); // [{ name: 'main', source: { path: '.../main.c', line: 76 }, ... }]
session.scopes(0); // Locals, Globals (this file), Registers, Machine — each a tree of VarNodes
session.evaluate('g_player.pos.x + 1').node.value; // '13 (0xd)'
session.stepOver();
session.stepBack(); // exactly one instruction back, replayed
session.dataBreakpointTarget('g_player.pos.x'); // { address, length: 4, name }
```

The `Host` abstracts the platform: timers for the run loop and a file system for
the project's `.gba-kit/` files. `@gba-kit/debug-core/node` provides one for
Node; a browser host, or a `ManualHost` whose clock the caller advances (what the
tests use), fits the same interface.

## Develop

```bash
pnpm --filter @gba-kit/debug-core build
pnpm --filter @gba-kit/debug-core test
```

## Testing

The session is tested against one small game-shaped C program built three ways,
so stepping, locals and unwinding are exercised on unoptimized and optimized
DWARF in both instruction sets:

| Variant    | What it covers                                                |
| ---------- | ------------------------------------------------------------- |
| `thumb-O0` | a homebrew debug build: one row per statement, stack locals   |
| `thumb-O2` | inlined calls, hoisted code, location lists, register locals  |
| `arm-O0`   | the ARM code paths (the CPU boots in ARM; here `main` is too) |

The ROM/ELF pairs are **committed** under `test-fixtures/build/`, so a clone runs
the tests with no cross toolchain. Rebuild them only after changing
`test-fixtures/source/`: `cd test-fixtures && ./build.sh` builds in Docker
(`devkitpro/devkitarm`), or `make` with `arm-none-eabi-gcc` on the path (or
`DEVKITARM` set). CI rebuilds them from scratch on every run.
