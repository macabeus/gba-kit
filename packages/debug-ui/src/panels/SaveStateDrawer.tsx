/**
 * The save states of this ROM under the screen, as the screens they were saved on.
 * Collapsed it is one bar; open it is a strip of cards, newest first, each of which
 * loads, renames or deletes the state it shows.
 */
import type { SavedStateInfo } from '@gba-kit/debug-core/protocol';
import { useState } from 'react';

import { Button, Screenshot } from '../components.js';
import { useSaveStates } from '../hooks.js';
import type { Transport } from '../transport.js';

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
          <span>Save states ({saves.states.length})</span>
          <span className={open ? 'gk-caret gk-caret-open' : 'gk-caret'}>▾</span>
        </button>
        <Button onClick={newSave} disabled={!stopped || saves.busy} title="Save the machine as it is now">
          + Save state
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

export interface SaveStatesViewProps {
  states: SavedStateInfo[];
  /** loading needs a stopped machine; renaming and deleting do not */
  disabled?: boolean;
  busy?: boolean;
  onLoad(state: SavedStateInfo): void;
  onRename(state: SavedStateInfo, to: string): void;
  onRemove(state: SavedStateInfo): void;
}

/** The states as cards, newest first: click a screen to load it back. */
export function SaveStatesView({ states, ...actions }: SaveStatesViewProps) {
  return (
    <div className="gk-cards">
      {[...states].reverse().map((s) => (
        <SaveStateCard key={s.path} state={s} {...actions} />
      ))}
    </div>
  );
}

function SaveStateCard({
  state,
  disabled,
  busy,
  onLoad,
  onRename,
  onRemove,
}: Omit<SaveStatesViewProps, 'states'> & { state: SavedStateInfo }) {
  const [renaming, setRenaming] = useState<string | null>(null);

  const commit = (): void => {
    const to = (renaming ?? '').trim();
    setRenaming(null);
    if (to && to !== state.name) {
      onRename(state, to);
    }
  };

  return (
    <div className="gk-card">
      <button
        type="button"
        className="gk-card-screen"
        onClick={() => onLoad(state)}
        disabled={disabled}
        title={`Load '${state.name}' (frame ${state.frame})`}
      >
        {state.thumbnail && state.width && state.height ? (
          <Screenshot
            rgba={state.thumbnail}
            width={state.width}
            height={state.height}
            label={`the screen at frame ${state.frame}`}
          />
        ) : (
          <span className="gk-muted gk-small">frame {state.frame}</span>
        )}
      </button>
      {renaming === null ? (
        <span className="gk-card-name" title={state.name}>
          {state.name}
        </span>
      ) : (
        <input
          className="gk-input gk-card-name"
          autoFocus
          value={renaming}
          onChange={(e) => setRenaming(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit();
            } else if (e.key === 'Escape') {
              setRenaming(null);
            }
          }}
        />
      )}
      <div className="gk-row gk-card-actions">
        <Button onClick={() => setRenaming(state.name)} disabled={busy} title="Rename">
          ✎
        </Button>
        <Button onClick={() => onRemove(state)} kind="danger" disabled={busy} title="Delete">
          🗑
        </Button>
      </div>
    </div>
  );
}
