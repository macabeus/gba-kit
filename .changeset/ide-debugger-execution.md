---
'@gba-kit/gba-emulator': minor
'@gba-kit/arm-emulator': minor
'@gba-kit/gba-browser': patch
---

Debugger-grade execution and inspection in the emulator core:

- `Gba.runFrame(shouldStop?)` takes a stop predicate checked before every instruction and while the CPU is halted. A stop charges no cycle, and the next call finishes the same hardware frame, so frames stay on the hardware grid however often a debugger interrupts them. `Gba.runScanline()`, `Gba.frameCount` and `Gba.scanline` are new; `runFrame` returns a `RunOutcome`.
- A CPU debug hook that refuses an instruction no longer costs a scheduler cycle (`ArmCpu.halted` distinguishes a halted CPU from a refused instruction).
- Snapshot restore is bit-exact: scheduled events keep their `fireCycle` and only get their callbacks reattached (`Scheduler.reattach`, `TimerController.reattachEvents`, `DmaController.reattachEvents`), held buttons are restored, and `frameCount` is part of the snapshot. Running K frames from a restored snapshot now reproduces the original run.
- The HLE BIOS no longer keeps module-global state: `handleSwi` takes a per-machine `BiosEnv`, so two `Gba` instances in one process cannot cross-talk.
- `GbaSystemBus.peek` / `poke`: side-effect-free debugger reads (an EEPROM peek never clocks its protocol) and writes that store the byte typed (no OAM drop / VRAM duplication) without notifying data watchpoints.
- `EmulatorBridge.loadState` releases the buttons a snapshot restores, keeping the browser's save-state UX unchanged.
