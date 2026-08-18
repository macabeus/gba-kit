---
'@gba-kit/gba-emulator': minor
'@gba-kit/debug-info': minor
'@gba-kit/gba-node': minor
---

Guard the write side, and bound a subscript by the extent the DWARF states

- `write8` / `write16` / `write32` / `writeBytes(address, size, value)` — new. The
  scripting surface had no write API, so scripts used the raw bus, which rounds a
  misaligned store down and discards a store to ROM. These carry the read guards.
- Variable paths take subscripts, bounds-checked against the DWARF extent:
  `readVariable('gLayers[2].width')`, `writeVariable('gGrid[1][3]', 0)`. An index past
  the end throws instead of resolving into whatever the linker placed next. A dimension
  the DWARF leaves unstated is not checked.
- `symbolExtent(name)` — new: an object's byte size and whether it came from `st_size`
  or the DWARF type. A write starting inside a known extent and running past its end is
  refused, naming what it would have hit.
- `addressToSymbol` resolves linker-placed globals (`SHN_ABS`/`NOTYPE`), which it
  previously skipped entirely.
