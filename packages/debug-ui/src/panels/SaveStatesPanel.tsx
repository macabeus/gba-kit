/**
 * The save states of this ROM as a table: the screen each was saved on, where it
 * was saved from, and what can be done with it. A save state is the whole machine
 * at a moment, not the game's own battery save.
 */
import type { SavedStateInfo } from '@gba-kit/debug-core/protocol';
import { useState } from 'react';

import { Button, Empty, Screenshot } from '../components.js';
import { useDebugState, useSaveStates } from '../hooks.js';
import type { Transport } from '../transport.js';

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
      <div className="gk-row" style={{ padding: '6px 10px 0' }}>
        <input
          className="gk-input gk-fill"
          placeholder={`name (default: frame-${state?.frame ?? 0})`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <Button onClick={save} kind="primary" disabled={!stopped || saves.busy}>
          Save state
        </Button>
        <Button onClick={saves.refresh}>Refresh</Button>
      </div>
      {saves.error && (
        <span className="gk-bad gk-small" style={{ padding: '0 10px' }}>
          {saves.error}
        </span>
      )}
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
  const [renaming, setRenaming] = useState<string | null>(null);

  const commit = (): void => {
    const to = (renaming ?? '').trim();
    setRenaming(null);
    if (to && to !== state.name) {
      void saves.rename(state, to);
    }
  };

  return (
    <tr>
      <td>
        {state.thumbnail && state.width && state.height ? (
          <Screenshot
            rgba={state.thumbnail}
            width={state.width}
            height={state.height}
            label={`the screen at frame ${state.frame}`}
          />
        ) : (
          <span className="gk-muted gk-small">no screen</span>
        )}
      </td>
      <td>
        {renaming === null ? (
          state.name
        ) : (
          <input
            className="gk-input"
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
      </td>
      <td className="gk-right gk-muted">{state.frame}</td>
      <td className="gk-muted">{state.createdAt ? new Date(state.createdAt).toLocaleString() : ''}</td>
      <td>
        <div className="gk-row">
          <Button onClick={() => void saves.load(state)} disabled={disabled}>
            Load
          </Button>
          <Button onClick={() => setRenaming(state.name)} disabled={saves.busy}>
            Rename
          </Button>
          <Button onClick={() => void saves.remove(state)} kind="danger" disabled={saves.busy}>
            Delete
          </Button>
        </div>
      </td>
    </tr>
  );
}
