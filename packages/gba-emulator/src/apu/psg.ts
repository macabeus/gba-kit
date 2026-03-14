/**
 * GBA PSG — Channels 1-4
 *
 * Channel 1: Square wave with sweep + envelope + duty cycle
 * Channel 2: Square wave with envelope + duty cycle
 * Channel 3: Programmable wave (4-bit samples from Wave RAM)
 * Channel 4: Noise (LFSR) with envelope
 *
 * All channels run at CPU_FREQ / (period * prescaler). The frame sequencer
 * (512 Hz, derived from a 256 Hz base) clocks length, envelope, and sweep.
 */
import type {
  PsgChannel1Snapshot,
  PsgChannel2Snapshot,
  PsgChannel3Snapshot,
  PsgChannel4Snapshot,
} from '../savestate.js';
import { CPU_FREQ } from '../types.js';

// ─── Duty Cycle Tables ───────────────────────────────────────────────

/** Duty cycle waveforms: 8 steps, 1 = high, 0 = low */
const DUTY_TABLE: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
  [1, 0, 0, 0, 0, 0, 0, 1], // 25%
  [1, 0, 0, 0, 0, 1, 1, 1], // 50%
  [0, 1, 1, 1, 1, 1, 1, 0], // 75%
];

/** Channel 3 volume shift table: 0=mute, 1=100%, 2=50%, 3=25% */
const WAVE_VOLUME_SHIFT = [4, 0, 1, 2] as const;

// ─── Frame Sequencer ─────────────────────────────────────────────────

/** Frame sequencer rate: 512 Hz (CPU_FREQ / 32768 cycles per step) */
const FRAME_SEQUENCER_PERIOD = CPU_FREQ / 512;

// ─── Channel 1: Square with Sweep ────────────────────────────────────

export class PsgChannel1 {
  // Sweep
  sweepPeriod = 0;
  sweepNegate = false;
  sweepShift = 0;
  #sweepTimer = 0;
  #sweepEnabled = false;
  #sweepShadowFreq = 0;

  // Duty / Length
  duty = 0;
  lengthCounter = 0;
  lengthEnabled = false;

  // Envelope
  envelopeInitialVolume = 0;
  envelopeDirection = 0; // 0 = decrease, 1 = increase
  envelopePeriod = 0;
  #envelopeTimer = 0;
  #volume = 0;

  // Frequency / Control
  frequency = 0;
  #frequencyTimer = 0;
  #dutyPosition = 0;

  // State
  enabled = false;
  #dacEnabled = false;

  /** Current output sample (0-15) */
  get output(): number {
    if (!this.enabled || !this.#dacEnabled) {
      return 0;
    }
    return DUTY_TABLE[this.duty]![this.#dutyPosition]! * this.#volume;
  }

  /** Write SOUND1CNT_L (sweep register, offset 0x60) */
  writeSweep(value: number): void {
    this.sweepShift = value & 0x7;
    this.sweepNegate = (value & 0x8) !== 0;
    this.sweepPeriod = (value >> 4) & 0x7;
  }

  /** Read SOUND1CNT_L */
  readSweep(): number {
    return this.sweepShift | (this.sweepNegate ? 0x8 : 0) | (this.sweepPeriod << 4);
  }

  /** Write SOUND1CNT_H (duty/envelope, offset 0x62) */
  writeDutyEnvelope(value: number): void {
    const length = value & 0x3f;
    this.lengthCounter = 64 - length;
    this.duty = (value >> 6) & 0x3;
    this.envelopePeriod = (value >> 8) & 0x7;
    this.envelopeDirection = (value >> 11) & 1;
    this.envelopeInitialVolume = (value >> 12) & 0xf;
    this.#dacEnabled = (value & 0xf800) !== 0;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  /** Read SOUND1CNT_H */
  readDutyEnvelope(): number {
    return (
      (this.duty << 6) |
      (this.envelopePeriod << 8) |
      (this.envelopeDirection << 11) |
      (this.envelopeInitialVolume << 12)
    );
  }

  /** Write SOUND1CNT_X (frequency/control, offset 0x64) */
  writeFreqControl(value: number): void {
    this.frequency = (this.frequency & 0x700) | (value & 0xff);
    if (value & 0xff00) {
      this.frequency = (this.frequency & 0xff) | ((value & 0x700) >> 0);
      // bit 8-10 of the 16-bit value are freq bits 8-10
      this.frequency = value & 0x7ff;
      this.lengthEnabled = (value & (1 << 14)) !== 0;

      if (value & (1 << 15)) {
        this.#trigger();
      }
    } else {
      this.frequency = value & 0x7ff;
      this.lengthEnabled = (value & (1 << 14)) !== 0;
    }
  }

  /** Read SOUND1CNT_X (only bit 14 is readable) */
  readFreqControl(): number {
    return this.lengthEnabled ? 1 << 14 : 0;
  }

  /** Trigger the channel (restart) */
  #trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) {
      this.lengthCounter = 64;
    }
    this.#frequencyTimer = (2048 - this.frequency) * 4;
    this.#volume = this.envelopeInitialVolume;
    this.#envelopeTimer = this.envelopePeriod;

    // Sweep init
    this.#sweepShadowFreq = this.frequency;
    this.#sweepTimer = this.sweepPeriod || 8;
    this.#sweepEnabled = this.sweepPeriod !== 0 || this.sweepShift !== 0;
    if (this.sweepShift !== 0) {
      // Calculate and check overflow immediately
      const newFreq = this.#calcSweepFreq();
      if (newFreq > 2047) {
        this.enabled = false;
      }
    }

    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  #calcSweepFreq(): number {
    let newFreq = this.#sweepShadowFreq >> this.sweepShift;
    if (this.sweepNegate) {
      newFreq = this.#sweepShadowFreq - newFreq;
    } else {
      newFreq = this.#sweepShadowFreq + newFreq;
    }
    return newFreq;
  }

