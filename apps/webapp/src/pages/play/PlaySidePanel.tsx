import type { EmulatorBridge, EmulatorState } from '@gba-kit/gba-browser';
import clsx from 'clsx';
import { useCallback, useRef, useState } from 'react';

import { Icon, type IconName } from '../../components/Icon';
import type { InputRecorder } from '../../scripting';
import { ScriptRecorderPanel } from './ScriptRecorderPanel';

type SidePanelTab = 'controls' | 'recorder';

interface TabDef {
  id: SidePanelTab;
  label: string;
  icon: IconName;
}

const TABS: TabDef[] = [
  { id: 'controls', label: 'Controls', icon: 'settings' },
  { id: 'recorder', label: 'Recorder', icon: 'code' },
];

interface PlaySidePanelProps {
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

export function PlaySidePanel({
  emulator,
  emuState,
  recorder,
  romData,
  onRun,
  onPause,
  onRomLoad,
  onStartRecording,
  onStopRecording,
}: PlaySidePanelProps) {
  const [activeTab, setActiveTab] = useState<SidePanelTab>('controls');
  const [audioEnabled, setAudioEnabled] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          onRomLoad(reader.result);
        }
      };
      reader.readAsArrayBuffer(file);
    },
    [onRomLoad],
  );

  return (
    <div className="w-90 shrink-0 flex flex-col">
      {/* Tab bar */}
      <div className="flex border-b border-slate-700 bg-slate-800/50 rounded-t-lg">
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-medium transition-all',
                isActive
                  ? 'text-sky-300 border-b-2 border-sky-400 bg-slate-800/80'
                  : 'text-slate-400 hover:text-slate-200 border-b-2 border-transparent',
              )}
            >
              <Icon name={tab.icon} className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1">
        {activeTab === 'controls' && (
          <div className="p-4 flex flex-col gap-4">
            {/* Play / Pause */}
            <div className="flex items-center gap-3">
              {emuState === 'running' ? (
                <button
                  type="button"
                  onClick={onPause}
                  className="flex-1 px-6 py-2.5 bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-lg font-medium hover:bg-amber-500/30 transition-all"
                >
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onRun}
                  className="flex-1 px-6 py-2.5 bg-green-500/20 text-green-300 border border-green-500/30 rounded-lg font-medium hover:bg-green-500/30 transition-all"
                >
                  Run
                </button>
              )}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex-1 px-6 py-2.5 bg-slate-700/50 text-slate-300 border border-slate-600 rounded-lg font-medium hover:bg-slate-600/50 transition-all"
              >
                Load ROM
              </button>
              <input ref={fileInputRef} type="file" accept=".gba,.bin" onChange={handleFileChange} className="hidden" />
            </div>

            {/* Audio toggle */}
            <button
              type="button"
              onClick={() => {
                emulator.toggleAudio();
                setAudioEnabled(emulator.audioEnabled);
              }}
              className={clsx(
                'w-full px-4 py-2.5 rounded-lg font-medium text-sm border transition-all flex items-center justify-center gap-2',
                audioEnabled
                  ? 'bg-sky-500/20 text-sky-300 border-sky-500/30 hover:bg-sky-500/30'
                  : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-600/50',
              )}
            >
              <Icon name={audioEnabled ? 'volumeOn' : 'volumeOff'} className="w-4 h-4" />
              {audioEnabled ? 'Audio On' : 'Audio Off'}
            </button>

            {/* Key hints */}
            <div className="bg-slate-800/50 rounded-lg border border-slate-700 p-3">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-2">Keyboard Controls</div>
              <div className="grid grid-cols-2 gap-y-1.5 text-sm">
                <div>
                  <span className="text-slate-300 font-mono">Arrow keys</span>{' '}
                  <span className="text-slate-500">D-pad</span>
                </div>
                <div>
                  <span className="text-slate-300 font-mono">Z</span> <span className="text-slate-500">A</span>
                </div>
                <div>
                  <span className="text-slate-300 font-mono">X</span> <span className="text-slate-500">B</span>
                </div>
                <div>
                  <span className="text-slate-300 font-mono">Enter</span> <span className="text-slate-500">Start</span>
                </div>
                <div>
                  <span className="text-slate-300 font-mono">Backspace</span>{' '}
                  <span className="text-slate-500">Select</span>
                </div>
                <div>
                  <span className="text-slate-300 font-mono">A / S</span> <span className="text-slate-500">L / R</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'recorder' && (
          <ScriptRecorderPanel
            recorder={recorder}
            emulator={emulator}
            romData={romData}
            onStartRecording={onStartRecording}
            onStopRecording={onStopRecording}
          />
        )}
      </div>
    </div>
  );
}
