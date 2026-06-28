---
'@gba-kit/gba-emulator': minor
'@gba-kit/gba-node': minor
---

Add `readVariable(path)` to the scripting engine — the read counterpart to `watchSymbol`. Given a `symbol` or `symbol.field.subfield` path it resolves the address from the symbol table and the byte size (and any bitfield shift/width) from the variable's DWARF type, reads the right number of bytes, and decodes a packed bitfield to its plain value. The read assembles individual bytes, so it is correct at any alignment and returns an unsigned 32-bit result; values wider than 4 bytes throw rather than silently truncating. Exposed on `ScriptingEngine` and in the `HeadlessRuntime` script sandbox.

`wait({ memory })` and `assert({ memory })` now also accept a `symbol`/`symbol.field` **path** for `address` (when debug info is loaded), resolving it through the DWARF and comparing against the field's full width (bitfields decoded) instead of a single byte. A raw numeric `address` keeps its existing single-byte behaviour. This lets callers write `wait({ memory: { address: 'game_sm.state', equals: 5 } })` (and the same for `assert`) without resolving the address themselves.
