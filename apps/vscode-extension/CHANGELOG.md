# gba-kit-vscode

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
  - @gba-kit/debug-adapter@0.9.0
  - @gba-kit/debug-ui@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [b61449b]
- Updated dependencies [e4b0be4]
- Updated dependencies [9cc6253]
  - @gba-kit/debug-adapter@0.8.0
  - @gba-kit/debug-ui@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [2176949]
- Updated dependencies [2176949]
  - @gba-kit/debug-adapter@0.7.0
  - @gba-kit/debug-ui@0.7.0
