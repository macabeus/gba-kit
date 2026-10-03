/**
 * GBA APU — Audio Processing Unit
 *
 * Mixes PSG channels 1-4 and DirectSound A/B, outputs samples to a
 * ring buffer for consumption by an AudioWorklet or similar sink.
 *
 * MMIO register offsets (from 0x04000000):
 *   0x60  SOUND1CNT_L  Channel 1 sweep
 *   0x62  SOUND1CNT_H  Channel 1 duty/envelope
 *   0x64  SOUND1CNT_X  Channel 1 frequency/control
 *   0x68  SOUND2CNT_L  Channel 2 duty/envelope
 *   0x6C  SOUND2CNT_H  Channel 2 frequency/control
 *   0x70  SOUND3CNT_L  Channel 3 enable
 *   0x72  SOUND3CNT_H  Channel 3 length/volume
 *   0x74  SOUND3CNT_X  Channel 3 frequency/control
 *   0x78  SOUND4CNT_L  Channel 4 envelope
 *   0x7C  SOUND4CNT_H  Channel 4 frequency/control
 *   0x80  SOUNDCNT_L   PSG master volume/routing
 *   0x82  SOUNDCNT_H   DirectSound volume, timer select, FIFO reset
 *   0x84  SOUNDCNT_X   Master enable, channel status
 *   0x88  SOUNDBIAS    Bias + resolution
 *   0x90-0x9F          Wave RAM (the 16-byte bank opposite the one NR30 bit 6 selects)
 *   0xA0  FIFO_A       DirectSound FIFO A (write-only, 32-bit)
 *   0xA4  FIFO_B       DirectSound FIFO B (write-only, 32-bit)
 *
 * The bus hands writes over at their own width (writeRegister8/16/32), so each byte keeps
 * its own side effects.
 *
 * The APU runs on the machine's clock. It catches up to it whenever something depends on it — a
 * register access, a FIFO sample popped at its timer's overflow, the host asking for samples, a
 * snapshot — so every cycle the machine spends, a DMA's included, reaches the sound hardware once
 * (mGBA audio.c GBAAudioSample, which samples up to a timestamp).
 */
import type { DmaController } from '../dma.js';
import type { ApuSnapshot } from '../savestate.js';
import type { TimerController } from '../timers.js';
import { CPU_FREQ, MMIO } from '../types.js';
import { DirectSoundChannel } from './direct-sound.js';
import { FRAME_SEQUENCER_PERIOD, PsgChannel1, PsgChannel2, PsgChannel3, PsgChannel4 } from './psg.js';

// ─── Constants ───────────────────────────────────────────────────────

/** Ring buffer capacity in stereo sample pairs */
const RING_BUFFER_SIZE = 4096;

/** Default sample rate for output */
const DEFAULT_SAMPLE_RATE = 32768;

/** Right shift of the PSG mix for SOUNDCNT_H bits 0-1: 25%, 50%, 100%, and 3 (prohibited) as 100% */
const PSG_RATIO_SHIFT = [4, 3, 2, 2] as const;

/** The machine's clock as the APU reads it (the Scheduler). */
export interface ApuClock {
  readonly currentCycle: number;
}

// ─── APU Class ───────────────────────────────────────────────────────

export class Apu {
  // PSG channels
  readonly #ch1 = new PsgChannel1();
  readonly #ch2 = new PsgChannel2();
  readonly #ch3 = new PsgChannel3();
  readonly #ch4 = new PsgChannel4();

  // DirectSound channels
  readonly #dsA = new DirectSoundChannel();
  readonly #dsB = new DirectSoundChannel();

  // Frame sequencer
  #frameSequencerTimer = 0;
  #frameSequencerStep = 0;

  // Sample output timing
  #sampleTimer = 0;
  /** CPU cycles between output samples */
  #cyclesPerSample: number;

  // Ring buffer (interleaved stereo: L, R, L, R, ...)
  readonly #ringBuffer = new Float32Array(RING_BUFFER_SIZE * 2);
  #ringWritePos = 0;
  #ringReadPos = 0;
  #ringSamples = 0;

