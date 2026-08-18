---
'@gba-kit/arm-emulator': minor
'@gba-kit/gba-emulator': minor
'@gba-kit/gba-node': minor
---

Observe execution instead of sampling it

`wait({ pc })` compared the PC once per frame. A frame is ~280,896 cycles, so it saw
only whatever the CPU was doing at the boundary — on a game that idles in a BIOS wait
loop, one address out of the thousands executed. Everything else timed out, which reads
as "never reached" however often it actually ran.

- `ArmCpu.addExecWatchpoint(address, cb)` — new: fires from the instruction step and
  returns a disposer. Composable, and independent of `setDebugHooks`, which is a single
  slot one owner replaces wholesale.
- `wait({ pc })` uses it, and accepts a symbol name as well as an address.
- `watchExecution(target, options?)` — new: the execution counterpart to
  `watchMemory`. Reports `count` (exact), `hits` (with the caller's `lr` and source
  location), `dropped` and `stop()`.
- `watchMemory` reports `dropped`. A cap that reported nothing left
  `hits.length === maxHits` meaning either "that is all of them" or "that is the first
  few" — different findings.
