import { useCallback, useState } from 'react';

import { Panel } from '../../components/Panel';

interface BreakpointPanelProps {
  breakpoints: number[];
  onToggle: (address: number) => void;
}

/** Instruction breakpoints by address; source-line breakpoints are the editor's job. */
export function BreakpointPanel({ breakpoints, onToggle }: BreakpointPanelProps) {
  const [inputAddr, setInputAddr] = useState('');

  const handleAdd = useCallback(() => {
    const addr = parseInt(inputAddr, 16);
    if (!isNaN(addr)) {
      onToggle((addr & ~1) >>> 0);
      setInputAddr('');
    }
  }, [inputAddr, onToggle]);

  return (
    <Panel title="Breakpoints" className="h-full" scroll={false}>
      <div className="flex-1 overflow-y-auto">
        {breakpoints.length === 0 ? (
          <div className="text-slate-600 text-xs px-3 py-2">No breakpoints set (Ctrl+B toggles one at the PC)</div>
        ) : (
          breakpoints.map((address) => (
            <div
              key={address}
              className="flex items-center justify-between px-3 py-1 hover:bg-slate-700/30 mono text-xs"
            >
              <span className="text-red-400">0x{address.toString(16).padStart(8, '0')}</span>
              <button
                type="button"
                onClick={() => onToggle(address)}
                className="text-slate-600 hover:text-red-400 text-[10px]"
              >
                &#10005;
              </button>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-1 px-2 py-1.5 border-t border-slate-700">
        <input
          type="text"
          value={inputAddr}
          onChange={(e) => setInputAddr(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="Address (hex)"
          className="font-mono text-[13px] leading-[1.4] text-xs bg-slate-900 border border-slate-600 rounded px-2 py-0.5 text-slate-200 flex-1 focus:outline-none focus:border-sky-500"
        />
        <button type="button" onClick={handleAdd} className="text-xs text-sky-400 hover:text-sky-300 px-2">
          + Add
        </button>
      </div>
    </Panel>
  );
}