  /** Clock the frequency timer (called at CPU rate via tick) */
  clockTimer(cycles: number): void {
    this.#frequencyTimer -= cycles;
    while (this.#frequencyTimer <= 0) {
      this.#frequencyTimer += (2048 - this.frequency) * 4;
      this.#dutyPosition = (this.#dutyPosition + 1) & 7;
    }
  }

  /** Clock sweep (128 Hz — frame sequencer steps 2, 6) */
  clockSweep(): void {
    if (this.#sweepTimer > 0) {
      this.#sweepTimer--;
    }
    if (this.#sweepTimer === 0) {
      this.#sweepTimer = this.sweepPeriod || 8;
      if (this.#sweepEnabled && this.sweepPeriod > 0) {
        const newFreq = this.#calcSweepFreq();
        if (newFreq <= 2047 && this.sweepShift > 0) {
          this.frequency = newFreq;
          this.#sweepShadowFreq = newFreq;
          // Check again for overflow
          if (this.#calcSweepFreq() > 2047) {
            this.enabled = false;
          }
        }
        if (newFreq > 2047) {
          this.enabled = false;
        }
      }
    }
  }

  /** Clock length counter (256 Hz — every frame sequencer step) */
  clockLength(): void {
    if (this.lengthEnabled && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0) {
        this.enabled = false;
      }
    }
  }

  /** Clock envelope (64 Hz — frame sequencer steps 7) */
  clockEnvelope(): void {
    if (this.envelopePeriod === 0) {
      return;
    }
    if (this.#envelopeTimer > 0) {
      this.#envelopeTimer--;
    }
    if (this.#envelopeTimer === 0) {
      this.#envelopeTimer = this.envelopePeriod;
      if (this.envelopeDirection === 1 && this.#volume < 15) {
        this.#volume++;
      } else if (this.envelopeDirection === 0 && this.#volume > 0) {
        this.#volume--;
      }
    }
  }

  serialize(): PsgChannel1Snapshot {
    return {
      sweepPeriod: this.sweepPeriod,
      sweepNegate: this.sweepNegate,
      sweepShift: this.sweepShift,
      sweepTimer: this.#sweepTimer,
      sweepEnabled: this.#sweepEnabled,
      sweepShadowFreq: this.#sweepShadowFreq,
      duty: this.duty,
      lengthCounter: this.lengthCounter,
      lengthEnabled: this.lengthEnabled,
      envelopeInitialVolume: this.envelopeInitialVolume,
      envelopeDirection: this.envelopeDirection,
      envelopePeriod: this.envelopePeriod,
      envelopeTimer: this.#envelopeTimer,
      volume: this.#volume,
      frequency: this.frequency,
      frequencyTimer: this.#frequencyTimer,
      dutyPosition: this.#dutyPosition,
      enabled: this.enabled,
      dacEnabled: this.#dacEnabled,
    };
  }

  deserialize(s: PsgChannel1Snapshot): void {
    this.sweepPeriod = s.sweepPeriod;
    this.sweepNegate = s.sweepNegate;
    this.sweepShift = s.sweepShift;
    this.#sweepTimer = s.sweepTimer;
    this.#sweepEnabled = s.sweepEnabled;
    this.#sweepShadowFreq = s.sweepShadowFreq;
    this.duty = s.duty;
    this.lengthCounter = s.lengthCounter;
    this.lengthEnabled = s.lengthEnabled;
    this.envelopeInitialVolume = s.envelopeInitialVolume;
    this.envelopeDirection = s.envelopeDirection;
    this.envelopePeriod = s.envelopePeriod;
    this.#envelopeTimer = s.envelopeTimer;
    this.#volume = s.volume;
    this.frequency = s.frequency;
    this.#frequencyTimer = s.frequencyTimer;
    this.#dutyPosition = s.dutyPosition;
    this.enabled = s.enabled;
    this.#dacEnabled = s.dacEnabled;
  }

  reset(): void {
    this.sweepPeriod = 0;
    this.sweepNegate = false;
    this.sweepShift = 0;
    this.#sweepTimer = 0;
    this.#sweepEnabled = false;
    this.#sweepShadowFreq = 0;
    this.duty = 0;
    this.lengthCounter = 0;
    this.lengthEnabled = false;
    this.envelopeInitialVolume = 0;
    this.envelopeDirection = 0;
    this.envelopePeriod = 0;
    this.#envelopeTimer = 0;
    this.#volume = 0;
    this.frequency = 0;
    this.#frequencyTimer = 0;
    this.#dutyPosition = 0;
    this.enabled = false;
    this.#dacEnabled = false;
  }
}

