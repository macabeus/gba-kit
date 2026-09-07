/**
 * The save states of this ROM as a table: the screen each was saved on, where it
 * was saved from, and what can be done with it. A save state is the whole machine
 * at a moment, not the game's own battery save.
 */
import type { SavedStateInfo } from '@gba-kit/debug-core/protocol';
import { useState } from 'react';

import { Button, EditableName, Empty, Icon } from '../components.js';
import { useDebugState, useSaveStates } from '../hooks.js';
import type { Transport } from '../transport.js';
import { SaveStateActions, SaveStateScreen, useRenaming } from './save-states.js';

export function SaveStatesPanel({ transport }: { transport: Transport }) {
  const state = useDebugState(transport);
  const saves = useSaveStates(transport);
  const [name, setName] = useState('');
  const stopped = state?.state === 'stopped';

  const save = (): void => {
    void saves.save(name).then(() => setName(''));
  };

  return (
    <div className="gk-col">
      <div className="gk-row gk-controls">
        <input
          className="gk-input gk-fill"
          placeholder={`name (default: frame-${state?.frame ?? 0})`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <Button onClick={save} kind="primary" disabled={!stopped || saves.busy}>
          <Icon name="add" />
          Save state
        </Button>
        <Button kind="icon" onClick={saves.refresh} title="Refresh" label="Refresh the list">
          <Icon name="refresh" />
        </Button>
      </div>
      {saves.error && <span className="gk-bad gk-small gk-note">{saves.error}</span>}
      {saves.states.length === 0 ? (
        <Empty>No save states for this ROM. They live under the project's .gba-kit/states/.</Empty>
      ) : (
        <table className="gk-table">
          <thead>
            <tr>
              <th>screen</th>
              <th>name</th>
              <th className="gk-right">frame</th>
              <th>saved</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {saves.states.map((s) => (
              <SaveStateRow key={s.path} state={s} saves={saves} disabled={!stopped || saves.busy} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SaveStateRow({
  state,
  saves,
  disabled,
}: {
  state: SavedStateInfo;
  saves: ReturnType<typeof useSaveStates>;
  disabled: boolean;
}) {
  const [renaming, rename, done] = useRenaming();

  return (
    <tr>
      <td>
        <SaveStateScreen state={state} scale={1} />
      </td>
      <td>
        <EditableName
          name={state.name}
          editing={renaming}
          onStop={done}
          onRename={(to) => void saves.rename(state, to)}
        />
      </td>
      <td className="gk-right gk-muted">{state.frame}</td>
      <td className="gk-muted">{state.createdAt ? new Date(state.createdAt).toLocaleString() : ''}</td>
      <td>
        <div className="gk-row">
          <Button onClick={() => void saves.load(state)} disabled={disabled}>
            <Icon name="debug-restart" />
            Load
          </Button>
          <SaveStateActions
            name={state.name}
            busy={saves.busy}
            onRename={rename}
            onRemove={() => void saves.remove(state)}
          />
        </div>
      </td>
    </tr>
  );
}
