---
'@gba-kit/gba-emulator': minor
'@gba-kit/gba-node': minor
---

Add data watchpoints to the scripting API: `watchMemory({ address, length?, filter? })`
records the program counter of every write to a memory range (with `clearWatchpoints()`
to remove them). This links a RAM address back to the code that writes it — the core
primitive for reverse-engineering/decomp workflows. The write fast-path early-outs when
no watchpoint is set.
