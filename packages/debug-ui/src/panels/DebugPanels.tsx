/** Every tool panel behind tabs: what a host with one slot for "the GBA tools" shows. */
import { useState } from 'react';

import { Tabs } from '../components.js';
import type { Transport } from '../transport.js';
import { EventsPanel } from './EventsPanel.js';
import { IoRegistersPanel } from './IoRegistersPanel.js';
import { LabelsPanel } from './LabelsPanel.js';
import { MemorySearchPanel } from './MemorySearchPanel.js';
import { PalettePanel } from './PalettePanel.js';
import { RecordingPanel } from './RecordingPanel.js';
import { SaveStatesPanel } from './SaveStatesPanel.js';
import { ScreenPanel } from './ScreenPanel.js';
import { SpritesPanel } from './SpritesPanel.js';
import { TilemapPanel } from './TilemapPanel.js';
import { TilesPanel } from './TilesPanel.js';
import { TracePanel } from './TracePanel.js';

export type PanelId =
  | 'screen'
  | 'io'
  | 'palette'
  | 'tiles'
  | 'tilemap'
  | 'sprites'
  | 'trace'
  | 'events'
  | 'search'
  | 'labels'
  | 'states'
  | 'recording';

export const PANELS: ReadonlyArray<{ id: PanelId; label: string }> = [
  { id: 'screen', label: 'Screen' },
  { id: 'io', label: 'I/O' },
  { id: 'palette', label: 'Palette' },
  { id: 'tiles', label: 'Tiles' },
  { id: 'tilemap', label: 'Tilemap' },
  { id: 'sprites', label: 'Sprites' },
  { id: 'trace', label: 'Trace' },
  { id: 'events', label: 'Events' },
  { id: 'search', label: 'Memory search' },
  { id: 'labels', label: 'Labels' },
  { id: 'states', label: 'States' },
  { id: 'recording', label: 'Recording' },
];

export function DebugPanels({
  transport,
  panels = PANELS.map((p) => p.id),
  initial,
  onChange,
}: {
  transport: Transport;
  /** which tabs to offer, in order */
  panels?: PanelId[];
  initial?: PanelId;
  onChange?: (panel: PanelId) => void;
}) {
  const [active, setActive] = useState<PanelId>(initial ?? panels[0] ?? 'screen');
  const tabs = PANELS.filter((p) => panels.includes(p.id));
  const select = (id: PanelId): void => {
    setActive(id);
    onChange?.(id);
  };
  return (
    <div className="gk-tabbed gk-root">
      <Tabs tabs={tabs} active={active} onChange={select} />
      <div className="gk-tab-body">
        <PanelBody id={active} transport={transport} />
      </div>
    </div>
  );
}

export function PanelBody({ id, transport }: { id: PanelId; transport: Transport }) {
  switch (id) {
    case 'screen':
      return (
        <div style={{ padding: 8 }}>
          <ScreenPanel transport={transport} />
        </div>
      );
    case 'io':
      return <IoRegistersPanel transport={transport} />;
    case 'palette':
      return <PalettePanel transport={transport} />;
    case 'tiles':
      return <TilesPanel transport={transport} />;
    case 'tilemap':
      return <TilemapPanel transport={transport} />;
    case 'sprites':
      return <SpritesPanel transport={transport} />;
    case 'trace':
      return <TracePanel transport={transport} />;
    case 'events':
      return <EventsPanel transport={transport} />;
    case 'search':
      return <MemorySearchPanel transport={transport} />;
    case 'labels':
      return <LabelsPanel transport={transport} />;
    case 'states':
      return <SaveStatesPanel transport={transport} />;
    case 'recording':
      return <RecordingPanel transport={transport} />;
  }
}
