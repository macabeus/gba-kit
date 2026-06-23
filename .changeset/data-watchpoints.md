---
'@gba-kit/gba-emulator': minor
'@gba-kit/gba-node': minor
---

Add data watchpoints to the scripting API: `watchMemory({ address, length?, filter?, maxHits? })`
records which code writes a memory range, with `clearWatchpoints()` to remove them. Each hit
reports the responsible instruction and a `source` — `'cpu'` or `'dma0'`..`'dma3'`. DMA writes
are attributed to the instruction that started the transfer, so watching a DMA-filled buffer
(VRAM, palette, OAM) points at the code that kicked off the copy.
