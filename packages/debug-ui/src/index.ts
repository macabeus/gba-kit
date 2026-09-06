/**
 * @gba-kit/debug-ui — the debugger panels an editor has no native view for,
 * as React components over a `Transport`. A VS Code webview and a web page host
 * the same components; import `@gba-kit/debug-ui/styles.css` and set the
 * `--gk-*` variables to paint them in the host's theme.
 */
export {
  createMessageTransport,
  serveTransport,
  type ControlAction,
  type Feed,
  type HostToTransport,
  type MessagePort,
  type Transport,
  type TransportBackend,
  type TransportToHost,
  type Unsubscribe,
} from './transport.js';
export { createSessionTransport, type SessionTransportOptions } from './session-transport.js';
export { useAction, useAtStop, useDebugState, useFetched, usePixels, useSaveStates } from './hooks.js';
export {
  Button,
  EditableName,
  Empty,
  Hex,
  Icon,
  type IconName,
  MAX_ROWS,
  OmittedRow,
  Panel,
  Screenshot,
  Select,
  StampCells,
  StampHeader,
  Tabs,
  attempt,
  newest,
  parseNumber,
  tabIds,
} from './components.js';
export { AudioPlayer } from './audio.js';
export { BUTTONS, GAMEPAD, KEYBOARD, KEYBOARD_HINT, buttonForKey, gamepadMask } from './keys.js';
export { base64ToBytes, cssColor, hex, spriteToRgba, tilemapToRgba, tilesToRgba, unpackRgb } from './render.js';
export { ScreenPanel, type ScreenPanelProps } from './panels/ScreenPanel.js';
export { PalettePanel, PaletteView } from './panels/PalettePanel.js';
export { TilesPanel, paintTiles, type TileSheet } from './panels/TilesPanel.js';
export { MAP_TILES, TilemapPanel } from './panels/TilemapPanel.js';
export { SpritesPanel, SpritesView } from './panels/SpritesPanel.js';
export { IoRegistersPanel, IoRegistersView } from './panels/IoRegistersPanel.js';
export { TracePanel, TraceView } from './panels/TracePanel.js';
export { EventsPanel, EventsView, describeEvent } from './panels/EventsPanel.js';
export { MemorySearchPanel } from './panels/MemorySearchPanel.js';
export { LabelsPanel, LabelsView } from './panels/LabelsPanel.js';
export { SaveStateDrawer } from './panels/SaveStateDrawer.js';
export { SaveStatesView, type SaveStatesViewProps } from './panels/save-states.js';
export { SaveStatesPanel } from './panels/SaveStatesPanel.js';
export { RecordingPanel, RecordingsView } from './panels/RecordingPanel.js';
export { DebugPanels, PANELS, PanelBody, type PanelId } from './panels/DebugPanels.js';
