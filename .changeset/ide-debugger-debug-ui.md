---
'@gba-kit/debug-ui': minor
---

New package: the debugger panels an editor has no native view for, as React components over a `Transport` seam, so one implementation serves a VS Code webview and a web page alike.

- **Screen** with keyboard and gamepad input (sent as one button mask so the two never fight), audio through an `AudioWorklet` fed from a queue of sample chunks, and a transport bar: run/pause, frame step, rewind, record (a stopped recording opens the Recording tab through the transport's `showPanel`).
- **Palette**, **Tiles** (any character base, 4/8 bpp, palette bank), **Tilemap** (rendered from the map and its tiles, with per-entry inspection), **Sprites** (a table of OAM with a painted preview of each, 1D and 2D mapping), **I/O registers** (decoded fields, filterable), **Trace** and **Events** (the instruction trace and the hardware event log), **Memory search** (search and narrow), **Labels** (edit, import `.sym`, export), **Save states** (each shown as the screen it was saved on, to load, rename or delete) and **Recording** (record, replay, open as a script). The Screen panel carries the same save states as a drawer beneath the display. Actions are drawn with VS Code's own icons (the codicon font), so the panels use the same glyph for the same idea as the editor around them.
- `DebugPanels` puts them behind tabs for a host with one slot.
- `createMessageTransport` / `serveTransport` speak `postMessage` between a webview and its host (a feed is unsubscribed once its last listener leaves, so frames and audio stop crossing to a panel that no longer shows them); `createSessionTransport` answers the same requests from an in-process `@gba-kit/debug-core` session. `@gba-kit/debug-ui/transport` exports the transport alone, for a host that bundles no React.
- Styled through `--gk-*` variables (`@gba-kit/debug-ui/styles.css`), so a host paints the panels in its own theme.