// ─── Channel 2: Square (no sweep) ────────────────────────────────────

export class PsgChannel2 {
  duty = 0;
  lengthCounter = 0;
  lengthEnabled = false;

  envelopeInitialVolume = 0;
  envelopeDirection = 0;
  envelopePeriod = 0;
  #envelopeTimer = 0;
  #volume = 0;

  frequency = 0;
  #frequencyTimer = 0;
  #dutyPosition = 0;

  enabled = false;
  #dacEnabled = false;

  get output(): number {
    if (!this.enabled || !this.#dacEnabled) {
      return 0;
    }
    return DUTY_TABLE[this.duty]![this.#dutyPosition]! * this.#volume;
  }

  /** Write SOUND2CNT_L (duty/envelope, offset 0x68) */
  writeDutyEnvelope(value: number): void {
    const length = value & 0x3f;
    this.lengthCounter = 64 - length;
    this.duty = (value >> 6) & 0x3;
    this.envelopePeriod = (value >> 8) & 0x7;
    this.envelopeDirection = (value >> 11) & 1;
    this.envelopeInitialVolume = (value >> 12) & 0xf;
    this.#dacEnabled = (value & 0xf800) !== 0;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  readDutyEnvelope(): number {
    return (
      (this.duty << 6) |
      (this.envelopePeriod << 8) |
      (this.envelopeDirection << 11) |
      (this.envelopeInitialVolume << 12)
    );
  }

  /** Write SOUND2CNT_H (frequency/control, offset 0x6C) */
  writeFreqControl(value: number): void {
    this.frequency = value & 0x7ff;
    this.lengthEnabled = (value & (1 << 14)) !== 0;
    if (value & (1 << 15)) {
      this.#trigger();
    }
  }

  readFreqControl(): number {
    return this.lengthEnabled ? 1 << 14 : 0;
  }

  #trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) {
      this.lengthCounter = 64;
    }
    this.#frequencyTimer = (2048 - this.frequency) * 4;
    this.#volume = this.envelopeInitialVolume;
    this.#envelopeTimer = this.envelopePeriod;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  clockTimer(cycles: number): void {
    this.#frequencyTimer -= cycles;
    while (this.#frequencyTimer <= 0) {
      this.#frequencyTimer += (2048 - this.frequency) * 4;
      this.#dutyPosition = (this.#dutyPosition + 1) & 7;
    }
  }

  clockLength(): void {
    if (this.lengthEnabled && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0) {
        this.enabled = false;
      }
    }
  }

  clockEnvelope(): void {
    if (this.envelopePeriod === 0) {
      return;
    }
    if (this.#envelopeTimer > 0) {
      this.#envelopeTimer--;
    }
    if (this.#envelopeTimer === 0) {
      this.#envelopeTimer = this.envelopePeriod;
      if (this.envelopeDirection === 1 && this.#volume < 15) {
        this.#volume++;
      } else if (this.envelopeDirection === 0 && this.#volume > 0) {
        this.#volume--;
      }
    }
  }

  serialize(): PsgChannel2Snapshot {
    return {
      duty: this.duty,
      lengthCounter: this.lengthCounter,
      lengthEnabled: this.lengthEnabled,
      envelopeInitialVolume: this.envelopeInitialVolume,
      envelopeDirection: this.envelopeDirection,
      envelopePeriod: this.envelopePeriod,
      envelopeTimer: this.#envelopeTimer,
      volume: this.#volume,
      frequency: this.frequency,
      frequencyTimer: this.#frequencyTimer,
      dutyPosition: this.#dutyPosition,
      enabled: this.enabled,
      dacEnabled: this.#dacEnabled,
    };
  }

  deserialize(s: PsgChannel2Snapshot): void {
    this.duty = s.duty;
    this.lengthCounter = s.lengthCounter;
    this.lengthEnabled = s.lengthEnabled;
    this.envelopeInitialVolume = s.envelopeInitialVolume;
    this.envelopeDirection = s.envelopeDirection;
    this.envelopePeriod = s.envelopePeriod;
    this.#envelopeTimer = s.envelopeTimer;
    this.#volume = s.volume;
    this.frequency = s.frequency;
    this.#frequencyTimer = s.frequencyTimer;
    this.#dutyPosition = s.dutyPosition;
    this.enabled = s.enabled;
    this.#dacEnabled = s.dacEnabled;
  }

  reset(): void {
    this.duty = 0;
    this.lengthCounter = 0;
    this.lengthEnabled = false;
    this.envelopeInitialVolume = 0;
    this.envelopeDirection = 0;
    this.envelopePeriod = 0;
    this.#envelopeTimer = 0;
    this.#volume = 0;
    this.frequency = 0;
    this.#frequencyTimer = 0;
    this.#dutyPosition = 0;
    this.enabled = false;
    this.#dacEnabled = false;
  }
}

