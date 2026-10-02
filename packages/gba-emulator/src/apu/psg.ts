/**
 * GBA PSG — Channels 1-4
 *
 * Channel 1: Square wave with sweep + envelope + duty cycle
 * Channel 2: Square wave with envelope + duty cycle
 * Channel 3: Programmable wave (4-bit samples from two banks of Wave RAM)
 * Channel 4: Noise (LFSR) with envelope
 *
 * Every register is written a byte at a time (the Game Boy's NRxy registers), so a byte
 * store has exactly that byte's effect: only the NRx4 byte restarts a channel. The channel
 * timers count GBA CPU cycles (16.78 MHz, four times the Game Boy clock). The frame
 * sequencer (512 Hz) clocks length, envelope, and sweep.
 *
 * References: GBATEK "GBA Sound Channel 1-4"; mGBA src/gb/audio.c (GBAudioRun, with
 * timingFactor 4 on the GBA), NanoBoyAdvance src/nba/src/hw/apu/channel/.
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

// ─── Timer Periods ───────────────────────────────────────────────────

/**
 * CPU cycles per duty step of channels 1-2. GBATEK SOUND1CNT_X: "Frequency =
 * 131072/(2048-n)Hz", and a period is 8 duty steps.
 */
function squareStepCycles(frequency: number): number {
  return 16 * (2048 - frequency);
}

/** CPU cycles per wave RAM digit of channel 3. GBATEK SOUND3CNT_X: "Sample Rate; 2097152/(2048-n) Hz". */
function waveStepCycles(frequency: number): number {
  return 8 * (2048 - frequency);
}

/**
 * CPU cycles per LFSR step of channel 4. GBATEK SOUND4CNT_H: "Frequency = 524288 Hz / r /
 * 2^(s+1) ;For r=0 assume r=0.5 instead".
 */
