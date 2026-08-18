---
'@gba-kit/arm-emulator': minor
'@gba-kit/gba-emulator': minor
'@gba-kit/gba-node': minor
---

Observe execution instead of sampling it

- `ArmCpu.addExecWatchpoint(address, cb)` — new: fires from the instruction step and
  returns a disposer. Composable, and independent of `setDebugHooks`.
- `wait({ execution })` replaces `wait({ pc })`, which compared the PC once per frame
  and so reported code that ran constantly as never reached. Takes an address or a
  symbol name.
- `watchExecution(target, options?)` — new: the execution counterpart to
  `watchMemory`, reporting `count`, `hits` (with the caller's `lr` and source
  location), `dropped` and `stop()`.
- `watchMemory` reports `dropped`, so a capped `hits` array is not read as the whole
  story.

`wait()` also throws on an unrecognised condition, which previously returned immediately.

**Breaking:** `wait({ pc })` is now `wait({ execution })`.