// ─── Channel 3: Wave ─────────────────────────────────────────────────

export class PsgChannel3 {
  /** Wave RAM: 16 bytes = 32 4-bit samples */
  readonly waveRam = new Uint8Array(16);

  enabled = false;
  #dacEnabled = false;
  lengthCounter = 0;
  lengthEnabled = false;
  volumeCode = 0; // 0-3
  frequency = 0;
  #frequencyTimer = 0;
  #sampleIndex = 0;
  /** Two banks: 0 or 1 (GBA supports bank mode but we use single-bank for now) */
  bankMode = false;
  bankSelect = 0;

  get output(): number {
    if (!this.enabled || !this.#dacEnabled) {
      return 0;
    }
    // Read current 4-bit sample from wave RAM
    const byteIndex = this.#sampleIndex >> 1;
    const nibble =
      (this.#sampleIndex & 1) === 0 ? (this.waveRam[byteIndex]! >> 4) & 0xf : this.waveRam[byteIndex]! & 0xf;
    const shift = WAVE_VOLUME_SHIFT[this.volumeCode]!;
    return nibble >> shift;
  }

  /** Write SOUND3CNT_L (enable, offset 0x70) */
  writeControl(value: number): void {
    this.bankMode = (value & (1 << 5)) !== 0;
    this.bankSelect = (value >> 6) & 1;
    this.#dacEnabled = (value & (1 << 7)) !== 0;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  readControl(): number {
    return (this.bankMode ? 1 << 5 : 0) | (this.bankSelect << 6) | (this.#dacEnabled ? 1 << 7 : 0);
  }

  /** Write SOUND3CNT_H (length/volume, offset 0x72) */
  writeLengthVolume(value: number): void {
    this.lengthCounter = 256 - (value & 0xff);
    this.volumeCode = (value >> 13) & 0x3;
  }

  readLengthVolume(): number {
    return this.volumeCode << 13;
  }

  /** Write SOUND3CNT_X (frequency/control, offset 0x74) */
  writeFreqControl(value: number): void {
    this.frequency = value & 0x7ff;
    this.lengthEnabled = (value & (1 << 14)) !== 0;
    if (value & (1 << 15)) {
      this.#trigger();
    }
  }

  readFreqControl(): number {
    return this.lengthEnabled ? 1 << 14 : 0;
  }

  #trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) {
      this.lengthCounter = 256;
    }
    this.#frequencyTimer = (2048 - this.frequency) * 2;
    this.#sampleIndex = 0;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  clockTimer(cycles: number): void {
    this.#frequencyTimer -= cycles;
    while (this.#frequencyTimer <= 0) {
      this.#frequencyTimer += (2048 - this.frequency) * 2;
      this.#sampleIndex = (this.#sampleIndex + 1) & 31;
    }
  }