function noiseStepCycles(divisorCode: number, clockShift: number): number {
  return (divisorCode === 0 ? 32 : 64 * divisorCode) << clockShift;
}

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

  /** Write NR10 (SOUND1CNT_L, 0x60): sweep */
  writeSweep(value: number): void {
    this.sweepShift = value & 0x7;
    this.sweepNegate = (value & 0x8) !== 0;
    this.sweepPeriod = (value >> 4) & 0x7;
  }

  /** Read NR10 */
  readSweep(): number {
    return this.sweepShift | (this.sweepNegate ? 0x8 : 0) | (this.sweepPeriod << 4);
  }

  /** Write NR11 (0x62): length and duty */
  writeLengthDuty(value: number): void {
    this.lengthCounter = 64 - (value & 0x3f);
    this.duty = (value >> 6) & 0x3;
  }

  /** Read NR11: the duty is readable, the length is write-only */
  readLengthDuty(): number {
    return this.duty << 6;
  }

  /** Write NR12 (0x63): envelope. A zero volume with a decreasing envelope turns the DAC off. */
  writeEnvelope(value: number): void {
    this.envelopePeriod = value & 0x7;
    this.envelopeDirection = (value >> 3) & 1;
    this.envelopeInitialVolume = (value >> 4) & 0xf;
    this.#dacEnabled = (value & 0xf8) !== 0;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  /** Read NR12 */
  readEnvelope(): number {
    return this.envelopePeriod | (this.envelopeDirection << 3) | (this.envelopeInitialVolume << 4);
  }

  /** Write NR13 (0x64): frequency bits 0-7 */
  writeFrequencyLow(value: number): void {
    this.frequency = (this.frequency & 0x700) | (value & 0xff);
  }

  /** Write NR14 (0x65): frequency bits 8-10, length enable, and restart (bit 7) */
  writeFrequencyHigh(value: number): void {
    this.frequency = (this.frequency & 0xff) | ((value & 0x7) << 8);
    this.lengthEnabled = (value & 0x40) !== 0;
    if (value & 0x80) {
      this.#trigger();
    }
  }

  /** Read NR14: only the length enable (bit 6) is readable */
  readFrequencyHigh(): number {
    return this.lengthEnabled ? 0x40 : 0;
  }

  /** Trigger the channel (restart) */
  #trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) {
      this.lengthCounter = 64;
    }
    this.#frequencyTimer = squareStepCycles(this.frequency);
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

  /** Advance the frequency timer by the given number of CPU cycles */
  clockTimer(cycles: number): void {
    this.#frequencyTimer -= cycles;
    while (this.#frequencyTimer <= 0) {
      this.#frequencyTimer += squareStepCycles(this.frequency);
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

  /** Write NR21 (SOUND2CNT_L low byte, 0x68): length and duty */
  writeLengthDuty(value: number): void {
    this.lengthCounter = 64 - (value & 0x3f);
    this.duty = (value >> 6) & 0x3;
  }

  /** Read NR21: the duty is readable, the length is write-only */
  readLengthDuty(): number {
    return this.duty << 6;
  }

  /** Write NR22 (0x69): envelope. A zero volume with a decreasing envelope turns the DAC off. */
  writeEnvelope(value: number): void {
    this.envelopePeriod = value & 0x7;
    this.envelopeDirection = (value >> 3) & 1;
    this.envelopeInitialVolume = (value >> 4) & 0xf;
    this.#dacEnabled = (value & 0xf8) !== 0;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  /** Read NR22 */
  readEnvelope(): number {
    return this.envelopePeriod | (this.envelopeDirection << 3) | (this.envelopeInitialVolume << 4);
  }

  /** Write NR23 (SOUND2CNT_H low byte, 0x6C): frequency bits 0-7 */
  writeFrequencyLow(value: number): void {
    this.frequency = (this.frequency & 0x700) | (value & 0xff);
  }

  /** Write NR24 (0x6D): frequency bits 8-10, length enable, and restart (bit 7) */
  writeFrequencyHigh(value: number): void {
    this.frequency = (this.frequency & 0xff) | ((value & 0x7) << 8);
    this.lengthEnabled = (value & 0x40) !== 0;
    if (value & 0x80) {
      this.#trigger();
    }
  }

  /** Read NR24: only the length enable (bit 6) is readable */
  readFrequencyHigh(): number {
    return this.lengthEnabled ? 0x40 : 0;
  }

  #trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) {
      this.lengthCounter = 64;
    }
    this.#frequencyTimer = squareStepCycles(this.frequency);
    this.#volume = this.envelopeInitialVolume;
    this.#envelopeTimer = this.envelopePeriod;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  /** Advance the frequency timer by the given number of CPU cycles */
  clockTimer(cycles: number): void {
    this.#frequencyTimer -= cycles;
    while (this.#frequencyTimer <= 0) {
      this.#frequencyTimer += squareStepCycles(this.frequency);
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

/** Bytes in one wave RAM bank (32 digits) */
const WAVE_BANK_SIZE = 16;

export class PsgChannel3 {
  /** Wave RAM: two banks of 16 bytes (32 4-bit digits each), bank 0 first */
  readonly waveRam = new Uint8Array(WAVE_BANK_SIZE * 2);

  enabled = false;
  #dacEnabled = false;
  lengthCounter = 0;
  lengthEnabled = false;
  volumeCode = 0; // 0-3
  /** SOUND3CNT_H bit 15: play at 75% whatever the volume code says */
  forceVolume = false;
  frequency = 0;
  #frequencyTimer = 0;
  /** Digit being played: 0-31 within the selected bank, 0-63 across both banks in dimension mode */
  #sampleIndex = 0;
  /** NR30 bit 5, Wave RAM dimension: false = one bank (32 digits), true = two banks (64 digits) */
  bankMode = false;
  /** NR30 bit 6: the bank played back in one-bank mode; the CPU reads and writes the other one */
  bankSelect = 0;

  get output(): number {
    if (!this.enabled || !this.#dacEnabled) {
      return 0;
    }
    // In dimension mode the 64 digits run through bank 0, then bank 1, from a restart
    // (mGBA src/gb/audio.c GBAudioRun shifts both banks as one register, NanoBoyAdvance
    // wave_channel.cc restarts at bank 0).
    const bank = this.bankMode ? this.#sampleIndex >> 5 : this.bankSelect;
    const digit = this.#sampleIndex & 31;
    const byte = this.waveRam[bank * WAVE_BANK_SIZE + (digit >> 1)]!;
    // Each byte plays its high nibble first (GBATEK WAVE_RAM).
    const nibble = (digit & 1) === 0 ? byte >> 4 : byte & 0xf;
    if (this.forceVolume) {
      // mGBA src/gb/audio.c GBAudioRun: "sample += sample << 1", then >> 2.
      return (nibble * 3) >> 2;
    }
    return nibble >> WAVE_VOLUME_SHIFT[this.volumeCode]!;
  }

  /** Write NR30 (SOUND3CNT_L, 0x70): dimension, bank select, playback */
  writeControl(value: number): void {
    this.bankMode = (value & (1 << 5)) !== 0;
    this.bankSelect = (value >> 6) & 1;
    this.#dacEnabled = (value & (1 << 7)) !== 0;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  /** Read NR30 */
  readControl(): number {
    return (this.bankMode ? 1 << 5 : 0) | (this.bankSelect << 6) | (this.#dacEnabled ? 1 << 7 : 0);
  }

  /** Write NR31 (0x72): length */
  writeLength(value: number): void {
    this.lengthCounter = 256 - (value & 0xff);
  }

  /** Write NR32 (0x73): volume code (bits 5-6) and force 75% (bit 7) */
  writeVolume(value: number): void {
    this.volumeCode = (value >> 5) & 0x3;
    this.forceVolume = (value & 0x80) !== 0;
  }

  /** Read NR32 */
  readVolume(): number {
    return (this.volumeCode << 5) | (this.forceVolume ? 0x80 : 0);
  }

  /** Write NR33 (SOUND3CNT_X low byte, 0x74): sample rate bits 0-7 */
  writeFrequencyLow(value: number): void {
    this.frequency = (this.frequency & 0x700) | (value & 0xff);
  }

  /** Write NR34 (0x75): sample rate bits 8-10, length enable, and restart (bit 7) */
  writeFrequencyHigh(value: number): void {
    this.frequency = (this.frequency & 0xff) | ((value & 0x7) << 8);
    this.lengthEnabled = (value & 0x40) !== 0;
    if (value & 0x80) {
      this.#trigger();
    }
  }

  /** Read NR34: only the length enable (bit 6) is readable */
  readFrequencyHigh(): number {
    return this.lengthEnabled ? 0x40 : 0;
  }

  #trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) {
      this.lengthCounter = 256;
    }
    this.#frequencyTimer = waveStepCycles(this.frequency);
    this.#sampleIndex = 0;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  /** Advance the frequency timer by the given number of CPU cycles */
  clockTimer(cycles: number): void {
    this.#frequencyTimer -= cycles;
    const mask = this.bankMode ? 63 : 31;
    while (this.#frequencyTimer <= 0) {
      this.#frequencyTimer += waveStepCycles(this.frequency);
      this.#sampleIndex = (this.#sampleIndex + 1) & mask;
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

  /**
   * Write a byte of wave RAM as the CPU sees it. GBATEK SOUND3CNT_L: "reading/writing to/from
   * wave RAM will address the other (not selected) bank".
   */
  writeWaveRam(offset: number, value: number): void {
    this.waveRam[this.#cpuBankBase() + (offset & 0xf)] = value & 0xff;
  }

  /** Read a byte of wave RAM as the CPU sees it (the bank not selected for playback) */
  readWaveRam(offset: number): number {
    return this.waveRam[this.#cpuBankBase() + (offset & 0xf)]!;
  }

  #cpuBankBase(): number {
    return (this.bankSelect ^ 1) * WAVE_BANK_SIZE;
  }

  serialize(): PsgChannel3Snapshot {
    return {
      waveRam: new Uint8Array(this.waveRam),
      enabled: this.enabled,
      dacEnabled: this.#dacEnabled,
      lengthCounter: this.lengthCounter,
      lengthEnabled: this.lengthEnabled,
      volumeCode: this.volumeCode,
      forceVolume: this.forceVolume,
      frequency: this.frequency,
      frequencyTimer: this.#frequencyTimer,
      sampleIndex: this.#sampleIndex,
      bankMode: this.bankMode,
      bankSelect: this.bankSelect,
    };
  }

  deserialize(s: PsgChannel3Snapshot): void {
    if (s.waveRam.length === WAVE_BANK_SIZE) {
      // A snapshot from the single-bank model: one buffer served playback and the CPU alike.
      this.waveRam.set(s.waveRam, 0);
      this.waveRam.set(s.waveRam, WAVE_BANK_SIZE);
    } else {
      this.waveRam.set(s.waveRam);
    }
    this.enabled = s.enabled;
    this.#dacEnabled = s.dacEnabled;
    this.lengthCounter = s.lengthCounter;
    this.lengthEnabled = s.lengthEnabled;
    this.volumeCode = s.volumeCode;
    this.forceVolume = s.forceVolume ?? false;
    this.frequency = s.frequency;
    this.#frequencyTimer = s.frequencyTimer;
    this.#sampleIndex = s.sampleIndex;
    this.bankMode = s.bankMode;
    this.bankSelect = s.bankSelect;
  }

  /** Clear the registers and stop playback, keeping wave RAM (what master sound off does) */
  powerOff(): void {
    this.enabled = false;
    this.#dacEnabled = false;
    this.lengthCounter = 0;
    this.lengthEnabled = false;
    this.volumeCode = 0;
    this.forceVolume = false;
    this.frequency = 0;
    this.#frequencyTimer = 0;
    this.#sampleIndex = 0;
    this.bankMode = false;
    this.bankSelect = 0;
  }

  reset(): void {
    this.powerOff();
    this.waveRam.fill(0);
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

  /** Write NR41 (SOUND4CNT_L low byte, 0x78): length */
  writeLength(value: number): void {
    this.lengthCounter = 64 - (value & 0x3f);
  }

  /** Write NR42 (0x79): envelope. A zero volume with a decreasing envelope turns the DAC off. */
  writeEnvelope(value: number): void {
    this.envelopePeriod = value & 0x7;
    this.envelopeDirection = (value >> 3) & 1;
    this.envelopeInitialVolume = (value >> 4) & 0xf;
    this.#dacEnabled = (value & 0xf8) !== 0;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  /** Read NR42 */
  readEnvelope(): number {
    return this.envelopePeriod | (this.envelopeDirection << 3) | (this.envelopeInitialVolume << 4);
  }

  /** Write NR43 (SOUND4CNT_H low byte, 0x7C): dividing ratio, counter width, shift clock */
  writeFrequency(value: number): void {
    this.divisorCode = value & 0x7;
    this.widthMode = (value & (1 << 3)) !== 0;
    this.clockShift = (value >> 4) & 0xf;
  }

  /** Read NR43 */
  readFrequency(): number {
    return this.divisorCode | (this.widthMode ? 1 << 3 : 0) | (this.clockShift << 4);
  }

  /** Write NR44 (0x7D): length enable and restart (bit 7) */
  writeControl(value: number): void {
    this.lengthEnabled = (value & 0x40) !== 0;
    if (value & 0x80) {
      this.#trigger();
    }
  }

  /** Read NR44: only the length enable (bit 6) is readable */
  readControl(): number {
    return this.lengthEnabled ? 0x40 : 0;
  }

  #trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) {
      this.lengthCounter = 64;
    }
    this.#lfsr = this.widthMode ? 0x7f : 0x7fff;
    this.#frequencyTimer = noiseStepCycles(this.divisorCode, this.clockShift);
    this.#volume = this.envelopeInitialVolume;
    this.#envelopeTimer = this.envelopePeriod;
    if (!this.#dacEnabled) {
      this.enabled = false;
    }
  }

  /** Advance the frequency timer by the given number of CPU cycles */
  clockTimer(cycles: number): void {
    this.#frequencyTimer -= cycles;
    while (this.#frequencyTimer <= 0) {
      this.#frequencyTimer += noiseStepCycles(this.divisorCode, this.clockShift);
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
