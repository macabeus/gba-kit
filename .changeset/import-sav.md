---
'@gba-kit/gba-emulator': minor
'@gba-kit/debug-core': minor
'@gba-kit/debug-adapter': minor
'@gba-kit/debug-ui': minor
---

Import a `.sav` file as a save state, and export the cartridge's save as one.

A ⋯ button beside `Save state` in the Screen panel opens a menu with
`Import from a .sav file` and `Export to a .sav file`. An import is a power-on
machine of this ROM with the file already in its cartridge, at frame 0: loading it
and pressing continue boots the ROM and the game finds the save, the way VBA-M's
`Import battery file` and mGBA's `Load alternate save game` work. The state is
named after the file, a name already taken gets `(2)`, and the machine being
debugged is not touched — the snapshot is built on a machine of its own. Over DAP
and in-process the requests are `gba-kit/importSave` and `gba-kit/exportSave`.

Which chip a file belongs in follows from the save type the ROM declares and the
file's size together, and a file those two do not account for is refused by a
message that names both rather than being padded or truncated into the wrong chip.
A `FLASH1M_V` cartridge is refused in both directions: its 128 KB live in two
banks, and gba-kit has 64 KB of cartridge backup memory and no bank switching.

Three fixes in the emulator come with it:

- **EEPROM images are now byte-compatible with mGBA, VBA-M and a flash cart.** The
  array was byte-reversed within each 8-byte word against every real `.sav`: a
  64-bit EEPROM word goes out most significant byte first and the GBA is
  little-endian, so the byte a game sends first is the last of the eight in memory.
  **A save state written before this, of a game that uses EEPROM, comes back with
  its in-game save byte-swapped** — the state format is unchanged and still loads,
  but that game's save inside it will not be read. Re-import the `.sav`.
- **`SRAM_F_V` cartridges get their SRAM.** Detection looked for the literal
  `SRAM_V`, which `SRAM_F_V102` does not contain, so those games had no working
  save at all. It now reads the SDK string the build embeds — word-aligned, longest
  prefix first, three version digits — and keeps it, so a message can name it.
- **A 64 Kbit EEPROM is addressed correctly when a `.sav` says it is one.** Address
  width was guessed from the first transfer, which latches 6 bits and never
  revises; an import sets the width its file's size implies.
