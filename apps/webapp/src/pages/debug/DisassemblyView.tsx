import type { EmulatorBridge } from '@gba-kit/gba-browser';
import clsx from 'clsx';
import { useMemo } from 'react';

import { Panel } from '../../components/Panel';

interface DisassemblyViewProps {
  emulator: EmulatorBridge;
  pc: number;
  breakpointVersion: number;
  onBreakpointChange: () => void;
}

const LINES_BEFORE = 10;
const LINES_AFTER = 30;

export function DisassemblyView({ emulator, pc, breakpointVersion, onBreakpointChange }: DisassemblyViewProps) {
  const breakpoints = useMemo(() => {
    const bps = emulator.getBreakpoints();
    return new Set(bps.filter((bp) => bp.enabled).map((bp) => bp.address));
  }, [emulator, breakpointVersion]);

  const isThumb = emulator.cpu.getT();
  const instrSize = isThumb ? 2 : 4;
  const startAddr = Math.max(0, pc - LINES_BEFORE * instrSize);
  const totalLines = LINES_BEFORE + 1 + LINES_AFTER;

  const lines = useMemo(() => emulator.disassembleAt(startAddr, totalLines), [emulator, startAddr, totalLines]);

  return (
    <Panel title="Disassembly" className="h-full" contentClassName="font-mono text-[13px] leading-[1.4] text-xs">
      {lines.map((line) => {
        const isCurrent = line.address === pc;
        const isBp = breakpoints.has(line.address);

        return (
          <div
            key={line.address}
            className={clsx(
              'flex items-center px-3 py-0.5 cursor-pointer hover:bg-slate-700/30',
              isBp && isCurrent && 'bg-red-500/25 border-l-3 border-l-red-500',
              isCurrent && !isBp && 'bg-sky-500/20 border-l-3 border-l-sky-500',
              isBp && !isCurrent && 'bg-red-500/15',
            )}
            onClick={() => {
              if (breakpoints.has(line.address)) {
                emulator.removeBreakpoint(line.address);
              } else {
                emulator.addBreakpoint(line.address);
              }
              onBreakpointChange();
            }}
          >
            {/* Breakpoint gutter */}
            <div className="w-4 shrink-0">{isBp && <span className="text-red-400 text-[10px]">&#9679;</span>}</div>

            {/* PC marker */}
            <div className="w-5 shrink-0 text-sky-400">{isCurrent ? '>' : ''}</div>

            {/* Address */}
            <span className="text-slate-500 w-24 shrink-0">0x{line.address.toString(16).padStart(8, '0')}</span>

            {/* Mnemonic */}
            <span className="text-slate-200">{line.mnemonic}</span>
          </div>
        );
      })}
    </Panel>
  );
}
