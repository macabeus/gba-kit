import type { Session } from '@gba-kit/debug-core';
import clsx from 'clsx';
import { useMemo } from 'react';

import { Panel } from '../../components/Panel';

interface DisassemblyViewProps {
  session: Session;
  revision: number;
  breakpoints: number[];
  onToggleBreakpoint: (address: number) => void;
}

const LINES_BEFORE = 10;
const LINES_AFTER = 30;

export function DisassemblyView({ session, revision, breakpoints, onToggleBreakpoint }: DisassemblyViewProps) {
  const pc = session.pc;
  const instrSize = session.machine.thumb ? 2 : 4;
  const startAddr = Math.max(0, pc - LINES_BEFORE * instrSize);
  const totalLines = LINES_BEFORE + 1 + LINES_AFTER;
  const bpSet = useMemo(() => new Set(breakpoints), [breakpoints]);

  // `revision` is the cache key: the machine moved, or a label changed
  const lines = useMemo(() => session.disassemble(startAddr, totalLines), [session, startAddr, totalLines, revision]);

  return (
    <Panel title="Disassembly" className="h-full" contentClassName="font-mono text-[13px] leading-[1.4] text-xs">
      {lines.map((line) => {
        const isCurrent = line.address === pc;
        const isBp = bpSet.has(line.address);
        const name = line.label ?? line.symbol;

        return (
          <div
            key={line.address}
            className={clsx(
              'flex items-center px-3 py-0.5 cursor-pointer hover:bg-slate-700/30',
              isBp && isCurrent && 'bg-red-500/25 border-l-3 border-l-red-500',
              isCurrent && !isBp && 'bg-sky-500/20 border-l-3 border-l-sky-500',
              isBp && !isCurrent && 'bg-red-500/15',
            )}
            onClick={() => onToggleBreakpoint(line.address)}
          >
            <div className="w-4 shrink-0">{isBp && <span className="text-red-400 text-[10px]">&#9679;</span>}</div>
            <div className="w-5 shrink-0 text-sky-400">{isCurrent ? '>' : ''}</div>
            <span className="text-slate-500 w-24 shrink-0">0x{line.address.toString(16).padStart(8, '0')}</span>
            <span className="text-slate-600 w-24 shrink-0">{line.bytes}</span>
            <span className={line.text === '<unmapped>' ? 'text-slate-600' : 'text-slate-200'}>{line.text}</span>
            {name && <span className="ml-3 text-emerald-400/80">{name}</span>}
            {line.source && (
              <span className="ml-auto text-slate-600 text-[10px]">
                {line.source.path.replace(/^.*\//, '')}:{line.source.line}
              </span>
            )}
          </div>
        );
      })}
    </Panel>
  );
}
