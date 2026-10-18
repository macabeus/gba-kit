# @gba-kit/gba-node

## 0.9.0

### Minor Changes

- c736b5d: The emulator runs the GBA's timing, CPU, video, sound and BIOS the way the hardware
  does, measured against jsmolka's gba-tests and the mGBA test suite.

  Every jsmolka ROM passes: arm, thumb, memory, bios, nes, unsafe, and the SRAM, 64 KB
  flash and 128 KB flash save tests. In the mGBA suite, Memory, I/O read, Timing, Timer
  IRQ, Shifter, Carry, Multiply long, BIOS math, DMA and SIO register tests all pass in
  full, and its video tests match the hardware captures, with Layer toggle 2 the one
  exception. Before this, Timing passed 4 of 2020 checks and Timer IRQ none. Klonoa:
  Empire of Dreams draws its world maps the same as mGBA running the real BIOS, and runs
  faster than before: about 480 frames per second headless, against about 355.
  - **Time is counted in ARM7TDMI cycles.** Each instruction costs its N, S and I
    cycles plus the wait states of the memory it touches, priced from WAITCNT and with
    the game pak prefetch buffer. An access at the start of a 128 KB block of the
    cartridge is nonsequential. A DMA takes its own cycles and holds the bus, channel by
    priority. An interrupt reaches the CPU 7 cycles after it is raised. Every subsystem
    (timers, DMA, APU, PPU latches) reads the same clock, which is exact in the middle
    of an instruction. A game now runs as much code per frame as on hardware, where it
    used to run one instruction per cycle.
  - **The CPU runs through its two-stage pipeline.** Self-modifying code sees the
    opcodes already fetched, and so does a debugger: a write over the instruction at
    the stopped PC is what runs next. The core applies the ARMv4 rules for misaligned
    and banked loads and stores, for an empty register list, for a base in the list, for
    `^` transfers, for MSR privilege and for condition NV, and sets the carry after a
    multiply from the multiplier's internal state. The algorithm and its zlib notice
    come from zaydlang and calc84maniac.
  - **I/O has one register path for every access width.** Each register reads through
    its own mask, write-only and unused registers read open bus, the BIOS reads back its
    last fetched opcode from outside, and a DMA's last unit is open bus while it runs.
    The LCD owns DISPSTAT and VCOUNT and compares VCOUNT on every line and on every LYC
    write.
  - **The PPU draws each line at the start of HBlank, from the state it latches.** So a
    raster effect lands on its own line. DISPCNT is latched 40 cycles into the line. All
    six modes share one compositor, so the bitmap modes get sprites, windows, blending
    and the affine transform. The compositor also covers the OBJ window, priority
    between sprites, the window flip-flop, mosaic, 5-bit blending, the OBJ cycle budget
    and Green Swap.
  - **Sound plays at the right pitch.** The PSG channels ran four times too fast. Each
    sound register byte now acts on its own, channel 3 has both wave banks and its 75%
    volume, and the mixer follows SOUNDBIAS. The APU also follows the machine clock, so
    Direct Sound keeps time through DMA.
  - **The BIOS functions return what the real BIOS returns.** ArcTan, ArcTan2, Div,
    Sqrt, BgAffineSet, ObjAffineSet (from the BIOS's sine table), BitUnPack, the
    decompressors and the Diff unfilters are bit-exact, and each charges the cycles of
    the BIOS's own loops. Halt, Stop, IntrWait, VBlankIntrWait and SoftReset run as BIOS
    code entered through the SWI exception, so an interrupt is serviced inside them as
    on hardware. SWI 0x19 is SoundBias and 0x1F is MidiKey2Freq. `Gba` sets up the
    post-BIOS boot state, which every host shares.
  - **A flash cartridge has its flash chip.** It has the command protocol, the chip ID,
    sector and chip erase, and the bank switch of a 128 KB chip. SRAM is 32 KB that
    reads 0xFF erased, and an 8-bit save bus sees every address bit. Flash `.sav` files
    now import and export like SRAM and EEPROM ones. Region 0x0D is EEPROM only on a
    cartridge that has one.
  - **The serial port answers.** A Normal-mode transfer on the internal clock completes
    with its interrupt, reading the idle line's ones, and the SIO registers read as the
    hardware does with nothing connected.

  **The Play page runs at the GBA's 59.73 frames per second on every display.** Its loop ran
  one frame per `requestAnimationFrame`, which is the display's refresh rate, so a game ran
  twice as fast on a 120 Hz screen. `FrameClock` (gba-browser) turns the time between two
  callbacks into the GBA frames it holds, and the script replayer paces by it too.

  The debugger follows the new machine. A read watchpoint fires on data loads and
  executed fetches, and stays quiet on opcodes the CPU prefetched. The call stack
  unwinds through a BIOS service call (`FrameMethod` `'service'`). The browser bridge
  steps through the same run loop as `debug-core`. The inspector reports `cycle` in CPU
  cycles.

  **Older save states still load.** Each new piece of state has a documented default
  when a snapshot predates it, so a state restores and keeps running. Its timing from
  then on is the new model's, so a replay of an old state can drift from what the old
  emulator would have done.

  API changes for code that drives the emulator directly:
  - `MemoryBus` (arm-emulator) has opcode fetches of their own (`fetch16`, `fetch32`) and
    prices accesses (`accessCycles`, `fetchCycles`, `dataCycles`, `idle`).
    `ArmCpu.step()` returns the cycles it took, and `ArmCpu.refused` says when a debugger
    stop refused the instruction.
  - `Gba` sets the boot state itself, so hosts no longer set the stack pointers, CPSR
    and PC after `loadRom`.
  - `BiosEnv` is gone, and `BIOS_SWI_HANDLER` describes the SWI handler for unwinders.
    The APU follows the scheduler's clock, so hosts stop ticking it and only read
    samples. `SerialPort`, `DISPCNT_LATCH_CYCLE` and `HBLANK_START_CYCLE` are exported.

### Patch Changes

- Updated dependencies [c736b5d]
  - @gba-kit/arm-emulator@0.9.0
  - @gba-kit/gba-emulator@0.9.0

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
