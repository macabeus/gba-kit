# @gba-kit/gba-node

## 0.3.0

### Minor Changes

- bf00bbd: Add `readVariable(path)` to the scripting engine — the read counterpart to `watchSymbol`. It resolves a `symbol` or `symbol.field.subfield` path to an address and width via the DWARF, reads the field (decoding bitfields), and returns an unsigned value; widths over 4 bytes throw. Exposed on `ScriptingEngine` and the `HeadlessRuntime` sandbox.

  `wait({ memory })` and `assert({ memory })` now also accept a `symbol`/`symbol.field` **path** for `address` (when debug info is loaded), reading the field's full width instead of a single byte; a numeric `address` keeps its single-byte behaviour:

  ```js
  await wait({ memory: { address: 'game_sm.state', equals: 5 } });
  ```

### Patch Changes

- Updated dependencies [bf00bbd]
  - @gba-kit/gba-emulator@0.3.0
  - @gba-kit/arm-emulator@0.3.0

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