  clockLength(): void {
    if (this.lengthEnabled && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0) {
        this.enabled = false;
      }
    }
  }

  /** Write a byte to wave RAM */
  writeWaveRam(offset: number, value: number): void {
    this.waveRam[offset & 0xf] = value & 0xff;
  }

  /** Read a byte from wave RAM */
  readWaveRam(offset: number): number {
    return this.waveRam[offset & 0xf]!;
  }

  serialize(): PsgChannel3Snapshot {
    return {
      waveRam: new Uint8Array(this.waveRam),
      enabled: this.enabled,
      dacEnabled: this.#dacEnabled,
      lengthCounter: this.lengthCounter,
      lengthEnabled: this.lengthEnabled,
      volumeCode: this.volumeCode,
      frequency: this.frequency,
      frequencyTimer: this.#frequencyTimer,
      sampleIndex: this.#sampleIndex,
      bankMode: this.bankMode,
      bankSelect: this.bankSelect,
    };
  }

  deserialize(s: PsgChannel3Snapshot): void {
    this.waveRam.set(s.waveRam);
    this.enabled = s.enabled;
    this.#dacEnabled = s.dacEnabled;
    this.lengthCounter = s.lengthCounter;
    this.lengthEnabled = s.lengthEnabled;
    this.volumeCode = s.volumeCode;
    this.frequency = s.frequency;
    this.#frequencyTimer = s.frequencyTimer;
    this.#sampleIndex = s.sampleIndex;
    this.bankMode = s.bankMode;
    this.bankSelect = s.bankSelect;
  }

  reset(): void {
    this.waveRam.fill(0);
    this.enabled = false;
    this.#dacEnabled = false;
    this.lengthCounter = 0;
    this.lengthEnabled = false;
    this.volumeCode = 0;
    this.frequency = 0;
    this.#frequencyTimer = 0;
    this.#sampleIndex = 0;
    this.bankMode = false;
    this.bankSelect = 0;
  }
}

// ─── Channel 4: Noise ────────────────────────────────────────────────

export class PsgChannel4 {
  lengthCounter = 0;
  lengthEnabled = false;

  envelopeInitialVolume = 0;
  envelopeDirection = 0;
  envelopePeriod = 0;
  #envelopeTimer = 0;
  #volume = 0;

  clockShift = 0;
  widthMode = false; // false = 15-bit LFSR, true = 7-bit LFSR
  divisorCode = 0;
  #lfsr = 0x7fff;
  #frequencyTimer = 0;

  enabled = false;
  #dacEnabled = false;

