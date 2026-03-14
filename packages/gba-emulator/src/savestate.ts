/**
 * GBA Save State — Snapshot Types
 *
 * Plain objects with typed arrays for IndexedDB structured clone compatibility.
 * Callbacks and references are NOT serialized — they are reconstructed after restore.
 */
import type { CpuSnapshot } from '@gba-kit/arm-emulator/cpu-snapshot';

export type { CpuSnapshot } from '@gba-kit/arm-emulator/cpu-snapshot';

export interface GbaSnapshot {
  version: 1;
  cpu: CpuSnapshot;
  currentScanline: number;
  inIrqHandler: boolean;
  scheduler: SchedulerSnapshot;
  interrupts: InterruptSnapshot;
  timers: TimerSnapshot;
  dma: DmaSnapshot;
  input: InputSnapshot;
  bus: SystemBusSnapshot;
  ppu: PpuSnapshot;
  apu?: ApuSnapshot;
}

// ─── Scheduler ────────────────────────────────────────────────────────

export interface SchedulerEventSnapshot {
  fireCycle: number;
  active: boolean;
}

export interface SchedulerSnapshot {
  currentCycle: number;
  events: SchedulerEventSnapshot[];
}

// ─── Interrupts ───────────────────────────────────────────────────────

export interface InterruptSnapshot {
  ime: number;
  ie: number;
  if_: number;
  halted: boolean;
  intrWaitFlags: number;
}

// ─── Timers ───────────────────────────────────────────────────────────

export interface TimerChannelSnapshot {
  counter: number;
  reload: number;
  prescaler: number;
  cascade: boolean;
  irqEnable: boolean;
  enabled: boolean;
  lastUpdateCycle: number;
}

export interface TimerSnapshot {
  channels: TimerChannelSnapshot[];
}

// ─── DMA ──────────────────────────────────────────────────────────────

export interface DmaChannelSnapshot {
  srcAddr: number;
  dstAddr: number;
  srcLatch: number;
  dstLatch: number;
  wordCount: number;
  wordCountLatch: number;
  dstControl: number;
  srcControl: number;
  repeat: boolean;
  wordSize: boolean;
  startTiming: number;
  irqEnable: boolean;
  enabled: boolean;
}

export interface DmaSnapshot {
  channels: DmaChannelSnapshot[];
}

// ─── Input ────────────────────────────────────────────────────────────

export interface InputSnapshot {
  buttons: number;
  keycnt: number;
}

// ─── System Bus ───────────────────────────────────────────────────────

export interface EepromSnapshot {
  data: Uint8Array;
  addrBits: number;
  state: number;
  command: number;
  address: number;
  bitBuffer: string; // BigInt serialized as string
  bitsReceived: number;
  sendBuffer: string; // BigInt serialized as string
  sendPos: number;
}

export interface SystemBusSnapshot {
  ewram: Uint8Array;
  iwram: Uint8Array;
  palette: Uint8Array;
  vram: Uint8Array;
  oam: Uint8Array;
  sram: Uint8Array;
  mmioRegisters: Uint8Array;
  hasSram: boolean;
  waitcnt: number;
  postflg: number;
  lastBiosRead: number;
  eeprom: EepromSnapshot;
}

// ─── PPU ──────────────────────────────────────────────────────────────

export interface PpuSnapshot {
  framebuffer: Uint32Array;
  bg2RefX: number;
  bg2RefY: number;
  bg3RefX: number;
  bg3RefY: number;
  bg2RefLatched: boolean;
  bg3RefLatched: boolean;
}

// ─── APU ──────────────────────────────────────────────────────────────

export interface DirectSoundSnapshot {
  buffer: Int8Array;
  readIndex: number;
  writeIndex: number;
  size: number;
  currentSample: number;
  enableLeft: boolean;
  enableRight: boolean;
  fullVolume: boolean;
  timerSelect: number;
}

export interface PsgChannel1Snapshot {
  sweepPeriod: number;
  sweepNegate: boolean;
  sweepShift: number;
  sweepTimer: number;
  sweepEnabled: boolean;
  sweepShadowFreq: number;
  duty: number;
  lengthCounter: number;
  lengthEnabled: boolean;
  envelopeInitialVolume: number;
  envelopeDirection: number;
  envelopePeriod: number;
  envelopeTimer: number;
  volume: number;
  frequency: number;
  frequencyTimer: number;
  dutyPosition: number;
  enabled: boolean;
  dacEnabled: boolean;
}

export interface PsgChannel2Snapshot {
  duty: number;
  lengthCounter: number;
  lengthEnabled: boolean;
  envelopeInitialVolume: number;
  envelopeDirection: number;
  envelopePeriod: number;
  envelopeTimer: number;
  volume: number;
  frequency: number;
  frequencyTimer: number;
  dutyPosition: number;
  enabled: boolean;
  dacEnabled: boolean;
}

export interface PsgChannel3Snapshot {
  waveRam: Uint8Array;
  enabled: boolean;
  dacEnabled: boolean;
  lengthCounter: number;
  lengthEnabled: boolean;
  volumeCode: number;
  frequency: number;
  frequencyTimer: number;
  sampleIndex: number;
  bankMode: boolean;
  bankSelect: number;
}

export interface PsgChannel4Snapshot {
  lengthCounter: number;
  lengthEnabled: boolean;
  envelopeInitialVolume: number;
  envelopeDirection: number;
  envelopePeriod: number;
  envelopeTimer: number;
  volume: number;
  clockShift: number;
  widthMode: boolean;
  divisorCode: number;
  lfsr: number;
  frequencyTimer: number;
  enabled: boolean;
  dacEnabled: boolean;
}

export interface ApuSnapshot {
  ch1: PsgChannel1Snapshot;
  ch2: PsgChannel2Snapshot;
  ch3: PsgChannel3Snapshot;
  ch4: PsgChannel4Snapshot;
  dsA: DirectSoundSnapshot;
  dsB: DirectSoundSnapshot;
  frameSequencerTimer: number;
  frameSequencerStep: number;
  sampleTimer: number;
  psgVolumeRight: number;
  psgVolumeLeft: number;
  psgEnableRight: number;
  psgEnableLeft: number;
  psgMasterVolume: number;
  masterEnable: boolean;
  biasLevel: number;
  biasResolution: number;
}
