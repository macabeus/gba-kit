/**
 * The I/O register file, decoded: every register the emulator models, its
 * current value, and its bit fields spelled out, for an I/O viewer and for
 * naming an address in the event log.
 */
import type { Machine } from './machine.js';

export interface IoField {
  name: string;
  /** lowest bit */
  bit: number;
  width: number;
  /** enumerated meanings, when a field is a selector */
  values?: Record<number, string>;
}

export interface IoRegisterDef {
  address: number;
  name: string;
  size: 2 | 4;
  group: 'display' | 'sound' | 'dma' | 'timer' | 'keypad' | 'interrupt' | 'system';
  fields?: IoField[];
}

const bit = (name: string, b: number): IoField => ({ name, bit: b, width: 1 });
const bits = (name: string, b: number, w: number, values?: Record<number, string>): IoField => ({
  name,
  bit: b,
  width: w,
  values,
});

const BG_CNT_FIELDS: IoField[] = [
  bits('priority', 0, 2),
  bits('charBase', 2, 2),
  bit('mosaic', 6),
  bit('8bpp', 7),
  bits('screenBase', 8, 5),
  bit('wrap', 13),
  bits('size', 14, 2),
];

const DMA_CNT_H_FIELDS: IoField[] = [
  bits('dstControl', 5, 2, { 0: 'increment', 1: 'decrement', 2: 'fixed', 3: 'increment+reload' }),
  bits('srcControl', 7, 2, { 0: 'increment', 1: 'decrement', 2: 'fixed' }),
  bit('repeat', 9),
  bit('32-bit', 10),
  bits('timing', 12, 2, { 0: 'immediately', 1: 'vblank', 2: 'hblank', 3: 'special' }),
  bit('irq', 14),
  bit('enable', 15),
];

const TM_CNT_H_FIELDS: IoField[] = [
  bits('prescaler', 0, 2, { 0: '1', 1: '64', 2: '256', 3: '1024' }),
  bit('cascade', 2),
  bit('irq', 6),
  bit('enable', 7),
];

const IRQ_FIELDS: IoField[] = [
  bit('vblank', 0),
  bit('hblank', 1),
  bit('vcount', 2),
  bit('timer0', 3),
  bit('timer1', 4),
  bit('timer2', 5),
  bit('timer3', 6),
  bit('serial', 7),
  bit('dma0', 8),
  bit('dma1', 9),
  bit('dma2', 10),
  bit('dma3', 11),
  bit('keypad', 12),
  bit('gamepak', 13),
];

const KEY_FIELDS: IoField[] = [
  bit('A', 0),
  bit('B', 1),
  bit('select', 2),
  bit('start', 3),
  bit('right', 4),
  bit('left', 5),
  bit('up', 6),
  bit('down', 7),
  bit('R', 8),
  bit('L', 9),
];

