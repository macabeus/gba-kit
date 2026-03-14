import { useEmulator } from '@gba-kit/gba-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Header } from './components/Header';
import { SaveStateDrawer } from './components/SaveStateDrawer';
import { SegmentedControl, type SegmentedControlItem } from './components/SegmentedControl';
import { DebugView } from './pages/debug/DebugView';
import { LoadView } from './pages/load/LoadView';
import { PlayView } from './pages/play/PlayView';
import { InputRecorder } from './scripting';

type AppMode = 'play' | 'debug';

const modeItems: SegmentedControlItem<AppMode>[] = [
  { id: 'play', label: 'Play', icon: 'bolt' },
  { id: 'debug', label: 'Debug', icon: 'chip' },
];

export function App() {
  const [mode, setMode] = useState<AppMode>('play');
  const [romLoaded, setRomLoaded] = useState(false);
  const [romData, setRomData] = useState<ArrayBuffer | null>(null);
  const [romAutoLoading, setRomAutoLoading] = useState(false);
  const [, forceRender] = useState(0);

  const { emulator, state: emuState } = useEmulator({
    onFrame: () => {
      forceRender((n) => n + 1);
      recorderRef.current?.onFrame();
    },
    onBreakpoint: () => setMode('debug'),
  });

  // Lazily create the recorder
  const recorderRef = useRef<InputRecorder | null>(null);
  if (!recorderRef.current) {
    recorderRef.current = new InputRecorder();
  }
  const recorder = recorderRef.current;

  // Feed keyboard events to the recorder when recording
  useEffect(() => {
    if (recorder.state !== 'recording') {
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => recorder.onKeyDown(e.key);
    const handleKeyUp = (e: KeyboardEvent) => recorder.onKeyUp(e.key);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [recorder, recorder.state]);

  const handleRomLoad = useCallback(
    (data: ArrayBuffer) => {
      emulator.loadRom(data);
      setRomLoaded(true);
      setRomData(data);
    },
    [emulator],
  );

  // Auto-load ROM from server if configured
  useEffect(() => {
    const config = window.__GBAKIT_CONFIG__;
    if (!config?.hasRom || romLoaded) {
      return;
    }

    setRomAutoLoading(true);
    fetch('/api/loadRom')
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to load ROM: ${res.statusText}`);
        }
        return res.arrayBuffer();
      })
      .then((data) => {
        handleRomLoad(data);
      })
      .catch((err) => {
        console.error('Auto ROM load failed:', err);
      })
      .finally(() => {
        setRomAutoLoading(false);
      });
  }, [handleRomLoad, romLoaded]);

  const handleModeChange = useCallback(
    (newMode: AppMode) => {
      if (newMode !== 'play') {
        emulator.pause();
      }
      setMode(newMode);
    },
    [emulator],
  );

  const handleRun = useCallback(() => emulator.run(), [emulator]);
  const handlePause = useCallback(() => emulator.pause(), [emulator]);
  const handleStep = useCallback(() => emulator.stepInstruction(), [emulator]);
  const handleStepOver = useCallback(() => emulator.stepOver(), [emulator]);

  const handleStartRecording = useCallback(() => {
    recorder.start();
    emulator.run();
    forceRender((n) => n + 1);
  }, [recorder, emulator]);

  const handleStopRecording = useCallback(() => {
    recorder.stop();
    emulator.pause();
    forceRender((n) => n + 1);
  }, [recorder, emulator]);

  // Page content based on ROM loaded state and mode
  let content: React.ReactNode;

  if (!romLoaded) {
    content = <LoadView loading={romAutoLoading} onRomLoad={handleRomLoad} />;
  } else if (mode === 'play') {
    content = (
      <PlayView
        emulator={emulator}
        emuState={emuState}
        recorder={recorder}
        romData={romData}
        onRun={handleRun}
        onPause={handlePause}
        onRomLoad={handleRomLoad}
        onStartRecording={handleStartRecording}
        onStopRecording={handleStopRecording}
      />
    );
  } else {
    content = (
      <DebugView
        emulator={emulator}
        emuState={emuState}
        onRun={handleRun}
        onPause={handlePause}
        onStep={handleStep}
        onStepOver={handleStepOver}
      />
    );
  }

  return (
    <div className="min-h-screen p-4">
      <Header
        subtitle="GBA Emulation Workbench"
        rightContent={
          romLoaded ? <SegmentedControl items={modeItems} value={mode} onChange={handleModeChange} /> : null
        }
      />

      {content}

      {romLoaded && <SaveStateDrawer emulator={emulator} romData={romData} />}
    </div>
  );
}
