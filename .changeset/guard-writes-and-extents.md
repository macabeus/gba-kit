---
'@gba-kit/gba-emulator': minor
'@gba-kit/debug-info': minor
'@gba-kit/gba-node': minor
---

Guard the write side, and bound a subscript by the extent the DWARF states

The scripting surface had no write API at all, so a script reaching for one dropped to
the raw bus — which rounds a misaligned store down and discards a store to ROM, both
silently. Alignment matters more here than on the read side: a misaligned store does not
merely write the wrong place, it overwrites the value next door, changing the state
being observed.

- `write8` / `write16` / `write32` / `writeBytes(address, size, value)` are new. They
  carry the same guards as the reads: misaligned and undecoded addresses throw, and so
  does a write to read-only memory.
- **Variable paths take subscripts**, bounds-checked against the DWARF extent:
  `readVariable('gLayers[2].width')`, `writeVariable('gGrid[1][3]', 0)`. An index past
  the end throws instead of resolving to whatever object the linker placed next. A
  dimension the DWARF leaves unstated (`extern T x[][4]`) cannot be checked and is not.
- `symbolExtent(name)` reports an object's byte size and whether it came from `st_size`
  or from the DWARF type. A write that starts inside a known extent and runs past its
  end is refused, naming what it would have run into.
- `addressToSymbol` resolves linker-defined globals. An ldscript `gFoo = 0x03000000;` is
  `SHN_ABS`/`NOTYPE`, and excluding those left it unable to name a single data global in
  a decomp ELF. Their extent is inferred, and reported as such via `exact`.
