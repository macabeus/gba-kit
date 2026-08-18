# @gba-kit/arm-emulator

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
