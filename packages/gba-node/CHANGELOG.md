# @gba-kit/gba-node

## 0.2.0

### Minor Changes

- 2ddc282: Add data watchpoints to the scripting API: `watchMemory({ address, length?, filter?, maxHits? })`
  records which code writes a memory range, with `clearWatchpoints()` to remove them. Each hit
  reports the responsible instruction and a `source` — `'cpu'` or `'dma0'`..`'dma3'`. DMA writes
  are attributed to the instruction that started the transfer, so watching a DMA-filled buffer
  (VRAM, palette, OAM) points at the code that kicked off the copy.
- Add `@gba-kit/debug-info`: parse ELF symbols + DWARF line tables to map a PC to its
  function and C source (`pcToFunction`, `pcToSource`, `symbolToAddress`,
  `addressToSymbol`). Wire source-level debugging into the scripting engine
  (`loadDebugInfo`, `watchSymbol` — which now defaults its watch length to the
  symbol's size) and the Node runtime (`elfPath` option), and add a Source panel to
  the webapp that follows execution in C alongside the disassembly.

### Patch Changes

- Updated dependencies [2ddc282]
- Updated dependencies
  - @gba-kit/gba-emulator@0.2.0
  - @gba-kit/arm-emulator@0.2.0
