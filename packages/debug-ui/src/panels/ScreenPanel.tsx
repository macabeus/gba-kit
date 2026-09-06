/**
 * The GBA screen: frames on a canvas, keyboard and gamepad into the machine,
 * audio when asked, and a transport bar an editor has no native buttons for
 * (frame step, rewind, record).
 */
import { AUDIO_SAMPLE_RATE } from '@gba-kit/debug-core/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AudioPlayer } from '../audio.js';
import { Button, Icon, attempt } from '../components.js';
import { useDebugState } from '../hooks.js';
import { KEYBOARD_HINT, buttonForKey, gamepadMask } from '../keys.js';
import type { Transport } from '../transport.js';
import { SaveStateDrawer } from './SaveStateDrawer.js';

export interface ScreenPanelProps {
  transport: Transport;
  /** CSS scale of the 240×160 canvas (default 2) */
  scale?: number;
  /** show the run/pause/frame/rewind/record bar (default true) */
  controls?: boolean;
  /** frames a "rewind" button goes back (default 60, one second) */
  rewindFrames?: number;
  /** offer an audio toggle (default true; needs a host that streams audio) */
  audio?: boolean;
  /** offer the save state drawer under the screen (default true) */
  saveStates?: boolean;
}

export function ScreenPanel({
  transport,
  scale = 2,
  controls = true,
  rewindFrames = 60,
  audio = true,
  saveStates = true,
}: ScreenPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useDebugState(transport);
  const [frame, setFrame] = useState(0);
  const [soundOn, setSoundOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const heldRef = useRef(0);
  const padRef = useRef(0);
  const sentRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    canvas.width = 240;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const image = ctx.createImageData(240, 160);
    return transport.onFrame((rgba, n) => {
      image.data.set(rgba.subarray(0, image.data.length));
      ctx.putImageData(image, 0, 0);
      if (n >= 0) {
        setFrame(n);
      }
    });
  }, [transport]);

  // keyboard and gamepad → buttons, as one mask so the two never fight
  const sendMask = useCallback(() => {
    const mask = heldRef.current | padRef.current;
    if (mask !== sentRef.current) {
      sentRef.current = mask;
      void transport.request('gba-kit/buttons', { mask }).catch(() => {});
    }
  }, [transport]);

  const onKey = useCallback(
    (e: React.KeyboardEvent, down: boolean) => {
      const button = buttonForKey(e.key);
      if (button < 0) {
        return;
      }
      e.preventDefault();
      const bit = 1 << button;
      heldRef.current = down ? heldRef.current | bit : heldRef.current & ~bit;
      sendMask();
    },
    [sendMask],
  );

  const onBlur = useCallback(() => {
    heldRef.current = 0;
    sendMask();
  }, [sendMask]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) {
      return;
    }
    let raf = 0;
    const poll = (): void => {
      let mask = 0;
      for (const pad of navigator.getGamepads()) {
        if (pad) {
          mask |= gamepadMask(pad.buttons, pad.axes);
        }
      }
      if (mask !== padRef.current) {
        padRef.current = mask;
        sendMask();
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [sendMask]);

  useEffect(() => {
    if (!soundOn) {
      playerRef.current?.mute();
      return;
    }
    const player = (playerRef.current ??= new AudioPlayer());
    let sampleRate: number = AUDIO_SAMPLE_RATE;
    attempt(setError, player.start(sampleRate));
    return transport.onAudio((samples, rate) => {
      if (rate !== sampleRate) {
        sampleRate = rate;
        player.close();
        attempt(setError, player.start(rate));
      }
      player.push(samples);
    });
  }, [transport, soundOn]);

  useEffect(() => () => playerRef.current?.close(), []);

  const running = state?.state === 'running';
  const stopped = state?.state === 'stopped';
  const recording = state?.recording ?? false;

  /**
   * Stop a recording where it can be seen and replayed: the Recording tool panel
   * when the host has one, else an editor with its script.
   */
  const toggleRecording = async (): Promise<void> => {
    if (recording) {
      const { script, recording: log } = await transport.request('gba-kit/recordStop');
      if (transport.showPanel) {
        transport.showPanel('recording');
      } else {
        transport.openText?.(
          script,
          'javascript',
          `recording-${log.startFrame}-${log.startFrame + log.frames.length}.js`,
        );
      }
    } else {
      await transport.request('gba-kit/recordStart');
    }
  };

  return (
    <div className="gk-screen">
      <canvas
        ref={canvasRef}
        className="gk-screen-canvas"
        style={{ width: 240 * scale, height: 160 * scale }}
        tabIndex={0}
        onKeyDown={(e) => onKey(e, true)}
        onKeyUp={(e) => onKey(e, false)}
        onBlur={onBlur}
        aria-label="GBA screen; focus it to play with the keyboard"
      />
      {controls && (
        <div className="gk-row">
          {running ? (
            <Button onClick={() => attempt(setError, transport.control('pause'))} kind="primary">
              <Icon name="debug-pause" />
              Pause
            </Button>
          ) : (
            <Button onClick={() => attempt(setError, transport.control('continue'))} kind="primary" disabled={!stopped}>
              <Icon name="debug-continue" />
              Run
            </Button>
          )}
          <Button
            onClick={() => attempt(setError, transport.request('gba-kit/stepFrame'))}
            disabled={!stopped}
            title="Run to the end of this frame"
          >
            <Icon name="debug-step-over" />
            Frame
          </Button>
          <Button
            onClick={() => attempt(setError, transport.request('gba-kit/rewind', { frames: rewindFrames }))}
            disabled={state?.state !== 'stopped' || state.history.earliestFrame === null}
            title={`Rewind ${rewindFrames} frames`}
          >
            <Icon name="debug-step-back" />
            Rewind
          </Button>
          <Button
            onClick={() => attempt(setError, toggleRecording())}
            active={recording}
            title="Record the buttons you press as a script"
          >
            <Icon name={recording ? 'debug-stop' : 'record'} />
            {recording ? 'Stop recording' : 'Record'}
          </Button>
          {audio && (
            <Button
              onClick={() => setSoundOn((v) => !v)}
              kind="icon"
              active={soundOn}
              title="Sound"
              label={soundOn ? 'Mute sound' : 'Unmute sound'}
            >
              <Icon name={soundOn ? 'unmute' : 'mute'} />
            </Button>
          )}
        </div>
      )}
      <div className="gk-status">
        <span className={state ? `gk-state-${state.state}` : ''}>{state?.state ?? 'connecting'}</span>
        {' · frame '}
        {state?.state === 'stopped' ? state.frame : frame}
        {state && (
          <>
            {' · pc '}
            <span className="gk-mono">0x{(state.pc >>> 0).toString(16).padStart(8, '0')}</span>
          </>
        )}
        {recording && <span className="gk-bad"> · recording</span>}
        {error && <span className="gk-bad"> · {error}</span>}
      </div>
      <div className="gk-hint">Click the screen, then: {KEYBOARD_HINT}</div>
      {saveStates && <SaveStateDrawer transport={transport} stopped={stopped} />}
    </div>
  );
}
