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
 *   0x90-0x9F          Wave RAM (16 bytes)
 *   0xA0  FIFO_A       DirectSound FIFO A (write-only, 32-bit)
 *   0xA4  FIFO_B       DirectSound FIFO B (write-only, 32-bit)
 */
import type { DmaController } from '../dma.js';
import type { ApuSnapshot } from '../savestate.js';
import type { TimerController } from '../timers.js';
import { CPU_FREQ } from '../types.js';
import { DirectSoundChannel } from './direct-sound.js';
import { FRAME_SEQUENCER_PERIOD, PsgChannel1, PsgChannel2, PsgChannel3, PsgChannel4 } from './psg.js';

// ─── Constants ───────────────────────────────────────────────────────

/** Ring buffer capacity in stereo sample pairs */
const RING_BUFFER_SIZE = 4096;

/** Default sample rate for output */
const DEFAULT_SAMPLE_RATE = 32768;

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

  constructor(sampleRate: number = DEFAULT_SAMPLE_RATE) {
    this.#cyclesPerSample = Math.floor(CPU_FREQ / sampleRate);
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

    // Timer 0 callback
    this.#timers.setOverflowCallback(0, () => {
      if (this.#dsA.timerSelect === 0) {
        this.#dsA.popSample();
        if (this.#dsA.needsRefill()) {
          this.#dma?.triggerSoundFifo(1);
        }
      }
      if (this.#dsB.timerSelect === 0) {
        this.#dsB.popSample();
        if (this.#dsB.needsRefill()) {
          this.#dma?.triggerSoundFifo(2);
        }
      }
    });

    // Timer 1 callback
    this.#timers.setOverflowCallback(1, () => {
      if (this.#dsA.timerSelect === 1) {
        this.#dsA.popSample();
        if (this.#dsA.needsRefill()) {
          this.#dma?.triggerSoundFifo(1);
        }
      }
      if (this.#dsB.timerSelect === 1) {
        this.#dsB.popSample();
        if (this.#dsB.needsRefill()) {
          this.#dma?.triggerSoundFifo(2);
        }
      }
    });
  }

  // ─── MMIO Register Access ──────────────────────────────────────────

  /** Read a 16-bit MMIO register (offset relative to 0x04000000) */
  readRegister(offset: number): number {
    switch (offset) {
      case 0x60:
        return this.#ch1.readSweep();
      case 0x62:
        return this.#ch1.readDutyEnvelope();
      case 0x64:
        return this.#ch1.readFreqControl();
      case 0x68:
        return this.#ch2.readDutyEnvelope();
      case 0x6c:
        return this.#ch2.readFreqControl();
      case 0x70:
        return this.#ch3.readControl();
      case 0x72:
        return this.#ch3.readLengthVolume();
      case 0x74:
        return this.#ch3.readFreqControl();
      case 0x78:
        return this.#ch4.readEnvelope();
      case 0x7c:
        return this.#ch4.readFreqControl();
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
          const lo = this.#ch3.readWaveRam(ramOffset);
          const hi = this.#ch3.readWaveRam(ramOffset + 1);
          return lo | (hi << 8);
        }
        return 0;
    }
  }

  /** Write a 16-bit MMIO register (offset relative to 0x04000000) */
  writeRegister(offset: number, value: number): void {
    if (!this.#masterEnable && offset !== 0x84 && offset !== 0x88) {
      // When master sound is disabled, only SOUNDCNT_X and SOUNDBIAS are writable
      return;
    }

    switch (offset) {
      case 0x60:
        this.#ch1.writeSweep(value);
        break;
      case 0x62:
        this.#ch1.writeDutyEnvelope(value);
        break;
      case 0x64:
        this.#ch1.writeFreqControl(value);
        break;
      case 0x68:
        this.#ch2.writeDutyEnvelope(value);
        break;
      case 0x6c:
        this.#ch2.writeFreqControl(value);
        break;
      case 0x70:
        this.#ch3.writeControl(value);
        break;
      case 0x72:
        this.#ch3.writeLengthVolume(value);
        break;
      case 0x74:
        this.#ch3.writeFreqControl(value);
        break;
      case 0x78:
        this.#ch4.writeEnvelope(value);
        break;
      case 0x7c:
        this.#ch4.writeFreqControl(value);
        break;
      case 0x80:
        this.#writeSoundcntL(value);
        break;
      case 0x82:
        this.#writeSoundcntH(value);
        break;
      case 0x84:
        this.#writeSoundcntX(value);
        break;
      case 0x88:
        this.#writeSoundbias(value);
        break;
      default:
        // Wave RAM (0x90-0x9F)
        if (offset >= 0x90 && offset <= 0x9f) {
          const ramOffset = offset - 0x90;
          this.#ch3.writeWaveRam(ramOffset, value & 0xff);
          this.#ch3.writeWaveRam(ramOffset + 1, (value >> 8) & 0xff);
        }
        break;
    }
  }

  /** Handle 32-bit FIFO write from DMA or CPU */
  writeFifo(channel: 0 | 1, value: number): void {
    if (channel === 0) {
      this.#dsA.writeFifo(value);
    } else {
      this.#dsB.writeFifo(value);
    }
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

  #writeSoundcntL(value: number): void {
    this.#psgVolumeRight = value & 7;
    this.#psgVolumeLeft = (value >> 4) & 7;
    this.#psgEnableRight = (value >> 8) & 0xf;
    this.#psgEnableLeft = (value >> 12) & 0xf;
  }

  // ─── SOUNDCNT_H (0x82): DirectSound Control ───────────────────────

  #readSoundcntH(): number {
    return (
      (this.#dsA.fullVolume ? 0 : 0) | // bit 0-1: PSG volume ratio (unused here, stored in mmio)
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

  #writeSoundcntH(value: number): void {
    // bits 0-1: PSG volume ratio (0=25%, 1=50%, 2=100%)
    // (stored in mmioRegisters by system bus for PSG mixing)
    this.#psgMasterVolume = value & 3;

    this.#dsA.fullVolume = (value & (1 << 2)) !== 0;
    this.#dsB.fullVolume = (value & (1 << 3)) !== 0;

    this.#dsA.enableRight = (value & (1 << 8)) !== 0;
    this.#dsA.enableLeft = (value & (1 << 9)) !== 0;
    this.#dsA.timerSelect = (value >> 10) & 1;

    // Bit 11: reset FIFO A
    if (value & (1 << 11)) {
      this.#dsA.resetFifo();
    }

    this.#dsB.enableRight = (value & (1 << 12)) !== 0;
    this.#dsB.enableLeft = (value & (1 << 13)) !== 0;
    this.#dsB.timerSelect = (value >> 14) & 1;

    // Bit 15: reset FIFO B
    if (value & (1 << 15)) {
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
      // Master sound disabled: reset all channels
      this.#ch1.reset();
      this.#ch2.reset();
      this.#ch3.reset();
      this.#ch4.reset();
      this.#psgVolumeRight = 0;
      this.#psgVolumeLeft = 0;
      this.#psgEnableRight = 0;
      this.#psgEnableLeft = 0;
    }
  }

  // ─── SOUNDBIAS (0x88) ─────────────────────────────────────────────

  #readSoundbias(): number {
    return (this.#biasLevel & 0x3ff) | (this.#biasResolution << 14);
  }

  #writeSoundbias(value: number): void {
    this.#biasLevel = value & 0x3ff;
    this.#biasResolution = (value >> 14) & 3;
  }

  // ─── Sample Generation ─────────────────────────────────────────────

  /** Advance APU state by the given number of CPU cycles */
  tick(cycles: number): void {
    if (!this.#masterEnable) {
      this.#sampleTimer += cycles;
      while (this.#sampleTimer >= this.#cyclesPerSample) {
        this.#sampleTimer -= this.#cyclesPerSample;
        this.#pushSample(0, 0);
      }
      return;
    }

    // Clock PSG timers
    this.#ch1.clockTimer(cycles);
    this.#ch2.clockTimer(cycles);
    this.#ch3.clockTimer(cycles);
    this.#ch4.clockTimer(cycles);

    // Frame sequencer
    this.#frameSequencerTimer += cycles;
    while (this.#frameSequencerTimer >= FRAME_SEQUENCER_PERIOD) {
      this.#frameSequencerTimer -= FRAME_SEQUENCER_PERIOD;
      this.#clockFrameSequencer();
    }

    // Output sample
    this.#sampleTimer += cycles;
    while (this.#sampleTimer >= this.#cyclesPerSample) {
      this.#sampleTimer -= this.#cyclesPerSample;
      this.#generateSample();
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

    // Apply PSG per-side volume (0-7 -> multiply by 1-8)
    psgLeft *= this.#psgVolumeLeft + 1;
    psgRight *= this.#psgVolumeRight + 1;

    // Apply PSG master volume ratio from SOUNDCNT_H bits 0-1
    // 0=25%, 1=50%, 2=100%, 3=forbidden (treat as 100%)
    const psgShift = this.#psgMasterVolume >= 2 ? 0 : 2 - this.#psgMasterVolume;
    psgLeft >>= psgShift;
    psgRight >>= psgShift;

    // DirectSound samples: signed 8-bit (-128..127)
    const dsASample = this.#dsA.currentSample;
    const dsBSample = this.#dsB.currentSample;

    // DirectSound volume: 50% or 100%
    const dsALeft = this.#dsA.enableLeft ? (this.#dsA.fullVolume ? dsASample : dsASample >> 1) : 0;
    const dsARight = this.#dsA.enableRight ? (this.#dsA.fullVolume ? dsASample : dsASample >> 1) : 0;
    const dsBLeft = this.#dsB.enableLeft ? (this.#dsB.fullVolume ? dsBSample : dsBSample >> 1) : 0;
    const dsBRight = this.#dsB.enableRight ? (this.#dsB.fullVolume ? dsBSample : dsBSample >> 1) : 0;

    // Mix: PSG range ~0..960, DirectSound range ~-128..127
    // Normalize PSG to roughly same scale as DirectSound: PSG max = 15*8*4 = 480
    // SOUNDBIAS adds a DC offset; final range is 0..0x3FF (10-bit)
    let left = psgLeft / 4 + dsALeft + dsBLeft;
    let right = psgRight / 4 + dsARight + dsBRight;

    // Apply bias
    left += this.#biasLevel;
    right += this.#biasLevel;

    // Clamp to 10-bit range (0..0x3FF)
    left = Math.max(0, Math.min(0x3ff, left));
    right = Math.max(0, Math.min(0x3ff, right));

    // Convert to float [-1.0, 1.0]: center at bias, then amplify.
    // The GBA's 10-bit DAC range (0-0x3FF) with bias at 0x200 maps audio to ±0x200.
    // DirectSound's max amplitude is ±128, which is only 25% of that range.
    // Apply 4× gain to bring DirectSound-heavy audio to comfortable levels.
    const floatLeft = Math.max(-1, Math.min(1, ((left - 0x200) / 0x200) * 4));
    const floatRight = Math.max(-1, Math.min(1, ((right - 0x200) / 0x200) * 4));

    this.#pushSample(floatLeft, floatRight);
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

  /** Serialize to a plain snapshot (ring buffer is NOT saved — it's ephemeral audio). */
  serialize(): ApuSnapshot {
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

  /** Restore from a snapshot. Re-installs timer callbacks. */
  deserialize(snap: ApuSnapshot): void {
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
    this.#biasLevel = snap.biasLevel;
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
