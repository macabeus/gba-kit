import type { EmulatorBridge, EmulatorState } from '@gba-kit/gba-browser';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';

import { BreakpointPanel } from './BreakpointPanel';
import { CodeAtlasView } from './CodeAtlasView';
import { DisassemblyView } from './DisassemblyView';
import { IoRegisterView } from './IoRegisterView';
import { MemoryViewer } from './MemoryViewer';
import { RegisterView } from './RegisterView';
import { ScreenView } from './ScreenView';

interface DebugViewProps {
  emulator: EmulatorBridge;
  emuState: EmulatorState;
  onRun: () => void;
  onPause: () => void;
  onStep: () => void;
  onStepOver: () => void;
}

type CenterPanel = 'disassembly' | 'code-atlas';
type BottomRightPanel = 'breakpoints' | 'io-registers';

export function DebugView({ emulator, emuState, onRun, onPause, onStep, onStepOver }: DebugViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [centerPanel, setCenterPanel] = useState<CenterPanel>('disassembly');
  const [bottomRightPanel, setBottomRightPanel] = useState<BottomRightPanel>('breakpoints');
  const [breakpointVersion, setBreakpointVersion] = useState(0);
  const bumpBreakpoints = useCallback(() => setBreakpointVersion((v) => v + 1), []);

  useEffect(() => {
    if (canvasRef.current) {
      emulator.attachCanvas(canvasRef.current);
    }
    return () => {
      emulator.detachCanvas();
    };
  }, [emulator]);

  // Game input forwarding — allows playing the game while in debug mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => emulator.handleKeyDown(e);
    const handleKeyUp = (e: KeyboardEvent) => emulator.handleKeyUp(e);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [emulator]);

  // Debugger keyboard shortcuts (Ctrl+key to avoid browser conflicts)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle Ctrl+<key> combos for debugger actions
      if (!e.ctrlKey && !e.metaKey) {
        return;
      }
      switch (e.key) {
        case 'r':
          e.preventDefault();
          emuState === 'running' ? onPause() : onRun();
          break;
        case "'":
          e.preventDefault();
          if (emuState !== 'running') {
            onStep();
          }
          break;
        case ';':
          e.preventDefault();
          if (emuState !== 'running') {
            onStepOver();
          }
          break;
        case 'b': {
          e.preventDefault();
          const pc = emulator.cpu.registers[15]!;
          const bps = emulator.getBreakpoints();
          if (bps.some((bp) => bp.address === pc)) {
            emulator.removeBreakpoint(pc);
          } else {
            emulator.addBreakpoint(pc);
          }
          bumpBreakpoints();
          break;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [emulator, emuState, onRun, onPause, onStep, onStepOver, bumpBreakpoints]);

  const pc = emulator.cpu.registers[15]!;

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-140px)]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-2">
        {emuState === 'running' ? (
          <ToolbarButton onClick={onPause} label="Pause" shortcut="Ctrl+R" color="amber" />
        ) : (
          <ToolbarButton onClick={onRun} label="Run" shortcut="Ctrl+R" color="green" />
        )}
        <ToolbarButton onClick={onStep} label="Step" shortcut="Ctrl+'" color="blue" disabled={emuState === 'running'} />
        <ToolbarButton
          onClick={onStepOver}
          label="Step Over"
          shortcut="Ctrl+;"
          color="blue"
          disabled={emuState === 'running'}
        />
        <div className="ml-4 text-slate-500 text-xs mono">PC: 0x{pc.toString(16).padStart(8, '0')}</div>
      </div>

      {/* Main panels */}
      <div className="flex-1 grid grid-cols-[240px_1fr_280px] grid-rows-[1fr_1fr] gap-3 min-h-0">
        {/* Top-left: Screen */}
        <div className="row-span-1">
          <ScreenView canvasRef={canvasRef} />
        </div>

        {/* Top-center: Disassembly / Code Atlas */}
        <div className="row-span-2 min-h-0 flex flex-col">
          <div className="flex gap-1 mb-1">
            <PanelTab
              label="Disassembly"
              active={centerPanel === 'disassembly'}
              onClick={() => setCenterPanel('disassembly')}
            />
            <PanelTab
              label="Code Atlas"
              active={centerPanel === 'code-atlas'}
              onClick={() => setCenterPanel('code-atlas')}
            />
          </div>
          <div className="flex-1 min-h-0">
            {centerPanel === 'disassembly' ? (
              <DisassemblyView
                emulator={emulator}
                pc={pc}
                breakpointVersion={breakpointVersion}
                onBreakpointChange={bumpBreakpoints}
              />
            ) : (
              <CodeAtlasView pc={pc} hasMizuchiDb={window.__GBAKIT_CONFIG__?.hasMizuchiDb ?? false} />
            )}
          </div>
        </div>

        {/* Top-right: Registers */}
        <div className="row-span-1 min-h-0">
          <RegisterView emulator={emulator} />
        </div>

        {/* Bottom-left: I/O Registers */}
        <div className="row-span-1 min-h-0">
          <IoRegisterView emulator={emulator} />
        </div>

        {/* Bottom-right: Breakpoints or I/O detail */}
        <div className="row-span-1 min-h-0 flex flex-col">
          {/* Panel tabs */}
          <div className="flex gap-1 mb-1">
            <PanelTab
              label="Breakpoints"
              active={bottomRightPanel === 'breakpoints'}
              onClick={() => setBottomRightPanel('breakpoints')}
            />
            <PanelTab
              label="I/O Detail"
              active={bottomRightPanel === 'io-registers'}
              onClick={() => setBottomRightPanel('io-registers')}
            />
          </div>
          <div className="flex-1 min-h-0">
            {bottomRightPanel === 'breakpoints' ? (
              <BreakpointPanel
                emulator={emulator}
                breakpointVersion={breakpointVersion}
                onBreakpointChange={bumpBreakpoints}
              />
            ) : (
              <IoRegisterView emulator={emulator} />
            )}
          </div>
        </div>
      </div>

      {/* Bottom: Memory viewer */}
      <div className="h-48 min-h-0">
        <MemoryViewer emulator={emulator} />
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  label,
  shortcut,
  color,
  disabled = false,
}: {
  onClick: () => void;
  label: string;
  shortcut: string;
  color: 'green' | 'amber' | 'blue';
  disabled?: boolean;
}) {
  const colors = {
    green: 'bg-green-500/20 text-green-300 border-green-500/30 hover:bg-green-500/30',
    amber: 'bg-amber-500/20 text-amber-300 border-amber-500/30 hover:bg-amber-500/30',
    blue: 'bg-sky-500/20 text-sky-300 border-sky-500/30 hover:bg-sky-500/30',
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'px-3 py-1 rounded text-xs font-medium border transition-all',
        colors[color],
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      {label} <span className="text-slate-500 ml-1">{shortcut}</span>
    </button>
  );
}

function PanelTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'px-2 py-0.5 text-[10px] rounded transition-all',
        active ? 'bg-slate-700 text-slate-200' : 'text-slate-500 hover:text-slate-400 hover:bg-slate-800',
      )}
    >
      {label}
    </button>
  );
}
