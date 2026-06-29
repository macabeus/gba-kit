---
'@gba-kit/gba-emulator': minor
'@gba-kit/gba-node': minor
---

Add `readVariable(path)` to the scripting engine — the read counterpart to `watchSymbol`. It resolves a `symbol` or `symbol.field.subfield` path to an address and width via the DWARF, reads the field (decoding bitfields), and returns an unsigned value; widths over 4 bytes throw. Exposed on `ScriptingEngine` and the `HeadlessRuntime` sandbox.

`wait({ memory })` and `assert({ memory })` now also accept a `symbol`/`symbol.field` **path** for `address` (when debug info is loaded), reading the field's full width instead of a single byte; a numeric `address` keeps its single-byte behaviour:

```js
await wait({ memory: { address: 'game_sm.state', equals: 5 } });
```
