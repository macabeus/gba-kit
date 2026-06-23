---
'@gba-kit/gba-emulator': minor
'@gba-kit/gba-node': minor
---

Add data watchpoints to the scripting API: `watchMemory({ address, length?, filter? })`
records who wrote a memory range (with `clearWatchpoints()` to remove them). This links a
RAM address back to the code that writes it — the core primitive for reverse-engineering /
decomp workflows. The write fast-path early-outs when no watchpoint is set.

Each hit reports a `source` (`'cpu'` or `'dma0'`..`'dma3'`). **DMA writes are attributed
to the instruction that started the transfer** (the store to `DMAxCNT_H`), so watchpoints
on DMA-filled buffers (VRAM, palette, OAM) point at the code that kicked off the copy
instead of an unrelated CPU PC. Hits fire only for writes that actually commit (8-bit
OAM/OBJ-VRAM and ROM writes are skipped), report the specific watched byte for wide
straddling stores, mask `value` to the access size, clamp `length` to ≥1, iterate
snapshot-safe so a callback may clear watchpoints mid-write, and contain a throwing
`filter` so it can't abort emulation.

Thumb state is read straight from the CPU (so attribution is correct even without the
optional `cpuCpsr` wiring). `watchMemory` also takes `maxHits` to cap recorded hits
(unbounded growth guard for wide/long watches), and `clearWatchpoints()` removes only the
watchpoints created via that engine, leaving any others intact.

Writes are matched on their canonical address, so a write reaching a watched byte through
a region mirror (EWRAM/IWRAM/palette/OAM/VRAM) still fires. EEPROM serial writes no longer
produce spurious hits. The hot path avoids allocating in the common single-watchpoint case,
and DMA skips its source-tagging work entirely when no watchpoint is set.
