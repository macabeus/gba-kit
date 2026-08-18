---
'@gba-kit/gba-emulator': patch
---

Accept a symbol wherever an address is accepted, and normalize a code address

Three quiet-wrong-answer bugs in how a location is named:

- A numeric code address kept bit 0. On ARM that bit is a state marker, not part of
  an address, and a Thumb function POINTER carries it set — which is what `read32`
  returns from a callback table. `watchExecution(ptr)` counted 0 where
  `watchExecution(name)` counted 420, for the same function.
- `watchMemory` took only a number. A symbol name was accepted by the untyped script
  context, coerced to address 0, and watched nothing — reporting no writes.
- `watchSymbol` defaulted its length to `st_size`, which is null for a linker-placed
  global. In a decomp that is every data global, so `watchSymbol('gLayers')` watched
  the first byte of a 112-byte array and reported the rest as never written. It now
  uses the object's extent, the same rule everywhere.
