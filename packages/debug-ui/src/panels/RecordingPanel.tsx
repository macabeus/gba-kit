import type { TakeBody } from '@gba-kit/debug-core/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Empty } from '../components.js';
import { useDebugState } from '../hooks.js';
import { base64ToBytes } from '../render.js';
import type { Transport } from '../transport.js';

/**
 * Record the buttons pressed, and keep every recording of the session as a row: the
 * screen it begins on, the script it amounts to, and the two ways to press it again.
 * A replay plays back at the speed it was recorded, so it is watched on the screen
 * rather than jumped through. The rows come from the session, so a recording stopped
 * anywhere (this panel, the Screen panel's button, an editor command) appears here.
 */
export function RecordingPanel({ transport }: { transport: Transport }) {
  const state = useDebugState(transport);
  const [takes, setTakes] = useState<TakeBody[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recording = state?.recording ?? false;
  const replaying = state?.replaying ?? false;
  const stopped = state?.state === 'stopped';
  const connected = state !== null;

  // The session's recordings, refreshed when one ends. There is nothing to ask
  // for before a session reports itself, and this refresh happens on its own rather
  // than because the user asked, so a failure leaves the list as it is instead of
  // writing to the error line, which reports what the user just did.
  const refresh = useCallback(() => {
    transport
      .request('gba-kit/recordings')
      .then((b) => setTakes(b.takes))
      .catch(() => {});
  }, [transport]);
  useEffect(() => {
    if (recording || !connected) {
      return;
    }
    refresh();
  }, [refresh, recording, connected]);

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
    act(async () => {
      if (recording) {
        await transport.request('gba-kit/recordStop');
        refresh();
      } else {
        await transport.request('gba-kit/recordStart');
      }
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
        <Button onClick={() => void toggle()} kind={recording ? 'danger' : 'primary'} disabled={busy}>
          {recording ? '■ Stop recording' : '● Record inputs'}
        </Button>
        <span className="gk-muted gk-small">
          {replaying
            ? 'playing a recording back…'
            : recording
              ? `recording since frame ${state?.history.recordingStart ?? '…'}`
              : takes.length === 0
                ? 'Press Record, play, press Stop.'
                : `${takes.length} recording${takes.length === 1 ? '' : 's'} this session`}
        </span>
      </div>
      {error && (
        <span className="gk-bad gk-small" style={{ padding: '0 10px' }}>
          {error}
        </span>
      )}
      {takes.length === 0 ? (
        <Empty>Recordings of this session are listed here, with the screen each begins on.</Empty>
      ) : (
        <div className="gk-fill" style={{ overflow: 'auto' }}>
          <RecordingsView
            takes={takes}
            disabled={!stopped || busy}
            onReplay={(take, from) => void replay(take, from)}
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
  onReplay,
  onOpenScript,
}: {
  takes: TakeBody[];
  disabled?: boolean;
  onReplay(take: TakeBody, from: 'start' | 'here'): void;
  /** absent when the host has nowhere to open a script */
  onOpenScript?: (take: TakeBody) => void;
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
              <Thumbnail take={take} />
              <div className="gk-muted gk-small">
                frame {take.recording.startFrame} · {take.recording.frames.length} frames
              </div>
            </td>
            <td style={{ position: 'relative', width: '100%' }}>
              <pre className="gk-pre gk-script">{take.script}</pre>
              {onOpenScript && (
                <button
                  type="button"
                  className="gk-button gk-float"
                  title="Open the script in an editor"
                  onClick={() => onOpenScript(take)}
                >
                  ⧉
                </button>
              )}
            </td>
            <td>
              <div className="gk-col" style={{ gap: 4 }}>
                <Button
                  onClick={() => onReplay(take, 'start')}
                  disabled={disabled}
                  title={`Rewind to frame ${take.recording.startFrame} and play the same buttons back from there`}
                >
                  ↻ From where recorded
                </Button>
                <Button
                  onClick={() => onReplay(take, 'here')}
                  disabled={disabled}
                  title="Play the same buttons back from where the machine is now"
                >
                  ▸ From here
                </Button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The screen a recording begins on, painted from its base64 RGBA. */
function Thumbnail({ take }: { take: TakeBody }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      return;
    }
    canvas.width = take.width;
    canvas.height = take.height;
    const image = ctx.createImageData(take.width, take.height);
    image.data.set(base64ToBytes(take.thumbnail));
    ctx.putImageData(image, 0, 0);
  }, [take]);
  return (
    <canvas
      ref={canvasRef}
      className="gk-pixels"
      style={{ width: take.width * 2, height: take.height * 2 }}
      aria-label={`the screen at frame ${take.recording.startFrame}`}
    />
  );
}
