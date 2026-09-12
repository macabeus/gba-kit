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
A flash cartridge is refused in both directions: gba-kit backs the cartridge with
plain memory and emulates no flash chip, so a game's identify sequence goes
unanswered and it never reads the save — while the command bytes it writes land in
the save as data.

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
  save at all. It now reads the SDK string the build embeds — word-aligned, with
  three version digits — and keeps it, so a message can name it.
- **A 64 Kbit EEPROM is read at the right addresses.** The address width was latched
  at 6 bits by the first six bits of any address and never revised, so a 64 Kbit
  cartridge read the wrong words for the rest of the run. The width now comes from the
  length of the read the game makes, which is what carries it. A write carries no
  length — 64 data bits follow the address with nothing to mark where it ended — so it
  still needs a width up front and takes 4 Kbit until a read has said otherwise, as
  before. An imported `.sav` says nothing about the width either: a 4 Kbit save padded
  out to 8 KB is a file some emulators write, so the cartridge's own first read settles
  it and the file's length only answers for how big an export is until then.
