# @gba-kit/gba-browser

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

### Patch Changes

- Updated dependencies [b61449b]
- Updated dependencies [e4b0be4]
  - @gba-kit/arm-emulator@0.8.0
  - @gba-kit/gba-emulator@0.8.0

## 0.7.0

### Patch Changes

- 2176949: Debugger-grade execution and inspection in the emulator core:
  - `Gba.runFrame(shouldStop?)` takes a stop predicate checked before every instruction and while the CPU is halted. A stop charges no cycle, and the next call finishes the same hardware frame, so frames stay on the hardware grid however often a debugger interrupts them. `Gba.runScanline()`, `Gba.frameCount` and `Gba.scanline` are new; `runFrame` returns a `RunOutcome`.
  - A CPU debug hook that refuses an instruction costs no scheduler cycle (`ArmCpu.halted` distinguishes a halted CPU from a refused instruction).
  - `CpuSnapshot.haltedBySWI` is gone: nothing ever set it, because a GBA halts through `HALTCNT` into the interrupt controller. A snapshot written with the field still loads, the field being ignored, but code that reads or constructs a `CpuSnapshot` must drop it.
  - Snapshot restore is bit-exact: scheduled events keep their `fireCycle` and only get their callbacks reattached (`Scheduler.reattach`, `TimerController.reattachEvents`, `DmaController.reattachEvents`), held buttons are restored, and `frameCount` is part of the snapshot, so running K frames from a restored snapshot reproduces the original run.
  - The HLE BIOS keeps no module-global state: `handleSwi` takes a per-machine `BiosEnv`, so two `Gba` instances in one process cannot cross-talk.
  - `GbaSystemBus.peek` / `poke`: side-effect-free debugger reads (an EEPROM peek never clocks its protocol) and writes that store the byte typed (no OAM drop / VRAM duplication) without notifying data watchpoints.
  - `GbaSystemBus.addReadWatchpoint`: read data breakpoints, the counterpart of the write watchpoints. A load overlapping the range reports the value it returned and which DMA channel, if any, performed it; the read paths pay one length check when none is set.
  - `EmulatorBridge.loadState` releases the buttons a snapshot restores, so a loaded state does not arrive with buttons held. `EmulatorBridge.refreshFrame()` repaints the canvas from the PPU after another driver of the same `Gba` (a debug session) moved it, `saveState` draws its thumbnail from the screen as it is now rather than the last frame the bridge rendered, and `run()` clears only the CPU debug hooks the bridge itself installed.
  - `disassembleThumbAt` / `disassembleArmAt`: a Thumb `bl` prefix/suffix pair is one 4-byte instruction with its target, and branch / literal-pool targets can be symbolized.
  - `Gba.onHardwareEvent`: one sink for interrupt requests and entries, DMA transfers (with the instruction that started them), I/O writes, VBlank/HBlank and halts — the feed for an event log; the hot paths pay nothing when nobody listens.

- Updated dependencies [2176949]
  - @gba-kit/gba-emulator@0.7.0
  - @gba-kit/arm-emulator@0.7.0

## 0.6.0

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

### Patch Changes

- Updated dependencies [bf00bbd]
  - @gba-kit/gba-emulator@0.3.0
  - @gba-kit/arm-emulator@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [2ddc282]
- Updated dependencies
  - @gba-kit/gba-emulator@0.2.0
  - @gba-kit/arm-emulator@0.2.0
