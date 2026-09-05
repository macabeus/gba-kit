import type { RecordingBody } from '@gba-kit/debug-core/protocol';
import { useEffect, useState } from 'react';

import { Button, Empty } from '../components.js';
import { useDebugState } from '../hooks.js';
import type { Transport } from '../transport.js';

/**
 * Record the buttons pressed, keep the log, replay it, and read it as a script.
 * The recording shown is the session's last one, whoever stopped it (this panel,
 * the Screen panel's button, an editor command), fetched whenever a recording ends.
 */
export function RecordingPanel({ transport }: { transport: Transport }) {
  const state = useDebugState(transport);
  const [last, setLast] = useState<RecordingBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recording = state?.recording ?? false;
  const stopped = state?.state === 'stopped';

  // Not recording, now or on mount: whatever ended last is what to show. There is
  // nothing to ask for before a session reports itself, and this refresh happens on
  // its own rather than because the user asked, so a failure leaves the panel empty
  // instead of writing to the error line, which reports what the user just did.
  const connected = state !== null;
  useEffect(() => {
    if (recording || !connected) {
      return;
    }
    let cancelled = false;
    transport
      .request('gba-kit/lastRecording')
      .then((b) => {
        if (!cancelled) {
          setLast(b.last);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [transport, recording, connected]);

  const toggle = async (): Promise<void> => {
    try {
      if (recording) {
        setLast(await transport.request('gba-kit/recordStop'));
      } else {
        await transport.request('gba-kit/recordStart');
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const replay = async (): Promise<void> => {
    if (!last) {
      return;
    }
    try {
      const { replayed } = await transport.request('gba-kit/replay', { recording: last.recording });
      setError(replayed ? null : 'the recording starts before the history kept; restart and replay from there');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="gk-col" style={{ padding: 8, height: '100%' }}>
      <div className="gk-row">
        <Button onClick={() => void toggle()} kind={recording ? 'danger' : 'primary'}>
          {recording ? '■ Stop recording' : '● Record inputs'}
        </Button>
        <Button
          onClick={() => void replay()}
          disabled={!last || !stopped}
          title="Rewind to where the recording started and press the same buttons again"
        >
          ↻ Replay
        </Button>
        {last && (
          <>
            <Button
              onClick={() =>
                transport.openText?.(last.script, 'javascript', `recording-${last.recording.startFrame}.js`)
              }
              disabled={!transport.openText}
            >
              Open as script
            </Button>
            <Button
              onClick={() =>
                transport.openText?.(
                  JSON.stringify(last.recording, null, 2),
                  'json',
                  `recording-${last.recording.startFrame}.json`,
                )
              }
              disabled={!transport.openText}
            >
              Open log
            </Button>
          </>
        )}
        <span className="gk-muted gk-small">
          {recording
            ? `recording since frame ${state?.history.recordingStart ?? '…'}`
            : last
              ? `${last.recording.frames.length} frames from frame ${last.recording.startFrame}`
              : 'Press Record, play, press Stop.'}
        </span>
      </div>
      {error && <span className="gk-bad gk-small">{error}</span>}
      {last ? (
        <pre className="gk-pre gk-fill">{last.script}</pre>
      ) : (
        <Empty>The script of the last recording shows here.</Empty>
      )}
    </div>
  );
}
