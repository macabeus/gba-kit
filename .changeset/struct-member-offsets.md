---
'@gba-kit/debug-info': minor
---

Parse struct/union layouts, bitfields, and enum constants from DWARF `.debug_info`.

`DebugInfo` gains:

- `struct(name)` — members with byte offsets and sizes.
- `structMember(name, path)` — resolve a dotted/array nested field path to its offset + size.
- `enumValues(name)` — `{ enumeratorName: value }`, including explicit/continued values.
- `hasTypeInfo`, plus the new exported `TypeIndex`.

Bitfield members also report `bitOffset`/`bitWidth`, normalized across the DWARF 2/3 (`DW_AT_bit_offset` from the storage-unit MSB) and DWARF 4+ (`DW_AT_data_bit_offset`) encodings, so a packed field decodes as `(read(addr + offset, size) >> bitOffset) & ((1 << bitWidth) - 1)`.

The parser resolves struct/enum tags and typedef aliases of anonymous struct/enums, follows typedef/qualifier chains for sizes, handles both the constant and `DW_OP_plus_uconst` block encodings of `data_member_location`, and bounds each `.debug_abbrev` table to the next CU's offset (agbcc abuts abbrev tables with no 0-code terminator, which would otherwise corrupt multi-CU type parsing).

`symbolToAddress` now also resolves linker-defined `STT_NOTYPE`/`STB_GLOBAL` symbols (the `gFoo = 0x...;` ldscript globals that place data at fixed RAM addresses), previously filtered out.
