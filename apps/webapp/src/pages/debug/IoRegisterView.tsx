import type { EmulatorBridge } from '@gba-kit/gba-browser';
import { useMemo } from 'react';

import { Panel } from '../../components/Panel';

interface IoRegisterViewProps {
  emulator: EmulatorBridge;
}

interface DecodedRegister {
  name: string;
  offset: number;
  value: number;
  fields: Array<{ name: string; value: string | number }>;
}

const BG_MODES = ['Mode 0', 'Mode 1', 'Mode 2', 'Mode 3', 'Mode 4', 'Mode 5', 'Invalid', 'Invalid'];

function decodeDispcnt(value: number): DecodedRegister {
  return {
    name: 'DISPCNT',
    offset: 0x00,
    value,
    fields: [
      { name: 'Mode', value: BG_MODES[value & 7]! },
      { name: 'Frame', value: (value >> 4) & 1 },
      { name: 'HBlank OAM', value: (value >> 5) & 1 ? 'Yes' : 'No' },
      { name: 'OBJ Map', value: (value >> 6) & 1 ? '1D' : '2D' },
      { name: 'Force Blank', value: (value >> 7) & 1 ? 'Yes' : 'No' },
      { name: 'BG0', value: (value >> 8) & 1 ? 'ON' : 'off' },
      { name: 'BG1', value: (value >> 9) & 1 ? 'ON' : 'off' },
      { name: 'BG2', value: (value >> 10) & 1 ? 'ON' : 'off' },
      { name: 'BG3', value: (value >> 11) & 1 ? 'ON' : 'off' },
      { name: 'OBJ', value: (value >> 12) & 1 ? 'ON' : 'off' },
      { name: 'WIN0', value: (value >> 13) & 1 ? 'ON' : 'off' },
      { name: 'WIN1', value: (value >> 14) & 1 ? 'ON' : 'off' },
      { name: 'OBJ WIN', value: (value >> 15) & 1 ? 'ON' : 'off' },
    ],
  };
}

function decodeBgCnt(name: string, offset: number, value: number): DecodedRegister {
  return {
    name,
    offset,
    value,
    fields: [
      { name: 'Priority', value: value & 3 },
      { name: 'Tile Base', value: `0x${(((value >> 2) & 3) * 0x4000).toString(16)}` },
      { name: 'Mosaic', value: (value >> 6) & 1 ? 'Yes' : 'No' },
      { name: 'Color', value: (value >> 7) & 1 ? '256' : '16' },
      { name: 'Map Base', value: `0x${(((value >> 8) & 0x1f) * 0x800).toString(16)}` },
      { name: 'Size', value: (value >> 14) & 3 },
    ],
  };
}

function decodeBldcnt(value: number): DecodedRegister {
  const effects = ['None', 'Alpha', 'Bright+', 'Bright-'];
  return {
    name: 'BLDCNT',
    offset: 0x50,
    value,
    fields: [
      { name: 'Effect', value: effects[(value >> 6) & 3]! },
      { name: '1st BG0', value: value & 1 ? 'Yes' : 'No' },
      { name: '1st BG1', value: (value >> 1) & 1 ? 'Yes' : 'No' },
      { name: '1st OBJ', value: (value >> 4) & 1 ? 'Yes' : 'No' },
      { name: '2nd BG0', value: (value >> 8) & 1 ? 'Yes' : 'No' },
      { name: '2nd BD', value: (value >> 13) & 1 ? 'Yes' : 'No' },
    ],
  };
}

export function IoRegisterView({ emulator }: IoRegisterViewProps) {
  const mmio = emulator.gba.bus.mmioRegisters;

  const registers = useMemo(() => {
    const read16 = (offset: number) => mmio[offset]! | (mmio[offset + 1]! << 8);

    return [
      decodeDispcnt(read16(0x00)),
      decodeBgCnt('BG0CNT', 0x08, read16(0x08)),
      decodeBgCnt('BG1CNT', 0x0a, read16(0x0a)),
      decodeBgCnt('BG2CNT', 0x0c, read16(0x0c)),
      decodeBgCnt('BG3CNT', 0x0e, read16(0x0e)),
      decodeBldcnt(read16(0x50)),
    ];
  }, [mmio]);

  return (
    <Panel title="I/O Registers" className="h-full" contentClassName="font-mono text-[13px] leading-[1.4] text-xs">
      {registers.map((reg) => (
        <div key={reg.name} className="border-b border-slate-700/50 px-3 py-1.5">
          <div className="flex justify-between mb-1">
            <span className="text-sky-400 font-medium">{reg.name}</span>
            <span className="text-slate-500">0x{reg.value.toString(16).padStart(4, '0')}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
            {reg.fields.map((field) => (
              <div key={field.name} className="flex justify-between">
                <span className="text-slate-500">{field.name}</span>
                <span className={field.value === 'ON' ? 'text-green-400' : 'text-slate-300'}>{field.value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Panel>
  );
}
