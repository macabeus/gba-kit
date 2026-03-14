import type { EmulatorBridge } from '@gba-kit/gba-browser';
import clsx from 'clsx';
import { useCallback, useMemo, useState } from 'react';

import { Panel } from '../../components/Panel';

interface MemoryViewerProps {
  emulator: EmulatorBridge;
}

interface MemorySection {
  label: string;
  start: number;
  size: number;
}

const MEMORY_SECTIONS: MemorySection[] = [
  { label: 'EWRAM', start: 0x02000000, size: 0x40000 },
  { label: 'IWRAM', start: 0x03000000, size: 0x8000 },
  { label: 'MMIO', start: 0x04000000, size: 0x400 },
  { label: 'PAL', start: 0x05000000, size: 0x400 },
  { label: 'VRAM', start: 0x06000000, size: 0x18000 },
  { label: 'OAM', start: 0x07000000, size: 0x400 },
  { label: 'ROM', start: 0x08000000, size: 0x2000000 },
  { label: 'SRAM', start: 0x0e000000, size: 0x10000 },
];

const BYTES_PER_ROW = 16;
const VISIBLE_ROWS = 8;

export function MemoryViewer({ emulator }: MemoryViewerProps) {
  const [sectionIndex, setSectionIndex] = useState(0);
  const section = MEMORY_SECTIONS[sectionIndex]!;

  const [baseAddr, setBaseAddr] = useState(section.start);
  const [inputAddr, setInputAddr] = useState(section.start.toString(16).padStart(8, '0'));

  const handleSectionChange = useCallback((index: number) => {
    setSectionIndex(index);
    const s = MEMORY_SECTIONS[index]!;
    setBaseAddr(s.start);
    setInputAddr(s.start.toString(16).padStart(8, '0'));
  }, []);

  const handleGoTo = useCallback(() => {
    const addr = parseInt(inputAddr, 16);
    if (!isNaN(addr)) {
      setBaseAddr(addr & ~0xf);
    }
  }, [inputAddr]);

  const totalBytes = BYTES_PER_ROW * VISIBLE_ROWS;
  const data = useMemo(() => emulator.readMemory(baseAddr, totalBytes), [emulator, baseAddr, totalBytes]);

  const memoryHeaderRight = (
    <div className="flex items-center gap-2">
      <span className="text-slate-500 text-xs">Go to:</span>
      <input
        type="text"
        value={inputAddr}
        onChange={(e) => setInputAddr(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleGoTo()}
        className="font-mono text-[13px] leading-[1.4] text-xs bg-slate-900 border border-slate-600 rounded px-2 py-0.5 text-slate-200 w-24 focus:outline-none focus:border-sky-500"
      />
      <button type="button" onClick={handleGoTo} className="text-xs text-sky-400 hover:text-sky-300">
        Go
      </button>
    </div>
  );

  const memorySectionTabs = (
    <div className="flex flex-wrap gap-0 mt-1.5 -mb-2 -mx-3 border-t border-slate-700">
      {MEMORY_SECTIONS.map((s, i) => (
        <button
          key={s.label}
          type="button"
          onClick={() => handleSectionChange(i)}
          className={clsx(
            'px-2 py-1 text-[10px] mono transition-colors',
            i === sectionIndex
              ? 'text-sky-300 bg-slate-700/50 border-b border-sky-400'
              : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/30',
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  );

  return (
    <Panel
      title="Memory"
      className="h-full"
      headerRight={memoryHeaderRight}
      headerExtra={memorySectionTabs}
      contentClassName="font-mono text-[13px] leading-[1.4] text-xs px-3 py-1"
    >
      {Array.from({ length: VISIBLE_ROWS }, (_, row) => {
        const rowAddr = baseAddr + row * BYTES_PER_ROW;
        const rowData = data.subarray(row * BYTES_PER_ROW, (row + 1) * BYTES_PER_ROW);

        return (
          <div key={rowAddr} className="flex items-center py-0.5 hover:bg-slate-700/30 rounded">
            {/* Address */}
            <span className="text-sky-400/70 w-24 shrink-0">{rowAddr.toString(16).padStart(8, '0')}</span>

            {/* Hex bytes */}
            <div className="flex gap-1 shrink-0 mr-4">
              {Array.from(rowData, (byte, i) => (
                <span key={i} className="text-slate-300 w-5 text-center">
                  {byte.toString(16).padStart(2, '0')}
                </span>
              ))}
            </div>

            {/* ASCII */}
            <span className="text-slate-500">
              {Array.from(rowData, (byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('')}
            </span>
          </div>
        );
      })}
    </Panel>
  );
}