  get output(): number {
    if (!this.enabled || !this.#dacEnabled) {
      return 0;
    }
    // LFSR bit 0 inverted: 0 = high, 1 = low
    return (~this.#lfsr & 1) * this.#volume;
  }

  /** Write SOUND4CNT_L (envelope, offset 0x78) */
  writeEnvelope(value: number): void {
    const length = value & 0x3f;
    this.lengthCounter = 64 - length;
    this.envelopePeriod = (value >> 8) & 0x7;
    this.envelopeDirection = (value >> 11) & 1;
    this.envelopeInitialVolume = (value >> 12) & 0xf;
    this.#dacEnabled = (value & 0xf800) !== 0;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  readEnvelope(): number {
    return (this.envelopePeriod << 8) | (this.envelopeDirection << 11) | (this.envelopeInitialVolume << 12);
  }

  /** Write SOUND4CNT_H (frequency/control, offset 0x7C) */
  writeFreqControl(value: number): void {
    this.divisorCode = value & 0x7;
    this.widthMode = (value & (1 << 3)) !== 0;
    this.clockShift = (value >> 4) & 0xf;
    this.lengthEnabled = (value & (1 << 14)) !== 0;
    if (value & (1 << 15)) {
      this.#trigger();
    }
  }

  readFreqControl(): number {
    return (
      this.divisorCode | (this.widthMode ? 1 << 3 : 0) | (this.clockShift << 4) | (this.lengthEnabled ? 1 << 14 : 0)
    );
  }

  #trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) {
      this.lengthCounter = 64;
    }
    this.#lfsr = this.widthMode ? 0x7f : 0x7fff;
    this.#frequencyTimer = this.#getDivisor() << this.clockShift;
    this.#volume = this.envelopeInitialVolume;
    this.#envelopeTimer = this.envelopePeriod;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  #getDivisor(): number {
    return this.divisorCode === 0 ? 8 : this.divisorCode * 16;
  }

  clockTimer(cycles: number): void {
    this.#frequencyTimer -= cycles;
    while (this.#frequencyTimer <= 0) {
      this.#frequencyTimer += this.#getDivisor() << this.clockShift;
      // Clock the LFSR
      const xor = (this.#lfsr & 1) ^ ((this.#lfsr >> 1) & 1);
      this.#lfsr >>= 1;
      this.#lfsr |= xor << 14;
      if (this.widthMode) {
        // Also set bit 6 for 7-bit mode
        this.#lfsr = (this.#lfsr & ~(1 << 6)) | (xor << 6);
      }
    }
  }

  clockLength(): void {
    if (this.lengthEnabled && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0) {
        this.enabled = false;
      }
    }
  }

  clockEnvelope(): void {
    if (this.envelopePeriod === 0) {
      return;
    }
    if (this.#envelopeTimer > 0) {
      this.#envelopeTimer--;
    }
    if (this.#envelopeTimer === 0) {
      this.#envelopeTimer = this.envelopePeriod;
      if (this.envelopeDirection === 1 && this.#volume < 15) {
        this.#volume++;
      } else if (this.envelopeDirection === 0 && this.#volume > 0) {
        this.#volume--;
      }
    }
  }

  serialize(): PsgChannel4Snapshot {
    return {
      lengthCounter: this.lengthCounter,
      lengthEnabled: this.lengthEnabled,
      envelopeInitialVolume: this.envelopeInitialVolume,
      envelopeDirection: this.envelopeDirection,
      envelopePeriod: this.envelopePeriod,
      envelopeTimer: this.#envelopeTimer,
      volume: this.#volume,
      clockShift: this.clockShift,
      widthMode: this.widthMode,
      divisorCode: this.divisorCode,
      lfsr: this.#lfsr,
      frequencyTimer: this.#frequencyTimer,
      enabled: this.enabled,
      dacEnabled: this.#dacEnabled,
    };
  }

  deserialize(s: PsgChannel4Snapshot): void {
    this.lengthCounter = s.lengthCounter;
    this.lengthEnabled = s.lengthEnabled;
    this.envelopeInitialVolume = s.envelopeInitialVolume;
    this.envelopeDirection = s.envelopeDirection;
    this.envelopePeriod = s.envelopePeriod;
    this.#envelopeTimer = s.envelopeTimer;
    this.#volume = s.volume;
    this.clockShift = s.clockShift;
    this.widthMode = s.widthMode;
    this.divisorCode = s.divisorCode;
    this.#lfsr = s.lfsr;
    this.#frequencyTimer = s.frequencyTimer;
    this.enabled = s.enabled;
    this.#dacEnabled = s.dacEnabled;
  }

  reset(): void {
    this.lengthCounter = 0;
    this.lengthEnabled = false;
    this.envelopeInitialVolume = 0;
    this.envelopeDirection = 0;
    this.envelopePeriod = 0;
    this.#envelopeTimer = 0;
    this.#volume = 0;
    this.clockShift = 0;
    this.widthMode = false;
    this.divisorCode = 0;
    this.#lfsr = 0x7fff;
    this.#frequencyTimer = 0;
    this.enabled = false;
    this.#dacEnabled = false;
  }
}

export { FRAME_SEQUENCER_PERIOD };
