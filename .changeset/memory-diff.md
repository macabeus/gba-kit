---
'@gba-kit/debug-core': minor
'@gba-kit/debug-info': minor
'@gba-kit/debug-adapter': minor
'@gba-kit/debug-ui': minor
'gba-kit-vscode': minor
---

Find the variable behind a feature by capturing RAM and comparing the captures

The `Memory search` tab becomes `Memory diff`, at the same panel id. Take a capture with
the menu on item A, move to item B, capture, move back, capture — then draw what the
value did between them. The captures are a graph: nodes to place, and arrows carrying
`changed`, `same`, `went up`, `went down` or nothing at all. A new capture arrives joined
to the one before it, which is the run as it was played.

An arrow is not obliged to join neighbours, and that is what does the work: between
neighbours, "changed, then changed again" is what every churning byte does, so on
Klonoa's save-file screen with no muting a chain keeps 3,117 addresses where an arrow
back to the first capture keeps 90. Where a node sits says one thing only — the order the
captures are read in, left to right, which is the order of the value columns under the
graph.

With the noise baseline as well, the same three captures take 294,912 addresses to 4 in
29 ms, and the cursor leads them, the one row the panel calls `likely` — writing 0, 1 and 2 to it moves the highlight between
the three save slots, and a data breakpoint on it names `FileSelectScreenUpdateCursor`.

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

Captures live in the session and nowhere else: they are never written under `.gba-kit/`,
and the 288 KB of RAM each holds never crosses to a client, which gets the counts, the
groups and a page of rows. A save state can be adopted as a capture, since a state
already carries both RAM regions. A session holds twenty of them — as many as the strip
has circled numbers to name — and says so rather than taking a twenty-first.

Results are grouped by what holds them, in three tiers the panel keeps visually
distinct: an object the program states an extent for (with its typed member path,
`gEntityInfo[13].xPosBg2`), a symbol in the same memory that is only the nearest one
below, and an address nothing names. `placementAt` in `@gba-kit/debug-info` is the new
inverse of the expression walk that works those out. The groups are read in the order
ranking put their rows in, so the one holding the best candidate leads — a larger group
of rows tied with it is a wider guess, not a better one.

Background noise is muted by address range and never by name: run three hundred idle
frames and whatever moves on its own is churn, watch the DMA in the same run and every
RAM range copied into VRAM, OAM or palette names itself a shadow buffer, and watch the
stack pointer to see how far below itself the abandoned call frames reach. How long that
run is worth making is measured in what survives rather than in churn found, and against
an ordering the panel does not control: the churn mask is 3,360 of its eventual 3,476
bytes by frame 60, but what it finds last is the mixer's per-note state, so a look only
covers the notes played while it ran. Sixty frames leave 3 candidates when the baseline
runs immediately before three back-to-back captures and 15 — 12 of them sound — when it
runs after them, or 8, 11 and 17 when a second, three or ten seconds pass between the
captures. Three hundred leave 3 in every one of those, at 1.2 s against 260 ms, so three
hundred is the default.

Every mute is a listed, reversible row carrying the bytes it hid, and it hides
candidates where the result is reported rather than where it is found — so switching one
on or off changes the result in front of you with no filter to run again.

A row's own path is what it is _called_, not what it may be _named_: `Add as a label`
takes the typed path only where the program states an extent covering the address _and
the object it names begins there_, and turns it into an identifier
(`gEntityInfo_3.xPosBg2`), because a `.sym` line's name is a C identifier and a bracketed
path would leave the project on export and never come back. Every byte of one `s32`
carries the same path, so a row at a byte inside an object leads with its address and
carries the path as a landmark (`0x03002921 in gEntityInfo[0].xPosBg2 + 0x1`), is
labelled by its address, and is not formatted through a type that covers four bytes it
does not — a value read at the object would say a row the filter kept as `unchanged` had
changed.

Each row also offers `Watch` and `Break on write`. A watch is the typed path where the
program names the address and a read of the row's own width (`u8(0x02000818)`) where it
does not; it is an optional capability of the transport, the way `openText` is, so the
VS Code host offers it and a host with no watch pane shows no such action.

`gba-kit/searchMemory` and `gba-kit/filterMemory` are unchanged and still answered; the
new engine reads values out of the captures rather than out of live memory. The new
requests are `gba-kit/captures`, `capture`, `retagCapture`, `forgetCapture`,
`discoverNoise`, `mutes`, `setMute`, `reorderCaptures`, `diffFilter` and `breakOnWrite`.
`gba-kit/breakOnWrite` refuses an address in ROM, the BIOS or nothing at all, since a
watch there verifies and then never fires, which reads as proof that nobody writes it.
