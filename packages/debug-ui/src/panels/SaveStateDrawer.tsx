/**
 * The save states of this ROM under the screen, as the screens they were saved on.
 * Collapsed it is one bar; open it is a strip of cards, newest first, each of which
 * loads, renames or deletes the state it shows.
 */
import { useState } from 'react';

import { Button, Icon, Menu } from '../components.js';
import { useSaveStates } from '../hooks.js';
import type { Transport } from '../transport.js';
import { SaveStatesView } from './save-states.js';

export function SaveStateDrawer({ transport, stopped }: { transport: Transport; stopped: boolean }) {
  const saves = useSaveStates(transport);
  const [open, setOpen] = useState(false);

  const newSave = (): void => {
    void saves.save().then(() => setOpen(true));
  };

  /**
   * A `.sav` becomes a state the same way the button beside it does: added, then the
   * drawer opened on it. Neither it nor the export is gated on `stopped` — the import
   * builds its snapshot on a machine of its own and the export reads copies of the
   * backing arrays, so neither borrows the machine's execution.
   */
  const items = [
    transport.pickFile && {
      label: 'Import from a .sav file',
      onSelect: () =>
        void saves.importSave(transport.pickFile!).then((added) => {
          if (added) {
            setOpen(true);
          }
        }),
    },
    transport.saveFile && {
      label: 'Export to a .sav file',
      onSelect: () => void saves.exportSave(transport.saveFile!),
    },
  ].filter((item) => item !== undefined);

  return (
    <div className="gk-drawer">
      <div className="gk-row">
        <button
          type="button"
          className="gk-drawer-bar"
          // states are saved from the tool panel and the editor too: read them again on the way open
          onClick={() => {
            if (!open) {
              saves.refresh();
            }
            setOpen(!open);
          }}
          aria-expanded={open}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span>Save states ({saves.states.length})</span>
        </button>
        <Button onClick={newSave} disabled={!stopped || saves.busy} title="Save the machine as it is now">
          <Icon name="add" />
          Save state
        </Button>
        {items.length > 0 && <Menu label="More save state actions" items={items} disabled={saves.busy} />}
      </div>
      {saves.error && <span className="gk-bad gk-small">{saves.error}</span>}
      {open &&
        (saves.states.length === 0 ? (
          <span className="gk-muted gk-small">Press Save state to keep the machine as it is now.</span>
        ) : (
          <SaveStatesView
            states={saves.states}
            disabled={!stopped || saves.busy}
            busy={saves.busy}
            onLoad={(s) => void saves.load(s)}
            onRename={(s, to) => void saves.rename(s, to)}
            onRemove={(s) => void saves.remove(s)}
          />
        ))}
    </div>
  );
}
