---
'@gba-kit/gba-emulator': patch
---

Accept a symbol wherever an address is accepted, and normalize a code address

- A numeric code address now has bit 0 cleared. A Thumb function pointer carries it
  set, so `watchExecution(ptr)` counted 0 where the same function by name counted 420.
- `watchMemory` takes a symbol name, and throws on an unknown one instead of coercing
  it to address 0 and watching nothing.
- A symbol watch defaults to the object's whole extent rather than `st_size`, which is
  null for a linker-placed global — `watchSymbol('gLayers')` watched 1 byte of 112.
