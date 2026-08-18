# @gba-kit/gba-node

## 0.6.0

### Minor Changes

- 7b60394: Refuse ill-posed reads instead of answering them

  The bus answers every address, as the console does: it rounds an unaligned load down
  and reads undecoded space as open bus. Correct for the CPU, and indistinguishable from
  the value you asked for. The bus is unchanged; the analysis surface now refuses.
  - `read16` / `read32` throw on a misaligned address, naming the one the hardware would
    have read, and on space the bus decodes to nothing. `read32` is now unsigned.
  - `readBytes(address, size)` — new: 1–4 bytes at any alignment, byte-assembled.
  - `readMember` / `writeMember` — new: read or write a DWARF `MemberLocation` at a base
    address, for an instance no symbol names.
  - `writeVariable(path, value)` — new: the write counterpart to `readVariable`.
  - `addressToSymbol` reports `exact` — whether `st_size` covered the address, or whether
    containment was inferred from the next symbol's start.

  **Breaking:** `read16` / `read32` throw for misaligned or undecoded addresses, which
  they previously answered. `readBytes` is the replacement.

- d894353: Guard the write side, and bound a subscript by the extent the DWARF states
  - `write8` / `write16` / `write32` / `writeBytes(address, size, value)` — new. The
    scripting surface had no write API, so scripts used the raw bus, which rounds a
    misaligned store down and discards a store to ROM. These carry the read guards.
  - Variable paths take subscripts, bounds-checked against the DWARF extent:
    `readVariable('gLayers[2].width')`, `writeVariable('gGrid[1][3]', 0)`. An index past
    the end throws instead of resolving into whatever the linker placed next. A dimension
    the DWARF leaves unstated is not checked.
  - `symbolExtent(name)` — new: an object's byte size and whether it came from `st_size`
    or the DWARF type. A write starting inside a known extent and running past its end is
    refused, naming what it would have hit.
  - `addressToSymbol` resolves linker-placed globals (`SHN_ABS`/`NOTYPE`), which it
    previously skipped entirely.

- e7e7c7d: Observe execution instead of sampling it
  - `ArmCpu.addExecWatchpoint(address, cb)` — new: fires from the instruction step and
    returns a disposer. Composable, and independent of `setDebugHooks`.
  - `wait({ execution })` replaces `wait({ pc })`, which compared the PC once per frame
    and so reported code that ran constantly as never reached. Takes an address or a
    symbol name.
  - `watchExecution(target, options?)` — new: the execution counterpart to
    `watchMemory`, reporting `count`, `hits` (each with `lr` and its source location),
    `dropped` and `stop()`. `lr` names a caller only for an address a `bl` reached.
  - `watchMemory` reports `dropped`, so a capped `hits` array is not read as the whole
    story.

  `wait()` also throws on an unrecognised condition, which previously returned immediately.

  **Breaking:** `wait({ pc })` is now `wait({ execution })`.

### Patch Changes

- Updated dependencies [e7e7c7d]
- Updated dependencies [7b60394]
- Updated dependencies [d894353]
- Updated dependencies [e7e7c7d]
- Updated dependencies
  - @gba-kit/gba-emulator@0.6.0
  - @gba-kit/arm-emulator@0.6.0

## 0.5.0

### Patch Changes

- @gba-kit/gba-emulator@0.5.0
- @gba-kit/arm-emulator@0.5.0

## 0.4.0

### Patch Changes

- @gba-kit/gba-emulator@0.4.0
- @gba-kit/arm-emulator@0.4.0

## 0.3.0

### Minor Changes

- bf00bbd: Add `readVariable(path)` to the scripting engine — the read counterpart to `watchSymbol`. It resolves a `symbol` or `symbol.field.subfield` path to an address and width via the DWARF, reads the field (decoding bitfields), and returns an unsigned value; widths over 4 bytes throw. Exposed on `ScriptingEngine` and the `HeadlessRuntime` sandbox.

  `wait({ memory })` and `assert({ memory })` now also accept a `symbol`/`symbol.field` **path** for `address` (when debug info is loaded), reading the field's full width instead of a single byte; a numeric `address` keeps its single-byte behaviour:

  ```js
  await wait({ memory: { address: 'game_sm.state', equals: 5 } });
  ```

### Patch Changes

- Updated dependencies [bf00bbd]
  - @gba-kit/gba-emulator@0.3.0
  - @gba-kit/arm-emulator@0.3.0

## 0.2.0

### Minor Changes

- 2ddc282: Add data watchpoints to the scripting API: `watchMemory({ address, length?, filter?, maxHits? })`
  records which code writes a memory range, with `clearWatchpoints()` to remove them. Each hit
  reports the responsible instruction and a `source` — `'cpu'` or `'dma0'`..`'dma3'`. DMA writes
  are attributed to the instruction that started the transfer, so watching a DMA-filled buffer
  (VRAM, palette, OAM) points at the code that kicked off the copy.
- Add `@gba-kit/debug-info`: parse ELF symbols + DWARF line tables to map a PC to its
  function and C source (`pcToFunction`, `pcToSource`, `symbolToAddress`,
  `addressToSymbol`). Wire source-level debugging into the scripting engine
  (`loadDebugInfo`, `watchSymbol` — which now defaults its watch length to the
  symbol's size) and the Node runtime (`elfPath` option), and add a Source panel to
  the webapp that follows execution in C alongside the disassembly.

### Patch Changes

- Updated dependencies [2ddc282]
- Updated dependencies
  - @gba-kit/gba-emulator@0.2.0
  - @gba-kit/arm-emulator@0.2.0
