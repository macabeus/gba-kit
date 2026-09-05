# @gba-kit/debug-ui

The debugger panels an editor has no native view for, as React components:

| Panel               | What it shows                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `ScreenPanel`       | the display; keyboard and gamepad input; audio; run/pause, frame step, rewind, record           |
| `PalettePanel`      | the 256 background and 256 sprite colors, with index, RGB and BGR555 of the one under the mouse |
| `TilesPanel`        | the tiles of any character base at 4 or 8 bpp, painted with a palette bank                      |
| `TilemapPanel`      | a background's map rendered from its tiles, with the entry under the mouse                      |
| `SpritesPanel`      | OAM as a table, each sprite painted, in 1D or 2D mapping                                        |
| `IoRegistersPanel`  | every modelled I/O register with its decoded fields                                             |
| `TracePanel`        | the instruction trace ring                                                                      |
| `EventsPanel`       | the hardware event log: VBlank, HBlank, interrupts, DMA, I/O writes, halts                      |
| `MemorySearchPanel` | find a value in RAM and narrow the candidates as it changes                                     |
| `LabelsPanel`       | names for addresses the ELF does not name; import `.sym` files, export                          |
| `SaveStatesPanel`   | save and load states                                                                            |
| `RecordingPanel`    | record the buttons pressed, replay them, read them as a script                                  |

`DebugPanels` puts them behind tabs. Everything talks to the debugger through a
`Transport`: the VS Code extension implements it with `postMessage` to the
extension host (`createMessageTransport` on the webview side, `serveTransport`
on the host side — importable alone from `@gba-kit/debug-ui/transport`, so a
host that only routes messages bundles no React), the webapp with direct calls
into a `@gba-kit/debug-core` session (`createSessionTransport`). The panels never know which. The request
vocabulary is `@gba-kit/debug-core/protocol`; the panels never touch the Node
debug adapter. A transport may also offer `showPanel` — the Screen panel uses
it when a recording stops, so the Recording tab (which shows the session's
last recording, whoever stopped it) comes up instead of a text editor.

## Usage

```tsx
import { DebugPanels, ScreenPanel, createSessionTransport } from '@gba-kit/debug-ui';
import '@gba-kit/debug-ui/styles.css';

const transport = createSessionTransport(session); // a @gba-kit/debug-core Session

<div className="gk-root">
  <ScreenPanel transport={transport} scale={3} />
  <DebugPanels transport={transport} panels={['io', 'palette', 'tiles', 'sprites']} />
</div>;
```

The stylesheet is driven by `--gk-*` custom properties declared on `.gk-root`
(background, foreground, accent, fonts). A host paints the panels in its theme
by overriding them; the VS Code extension maps them to `--vscode-*` colors.

## Develop

```bash
pnpm --filter @gba-kit/debug-ui build
pnpm --filter @gba-kit/debug-ui test
```

The tests need no browser: the transport plumbing, the pixel helpers, the key
maps and the presentational views (rendered to HTML) are checked in Node, and
the in-process transport is exercised against a real session on the
`@gba-kit/debug-core` fixtures.