  // SOUNDCNT_L: PSG volume & routing
  #psgVolumeRight = 0; // 0-7
  #psgVolumeLeft = 0; // 0-7
  #psgEnableRight = 0; // bits 0-3 = ch1-4 right
  #psgEnableLeft = 0; // bits 0-3 = ch1-4 left

  // SOUNDCNT_X: master enable
  #masterEnable = false;

  // SOUNDBIAS
  #biasLevel = 0x200;
  #biasResolution = 0; // 0-3

  // Timer and DMA references
  #timers: TimerController | null = null;
  #dma: DmaController | null = null;

  readonly #clock: ApuClock;
  /** The machine cycle the channels, the frame sequencer and the sample timer have reached. */
  #syncedCycle: number;

  constructor(clock: ApuClock, sampleRate: number = DEFAULT_SAMPLE_RATE) {
    this.#clock = clock;
    this.#syncedCycle = clock.currentCycle;
    this.#cyclesPerSample = Math.floor(CPU_FREQ / sampleRate);
  }

  /** Bring the APU up to the machine's clock. */
  #sync(): void {
    this.#syncTo(this.#clock.currentCycle);
  }

  /** Bring the APU up to the machine cycle `cycle`, if it has not reached it yet. */
  #syncTo(cycle: number): void {
    if (cycle > this.#syncedCycle) {
      this.#advance(cycle - this.#syncedCycle);
      this.#syncedCycle = cycle;
    }
  }

  // ─── Timer Integration ─────────────────────────────────────────────

  /** Connect to the timer controller and register FIFO overflow callbacks */
  connectTimers(timers: TimerController): void {
    this.#timers = timers;
    this.#installTimerCallbacks();
  }

  /** Connect to the DMA controller for sound FIFO refills */
  connectDma(dma: DmaController): void {
    this.#dma = dma;
  }

  #installTimerCallbacks(): void {
    if (!this.#timers) {
      return;
    }

    // A FIFO plays its next sample at its timer's overflow, so the APU runs up to that cycle first.
    this.#timers.setOverflowCallback(0, (at) => {
      this.#syncTo(at);
      if (this.#dsA.timerSelect === 0) {
        this.#dsA.popSample();
        if (this.#dsA.needsRefill()) {
          this.#dma?.requestSoundFifo(MMIO.FIFO_A);
        }
      }
      if (this.#dsB.timerSelect === 0) {
        this.#dsB.popSample();
        if (this.#dsB.needsRefill()) {
          this.#dma?.requestSoundFifo(MMIO.FIFO_B);
        }
      }
    });

    this.#timers.setOverflowCallback(1, (at) => {
      this.#syncTo(at);
      if (this.#dsA.timerSelect === 1) {
        this.#dsA.popSample();
        if (this.#dsA.needsRefill()) {
          this.#dma?.requestSoundFifo(MMIO.FIFO_A);
        }
      }
      if (this.#dsB.timerSelect === 1) {
        this.#dsB.popSample();
        if (this.#dsB.needsRefill()) {
          this.#dma?.requestSoundFifo(MMIO.FIFO_B);
        }
      }
    });
  }

  // ─── MMIO Register Access ──────────────────────────────────────────

  /**
   * Read the halfword at an even `offset` (relative to 0x04000000, 0x60-0x9E), with the
   * write-only and unused bits read as 0 (GBATEK "GBA Sound Channel 1-4", mGBA src/gba/io.c
   * GBAIOWrite masks).
   */
  readRegister16(offset: number): number {
    this.#sync();
    switch (offset) {
      case 0x60:
        return this.#ch1.readSweep();
      case 0x62:
        return this.#ch1.readLengthDuty() | (this.#ch1.readEnvelope() << 8);
      case 0x64:
        return this.#ch1.readFrequencyHigh() << 8;
      case 0x68:
        return this.#ch2.readLengthDuty() | (this.#ch2.readEnvelope() << 8);
      case 0x6c:
        return this.#ch2.readFrequencyHigh() << 8;
      case 0x70:
        return this.#ch3.readControl();
      case 0x72:
        return this.#ch3.readVolume() << 8;
      case 0x74:
        return this.#ch3.readFrequencyHigh() << 8;
      case 0x78:
        return this.#ch4.readEnvelope() << 8;
      case 0x7c:
        return this.#ch4.readFrequency() | (this.#ch4.readControl() << 8);
      case 0x80:
        return this.#readSoundcntL();
      case 0x82:
        return this.#readSoundcntH();
      case 0x84:
        return this.#readSoundcntX();
      case 0x88:
        return this.#readSoundbias();
      default:
        // Wave RAM (0x90-0x9F)
        if (offset >= 0x90 && offset <= 0x9f) {
          const ramOffset = offset - 0x90;
          return this.#ch3.readWaveRam(ramOffset) | (this.#ch3.readWaveRam(ramOffset + 1) << 8);
        }
        return 0;
    }
  }

  /**
   * Write one byte at `offset` (relative to 0x04000000, 0x60-0xA7). Each byte of a sound
   * register has its own effect: a store to NRx3 sets frequency bits only, and only the NRx4
   * byte restarts a channel (mGBA src/gba/io.c GBAIOWrite8, NanoBoyAdvance bus/io.cc).
   */
  writeRegister8(offset: number, value: number): void {
    this.#sync();
    value &= 0xff;
    // GBATEK SOUNDCNT_X: while bit 7 is cleared, "all PSG registers at 4000060h..4000081h are
    // reset to zero" and hold there, while "registers 4000082h and 4000088h are kept
    // read/write-able". Wave RAM stays writable too (mGBA src/gba/io.c GBAIOWrite32).
    if (offset < 0x82 && !this.#masterEnable) {
      return;
    }

    switch (offset) {
      case 0x60:
        this.#ch1.writeSweep(value);
        break;
      case 0x62:
        this.#ch1.writeLengthDuty(value);
        break;
      case 0x63:
        this.#ch1.writeEnvelope(value);
        break;
      case 0x64:
        this.#ch1.writeFrequencyLow(value);
        break;
      case 0x65:
        this.#ch1.writeFrequencyHigh(value);
        break;
      case 0x68:
        this.#ch2.writeLengthDuty(value);
        break;
      case 0x69:
        this.#ch2.writeEnvelope(value);
        break;
      case 0x6c:
        this.#ch2.writeFrequencyLow(value);
        break;
      case 0x6d:
        this.#ch2.writeFrequencyHigh(value);
        break;
      case 0x70:
        this.#ch3.writeControl(value);
        break;
      case 0x72:
        this.#ch3.writeLength(value);
        break;
      case 0x73:
        this.#ch3.writeVolume(value);
        break;
      case 0x74:
        this.#ch3.writeFrequencyLow(value);
        break;
      case 0x75:
        this.#ch3.writeFrequencyHigh(value);
        break;
      case 0x78:
        this.#ch4.writeLength(value);
        break;
      case 0x79:
        this.#ch4.writeEnvelope(value);
        break;
      case 0x7c:
        this.#ch4.writeFrequency(value);
        break;
      case 0x7d:
        this.#ch4.writeControl(value);
        break;
      case 0x80:
        this.#psgVolumeRight = value & 7;
        this.#psgVolumeLeft = (value >> 4) & 7;
        break;
      case 0x81:
        this.#psgEnableRight = value & 0xf;
        this.#psgEnableLeft = value >> 4;
        break;
      case 0x82:
        this.#writeSoundcntHLow(value);
        break;
      case 0x83:
        this.#writeSoundcntHHigh(value);
        break;
      case 0x84:
        this.#writeSoundcntX(value);
        break;
      case 0x88:
        this.#biasLevel = (this.#biasLevel & 0x300) | (value & 0xfe);
        break;
      case 0x89:
        this.#biasLevel = (this.#biasLevel & 0xff) | ((value & 3) << 8);
        this.#biasResolution = value >> 6;
        break;
      default:
        if (offset >= 0x90 && offset <= 0x9f) {
          this.#ch3.writeWaveRam(offset - 0x90, value);
        } else if (offset >= 0xa0 && offset <= 0xa7) {
          this.#fifo(offset).writeFifo(offset, value, 1);
        }
        break;
    }
  }

  /** Write a halfword at an even `offset` (0x60-0xA6): a FIFO takes it whole, a register byte by byte */
  writeRegister16(offset: number, value: number): void {
    this.#sync();
    if (offset >= 0xa0 && offset <= 0xa7) {
      this.#fifo(offset).writeFifo(offset, value & 0xffff, 2);
      return;
    }
    this.writeRegister8(offset, value);
    this.writeRegister8(offset + 1, value >> 8);
  }

  /** Write a word at a word-aligned `offset` (0x60-0xA4): a FIFO takes it whole, a register by halfwords */
  writeRegister32(offset: number, value: number): void {
    if (offset === 0xa0 || offset === 0xa4) {
      this.#fifo(offset).writeFifo(0, value, 4);
      return;
    }
    this.writeRegister16(offset, value & 0xffff);
    this.writeRegister16(offset + 2, value >>> 16);
  }

  /** FIFO A for 0xA0-0xA3, FIFO B for 0xA4-0xA7 */
  #fifo(offset: number): DirectSoundChannel {
    return offset < 0xa4 ? this.#dsA : this.#dsB;
  }

  // ─── SOUNDCNT_L (0x80): PSG Volume & Routing ──────────────────────

  #readSoundcntL(): number {
    return (
      (this.#psgVolumeRight & 7) |
      ((this.#psgVolumeLeft & 7) << 4) |
      ((this.#psgEnableRight & 0xf) << 8) |
      ((this.#psgEnableLeft & 0xf) << 12)
    );
  }

  // ─── SOUNDCNT_H (0x82): DirectSound Control ───────────────────────

  #readSoundcntH(): number {
    return (
      this.#psgMasterVolume |
      (this.#dsA.fullVolume ? 1 << 2 : 0) |
      (this.#dsB.fullVolume ? 1 << 3 : 0) |
      (this.#dsA.enableRight ? 1 << 8 : 0) |
      (this.#dsA.enableLeft ? 1 << 9 : 0) |
      (this.#dsA.timerSelect << 10) |
      (this.#dsB.enableRight ? 1 << 12 : 0) |
      (this.#dsB.enableLeft ? 1 << 13 : 0) |
      (this.#dsB.timerSelect << 14)
    );
  }

  /** SOUNDCNT_H bits 0-7: PSG volume ratio, DirectSound A/B volume */
  #writeSoundcntHLow(value: number): void {
    // bits 0-1: PSG volume ratio (0=25%, 1=50%, 2=100%)
    this.#psgMasterVolume = value & 3;
    this.#dsA.fullVolume = (value & (1 << 2)) !== 0;
    this.#dsB.fullVolume = (value & (1 << 3)) !== 0;
  }

  /** SOUNDCNT_H bits 8-15: DirectSound routing and timers; bits 11 and 15 reset a FIFO when written as 1 */
  #writeSoundcntHHigh(value: number): void {
    this.#dsA.enableRight = (value & (1 << 0)) !== 0;
    this.#dsA.enableLeft = (value & (1 << 1)) !== 0;
    this.#dsA.timerSelect = (value >> 2) & 1;
    if (value & (1 << 3)) {
      this.#dsA.resetFifo();
    }

    this.#dsB.enableRight = (value & (1 << 4)) !== 0;
    this.#dsB.enableLeft = (value & (1 << 5)) !== 0;
    this.#dsB.timerSelect = (value >> 6) & 1;
    if (value & (1 << 7)) {
      this.#dsB.resetFifo();
    }
  }

  /** PSG master volume ratio from SOUNDCNT_H bits 0-1 (0=25%, 1=50%, 2=100%) */
  #psgMasterVolume = 0;

  // ─── SOUNDCNT_X (0x84): Master Enable ─────────────────────────────

  #readSoundcntX(): number {
    return (
      (this.#ch1.enabled ? 1 : 0) |
      (this.#ch2.enabled ? 2 : 0) |
      (this.#ch3.enabled ? 4 : 0) |
      (this.#ch4.enabled ? 8 : 0) |
      (this.#masterEnable ? 0x80 : 0)
    );
  }

  #writeSoundcntX(value: number): void {
    const wasEnabled = this.#masterEnable;
    this.#masterEnable = (value & 0x80) !== 0;

    if (wasEnabled && !this.#masterEnable) {
      // Master sound off zeroes the PSG registers 0x60-0x81; wave RAM keeps its contents
      // (NanoBoyAdvance registers.cc SoundControl::Write, ResetWaveRAM::No).
      this.#ch1.reset();
      this.#ch2.reset();
      this.#ch3.powerOff();
      this.#ch4.reset();
      this.#psgVolumeRight = 0;
      this.#psgVolumeLeft = 0;
      this.#psgEnableRight = 0;
      this.#psgEnableLeft = 0;
    }
  }

  // ─── SOUNDBIAS (0x88) ─────────────────────────────────────────────

  #readSoundbias(): number {
    return this.#biasLevel | (this.#biasResolution << 14);
  }

  // ─── Sample Generation ─────────────────────────────────────────────

  /** Advance the channels, the frame sequencer and the sample timer by `cycles` CPU cycles. */
  #advance(cycles: number): void {
    // Advance in slices that end on sample boundaries, so each sample sees the channels as
    // they are at its own cycle, however long the caller's batch is.
    while (cycles > 0) {
      const slice = Math.min(cycles, Math.max(0, this.#cyclesPerSample - this.#sampleTimer));
      cycles -= slice;

      if (this.#masterEnable) {
        this.#ch1.clockTimer(slice);
        this.#ch2.clockTimer(slice);
        this.#ch3.clockTimer(slice);
        this.#ch4.clockTimer(slice);

        this.#frameSequencerTimer += slice;
        while (this.#frameSequencerTimer >= FRAME_SEQUENCER_PERIOD) {
          this.#frameSequencerTimer -= FRAME_SEQUENCER_PERIOD;
          this.#clockFrameSequencer();
        }
      }

      this.#sampleTimer += slice;
      if (this.#sampleTimer >= this.#cyclesPerSample) {
        this.#sampleTimer -= this.#cyclesPerSample;
        if (this.#masterEnable) {
          this.#generateSample();
        } else {
          this.#pushSample(0, 0);
        }
      }
    }
  }

  #clockFrameSequencer(): void {
    const step = this.#frameSequencerStep;

    // Length counter: clocked at steps 0, 2, 4, 6 (256 Hz)
    if ((step & 1) === 0) {
      this.#ch1.clockLength();
      this.#ch2.clockLength();
      this.#ch3.clockLength();
      this.#ch4.clockLength();
    }

    // Sweep: clocked at steps 2, 6 (128 Hz)
    if (step === 2 || step === 6) {
      this.#ch1.clockSweep();
    }

    // Envelope: clocked at step 7 (64 Hz)
    if (step === 7) {
      this.#ch1.clockEnvelope();
      this.#ch2.clockEnvelope();
      this.#ch4.clockEnvelope();
    }

    this.#frameSequencerStep = (step + 1) & 7;
  }

  /**
   * Mix one output sample in the 10-bit DAC's units. GBATEK "Max Output Levels": "Each of the
   * two FIFOs can span the FULL output range (+/-200h). Each of the four PSGs can span one
   * QUARTER of the output range (+/-80h)." The sum plus SOUNDBIAS is clipped to 0..3FFh, and
   * the sink gets it relative to the bias (mGBA src/gba/audio.c _applyBias), 0x200 = 1.0.
   */
  #generateSample(): void {
    // Get PSG channel outputs (0-15 each)
    const ch1Out = this.#ch1.output;
    const ch2Out = this.#ch2.output;
    const ch3Out = this.#ch3.output;
    const ch4Out = this.#ch4.output;

    // Mix PSG left/right (each channel routed independently)
    let psgLeft = 0;
    let psgRight = 0;

    if (this.#psgEnableLeft & 1) {
      psgLeft += ch1Out;
    }
    if (this.#psgEnableLeft & 2) {
      psgLeft += ch2Out;
    }
    if (this.#psgEnableLeft & 4) {
      psgLeft += ch3Out;
    }
    if (this.#psgEnableLeft & 8) {
      psgLeft += ch4Out;
    }

    if (this.#psgEnableRight & 1) {
      psgRight += ch1Out;
    }
    if (this.#psgEnableRight & 2) {
      psgRight += ch2Out;
    }
    if (this.#psgEnableRight & 4) {
      psgRight += ch3Out;
    }
    if (this.#psgEnableRight & 8) {
      psgRight += ch4Out;
    }

    // A channel at volume 15, master volume 7 and ratio 100% spans 15 * 8 * 8 >> 2 = 240
    // (mGBA src/gb/audio.c GBAudioSamplePSG: (sum << 3) * (1 + volume), then
    // >> (4 - ratio) in src/gba/audio.c GBAAudioSample).
    const psgShift = PSG_RATIO_SHIFT[this.#psgMasterVolume]!;
    psgLeft = ((psgLeft << 3) * (this.#psgVolumeLeft + 1)) >> psgShift;
    psgRight = ((psgRight << 3) * (this.#psgVolumeRight + 1)) >> psgShift;

    // DirectSound: signed 8-bit samples, << 2 spans -0x200..0x1FC at 100%, half at 50%.
    const dsA = (this.#dsA.currentSample << 2) >> (this.#dsA.fullVolume ? 0 : 1);
    const dsB = (this.#dsB.currentSample << 2) >> (this.#dsB.fullVolume ? 0 : 1);

    const left = psgLeft + (this.#dsA.enableLeft ? dsA : 0) + (this.#dsB.enableLeft ? dsB : 0);
    const right = psgRight + (this.#dsA.enableRight ? dsA : 0) + (this.#dsB.enableRight ? dsB : 0);

    this.#pushSample(this.#dacOutput(left), this.#dacOutput(right));
  }

  /** Add SOUNDBIAS, clip to the DAC's 0..3FFh, and scale the level around the bias to the sink's [-1, 1] */
  #dacOutput(level: number): number {
    const dac = Math.min(0x3ff, Math.max(0, level + this.#biasLevel));
    return Math.min(1, Math.max(-1, (dac - this.#biasLevel) / 0x200));
  }

  #pushSample(left: number, right: number): void {
    if (this.#ringSamples >= RING_BUFFER_SIZE) {
      // Buffer full — drop oldest sample
      this.#ringReadPos = (this.#ringReadPos + 2) % (RING_BUFFER_SIZE * 2);
      this.#ringSamples--;
    }
    this.#ringBuffer[this.#ringWritePos] = left;
    this.#ringBuffer[this.#ringWritePos + 1] = right;
    this.#ringWritePos = (this.#ringWritePos + 2) % (RING_BUFFER_SIZE * 2);
    this.#ringSamples++;
  }

  // ─── Audio Output ──────────────────────────────────────────────────

  /**
   * Read interleaved stereo samples into the output buffer.
   * Returns the number of sample frames (pairs) written.
   * The output array should have room for `output.length / 2` stereo pairs.
   */
  readSamples(output: Float32Array): number {
    this.#sync();
    const requestedFrames = Math.floor(output.length / 2);
    const available = Math.min(requestedFrames, this.#ringSamples);

    for (let i = 0; i < available; i++) {
      output[i * 2] = this.#ringBuffer[this.#ringReadPos]!;
      output[i * 2 + 1] = this.#ringBuffer[this.#ringReadPos + 1]!;
      this.#ringReadPos = (this.#ringReadPos + 2) % (RING_BUFFER_SIZE * 2);
    }
    this.#ringSamples -= available;

    // Zero-fill the remainder
    for (let i = available * 2; i < output.length; i++) {
      output[i] = 0;
    }

    return available;
  }

  // ─── Serialization ─────────────────────────────────────────────────

  /**
   * Serialize to a plain snapshot, the APU as it stands at the machine's clock. The output ring
   * buffer is ephemeral audio and stays out of it.
   */
  serialize(): ApuSnapshot {
    this.#sync();
    return {
      ch1: this.#ch1.serialize(),
      ch2: this.#ch2.serialize(),
      ch3: this.#ch3.serialize(),
      ch4: this.#ch4.serialize(),
      dsA: this.#dsA.serialize(),
      dsB: this.#dsB.serialize(),
      frameSequencerTimer: this.#frameSequencerTimer,
      frameSequencerStep: this.#frameSequencerStep,
      sampleTimer: this.#sampleTimer,
      psgVolumeRight: this.#psgVolumeRight,
      psgVolumeLeft: this.#psgVolumeLeft,
      psgEnableRight: this.#psgEnableRight,
      psgEnableLeft: this.#psgEnableLeft,
      psgMasterVolume: this.#psgMasterVolume,
      masterEnable: this.#masterEnable,
      biasLevel: this.#biasLevel,
      biasResolution: this.#biasResolution,
    };
  }

  /** Restore from a snapshot; the machine's clock is already restored to the snapshot's cycle. */
  deserialize(snap: ApuSnapshot): void {
    this.#syncedCycle = this.#clock.currentCycle;
    this.#ch1.deserialize(snap.ch1);
    this.#ch2.deserialize(snap.ch2);
    this.#ch3.deserialize(snap.ch3);
    this.#ch4.deserialize(snap.ch4);
    this.#dsA.deserialize(snap.dsA);
    this.#dsB.deserialize(snap.dsB);
    this.#frameSequencerTimer = snap.frameSequencerTimer;
    this.#frameSequencerStep = snap.frameSequencerStep;
    this.#sampleTimer = snap.sampleTimer;
    this.#psgVolumeRight = snap.psgVolumeRight;
    this.#psgVolumeLeft = snap.psgVolumeLeft;
    this.#psgEnableRight = snap.psgEnableRight;
    this.#psgEnableLeft = snap.psgEnableLeft;
    this.#psgMasterVolume = snap.psgMasterVolume;
    this.#masterEnable = snap.masterEnable;
    this.#biasLevel = snap.biasLevel & 0x3fe;
    this.#biasResolution = snap.biasResolution;

    // Clear the ring buffer (ephemeral audio output)
    this.#ringBuffer.fill(0);
    this.#ringWritePos = 0;
    this.#ringReadPos = 0;
    this.#ringSamples = 0;

    // Re-install timer overflow callbacks
    this.#installTimerCallbacks();
  }

  // ─── Reset ─────────────────────────────────────────────────────────

  reset(): void {
    this.#syncedCycle = this.#clock.currentCycle;
    this.#ch1.reset();
    this.#ch2.reset();
    this.#ch3.reset();
    this.#ch4.reset();
    this.#dsA.reset();
    this.#dsB.reset();

    this.#frameSequencerTimer = 0;
    this.#frameSequencerStep = 0;
    this.#sampleTimer = 0;

    this.#ringBuffer.fill(0);
    this.#ringWritePos = 0;
    this.#ringReadPos = 0;
    this.#ringSamples = 0;

    this.#psgVolumeRight = 0;
    this.#psgVolumeLeft = 0;
    this.#psgEnableRight = 0;
    this.#psgEnableLeft = 0;
    this.#psgMasterVolume = 0;

    this.#masterEnable = false;
    this.#biasLevel = 0x200;
    this.#biasResolution = 0;

    // Re-install timer callbacks if timers are connected
    this.#installTimerCallbacks();
  }
}
