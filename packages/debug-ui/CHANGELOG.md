# @gba-kit/debug-ui

## 0.9.0

### Minor Changes

- 8976097: Find the variable behind a feature by capturing RAM and comparing the captures

  The `Memory search` tab becomes `Memory diff`, at the same panel id. Take a capture with
  the menu on item A, move to item B, capture, move back, capture — then draw what the
  value did between them. The captures are a graph: nodes to place, and arrows carrying
  `changed`, `same`, `went up` or `went down`. A new capture arrives joined to the one
  before it, which is the run as it was played.

  An arrow is not obliged to join neighbours, and that is what does the work: between
  neighbours, "changed, then changed again" is what every churning byte does, so the `same`
  arrow back to the first capture is what separates the variable from the churn. Where a
  node sits says one thing only — the order the captures are read in, left to right, which
  is the order of the value columns under the graph.

  A query is a standing description of the run, not a step in a narrowing: it is answered
  against the whole address space every time, so loosening an arrow brings addresses back
  and the answer follows the graph as it is drawn. That is why there is no `Apply`, no
  `Preview` and no `Undo` — a pass over both regions costs tens of milliseconds, which is
  what makes recomputing affordable. A value can also be held against the capture that saw
  it, which is the exact-value search, now sayable for one capture of several. Links that
  cannot all hold — `①` up to `②`, `②` up to `③`, and `③` the same state as `①` — are
  refused by name rather than answered with no rows.

  A capture does not ask the machine to stop first: a run advances one frame per tick of
  the host's clock and a request is answered between them, so a running machine is read
  where it already is and the capture is of a whole frame either way. Looking for
  background noise still needs a stop, since it runs frames of its own and puts the machine
  back.

  A candidate is placed in one of four tiers, and the fourth is the one a decomp needs
  most: memory **a pointer reaches**. `gMenu->cursor` has no symbol of its own — the
  address exists only while `gMenu` holds that value — so no static lookup can ever name
  it. The pointers a program declares are read out of the captures instead, including
  the ones that live inside structs and arrays, and an address one of them covers is walked
  through the pointee's type like any object. A pointer is followed only where every
  capture agrees on its value: one that moved between them names different memory in each
  column, which is a name that is wrong somewhere. Only an object that declares an extent
  covering the address outranks a pointer aimed at it — the nearest symbol below is a
  landmark, which declares nothing about the address and so does not displace a name.

  **Break on write** on a result sets a watch, and the panel lists what is watched. The
  editor's Breakpoints view lists source and function breakpoints only — VS Code's extension
  API has no data breakpoint to add to it — so a watch set from a panel is shown by whoever
  set it or not at all. `gba-kit/watchpoints` answers what is watched and `gba-kit/unwatch`
  stops one, which also makes it visible when a DAP client replaces the list with its own.

  Captures live in the session and nowhere else: they are never written under `.gba-kit/`,
  and the 288 KB of RAM each holds never crosses to a client, which gets the counts, the
  groups and a page of rows. A save state can be adopted as a capture, since a state
  already carries both RAM regions. A session holds twenty of them — as many as there
  are circled numbers, ① to ⑳, to name them — and says so rather than taking a twenty-first.

  Results are grouped by what holds them, in four tiers the panel keeps visually
  distinct: an object the program states an extent for (with its typed member path,
  `gEnemies[3].x`), a pointer that reaches it (`gMenu->cursor`, shown with the address the
  columns were read from, since that name holds only while the pointer holds that value), a
  symbol in the same memory that is only the nearest one below, and an address nothing
  names. `placementAt` in `@gba-kit/debug-info` is the new
  inverse of the expression walk that works those out. The groups are read in the order
  ranking put their rows in, so the one holding the best candidate leads — a larger group
  of rows tied with it is a wider guess, not a better one.

  Background noise is muted by address range and never by name: run three hundred idle
  frames and whatever moves on its own is churn, watch the DMA in the same run and every
  RAM range copied into VRAM, OAM or palette names itself a shadow buffer, and watch the
  stack pointer to see how far below itself the abandoned call frames reach. How long that
  run is worth making is measured in what survives rather than in churn found: state that
  moves only now and then — a sound driver's per-note state, which changes at note
  boundaries — is found only if it moved while the baseline ran, and what it missed
  survives into the results. Three hundred frames is the default, and the panel also offers
  sixty and nine hundred.

  Every mute is a listed, reversible row carrying the bytes it hid, and it hides
  candidates where the result is reported rather than where it is found — so switching one
  on or off changes the result in front of you with no filter to run again.

  A row's own path is what it is _called_, not what it may be _named_: `Add as a label`
  takes the typed path only where the program states an extent covering the address _and
  the object it names begins there_, and turns it into an identifier
  (`gEnemies_3.x`), because a `.sym` line's name is a C identifier and a bracketed
  path would leave the project on export and never come back. Every byte of one `s32`
  carries the same path, so a row at a byte inside an object leads with its address and
  carries the path as a landmark (`0x03002921 in gEnemies[0].x + 0x1`), is
  labelled by its address, and is not formatted through a type that covers four bytes it
  does not — a value read at the object would say a row the filter kept as `same` had
  changed.

  Each row also offers `Watch` and `Break on write`. A watch is the typed path where the
  program names the address and a read of the row's own width (`u8(0x02001234)`) where it
  does not; it is an optional capability of the transport, the way `openText` is, so the
  VS Code host offers it and a host with no watch pane shows no such action.

  `gba-kit/searchMemory` and `gba-kit/filterMemory` are unchanged and still answered; the
  new engine reads values out of the captures rather than out of live memory. The new
  requests are `gba-kit/captures`, `capture`, `retagCapture`, `forgetCapture`,
  `discoverNoise`, `mutes`, `setMute`, `reorderCaptures`, `diffFilter` and `breakOnWrite`.
  `gba-kit/breakOnWrite` refuses an address in ROM, the BIOS or nothing at all, since a
  watch there verifies and then never fires, which reads as proof that nobody writes it.

### Patch Changes

- Updated dependencies [c736b5d]
- Updated dependencies [8976097]
  - @gba-kit/debug-core@0.9.0

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
