# @gba-kit/arm-emulator

## 0.7.0

### Minor Changes

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

## 0.6.0

### Minor Changes

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

- Implement the THUMB empty-Rlist quirk for LDMIA/STMIA

  THUMB.15 encodes the register list in 8 bits, so `Rlist == 0` is representable, and
  ARM7TDMI does not treat it as a no-op: it transfers R15 and advances the base by
  0x40 (GBATEK, THUMB.15). The per-register loop did not run and the base was left
  alone, so `stmia r1!, {}` stored nothing and moved nothing.

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.0
