/**
 * How a save state is shown, wherever one is listed: as a card in the Screen panel's
 * drawer, or as a row in the Save states tab. Both offer the same two things beyond
 * loading it, so both take them from here.
 */
import type { SavedStateInfo } from '@gba-kit/debug-core/protocol';
import { useState } from 'react';

import { Button, EditableName, Icon, Screenshot } from '../components.js';

/** The screen a state was saved on, or where it sits when it was saved before states kept one. */
export function SaveStateScreen({ state, scale }: { state: SavedStateInfo; scale?: number }) {
  return state.thumbnail && state.width && state.height ? (
    <Screenshot
      rgba={state.thumbnail}
      width={state.width}
      height={state.height}
      scale={scale}
      label={`the screen at frame ${state.frame}`}
    />
  ) : (
    <span className="gk-muted gk-small">frame {state.frame}</span>
  );
}

/** Rename and delete, the two things every view of a state offers besides loading it. */
export function SaveStateActions({
  name,
  busy,
  onRename,
  onRemove,
}: {
  name: string;
  busy?: boolean;
  onRename(): void;
  onRemove(): void;
}) {
  return (
    <>
      <Button kind="icon" onClick={onRename} disabled={busy} title="Rename" label={`Rename '${name}'`}>
        <Icon name="edit" />
      </Button>
      <Button kind="icon danger" onClick={onRemove} disabled={busy} title="Delete" label={`Delete '${name}'`}>
        <Icon name="trash" />
      </Button>
    </>
  );
}

/** Whether this state's name is being edited, and the field for it. */
export function useRenaming(): [boolean, () => void, () => void] {
  const [editing, setEditing] = useState(false);
  return [editing, () => setEditing(true), () => setEditing(false)];
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
  const [renaming, rename, done] = useRenaming();
  return (
    <div className="gk-card">
      <button
        type="button"
        className="gk-card-screen"
        onClick={() => onLoad(state)}
        disabled={disabled}
        title={`Load '${state.name}' (frame ${state.frame})`}
      >
        <SaveStateScreen state={state} />
      </button>
      <EditableName
        name={state.name}
        editing={renaming}
        className="gk-card-name"
        onStop={done}
        onRename={(to) => onRename(state, to)}
      />
      <div className="gk-row gk-card-actions">
        <SaveStateActions name={state.name} busy={busy} onRename={rename} onRemove={() => onRemove(state)} />
      </div>
    </div>
  );
}
