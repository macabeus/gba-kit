---
'@gba-kit/debug-info': minor
---

Read what a global is DECLARED as, not just where its fields sit — and parse big-endian ELFs.

`TypeIndex` gains:

- `variableShape(varName)` — classify a global/static's declaration as `scalar` | `pointer` | `array` | `struct`, resolved through typedefs and cv-qualifiers, carrying the `volatile`/`const` crossed on the way (`volatile` says accesses are observable, `const` the ROM-table spelling). `null` when the name has no DIE, which also makes it the "is this name declared in the project headers?" probe.
- `pointee` on the `pointer` shape — what the pointer points AT, when its target resolves to a struct or union: the name `struct()` looks that layout up by, the target's byte size, and the target's own `volatile`/`const`. The target's qualifiers are the ones written to the left of the `*` (`volatile struct S *g`) and stay separate from the pointer variable's own, to the right of it (`struct S *volatile g`).

A struct or union is named by its tag, or — for the `typedef struct {…} T;` idiom, where the struct itself is unnamed and the alias is the only name its layout has — by the last typedef crossed. That holds on the `struct` shape as well as on `pointee`, so either name goes straight back into `struct()`. A target that is only forward-declared carries no size of its own, so it is sized from the definition its tag resolves to.

`struct()` members now also carry the declaration facts an offset and a size cannot: base-type `signed`ness, `pointer`, the `volatile`/`const` its type chain crosses, and — for an array member — `elemSize`, `elemSigned` and `length`. A cv-qualifier moves no field, so it is only ever visible as a declaration fact, and it is not interchangeable with its absence: repeated accesses to a `volatile` member are observable, and a write through a `const` one is a constraint violation. `size` is the WHOLE member (`char name[6]` → 6), so the element stride is what an indexed read into it needs, and the count is what bounds it; each key is absent when the DWARF does not determine it (a flexible array member declares a stride but no length).

`ElfFile` and the DWARF parsers read big-endian (`ELFDATA2MSB`) containers and payloads, including bitfields — a big-endian target allocates them from the most significant end of the storage unit, so the same C declaration yields mirrored shifts. RELA relocations are applied to `.debug_*` sections, so the DWARF in a relocatable `.o` resolves too.

`.debug_line` units are walked by their own `DW_LNE_end_sequence` terminators rather than by `unit_length` alone. agbcc (GCC 2.95) sizes a unit by predicting the encoded length of each statement and mispredicts, so `unit_length` can stop short of the program it describes; stopping there leaves the next unit's header to be read as line-program bytes and loses every row after it.
