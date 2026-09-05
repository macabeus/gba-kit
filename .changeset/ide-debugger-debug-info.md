---
'@gba-kit/debug-info': minor
---

The queries an IDE debugger needs on top of the parser:

- `LineTable.sourceToPcs(file, line)`, `nearestLineWithCode`, `rowAt(address)` (statement-aware, for stepping) and `files`; paths are matched normalized.
- `SymbolIndex` keeps each symbol's binding and section; `globalSymbol(name)` / `DebugInfo.globalSymbolAddress` answer only with a defined global (a file-static of the same spelling never satisfies a C `extern`, and two globals at different addresses are refused as ambiguous). Linker globals placed inside a section (`gFoo = .;`, as a decomp's ldscript does) now resolve, not only `SHN_ABS` ones; undefined/common symbols and absolute FUNC placeholders are dropped.
- `modeAt(address)` reports the instruction set from GNU `$a` / `$t` / `$d` mapping symbols.
- `checkRomIdentity(rom)` compares the ELF's cartridge-window sections with a ROM and names the first mismatch; `isLinked` distinguishes an image from an object file (`ElfFile.type`).
- Line rows for code the linker discarded (addresses below every loadable section) are dropped, so a PC in the BIOS stub no longer resolves into them.
- `readDwarfEntries(elf)` exports the DIE trees with attribute forms and unit versions, for scope- and location-level readers.
