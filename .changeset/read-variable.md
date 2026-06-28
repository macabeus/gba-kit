---
'@gba-kit/gba-emulator': minor
'@gba-kit/gba-node': minor
---

Add `readVariable(path)` to the scripting engine — the read counterpart to `watchSymbol`. Given a `symbol` or `symbol.field.subfield` path it resolves the address from the symbol table and the byte size (and any bitfield shift/width) from the variable's DWARF type, reads the right number of bytes, and decodes a packed bitfield to its plain value. Exposed on `ScriptingEngine` and in the `HeadlessRuntime` script sandbox.
