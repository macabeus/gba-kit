import { EmulatorBridge, EmulatorState } from '@gba-kit/gba-browser';

import { InputRecorder } from '../../scripting';
import { CanvasGBA } from './CanvasGBA';
import { PlaySidePanel } from './PlaySidePanel';

interface PlayViewProps {
  emulator: EmulatorBridge;
  emuState: EmulatorState;
  recorder: InputRecorder;
  romData: ArrayBuffer | null;
  onRun: () => void;
  onPause: () => void;
  onRomLoad: (data: ArrayBuffer) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
}

export function PlayView({
  emulator,
  emuState,
  recorder,
  romData,
  onRun,
  onPause,
  onRomLoad,
  onStartRecording,
  onStopRecording,
}: PlayViewProps) {
  return (
    <div className="flex gap-6 items-start">
      <div className="flex-1">
        <CanvasGBA emulator={emulator} />
      </div>

      <PlaySidePanel
        emulator={emulator}
        emuState={emuState}
        recorder={recorder}
        romData={romData}
        onRun={onRun}
        onPause={onPause}
        onRomLoad={onRomLoad}
        onStartRecording={onStartRecording}
        onStopRecording={onStopRecording}
      />
    </div>
  );
}
