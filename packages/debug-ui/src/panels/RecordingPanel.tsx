import type { TakeBody } from '@gba-kit/debug-core/protocol';
import { useState } from 'react';

import { Button, Empty, Icon, Screenshot } from '../components.js';
import { useDebugState, useFetched } from '../hooks.js';
import type { Transport } from '../transport.js';

/**
 * Record the buttons pressed, and keep every recording of the session as a row: the
 * screen it begins on, the script it amounts to, and the two ways to press it again.
 * A replay plays back at the speed it was recorded, so it is watched on the screen
 * rather than jumped through. The rows come from the session, so a recording stopped
 * anywhere (this panel, the Screen panel's button, an editor command) appears here,
 * and so does one made in an earlier session, which the project keeps on disk.
 */
export function RecordingPanel({ transport }: { transport: Transport }) {
  const state = useDebugState(transport);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recording = state?.recording ?? false;
  const replaying = state?.replaying ?? false;
  const stopped = state?.state === 'stopped';

  // The session's recordings, re-read whenever one ends — here, from the Screen
  // panel's button, or from an editor command, since all three flip the same flag.
  // A read that fails is not reported: it happened on its own rather than because
  // the user asked, and the error line says what the user just did.
  const listed = useFetched(
    transport,
    (t) => t.request('gba-kit/recordings'),
    state === null || recording ? null : 'idle',
  );
  const takes = listed.data?.takes ?? [];

  const act = async (what: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await what();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (): Promise<void> =>
    act(() => transport.request(recording ? 'gba-kit/recordStop' : 'gba-kit/recordStart'));

  const remove = (take: TakeBody): Promise<void> =>
    act(async () => {
      await transport.request('gba-kit/deleteRecording', { id: take.id });
      listed.refresh();
    });

  const replay = (take: TakeBody, from: 'start' | 'here'): Promise<void> =>
    act(async () => {
      const { replayed } = await transport.request('gba-kit/replay', { recording: take.recording, from });
      if (!replayed) {
        throw new Error(`frame ${take.recording.startFrame} is no longer in history; replay it from here instead`);
      }
    });

  return (
    <div className="gk-col" style={{ height: '100%' }}>
      <div className="gk-row" style={{ padding: '6px 10px 0' }}>
        <Button onClick={() => void toggle()} kind="primary" active={recording} disabled={busy}>
          <Icon name={recording ? 'debug-stop' : 'record'} />
          {recording ? 'Stop recording' : 'Record inputs'}
        </Button>
        <span className="gk-muted gk-small">
          {replaying
            ? 'playing a recording back…'
            : recording
              ? `recording since frame ${state?.history.recordingStart ?? '…'}`
              : takes.length === 0
                ? 'Press Record, play, press Stop.'
                : `${takes.length} recording${takes.length === 1 ? '' : 's'} for this ROM`}
        </span>
      </div>
      {error && (
        <span className="gk-bad gk-small" style={{ padding: '0 10px' }}>
          {error}
        </span>
      )}
      {takes.length === 0 ? (
        <Empty>Recordings of this ROM are listed here, with the screen each begins on.</Empty>
      ) : (
        <div className="gk-fill" style={{ overflow: 'auto' }}>
          <RecordingsView
            takes={takes}
            disabled={!stopped || busy}
            busy={busy}
            onReplay={(take, from) => void replay(take, from)}
            onRemove={(take) => void remove(take)}
            onOpenScript={
              transport.openText
                ? (take) => transport.openText?.(take.script, 'javascript', `recording-${take.recording.startFrame}.js`)
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}

/** The recordings as a table: the screen each begins on, its script, and how to press it again. Newest first. */
export function RecordingsView({
  takes,
  disabled,
  busy,
  onReplay,
  onOpenScript,
  onRemove,
}: {
  takes: TakeBody[];
  /** replaying needs a stopped machine; deleting does not */
  disabled?: boolean;
  busy?: boolean;
  onReplay(take: TakeBody, from: 'start' | 'here'): void;
  /** absent when the host has nowhere to open a script */
  onOpenScript?: (take: TakeBody) => void;
  onRemove?: (take: TakeBody) => void;
}) {
  return (
    <table className="gk-table">
      <thead>
        <tr>
          <th>Thumbnail</th>
          <th>Script</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {[...takes].reverse().map((take) => (
          <tr key={take.id}>
            <td>
              <Screenshot
                rgba={take.thumbnail}
                width={take.width}
                height={take.height}
                scale={1}
                label={`the screen at frame ${take.recording.startFrame}`}
              />
              <div className="gk-muted gk-small">
                frame {take.recording.startFrame} · {take.recording.frames.length} frames
              </div>
              {take.createdAt && <div className="gk-muted gk-small">{new Date(take.createdAt).toLocaleString()}</div>}
            </td>
            <td style={{ position: 'relative', width: '100%' }}>
              <pre className="gk-pre gk-script">{take.script}</pre>
              {onOpenScript && (
                <span className="gk-float">
                  <Button
                    kind="icon"
                    title="Open the script in an editor"
                    label="Open the script in an editor"
                    onClick={() => onOpenScript(take)}
                  >
                    <Icon name="go-to-file" />
                  </Button>
                </span>
              )}
            </td>
            <td>
              <div className="gk-col" style={{ gap: 4 }}>
                <Button
                  onClick={() => onReplay(take, 'start')}
                  disabled={disabled}
                  title={`Rewind to frame ${take.recording.startFrame} and play the same buttons back from there`}
                >
                  <Icon name="debug-restart" />
                  From where recorded
                </Button>
                <Button
                  onClick={() => onReplay(take, 'here')}
                  disabled={disabled}
                  title="Play the same buttons back from where the machine is now"
                >
                  <Icon name="play" />
                  From here
                </Button>
                {onRemove && (
                  <span className="gk-row" style={{ justifyContent: 'flex-end' }}>
                    <Button
                      kind="icon danger"
                      onClick={() => onRemove(take)}
                      disabled={busy}
                      title="Delete"
                      label={`Delete the recording from frame ${take.recording.startFrame}`}
                    >
                      <Icon name="trash" />
                    </Button>
                  </span>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
