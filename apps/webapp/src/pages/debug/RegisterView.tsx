import type { EmulatorBridge } from '@gba-kit/gba-browser';
import { useMemo } from 'react';

import { Panel } from '../../components/Panel';

interface RegisterViewProps {
  emulator: EmulatorBridge;
}

const REG_NAMES = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'SP', 'LR', 'PC'];

export function RegisterView({ emulator }: RegisterViewProps) {
  const cpu = emulator.cpu;
  const regs = cpu.registers;
  const n = cpu.getN();
  const z = cpu.getZ();
  const c = cpu.getC();
  const v = cpu.getV();
  const isThumb = cpu.getT();

  const flagStr = useMemo(() => [n ? 'N' : 'n', z ? 'Z' : 'z', c ? 'C' : 'c', v ? 'V' : 'v'].join(''), [n, z, c, v]);

  return (
    <Panel
      title="Registers"
      className="h-full"
      contentClassName="font-mono text-[13px] leading-[1.4] text-xs space-y-0.5 px-2 py-1"
    >
      {REG_NAMES.map((name, i) => (
        <div key={name} className="flex justify-between px-1 py-0.5 rounded hover:bg-slate-700/50">
          <span className="text-slate-400 w-8">{name}</span>
          <span className="text-slate-200">0x{(regs[i]! >>> 0).toString(16).padStart(8, '0')}</span>
        </div>
      ))}

      <div className="border-t border-slate-700 mt-2 pt-2">
        <div className="flex justify-between px-1 py-0.5">
          <span className="text-slate-400">CPSR</span>
          <span className="text-slate-200">{flagStr}</span>
        </div>
        <div className="flex justify-between px-1 py-0.5">
          <span className="text-slate-400">Mode</span>
          <span className="text-slate-200">{isThumb ? 'Thumb' : 'ARM'}</span>
        </div>
      </div>
    </Panel>
  );
}
