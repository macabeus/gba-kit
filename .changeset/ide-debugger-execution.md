---
'@gba-kit/gba-emulator': minor
'@gba-kit/arm-emulator': minor
'@gba-kit/gba-browser': patch
---

Debugger-grade execution and inspection in the emulator core:

- `Gba.runFrame(shouldStop?)` takes a stop predicate checked before every instruction and while the CPU is halted. A stop charges no cycle, and the next call finishes the same hardware frame, so frames stay on the hardware grid however often a debugger interrupts them. `Gba.runScanline()`, `Gba.frameCount` and `Gba.scanline` are new; `runFrame` returns a `RunOutcome`.
- A CPU debug hook that refuses an instruction costs no scheduler cycle (`ArmCpu.halted` distinguishes a halted CPU from a refused instruction).
- Snapshot restore is bit-exact: scheduled events keep their `fireCycle` and only get their callbacks reattached (`Scheduler.reattach`, `TimerController.reattachEvents`, `DmaController.reattachEvents`), held buttons are restored, and `frameCount` is part of the snapshot, so running K frames from a restored snapshot reproduces the original run.
- The HLE BIOS keeps no module-global state: `handleSwi` takes a per-machine `BiosEnv`, so two `Gba` instances in one process cannot cross-talk.
- `GbaSystemBus.peek` / `poke`: side-effect-free debugger reads (an EEPROM peek never clocks its protocol) and writes that store the byte typed (no OAM drop / VRAM duplication) without notifying data watchpoints.
- `GbaSystemBus.addReadWatchpoint`: read data breakpoints, the counterpart of the write watchpoints. A load overlapping the range reports the value it returned and which DMA channel, if any, performed it; the read paths pay one length check when none is set.
- `EmulatorBridge.loadState` releases the buttons a snapshot restores, so a loaded state does not arrive with buttons held. `EmulatorBridge.refreshFrame()` repaints the canvas from the PPU after another driver of the same `Gba` (a debug session) moved it, `saveState` draws its thumbnail from the screen as it is now rather than the last frame the bridge rendered, and `run()` clears only the CPU debug hooks the bridge itself installed.
- `disassembleThumbAt` / `disassembleArmAt`: a Thumb `bl` prefix/suffix pair is one 4-byte instruction with its target, and branch / literal-pool targets can be symbolized.
- `Gba.onHardwareEvent`: one sink for interrupt requests and entries, DMA transfers (with the instruction that started them), I/O writes, VBlank/HBlank and halts — the feed for an event log; the hot paths pay nothing when nobody listens.
