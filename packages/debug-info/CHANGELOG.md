# @gba-kit/debug-info

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
