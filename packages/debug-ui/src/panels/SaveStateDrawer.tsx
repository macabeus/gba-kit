/**
 * The save states of this ROM under the screen, as the screens they were saved on.
 * Collapsed it is one bar; open it is a strip of cards, newest first, each of which
 * loads, renames or deletes the state it shows.
 */
import { useState } from 'react';

import { Button, Icon } from '../components.js';
import { useSaveStates } from '../hooks.js';
import type { Transport } from '../transport.js';
import { SaveStatesView } from './save-states.js';

export function SaveStateDrawer({ transport, stopped }: { transport: Transport; stopped: boolean }) {
  const saves = useSaveStates(transport);
  const [open, setOpen] = useState(false);

  const newSave = (): void => {
    void saves.save().then(() => setOpen(true));
  };

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