export const IO_REGISTERS: IoRegisterDef[] = [
  {
    address: 0x04000000,
    name: 'DISPCNT',
    size: 2,
    group: 'display',
    fields: [
      bits('mode', 0, 3),
      bit('frame', 4),
      bit('hblankOam', 5),
      bit('obj1d', 6),
      bit('forcedBlank', 7),
      bit('bg0', 8),
      bit('bg1', 9),
      bit('bg2', 10),
      bit('bg3', 11),
      bit('obj', 12),
      bit('win0', 13),
      bit('win1', 14),
      bit('objWin', 15),
    ],
  },
  {
    address: 0x04000004,
    name: 'DISPSTAT',
    size: 2,
    group: 'display',
    fields: [
      bit('inVBlank', 0),
      bit('inHBlank', 1),
      bit('vcountMatch', 2),
      bit('vblankIrq', 3),
      bit('hblankIrq', 4),
      bit('vcountIrq', 5),
      bits('vcountTarget', 8, 8),
    ],
  },
  { address: 0x04000006, name: 'VCOUNT', size: 2, group: 'display' },
  { address: 0x04000008, name: 'BG0CNT', size: 2, group: 'display', fields: BG_CNT_FIELDS },
  { address: 0x0400000a, name: 'BG1CNT', size: 2, group: 'display', fields: BG_CNT_FIELDS },
  { address: 0x0400000c, name: 'BG2CNT', size: 2, group: 'display', fields: BG_CNT_FIELDS },
  { address: 0x0400000e, name: 'BG3CNT', size: 2, group: 'display', fields: BG_CNT_FIELDS },
  { address: 0x04000010, name: 'BG0HOFS', size: 2, group: 'display' },
  { address: 0x04000012, name: 'BG0VOFS', size: 2, group: 'display' },
  { address: 0x04000014, name: 'BG1HOFS', size: 2, group: 'display' },
  { address: 0x04000016, name: 'BG1VOFS', size: 2, group: 'display' },
  { address: 0x04000018, name: 'BG2HOFS', size: 2, group: 'display' },
  { address: 0x0400001a, name: 'BG2VOFS', size: 2, group: 'display' },
  { address: 0x0400001c, name: 'BG3HOFS', size: 2, group: 'display' },
  { address: 0x0400001e, name: 'BG3VOFS', size: 2, group: 'display' },
  { address: 0x04000020, name: 'BG2PA', size: 2, group: 'display' },
  { address: 0x04000022, name: 'BG2PB', size: 2, group: 'display' },
  { address: 0x04000024, name: 'BG2PC', size: 2, group: 'display' },
  { address: 0x04000026, name: 'BG2PD', size: 2, group: 'display' },
  { address: 0x04000028, name: 'BG2X', size: 4, group: 'display' },
  { address: 0x0400002c, name: 'BG2Y', size: 4, group: 'display' },
  { address: 0x04000030, name: 'BG3PA', size: 2, group: 'display' },
  { address: 0x04000032, name: 'BG3PB', size: 2, group: 'display' },
  { address: 0x04000034, name: 'BG3PC', size: 2, group: 'display' },
  { address: 0x04000036, name: 'BG3PD', size: 2, group: 'display' },
  { address: 0x04000038, name: 'BG3X', size: 4, group: 'display' },
  { address: 0x0400003c, name: 'BG3Y', size: 4, group: 'display' },
  { address: 0x04000040, name: 'WIN0H', size: 2, group: 'display', fields: [bits('right', 0, 8), bits('left', 8, 8)] },
  { address: 0x04000042, name: 'WIN1H', size: 2, group: 'display', fields: [bits('right', 0, 8), bits('left', 8, 8)] },
  { address: 0x04000044, name: 'WIN0V', size: 2, group: 'display', fields: [bits('bottom', 0, 8), bits('top', 8, 8)] },
  { address: 0x04000046, name: 'WIN1V', size: 2, group: 'display', fields: [bits('bottom', 0, 8), bits('top', 8, 8)] },
  { address: 0x04000048, name: 'WININ', size: 2, group: 'display' },
  { address: 0x0400004a, name: 'WINOUT', size: 2, group: 'display' },
  { address: 0x0400004c, name: 'MOSAIC', size: 2, group: 'display' },
  {
    address: 0x04000050,
    name: 'BLDCNT',
    size: 2,
    group: 'display',
    fields: [
      bits('first', 0, 6),
      bits('effect', 6, 2, { 0: 'none', 1: 'alpha', 2: 'brighten', 3: 'darken' }),
      bits('second', 8, 6),
    ],
  },
  { address: 0x04000052, name: 'BLDALPHA', size: 2, group: 'display', fields: [bits('eva', 0, 5), bits('evb', 8, 5)] },
  { address: 0x04000054, name: 'BLDY', size: 2, group: 'display', fields: [bits('evy', 0, 5)] },
  { address: 0x04000080, name: 'SOUNDCNT_L', size: 2, group: 'sound' },
  { address: 0x04000082, name: 'SOUNDCNT_H', size: 2, group: 'sound' },
  {
    address: 0x04000084,
    name: 'SOUNDCNT_X',
    size: 2,
    group: 'sound',
    fields: [bit('ch1', 0), bit('ch2', 1), bit('ch3', 2), bit('ch4', 3), bit('master', 7)],
  },
  { address: 0x04000088, name: 'SOUNDBIAS', size: 2, group: 'sound' },
  { address: 0x040000b0, name: 'DMA0SAD', size: 4, group: 'dma' },
  { address: 0x040000b4, name: 'DMA0DAD', size: 4, group: 'dma' },
  { address: 0x040000b8, name: 'DMA0CNT_L', size: 2, group: 'dma' },
  { address: 0x040000ba, name: 'DMA0CNT_H', size: 2, group: 'dma', fields: DMA_CNT_H_FIELDS },
  { address: 0x040000bc, name: 'DMA1SAD', size: 4, group: 'dma' },
  { address: 0x040000c0, name: 'DMA1DAD', size: 4, group: 'dma' },
  { address: 0x040000c4, name: 'DMA1CNT_L', size: 2, group: 'dma' },
  { address: 0x040000c6, name: 'DMA1CNT_H', size: 2, group: 'dma', fields: DMA_CNT_H_FIELDS },
  { address: 0x040000c8, name: 'DMA2SAD', size: 4, group: 'dma' },
  { address: 0x040000cc, name: 'DMA2DAD', size: 4, group: 'dma' },
  { address: 0x040000d0, name: 'DMA2CNT_L', size: 2, group: 'dma' },
  { address: 0x040000d2, name: 'DMA2CNT_H', size: 2, group: 'dma', fields: DMA_CNT_H_FIELDS },
  { address: 0x040000d4, name: 'DMA3SAD', size: 4, group: 'dma' },
  { address: 0x040000d8, name: 'DMA3DAD', size: 4, group: 'dma' },
  { address: 0x040000dc, name: 'DMA3CNT_L', size: 2, group: 'dma' },
  { address: 0x040000de, name: 'DMA3CNT_H', size: 2, group: 'dma', fields: DMA_CNT_H_FIELDS },
  { address: 0x04000100, name: 'TM0CNT_L', size: 2, group: 'timer' },
  { address: 0x04000102, name: 'TM0CNT_H', size: 2, group: 'timer', fields: TM_CNT_H_FIELDS },
  { address: 0x04000104, name: 'TM1CNT_L', size: 2, group: 'timer' },
  { address: 0x04000106, name: 'TM1CNT_H', size: 2, group: 'timer', fields: TM_CNT_H_FIELDS },
  { address: 0x04000108, name: 'TM2CNT_L', size: 2, group: 'timer' },
  { address: 0x0400010a, name: 'TM2CNT_H', size: 2, group: 'timer', fields: TM_CNT_H_FIELDS },
  { address: 0x0400010c, name: 'TM3CNT_L', size: 2, group: 'timer' },
  { address: 0x0400010e, name: 'TM3CNT_H', size: 2, group: 'timer', fields: TM_CNT_H_FIELDS },
  { address: 0x04000130, name: 'KEYINPUT', size: 2, group: 'keypad', fields: KEY_FIELDS },
  {
    address: 0x04000132,
    name: 'KEYCNT',
    size: 2,
    group: 'keypad',
    fields: [...KEY_FIELDS, bit('irq', 14), bit('and', 15)],
  },
  { address: 0x04000200, name: 'IE', size: 2, group: 'interrupt', fields: IRQ_FIELDS },
  { address: 0x04000202, name: 'IF', size: 2, group: 'interrupt', fields: IRQ_FIELDS },
  { address: 0x04000204, name: 'WAITCNT', size: 2, group: 'system' },
  { address: 0x04000208, name: 'IME', size: 2, group: 'interrupt', fields: [bit('enable', 0)] },
  { address: 0x04000300, name: 'POSTFLG', size: 2, group: 'system' },
];

const BY_ADDRESS = new Map(IO_REGISTERS.map((r) => [r.address, r]));

/** The register at (or containing) `address`, or null. */
export function ioRegisterAt(address: number): IoRegisterDef | null {
  const a = address >>> 0;
  return BY_ADDRESS.get(a) ?? BY_ADDRESS.get(a & ~1) ?? BY_ADDRESS.get(a & ~3) ?? null;
}

export interface IoRegisterValue extends IoRegisterDef {
  value: number;
  decoded: Array<{ name: string; value: number; label?: string }>;
}

/** Every modelled register with its current value and decoded fields. */
export function ioSnapshot(machine: Machine): IoRegisterValue[] {
  return IO_REGISTERS.map((def) => {
    const value = machine.peekUnsigned(def.address, def.size) ?? 0;
    const decoded = (def.fields ?? []).map((f) => {
      const v = (value >>> f.bit) & ((1 << f.width) - 1);
      return { name: f.name, value: v, label: f.values?.[v] };
    });
    return { ...def, value, decoded };
  });
}
