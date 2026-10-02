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
  /** Hardware frames completed since reset. Older snapshots omit it and restore as 0. */
  frameCount?: number;
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
  /** How long the `.sav` installed in the chip was. Older snapshots omit it and restore as 0. */
  installedBytes?: number;
  state: number;
  command: number;
  address: number;
  bitBuffer: string; // BigInt serialized as string
  bitsReceived: number;
  sendBuffer: string; // BigInt serialized as string
  sendPos: number;
}

/** The cartridge's flash chip (`flash.ts`). */
export interface FlashSnapshot {
  /** The whole chip, bank 0 first: 64 KB or 128 KB, empty on a cartridge without flash. */
  data: Uint8Array;
  /** How far into an unlock sequence the chip is (0 to 2). */
  unlock: number;
  /** The command in effect, by its command byte (0 for none). */
  command: number;
  /** The bank the 0x0E window shows. */
  bank: number;
}

export interface SystemBusSnapshot {
  ewram: Uint8Array;
  iwram: Uint8Array;
  palette: Uint8Array;
  vram: Uint8Array;
  oam: Uint8Array;
  /** The 32 KB SRAM chip. Older snapshots carry 64 KB, the window as it was served; its first 32 KB restore. */
  sram: Uint8Array;
  mmioRegisters: Uint8Array;
  /** Whether the 0x0E window is backed. The cartridge answers for it, so `deserialize` passes over this; it stays in the snapshot for readers that take it from there. */
  hasSram: boolean;
  waitcnt: number;
  postflg: number;
  lastBiosRead: number;
  eeprom: EepromSnapshot;
  /** Older snapshots omit it: a flash cartridge's bytes were then in `sram`, which restores into bank 0, in read mode. */
  flash?: FlashSnapshot;
}

// ─── PPU ──────────────────────────────────────────────────────────────

/**
 * The fields after the reference points are optional because older snapshots lack them
 * (they carried `bg2RefLatched`/`bg3RefLatched`, which `deserialize` passes over); see
 * `Ppu.deserialize` for what each restores as.
 */
export interface PpuSnapshot {
  framebuffer: Uint32Array;
  bg2RefX: number;
  bg2RefY: number;
  bg3RefX: number;
  bg3RefY: number;
  /** BG2X, BG2Y, BG3X, BG3Y written since the last line start (bits 0-3). */
  refWritten?: number;
  /** DISPCNT sampled at the last three line starts, oldest first. */
  dispcntLatch?: number[];
  /** WIN0/WIN1 vertical flip-flops (bits 0-1) and horizontal flip-flops (bits 2-3). */
  windowFlags?: number;
  /** BG and OBJ mosaic vertical counters. */
  bgMosaicY?: number;
  objMosaicY?: number;
  /** The OBJ line on display, then the one prepared for the next line (240 packed pixels each). */
  objLines?: Uint32Array;
  /** The scanlines `objLines` were built for, -1 for none. */
  objLineNumbers?: number[];
}

// ─── APU ──────────────────────────────────────────────────────────────

export interface DirectSoundSnapshot {
  buffer: Int8Array;
  readIndex: number;
  writeIndex: number;
  size: number;
  /** The FIFO register's 32-bit input latch. Older snapshots lack it and restore it as 0. */
  latch?: number;
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
  /** Both wave RAM banks, 32 bytes, bank 0 first. Older snapshots hold one 16-byte bank, restored into both. */
  waveRam: Uint8Array;
  enabled: boolean;
  dacEnabled: boolean;
  lengthCounter: number;
  lengthEnabled: boolean;
  volumeCode: number;
  /** SOUND3CNT_H bit 15, force 75% volume. Older snapshots lack it and restore it as false. */
  forceVolume?: boolean;
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
