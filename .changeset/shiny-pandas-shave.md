---
'@gba-kit/debug-core': minor
'@gba-kit/debug-info': minor
'@gba-kit/debug-adapter': minor
'@gba-kit/debug-ui': minor
'gba-kit-vscode': minor
---

Find the variable behind a feature by capturing RAM and comparing the captures

The `Memory search` tab becomes `Memory diff`, at the same panel id. Searching for a
value is still one of its modes; the rest of it asks a question an exact value cannot.
Take a capture with the menu on item A, move to item B, capture, move back, capture —
tag them `A B A` — and ask for the addresses that are equal wherever the tags are equal
and different wherever they differ. Everything that merely moves fails that on the first
pair sharing a tag. On Klonoa's save-file screen it takes 294,912 addresses to 39 in
17 ms, and the cursor is the top-ranked row.

Captures live in the session and nowhere else: they are never written under `.gba-kit/`,
and the 288 KB of RAM each holds never crosses to a client, which gets the counts, the
groups and a page of rows. A save state can be adopted as a capture, since a state
already carries both RAM regions.

Results are grouped by what holds them, in three tiers the panel keeps visually
distinct: an object the program states an extent for (with its typed member path,
`gEntityInfo[13].xPosBg2`), a symbol in the same memory that is only the nearest one
below, and an address nothing names. `placementAt` in `@gba-kit/debug-info` is the new
inverse of the expression walk that works those out.

Background noise is muted by address range and never by name: run a few idle frames and
whatever moves on its own is churn, watch the DMA in the same run and every RAM range
copied into VRAM, OAM or palette names itself a shadow buffer. Every mute is a listed,
reversible row carrying the bytes it hid.

`gba-kit/searchMemory` and `gba-kit/filterMemory` are unchanged and still answered; the
new engine's exact-value mode is the same implementation reached another way. The new
requests are `gba-kit/captures`, `capture`, `retagCapture`, `forgetCapture`,
`discoverNoise`, `mutes`, `setMute`, `diffPreview`, `diffFilter` and `breakOnWrite`.
