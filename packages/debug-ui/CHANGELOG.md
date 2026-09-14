# @gba-kit/debug-ui

## 0.8.0

### Minor Changes

- e4b0be4: Import a `.sav` file as a save state, and export the cartridge's save as one.

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
  the save as data. That covers 1 Mbit flash too, which would also need bank
  switching the single 64 KB window has no room for.

  An export is the size the cartridge really has: 32768 bytes for SRAM, and 512 or
  8192 for EEPROM according to the width the game addressed with, not the 8 KB the
  array always occupies. An EEPROM the game has not read or written yet has told
  nobody which of the two it is, so exporting one is refused rather than guessed —
  run the game until it touches its save, or import a `.sav` first.

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

### Patch Changes

- Updated dependencies [b61449b]
- Updated dependencies [e4b0be4]
- Updated dependencies [9cc6253]
  - @gba-kit/debug-core@0.8.0

## 0.7.0

### Minor Changes

- 2176949: New package: the debugger panels an editor has no native view for, as React components over a `Transport` seam, so one implementation serves a VS Code webview and a web page alike.
  - **Screen** with keyboard and gamepad input (sent as one button mask so the two never fight), audio through an `AudioWorklet` fed from a queue of sample chunks, and a transport bar: run/pause, frame step, rewind, record (a stopped recording opens the Recording tab through the transport's `showPanel`).
  - **Palette**, **Tiles** (any character base, 4/8 bpp, palette bank), **Tilemap** (rendered from the map and its tiles, with per-entry inspection), **Sprites** (a table of OAM with a painted preview of each, 1D and 2D mapping), **I/O registers** (decoded fields, filterable), **Trace** and **Events** (the instruction trace and the hardware event log), **Memory search** (search and narrow), **Labels** (edit, import `.sym`, export), **Save states** (each shown as the screen it was saved on, to load, rename or delete) and **Recording** (record, replay, open as a script, delete; recordings the project kept are listed with the ones made now). The Screen panel carries the same save states as a drawer beneath the display. Actions are drawn with VS Code's own icons (the codicon font), so the panels use the same glyph for the same idea as the editor around them.
  - `DebugPanels` puts them behind tabs for a host with one slot.
  - `createMessageTransport` / `serveTransport` speak `postMessage` between a webview and its host (a feed is unsubscribed once its last listener leaves, so frames and audio stop crossing to a panel that no longer shows them); `createSessionTransport` answers the same requests from an in-process `@gba-kit/debug-core` session. `@gba-kit/debug-ui/transport` exports the transport alone, for a host that bundles no React.
  - Styled through `--gk-*` variables (`@gba-kit/debug-ui/styles.css`), so a host paints the panels in its own theme.

### Patch Changes

- Updated dependencies [2176949]
- Updated dependencies [2176949]
  - @gba-kit/debug-core@0.7.0
