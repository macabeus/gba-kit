import { describe, expect, it } from 'vitest';

import { Apu } from '../apu/apu.js';
import { FRAME_SEQUENCER_PERIOD, PsgChannel2, PsgChannel3, PsgChannel4 } from '../apu/psg.js';
import { Gba } from '../gba.js';
import type { TimerController } from '../timers.js';
import { CPU_FREQ } from '../types.js';

const IO = 0x04000000;

/** A machine with master sound on; the sound registers ignore writes until then. */
function soundOn(): Gba {
  const gba = new Gba();
  gba.bus.write8(IO + 0x84, 0x80);
  return gba;
}

/** Count rising edges of `output` while clocking `cycles` CPU cycles in `step`-cycle slices. */
function risingEdges(channel: { clockTimer(c: number): void; output: number }, cycles: number, step: number): number {
  let edges = 0;
  let last = channel.output;
  for (let t = 0; t < cycles; t += step) {
    channel.clockTimer(step);
    const now = channel.output;
    if (now > last) {
      edges++;
    }
    last = now;
  }
  return edges;
}

/** FIFO A's queued bytes, oldest first. */
function fifoABytes(gba: Gba): number[] {
  const fifo = gba.apu.serialize().dsA;
  return Array.from({ length: fifo.size }, (_, i) => fifo.buffer[(fifo.readIndex + i) & 31]! & 0xff);
}

/** A stand-in for the machine's clock, which a test moves by hand. */
interface TestClock {
  currentCycle: number;
}

/**
 * An Apu on a stand-in clock and stand-in timers, so a test pops FIFO samples by calling the timer
 * 0 overflow callback; master sound on, SOUNDBIAS at its default 0x200.
 */
function apuWithTimers(): { apu: Apu; clock: TestClock; overflowTimer0: () => void } {
  const callbacks: Array<(at: number) => void> = [];
  const timers = {
    setOverflowCallback: (index: number, cb: (at: number) => void) => {
      callbacks[index] = cb;
    },
  } as unknown as TimerController;
  const clock: TestClock = { currentCycle: 0 };
  const apu = new Apu(clock);
  apu.connectTimers(timers);
  apu.writeRegister8(0x84, 0x80);
  return { apu, clock, overflowTimer0: () => callbacks[0]!(clock.currentCycle) };
}

/** Run the clock for `samples` output samples (512 cycles each at 32768 Hz) and return the left channel. */
function leftSamples({ apu, clock }: { apu: Apu; clock: TestClock }, samples: number): number[] {
  clock.currentCycle += 512 * samples;
  const out = new Float32Array(samples * 2);
  const n = apu.readSamples(out);
  return Array.from({ length: n }, (_, i) => out[i * 2]!);
}

describe('PSG timers run on the GBA clock', () => {
  it('channel 2 at n=1750 plays 131072/(2048-n) ≈ 440 Hz', () => {
    // GBATEK SOUND2CNT_H: "Frequency = 131072/(2048-n)Hz".
    const ch2 = new PsgChannel2();
    ch2.writeLengthDuty(0x80); // 50% duty
    ch2.writeEnvelope(0xf0); // volume 15, no envelope
    ch2.writeFrequencyLow(1750 & 0xff);
    ch2.writeFrequencyHigh(0x80 | (1750 >> 8));
    const edges = risingEdges(ch2, CPU_FREQ, 16);
    expect(Math.abs(edges - 131072 / (2048 - 1750))).toBeLessThanOrEqual(1);
  });

  it('channel 3 at n=0 steps 2097152/2048 = 1024 digits a second', () => {
    // GBATEK SOUND3CNT_X: "Sample Rate; 2097152/(2048-n) Hz". One pulse per 32 digits → 32 Hz.
    const ch3 = new PsgChannel3();
    ch3.writeControl(0x40); // select bank 1, so the CPU writes bank 0
    ch3.writeWaveRam(0, 0xf0);
    ch3.writeControl(0x80); // play bank 0
    ch3.writeVolume(0x20); // 100%
    ch3.writeFrequencyHigh(0x80);
    expect(risingEdges(ch3, CPU_FREQ, 8)).toBe(32);
  });

  it('channel 4 steps its LFSR every 32 << s cycles for r=0 and 64 * r << s otherwise', () => {
    // GBATEK SOUND4CNT_H: "Frequency = 524288 Hz / r / 2^(s+1) ;For r=0 assume r=0.5 instead".
    const lfsrAfter = (nr43: number, cycles: number): number => {
      const ch4 = new PsgChannel4();
      ch4.writeEnvelope(0xf0);
      ch4.writeFrequency(nr43);
      ch4.writeControl(0x80);
      ch4.clockTimer(cycles);
      return ch4.serialize().lfsr;
    };
    expect(lfsrAfter(0x00, 31)).toBe(0x7fff);
    expect(lfsrAfter(0x00, 32)).not.toBe(0x7fff);
    // r=1, s=2: 64 << 2 = 256 cycles
    expect(lfsrAfter(0x21, 255)).toBe(0x7fff);
    expect(lfsrAfter(0x21, 256)).not.toBe(0x7fff);
  });
});

