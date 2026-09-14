# @gba-kit/gba-node

## 0.8.0

### Minor Changes

- e4b0be4: Import a `.sav` file as a save state, and export the cartridge's save as one.

  A ⋯ button beside `Save state` in the Screen panel opens a menu with
  `Import from a .sav file` and `Export to a .sav file`. An import is a power-on
  machine of this ROM with the file already in its cartridge, at frame 0: loading it
  and pressing continue boots the ROM and the game finds the save, the way VBA-M's
  `Import battery file` and mGBA's `Load alternate save game` work. The state is
  named after the file, a name already taken gets `(2)`, and the machine being
  debugged is not touched — the snapshot is built on a machine of its own. Over DAP
  and in-process the requests are `gba-kit/importSave` and `gba-kit/exportSave`.

  Which chip a file belongs in follows from the save type the ROM declares and the
  file's size together, and a file those two do not account for is refused by a
  message that names both rather than being padded or truncated into the wrong chip.
  A flash cartridge is refused in both directions: gba-kit backs the cartridge with
  plain memory and emulates no flash chip, so a game's identify sequence goes
  unanswered and it never reads the save — while the command bytes it writes land in
  the save as data. That covers 1 Mbit flash too, which would also need bank
  switching the single 64 KB window has no room for.

  An export is the size the cartridge really has: 32768 bytes for SRAM, and 512 or
  8192 for EEPROM according to the width the game addressed with, not the 8 KB the
  array always occupies. An EEPROM the game has not read or written yet has told
  nobody which of the two it is, so exporting one is refused rather than guessed —
  run the game until it touches its save, or import a `.sav` first.

  Three fixes in the emulator come with it:
  - **EEPROM images are now byte-compatible with mGBA, VBA-M and a flash cart.** The
    array was byte-reversed within each 8-byte word against every real `.sav`: a
    64-bit EEPROM word goes out most significant byte first and the GBA is
    little-endian, so the byte a game sends first is the last of the eight in memory.
    **A save state written before this, of a game that uses EEPROM, comes back with
    its in-game save byte-swapped** — the state format is unchanged and still loads,
    but that game's save inside it will not be read. Re-import the `.sav`.
  - **`SRAM_F_V` cartridges get their SRAM.** Detection looked for the literal
    `SRAM_V`, which `SRAM_F_V102` does not contain, so those games had no working
    save at all. It now reads the SDK string the build embeds — word-aligned, with
    three version digits — and keeps it, so a message can name it.
  - **A 64 Kbit EEPROM is read at the right addresses.** The address width was latched
    at 6 bits by the first six bits of any address and never revised, so a 64 Kbit
    cartridge read the wrong words for the rest of the run. The width now comes from the
    length of the read the game makes, which is what carries it. A write carries no
    length — 64 data bits follow the address with nothing to mark where it ended — so it
    still needs a width up front and takes 4 Kbit until a read has said otherwise, as
    before. An imported `.sav` says nothing about the width either: a 4 Kbit save padded
    out to 8 KB is a file some emulators write, so the cartridge's own first read settles
    it and the file's length only answers for how big an export is until then.

### Patch Changes

- Updated dependencies [b61449b]
- Updated dependencies [e4b0be4]
  - @gba-kit/arm-emulator@0.8.0
  - @gba-kit/gba-emulator@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [2176949]
  - @gba-kit/gba-emulator@0.7.0
  - @gba-kit/arm-emulator@0.7.0

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
