---
'@gba-kit/gba-emulator': minor
---

Rename `wait({ pc })` to `wait({ execution })`

`pc` named the field after the one value it does not take. In this API the program
counter is pipeline-ahead of the instruction it is executing — `WatchHit` carries `pc`
and `instructionAddress` as separate fields for exactly that reason — while
`wait({ pc })` wants the instruction address. Passing a hit's `pc` watches the next
instruction, which reads as a plausible count or as zero depending on whether that
instruction is reachable.

`execution` also matches `watchExecution`, so the same concept has one word: one call
waits for it, the other records it.

`wait({ pc })` still works and logs a deprecation notice.
