# @gba-kit/debug-info

## 0.4.0

### Minor Changes

- 6479b6b: Read what a name is DECLARED as — shapes, signatures and macro names — from either byte order.
  - `variableShape(name)` classifies a global/static as `scalar | pointer | array | struct`,
    resolved through typedef/cv chains: `volatile`/`const`, array `elemSize`/`elemSigned`/`length`,
    and the pointer's `pointee` (the name `struct()` resolves, its size, its own qualifiers).
    A `typedef struct {…} T;` is named by its alias; `null` doubles as the "is this name
    declared in the project headers?" probe.
  - `struct()` members carry the declaration facts layout alone cannot: `signed`, `pointer`,
    `pointeeSize`/`pointeeSigned`, `volatile`/`const`, and array `elemSize`/`elemSigned`/`length`.
    Every key is absent when the DWARF does not determine it.
  - `functionSignature(name)` returns a COMPILED function's return and parameter types
    (`low_pc` is the witness): `null` means "this ELF did not compile it", never "it takes
    no arguments". gcc's abstract/concrete split at `-O1+` resolves to one definition.
  - `DebugInfo.macros` / `parseDebugMacinfo` read the `-g3` macro table (DWARF 2/3
    `.debug_macinfo`, the self-contained form) — the only place an address-cast `#define`
    name survives, since a macro leaves no symbol and no DIE. A truncated stream yields a
    sound prefix, never a corrupted entry.
  - Big-endian ELF/DWARF end to end — bitfields are allocated from the MSB end and reported
    that way — and RELA relocations are applied to `.debug_*` in relocatable objects.
  - `.debug_line` is walked by its own `DW_LNE_end_sequence` terminators: agbcc (GCC 2.95)
    mispredicts `unit_length`, which used to cost every row after the first short unit.
  - Producer-dialect fixes, pinned on committed toolchain output: DWARF 2/3's `DW_FORM_flag`
    decodes as a boolean (every declaration/prototyped test was inert, so a forward-declared
    struct could shadow its own definition by link order); GCC 2.95's `0xffffffff` upper
    bound reads as zero-length, not 2^32 elements; and a DECLARATION's `[1]` array is agbcc's
    unsized-extern spelling, reported as `length: null`.

## 0.3.0

### Minor Changes

- bf00bbd: Parse struct/union layouts, bitfields, and enum constants from DWARF `.debug_info`.

  `DebugInfo` gains:
  - `struct(name)` — members with byte offsets and sizes.
  - `structMember(name, path)` — resolve a dotted/array nested field path to its offset + size, descending through anonymous unions/structs.
  - `enumValues(name)` — `{ enumeratorName: value }`, including explicit/continued values.
  - `variableMember(varName, path)` — like `structMember`, but rooted at a global/static variable; its type is read from the variable's own DWARF DIE, so no type name is needed.
  - `resolveVariable("symbol.field.subfield")` — resolve a path to an absolute `ResolvedLocation` in one call: address from `.symtab`, layout from the variable's DWARF type.
  - `hasTypeInfo`, plus the new exported `TypeIndex`.

  Bitfield members also report `bitOffset`/`bitWidth`, normalized across the DWARF 2/3 and 4+ encodings. Members whose byte size can't be determined (incomplete type, flexible array) report `size: null`.

  Handles DWARF 2–5 from agbcc and modern GCC, including typedef/qualifier chains and multi-CU abbrev tables.

  `symbolToAddress` now also resolves linker-defined absolute (`SHN_ABS`) globals — the `gFoo = 0x...;` ldscript symbols that place data at fixed RAM addresses — while keeping section-relative markers like `_end`/`__bss_start` excluded.

## 0.2.0

### Minor Changes

- Add `@gba-kit/debug-info`: parse ELF symbols + DWARF line tables to map a PC to its
  function and C source (`pcToFunction`, `pcToSource`, `symbolToAddress`,
  `addressToSymbol`). Wire source-level debugging into the scripting engine
  (`loadDebugInfo`, `watchSymbol` — which now defaults its watch length to the
  symbol's size) and the Node runtime (`elfPath` option), and add a Source panel to
  the webapp that follows execution in C alongside the disassembly.
