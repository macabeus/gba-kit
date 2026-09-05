/**
 * The Debug page: a `@gba-kit/debug-core` session over the Play page's machine,
 * the views VS Code would render natively (disassembly, source, registers,
 * breakpoints, memory) built here, and the emulator views (screen, PPU, I/O,
 * trace, events, search, labels) from `@gba-kit/debug-ui`.
 */
import type { Session } from '@gba-kit/debug-core';
import { DebugPanels, ScreenPanel, createSessionTransport } from '@gba-kit/debug-ui';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { BreakpointPanel } from './BreakpointPanel';
import { DisassemblyView } from './DisassemblyView';
import { MemoryViewer } from './MemoryViewer';
import { RegisterView } from './RegisterView';
import { SourceView } from './SourceView';

interface DebugViewProps {
  session: Session | null;
  /** bumps on every stop, resume and machine change */
  revision: number;
  error: string | null;
  onElfLoad: (elf: Uint8Array) => void;
}

type CenterPanel = 'disassembly' | 'source';

/** Open text in a new tab: the webapp's stand-in for an editor. */
function openText(content: string, language: string): void {
  const url = URL.createObjectURL(
    new Blob([content], { type: language === 'json' ? 'application/json' : 'text/plain' }),
  );
  window.open(url, '_blank');
}

export function DebugView({ session, revision, error, onElfLoad }: DebugViewProps) {
  const [centerPanel, setCenterPanel] = useState<CenterPanel>('disassembly');
  const [breakpoints, setBreakpoints] = useState<number[]>([]);
  const transport = useMemo(() => (session ? createSessionTransport(session, { openText }) : null), [session]);

  // instruction breakpoints live in the session; this list is what the views draw
  useEffect(() => {
    session?.setInstructionBreakpoints(breakpoints.map((address) => ({ address })));
  }, [session, breakpoints]);

  const toggleBreakpoint = useCallback((address: number) => {
    setBreakpoints((list) =>
      list.includes(address) ? list.filter((a) => a !== address) : [...list, address].sort((a, b) => a - b),
    );
  }, []);

  const stopped = session?.state === 'stopped';
  const running = session?.state === 'running';

  // Debugger keyboard shortcuts (Ctrl+key to avoid browser conflicts)
  useEffect(() => {
    if (!session) {
      return;
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!e.ctrlKey && !e.metaKey) {
        return;
      }
      switch (e.key) {
        case 'r':
          e.preventDefault();
          session.state === 'running' ? session.pause() : session.state === 'stopped' && session.continue();
          break;
        case "'":
          e.preventDefault();
          if (session.state === 'stopped') {
            session.stepInstruction();
          }
          break;
        case ';':
          e.preventDefault();
          if (session.state === 'stopped') {
            session.stepOver();
          }
          break;
        case 'b':
          e.preventDefault();
          toggleBreakpoint(session.pc & ~1);
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session, toggleBreakpoint]);

  if (error) {
    return <div className="text-red-400 text-sm px-2 py-4">Could not start the debugger: {error}</div>;
  }
  if (!session || !transport) {
    return <div className="text-slate-500 text-sm px-2 py-4">Starting the debugger…</div>;
  }

  const pc = session.pc;
  const position = session.position;

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-140px)] gk-root">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-2 flex-wrap">
        {running ? (
          <ToolbarButton onClick={() => session.pause()} label="Pause" shortcut="Ctrl+R" color="amber" />
        ) : (
          <ToolbarButton
            onClick={() => session.continue()}
            label="Run"
            shortcut="Ctrl+R"
            color="green"
            disabled={!stopped}
          />
        )}
        <ToolbarButton
          onClick={() => session.stepInstruction()}
          label="Step"
          shortcut="Ctrl+'"
          color="blue"
          disabled={!stopped}
        />
        <ToolbarButton
          onClick={() => session.stepOver()}
          label="Step Over"
          shortcut="Ctrl+;"
          color="blue"
          disabled={!stopped}
        />
        <ToolbarButton onClick={() => session.stepInto()} label="Step Into" color="blue" disabled={!stopped} />
        <ToolbarButton onClick={() => session.stepOut()} label="Step Out" color="blue" disabled={!stopped} />
        <ToolbarButton onClick={() => session.stepBack()} label="Step Back" color="blue" disabled={!stopped} />
        <ToolbarButton onClick={() => session.stepFrame()} label="Frame" color="blue" disabled={!stopped} />
        <ToolbarButton onClick={() => session.rewindFrames(60)} label="Rewind 1s" color="blue" disabled={!stopped} />
        <div className="ml-4 text-slate-500 text-xs mono">
          PC: 0x{pc.toString(16).padStart(8, '0')} · frame {position.frame} · line {position.scanline}
          {session.program.hasSymbols ? '' : ' · no ELF'}
        </div>
      </div>

      {/* Main panels */}
      <div className="flex-1 grid grid-cols-[260px_1fr_360px] grid-rows-[auto_1fr] gap-3 min-h-0">
        {/* Top-left: Screen */}
        <div className="bg-slate-800/50 rounded-lg border border-slate-700 p-2">
          <ScreenPanel transport={transport} scale={1} controls={false} />
        </div>

        {/* Center: Disassembly / Source */}
        <div className="row-span-2 min-h-0 flex flex-col">
          <div className="flex gap-1 mb-1">
            <PanelTab
              label="Disassembly"
              active={centerPanel === 'disassembly'}
              onClick={() => setCenterPanel('disassembly')}
            />
            <PanelTab label="Source" active={centerPanel === 'source'} onClick={() => setCenterPanel('source')} />
          </div>
          <div className="flex-1 min-h-0">
            {centerPanel === 'disassembly' ? (
              <DisassemblyView
                session={session}
                revision={revision}
                breakpoints={breakpoints}
                onToggleBreakpoint={toggleBreakpoint}
              />
            ) : (
              <SourceView session={session} revision={revision} onElfLoad={onElfLoad} />
            )}
          </div>
        </div>

        {/* Top-right: Breakpoints */}
        <div className="min-h-0 max-h-40">
          <BreakpointPanel breakpoints={breakpoints} onToggle={toggleBreakpoint} />
        </div>

        {/* Bottom-left: Registers */}
        <div className="min-h-0">
          <RegisterView session={session} revision={revision} />
        </div>

        {/* Bottom-right: the emulator views */}
        <div className="min-h-0 bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
          <DebugPanels
            transport={transport}
            panels={['io', 'palette', 'tiles', 'tilemap', 'sprites', 'trace', 'events', 'search', 'labels']}
          />
        </div>
      </div>

      {/* Bottom: Memory viewer */}
      <div className="h-48 min-h-0">
        <MemoryViewer session={session} revision={revision} />
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
  shortcut?: string;
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
      {label}
      {shortcut && <span className="text-slate-500 ml-1">{shortcut}</span>}
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
