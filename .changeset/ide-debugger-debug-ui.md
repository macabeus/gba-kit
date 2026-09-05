---
'@gba-kit/debug-ui': minor
---

New package: the debugger panels an editor has no native view for, as React components over a `Transport` seam, so one implementation serves a VS Code webview and a web page alike.

- **Screen** with keyboard and gamepad input (sent as one button mask so the two never fight), audio through an `AudioWorklet` fed from a ring buffer, and a transport bar: run/pause, frame step, rewind, record.
- **Palette**, **Tiles** (any character base, 4/8 bpp, palette bank), **Tilemap** (rendered from the map and its tiles, with per-entry inspection), **Sprites** (a table of OAM with a painted preview of each, 1D and 2D mapping), **I/O registers** (decoded fields, filterable), **Trace** and **Events** (the instruction trace and the hardware event log), **Memory search** (search and narrow), **Labels** (edit, import `.sym`, export), **Save states** and **Recording** (record, replay, open as a script).
- `DebugPanels` puts them behind tabs for a host with one slot.
- `createMessageTransport` / `serveTransport` speak `postMessage` between a webview and its host; `createSessionTransport` answers the same requests from an in-process `@gba-kit/debug-core` session.
- Styled through `--gk-*` variables (`@gba-kit/debug-ui/styles.css`), so a host paints the panels in its own theme.