describe('sound registers take byte writes natively', () => {
  it('a byte store to NR23 sets the frequency and leaves an expired channel 2 stopped', () => {
    const gba = soundOn();
    gba.bus.write8(IO + 0x69, 0xf0); // NR22: volume 15
    gba.bus.write8(IO + 0x68, 0x3f); // NR21: length 1
    gba.bus.write8(IO + 0x6d, 0xc0); // NR24: length enable + restart
    expect(gba.bus.read16(IO + 0x84) & 2).toBe(2);

    gba.scheduler.advance(FRAME_SEQUENCER_PERIOD * 2); // a length clock expires the channel
    expect(gba.bus.read16(IO + 0x84) & 2).toBe(0);

    gba.bus.write8(IO + 0x6c, 0x55); // NR23
    expect(gba.bus.read16(IO + 0x84) & 2).toBe(0);
    expect(gba.apu.serialize().ch2.frequency).toBe(0x055);
  });

  it('a byte store to NR12 leaves the length counter alone', () => {
    const gba = soundOn();
    gba.bus.write8(IO + 0x62, 50); // NR11: length 64 - 50 = 14
    gba.bus.write8(IO + 0x63, 0xf0); // NR12
    expect(gba.apu.serialize().ch1.lengthCounter).toBe(14);
  });

  it('a byte store to SOUNDCNT_H low leaves the FIFOs; the reset bit in the high byte clears FIFO A', () => {
    const gba = soundOn();
    gba.bus.write32(IO + 0xa0, 0x04030201);
    gba.bus.write32(IO + 0xa0, 0x08070605);
    gba.bus.write8(IO + 0x82, 0x0e);
    expect(fifoABytes(gba)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    gba.bus.write8(IO + 0x83, 0x08);
    expect(fifoABytes(gba)).toEqual([]);
  });

  it('a halfword store to SOUND1CNT_X writes the frequency and then restarts', () => {
    const gba = soundOn();
    gba.bus.write16(IO + 0x62, 0xf000);
    gba.bus.write16(IO + 0x64, 0x8000 | 0x6a5);
    expect(gba.apu.serialize().ch1.frequency).toBe(0x6a5);
    expect(gba.bus.read16(IO + 0x84) & 1).toBe(1);
  });
});

describe('DirectSound FIFO writes', () => {
  it('each write of any width queues one word, merged into the FIFO latch', () => {
    // mGBA src/gba/io.c GBAIOWrite FIFO_A_LO/FIFO_A_HI: each halfword completes a word with
    // the other half and queues it.
    const gba = new Gba();
    gba.bus.write16(IO + 0xa0, 0x2211);
    gba.bus.write16(IO + 0xa2, 0x4433);
    expect(fifoABytes(gba)).toEqual([0x11, 0x22, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44]);

    gba.bus.write8(IO + 0xa1, 0x99);
    expect(fifoABytes(gba).slice(8)).toEqual([0x11, 0x99, 0x33, 0x44]);

    gba.bus.write32(IO + 0xa0, 0x0d0c0b0a);
    expect(fifoABytes(gba).slice(12)).toEqual([0x0a, 0x0b, 0x0c, 0x0d]);
  });

  it('a halfword store to FIFO_B_H reaches FIFO B', () => {
    const gba = new Gba();
    gba.bus.write16(IO + 0xa6, 0x4433);
    expect(gba.apu.serialize().dsB.size).toBe(4);
    expect(gba.apu.serialize().dsA.size).toBe(0);
  });
});

describe('channel 3', () => {
  it('SOUND3CNT_H bit 15 forces 75% volume over the volume code', () => {
    // GBATEK SOUND3CNT_H: "15 R/W Force Volume (0=Use above, 1=Force 75% regardless of above)".
    const ch3 = new PsgChannel3();
    ch3.writeControl(0x40);
    for (let i = 0; i < 16; i++) {
      ch3.writeWaveRam(i, 0xff);
    }
    ch3.writeControl(0x80);
    ch3.writeVolume(0x80); // volume code 0 (mute), force 75%
    ch3.writeFrequencyHigh(0x80);
    expect(ch3.output).toBe((15 * 3) >> 2);
    expect(ch3.readVolume()).toBe(0x80);
  });

  it('the CPU reads and writes the bank not selected for playback', () => {
    // GBATEK SOUND3CNT_L: "The currently selected Bank Number (Bit 6) will be played back,
    // while reading/writing to/from wave RAM will address the other (not selected) bank."
    const gba = soundOn();
    gba.bus.write8(IO + 0x70, 0x40); // bank 1 selected → the CPU sees bank 0
    gba.bus.write16(IO + 0x90, 0xbeef);
    gba.bus.write8(IO + 0x70, 0x00); // bank 0 selected → the CPU sees bank 1
    expect(gba.bus.read16(IO + 0x90)).toBe(0);
    gba.bus.write16(IO + 0x90, 0x1234);
    gba.bus.write8(IO + 0x70, 0x40);
    expect(gba.bus.read16(IO + 0x90)).toBe(0xbeef);
    expect(Array.from(gba.apu.serialize().ch3.waveRam.slice(0, 2))).toEqual([0xef, 0xbe]);
    expect(Array.from(gba.apu.serialize().ch3.waveRam.slice(16, 18))).toEqual([0x34, 0x12]);
  });

  it('plays the selected bank, and both banks as 64 digits in dimension mode', () => {
    const ch3 = new PsgChannel3();
    ch3.writeControl(0x40); // the CPU fills bank 0 with 0xF
    for (let i = 0; i < 16; i++) {
      ch3.writeWaveRam(i, 0xff);
    }
    ch3.writeVolume(0x20);

    ch3.writeControl(0xc0); // play bank 1 (zeros)
    ch3.writeFrequencyHigh(0x80);
    expect(ch3.output).toBe(0);
    ch3.writeControl(0x80); // play bank 0
    expect(ch3.output).toBe(15);
    // one bank of constant digits never toggles
    expect(risingEdges(ch3, CPU_FREQ / 4, 8)).toBe(0);

    ch3.writeControl(0xa0); // dimension: 32 digits of 0xF then 32 of 0 → 1024 / 64 = 16 Hz
    ch3.writeFrequencyHigh(0x80);
    expect(risingEdges(ch3, CPU_FREQ, 8)).toBe(16);
  });
});

describe('master sound enable', () => {
  it('SOUNDCNT_H, SOUNDBIAS and wave RAM stay writable while sound is off; the PSG registers ignore writes', () => {
    // GBATEK SOUNDCNT_X: "registers 4000082h and 4000088h are kept read/write-able".
    const gba = new Gba();
    gba.bus.write16(IO + 0x82, 0x0b0e);
    expect(gba.bus.read16(IO + 0x82)).toBe(0x030e);
    gba.bus.write16(IO + 0x88, 0x0100);
    expect(gba.bus.read16(IO + 0x88)).toBe(0x0100);
    gba.bus.write16(IO + 0x90, 0x5678);
    expect(gba.bus.read16(IO + 0x90)).toBe(0x5678);
    gba.bus.write16(IO + 0x80, 0xff77);
    expect(gba.bus.read16(IO + 0x80)).toBe(0);
  });

  it('turning sound off zeroes the PSG registers and keeps wave RAM', () => {
    const gba = soundOn();
    gba.bus.write16(IO + 0x80, 0xff77);
    gba.bus.write8(IO + 0x70, 0x00);
    gba.bus.write16(IO + 0x90, 0x1234);
    gba.bus.write8(IO + 0x84, 0x00);
    expect(gba.bus.read16(IO + 0x80)).toBe(0);
    // NR30 is now 0, so the CPU still sees bank 1
    expect(gba.bus.read16(IO + 0x90)).toBe(0x1234);
    gba.bus.write8(IO + 0x84, 0x80);
    expect(gba.bus.read16(IO + 0x90)).toBe(0x1234);
  });
});

describe('sound register read masks', () => {
  it('write-only and unused bits read as 0', () => {
    // GBATEK "GBA Sound Channel 1-4" / "GBA Sound Control Registers"; mGBA src/gba/io.c
    // GBAIOWrite stores each register with these masks.
    const gba = soundOn();
    const masks: Array<[number, number]> = [
      [0x60, 0x007f],
      [0x62, 0xffc0],
      [0x64, 0x4000],
      [0x68, 0xffc0],
      [0x6c, 0x4000],
      [0x70, 0x00e0],
      [0x72, 0xe000],
      [0x74, 0x4000],
      [0x78, 0xff00],
      [0x7c, 0x40ff],
      [0x80, 0xff77],
      [0x82, 0x770f],
      [0x88, 0xc3fe],
    ];
    for (const [offset, mask] of masks) {
      gba.bus.write16(IO + offset, 0xffff);
      expect([offset, gba.bus.read16(IO + offset)]).toEqual([offset, mask]);
    }
  });
});

describe('mixer', () => {
  it('a FIFO spans the full ±0x200 at 100% and half of it at 50%', () => {
    // GBATEK "Max Output Levels": "Each of the two FIFOs can span the FULL output range (+/-200h)."
    const machine = apuWithTimers();
    const { apu, overflowTimer0 } = machine;
    apu.writeRegister32(0xa0, 0x7f7f7f7f);
    apu.writeRegister16(0x82, 0x0304); // FIFO A 100%, left + right, timer 0
    overflowTimer0();
    expect(leftSamples(machine, 1)).toEqual([508 / 512]);

    apu.writeRegister8(0x82, 0x00); // 50%
    expect(leftSamples(machine, 1)).toEqual([254 / 512]);
  });

  it('the sum clips at the 10-bit DAC range around the bias', () => {
    const machine = apuWithTimers();
    const { apu, overflowTimer0 } = machine;
    apu.writeRegister32(0xa0, 0x7f7f7f7f);
    apu.writeRegister32(0xa4, 0x7f7f7f7f);
    apu.writeRegister16(0x82, 0x330c); // A and B at 100%, both sides, timer 0
    overflowTimer0();
    // 508 + 508 + 0x200 clips at 0x3FF
    expect(leftSamples(machine, 1)).toEqual([0x1ff / 0x200]);

    apu.writeRegister32(0xa0, 0x80808080);
    apu.writeRegister32(0xa4, 0x80808080);
    overflowTimer0();
    overflowTimer0();
    overflowTimer0();
    overflowTimer0();
    overflowTimer0();
    // -512 - 512 + 0x200 clips at 0
    expect(leftSamples(machine, 1)).toEqual([-1]);
  });

  it('silence is 0 whatever SOUNDBIAS is', () => {
    const machine = apuWithTimers();
    const { apu } = machine;
    apu.writeRegister16(0x88, 0x0000);
    expect(leftSamples(machine, 4)).toEqual([0, 0, 0, 0]);
    apu.writeRegister16(0x88, 0x0100);
    expect(leftSamples(machine, 4)).toEqual([0, 0, 0, 0]);
  });

  it('one PSG channel at full volume spans a quarter of the range', () => {
    // GBATEK "Max Output Levels": "Each of the four PSGs can span one QUARTER of the output
    // range (+/-80h)." mGBA reaches 15 * 8 * 8 >> 2 = 240.
    const machine = apuWithTimers();
    const { apu } = machine;
    apu.writeRegister16(0x80, 0x2277); // master volume 7 both sides, channel 2 left + right
    apu.writeRegister8(0x82, 0x02); // PSG at 100%
    apu.writeRegister16(0x68, 0xf080); // 50% duty, volume 15
    apu.writeRegister16(0x6c, 0x8000 | 1750);
    const samples = leftSamples(machine, 512);
    expect(Math.max(...samples)).toBe(240 / 512);
    expect(Math.min(...samples)).toBe(0);
  });
});

describe('the APU runs on the machine clock', () => {
  /** A machine running `b .` from ROM while HBlank DMA3 copies 32 words in EWRAM on every visible line. */
  function busyWithHBlankDma(): Gba {
    const gba = new Gba();
    gba.loadRom(new Uint8Array([0xfe, 0xff, 0xff, 0xea])); // b .
    gba.bus.write32(0x040000d4, 0x02000000); // DMA3SAD
    gba.bus.write32(0x040000d8, 0x02001000); // DMA3DAD
    gba.bus.write16(0x040000dc, 32); // DMA3CNT_L
    gba.bus.write16(0x040000de, 0x8000 | (2 << 12) | (1 << 10) | (1 << 9)); // enable, HBlank, 32-bit, repeat
    return gba;
  }

  it('makes one sample per 512 cycles of the machine, the cycles a DMA holds the bus included', () => {
    // The machine makes CPU_FREQ / 32768 = 512 cycles per output sample, whoever spends them:
    // here a third of each visible line goes to DMA (mGBA audio.c GBAAudioSample samples up to the
    // timestamp of the machine's clock).
    const gba = busyWithHBlankDma();
    const out = new Float32Array(2048);
    let samples = 0;
    const start = gba.scheduler.currentCycle;
    for (let frame = 0; frame < 30; frame++) {
      gba.runFrame();
      samples += gba.apu.readSamples(out);
    }
    expect(gba.dma.serialize().channels[3]!.enabled).toBe(true);
    expect(samples).toBe(Math.floor((gba.scheduler.currentCycle - start) / 512));
  });

  it('restores to the same stream of samples', () => {
    const a = busyWithHBlankDma();
    a.runFrame();
    const b = new Gba();
    b.loadRom(new Uint8Array([0xfe, 0xff, 0xff, 0xea]));
    b.deserialize(a.serialize());
    a.apu.readSamples(new Float32Array(4096));
    b.apu.readSamples(new Float32Array(4096));
    a.runFrame();
    b.runFrame();
    const outA = new Float32Array(2048);
    const outB = new Float32Array(2048);
    expect(b.apu.readSamples(outB)).toBe(a.apu.readSamples(outA));
    expect(b.serialize().apu).toEqual(a.serialize().apu);
  });

  it('a snapshot without APU state restores the APU at power-on, following the restored clock', () => {
    const gba = busyWithHBlankDma();
    gba.runFrame();
    const snap = gba.serialize();
    delete snap.apu;
    for (let frame = 0; frame < 10; frame++) {
      gba.runFrame();
    }
    gba.deserialize(snap);
    expect(gba.serialize().apu).toEqual(new Gba().serialize().apu);
    const restoredAt = gba.scheduler.currentCycle;
    const out = new Float32Array(2048);
    let samples = 0;
    for (let frame = 0; frame < 2; frame++) {
      gba.runFrame();
      samples += gba.apu.readSamples(out);
    }
    expect(samples).toBe(Math.floor((gba.scheduler.currentCycle - restoredAt) / 512));
  });
});
