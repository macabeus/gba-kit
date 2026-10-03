/**
 * GBA DMA Controller
 *
 * 4 DMA channels with priority (0 highest, 3 lowest).
 * Supports immediate, VBlank, HBlank, and special (sound FIFO, video capture) start modes.
 *
 * A channel copies SAD, DAD and CNT_L into its internal counters when its enable bit goes from 0
 * to 1 (GBATEK "DMA Transfers": "Upon DMA Enable (Bit 15) changing from 0 to 1: Reloads SAD, DAD,
 * CNT_L"). Each unit passes through the channel's data latch; for a source below EWRAM (the BIOS
 * and the unused region after it) the channel skips the read and writes what the latch holds from
 * its last read (mGBA dma.c GBADMAService; mgba-suite "DMA tests").
 *
 * The channels share one bus master. A channel asks for the bus 3 cycles after its trigger, a
 * sound FIFO channel as soon as its FIFO asks for data (mGBA audio.c GBAAudioSampleFIFO), and
 * once one has it the CPU stops until no channel is left. That run begins and ends with an
 * internal cycle, 2I however many channels it serves back to back (GBATEK "DMA Transfers":
 * "Internal time for DMA processing is 2I"; NanoBoyAdvance dma.cc Run). It moves one unit at a
 * time, a read then a write, always for the highest-priority channel that is waiting, so a
 * channel triggered mid-transfer takes over at the next unit and the lower one resumes after it
 * (GBATEK: "DMA Channels with lower priority are paused until channels with higher priority have
 * completed"; mGBA dma.c re-arbitrates after every unit). Every access is sequential but a
 * channel's first one to the game pak (NanoBoyAdvance dma.cc RunChannel), which gives the times
 * mgba-suite's Timing "DMA" rows measured on hardware. The clock moves with each unit, so an
 * event that comes due during a transfer fires after the unit it falls in, and the transfer
 * resumes once it has.
 */
import type { InterruptController } from './interrupts.js';
import type { DmaSnapshot } from './savestate.js';
import type { Scheduler } from './scheduler.js';
import { DmaAddrControl, DmaStartTiming, EventId, IrqFlag } from './types.js';
import type { WriteOrigin } from './write-source.js';

/** State for a single DMA channel */
interface DmaChannel {
  /** Source address (internal, updated during transfer) */
  srcAddr: number;
  /** Destination address (internal, updated during transfer) */
  dstAddr: number;
  /** Latched source address (written by CPU) */
  srcLatch: number;
  /** Latched destination address (written by CPU) */
  dstLatch: number;
  /** Units the current transfer has left to move (internal, updated during transfer) */
  wordCount: number;
  /** Latched word count (DMAx_CNT_L: 14-bit for DMA0-2, 16-bit for DMA3) */
  wordCountLatch: number;
  /** Destination address control */
  dstControl: DmaAddrControl;
  /** Source address control */
  srcControl: DmaAddrControl;
  /** Repeat mode (for HBlank/VBlank/Special) */
  repeat: boolean;
  /** Transfer width: false = 16-bit, true = 32-bit */
  wordSize: boolean;
  /** Start timing */
  startTiming: DmaStartTiming;
  /** Game Pak DRQ (DMA3CNT_H bit 11), stored and read back; on DMA0-2 bit 11 reads 0 */
  gamePakDrq: boolean;
  /** IRQ on completion */
  irqEnable: boolean;
  /** DMA enabled */
  enabled: boolean;
  /** Instruction that last enabled this channel (the origin of its writes for watchpoints). */
  startOrigin: WriteOrigin;
  /** The last unit read, both halves equal after a 16-bit read; what an unreadable source gives. */
  latch: number;
}

const ZERO_ORIGIN: WriteOrigin = { pc: 0, instructionAddress: 0, thumb: false };

/** Memory read/write functions injected from the system bus */
export interface DmaMemoryAccess {
  read16(address: number): number;
  read32(address: number): number;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
  /** Current CPU location, captured on channel enable to attribute its writes (watchpoints). */
  getOrigin?(): WriteOrigin;
  /** Mark/unmark subsequent writes as coming from a DMA channel (watchpoints). */
  setDmaSource?(channel: number, origin: WriteOrigin): void;
  clearDmaSource?(): void;
  /** One access made now, and the cycles it takes (the bus's `dataCycles`). */
  dataCycles(address: number, width: 2 | 4, sequential: boolean): number;
  /** Cycles in which the channel holds the bus without an access (the bus's `idle`). */
  idle(cycles: number): void;
}

/** Cycles from a channel's trigger to its request for the bus (mGBA GBADMAWriteCNT_HI: "DMAs take 3 cycles to start"). */
const DMA_START_DELAY = 3;

/** The internal cycle a run begins with, and the one it ends with. */
const RUN_EDGE_CYCLES = 1;

/** Where the game pak's address space begins. */
const CARTRIDGE_BASE = 0x08000000;

/** Where the game pak's ROM mirrors end and SRAM begins. A source in the ROM always increments. */
const SRAM_BASE = 0x0e000000;

/** The lowest source a DMA reads; below it the channel writes its latch (mGBA GBADMAService, `source >= GBA_BASE_EWRAM`). */
const READABLE_BASE = 0x02000000;

/** Sound FIFO DMA moves 4 words per request, whatever CNT_L and the width bit say (GBATEK "Sound DMA"). */
const FIFO_UNITS = 4;

/** Video capture runs on lines 2-161 and stops when VCOUNT reaches 162 (GBATEK "Video Capture Mode"). */
const CAPTURE_FIRST_LINE = 2;
const CAPTURE_END_LINE = 162;

const DMA_EVENT_IDS = [EventId.Dma0, EventId.Dma1, EventId.Dma2, EventId.Dma3] as const;
const DMA_IRQ_FLAGS = [IrqFlag.Dma0, IrqFlag.Dma1, IrqFlag.Dma2, IrqFlag.Dma3] as const;

/** What a DMA transfer is about to do, as reported to {@link DmaController.onTransfer}. */
export interface DmaTransferInfo {
  source: number;
  destination: number;
  /** Transfer units (halfwords or words) */
  count: number;
  wordSize: 2 | 4;
  timing: DmaStartTiming;
  /** Instruction that enabled the channel */
  origin: WriteOrigin;
}

export class DmaController {
  readonly #channels: DmaChannel[] = [];
  readonly #scheduler: Scheduler;
  readonly #interrupts: InterruptController;
  #memory: DmaMemoryAccess | undefined;

  /** The channels that asked for the bus and have units left, bit n for DMAn. */
  #waiting = 0;
  /** Whether a run holds the bus: it has spent the internal cycle it begins with. */
  #running = false;
  /** The channel that moved the run's last unit, -1 before the first. */
  #current = -1;
  /** Whether that channel has made its nonsequential game pak access since it took the bus. */
  #gamePakAccessed = false;
  /** Whether the run is moving units now; a channel that asks then waits for the next unit. */
  #moving = false;
  /** The unit the run last moved, as the bus carried it: a halfword on both halves. */
  #busValue = 0;

  constructor(scheduler: Scheduler, interrupts: InterruptController) {
    this.#scheduler = scheduler;
    this.#interrupts = interrupts;

    for (let i = 0; i < 4; i++) {
      this.#channels.push({
        srcAddr: 0,
        dstAddr: 0,
        srcLatch: 0,
        dstLatch: 0,
        wordCount: 0,
        wordCountLatch: 0,
        dstControl: DmaAddrControl.Increment,
        srcControl: DmaAddrControl.Increment,
        repeat: false,
        wordSize: false,
        startTiming: DmaStartTiming.Immediately,
        gamePakDrq: false,
        irqEnable: false,
        enabled: false,
        startOrigin: ZERO_ORIGIN,
        latch: 0,
      });
    }
  }

  /** Set memory access functions (called during system bus setup to break circular dep) */
  setMemoryAccess(memory: DmaMemoryAccess): void {
    this.#memory = memory;
  }

  /** DMAx_SAD as last written. The register is write-only: the CPU reads open bus there, a debugger reads this. */
  readSrcLatch(index: number): number {
    return this.#channels[index]!.srcLatch;
  }

  /** DMAx_DAD as last written (write-only, like DMAx_SAD). */
  readDstLatch(index: number): number {
    return this.#channels[index]!.dstLatch;
  }

  /** DMAx_CNT_L as last written (write-only: the CPU reads 0 there). */
  readWordCountLatch(index: number): number {
    return this.#channels[index]!.wordCountLatch;
  }

  /** Write source address (DMAx_SAD) — 27-bit for DMA0, 28-bit for DMA1-3 */
  writeSrcAddr(index: number, value: number): void {
    const mask = index === 0 ? 0x07ffffff : 0x0fffffff;
    this.#channels[index]!.srcLatch = value & mask;
  }

  /** Write destination address (DMAx_DAD) — 27-bit for DMA0-2, 28-bit for DMA3 */
  writeDstAddr(index: number, value: number): void {
    const mask = index === 3 ? 0x0fffffff : 0x07ffffff;
    this.#channels[index]!.dstLatch = value & mask;
  }

  /** Write word count (DMAx_CNT_L) */
  writeWordCount(index: number, value: number): void {
    const mask = index === 3 ? 0xffff : 0x3fff;
    this.#channels[index]!.wordCountLatch = value & mask;
  }

  /** Read control register (DMAx_CNT_H) */
  readControl(index: number): number {
    const ch = this.#channels[index]!;
    return (
      ((ch.dstControl & 3) << 5) |
      ((ch.srcControl & 3) << 7) |
      (ch.repeat ? 1 << 9 : 0) |
      (ch.wordSize ? 1 << 10 : 0) |
      (ch.gamePakDrq ? 1 << 11 : 0) |
      ((ch.startTiming & 3) << 12) |
      (ch.irqEnable ? 1 << 14 : 0) |
      (ch.enabled ? 1 << 15 : 0)
    );
  }

  /**
   * Write control register (DMAx_CNT_H). The control bits take effect at once; the internal
   * counters reload, and an immediate transfer starts, only when the write sets a clear enable bit
   * (mGBA dma.c GBADMAWriteCNT_HI, `!wasEnabled`), so rewriting a running channel's control leaves
   * its addresses and count where the transfer has brought them.
   */
  writeControl(index: number, value: number): void {
    const ch = this.#channels[index]!;
    const wasEnabled = ch.enabled;

    ch.dstControl = ((value >> 5) & 3) as DmaAddrControl;
    ch.srcControl = ((value >> 7) & 3) as DmaAddrControl;
    ch.repeat = (value & (1 << 9)) !== 0;
    ch.wordSize = (value & (1 << 10)) !== 0;
    ch.gamePakDrq = index === 3 && (value & (1 << 11)) !== 0;
    ch.startTiming = ((value >> 12) & 3) as DmaStartTiming;
    ch.irqEnable = (value & (1 << 14)) !== 0;
    ch.enabled = (value & (1 << 15)) !== 0;

    if (!wasEnabled && ch.enabled) {
      // Capture the instruction that started this DMA (for watchpoint attribution).
      ch.startOrigin = this.#memory?.getOrigin?.() ?? ZERO_ORIGIN;
      // The internal address counters are aligned to the transfer width, so a misaligned SAD/DAD
      // loses its low bits here (mGBA GBADMAWriteCNT_HI: `nextSource &= -width`). Sound FIFO DMA
      // moves words.
      const alignMask = ch.wordSize || this.#isSoundFifo(index) ? ~3 : ~1;
      ch.srcAddr = (ch.srcLatch & alignMask) >>> 0;
      ch.dstAddr = (ch.dstLatch & alignMask) >>> 0;
      ch.wordCount = this.#unitsPerTransfer(index);

      if (ch.startTiming === DmaStartTiming.Immediately) {
        this.#scheduleTransfer(index, this.#scheduler.currentCycle);
      }
    } else if (wasEnabled && !ch.enabled) {
      this.#scheduler.cancel(DMA_EVENT_IDS[index]!);
      this.#waiting &= ~(1 << index);
    }
  }

  /**
   * What the data bus carries after a channel moved a unit, until the CPU drives it again: an
   * open-bus read while a DMA runs, and in the instruction right after it, returns this (mGBA
   * dma.c GBADMAService sets `gba->bus` after every unit; memory.c GBALoadBad; mgba-suite Misc
   * edge "DMA Prefetch").
   */
  get busValue(): number {
    return this.#busValue;
  }

  /** What a transfer moves: CNT_L units, 0 meaning the most there are, and always 4 words for a sound FIFO. */
  #unitsPerTransfer(index: number): number {
    if (this.#isSoundFifo(index)) {
      return FIFO_UNITS;
    }
    const count = this.#channels[index]!.wordCountLatch;
    return count === 0 ? (index === 3 ? 0x10000 : 0x4000) : count;
  }

  /** Trigger the DMA channels waiting for `timing`, which occurred at the cycle `at`. */
  trigger(timing: DmaStartTiming, at: number): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.#channels[i]!;
      if (ch.enabled && ch.startTiming === timing) {
        this.#scheduleTransfer(i, at);
      }
    }
  }

  /**
   * The sound FIFO at `fifoAddress` (FIFO_A or FIFO_B) asks for data: the DMA1 or DMA2 in Special
   * timing whose destination is that FIFO moves 4 words into it (GBATEK "Sound DMA": the
   * destination "must be FIFO_A (040000A0h) or FIFO_B (040000A4h)"; mGBA audio.c
   * GBAAudioScheduleFifoDma binds the FIFO to the channel by its destination).
   */
  requestSoundFifo(fifoAddress: number): void {
    for (let i = 1; i <= 2; i++) {
      const ch = this.#channels[i]!;
      if (ch.enabled && ch.startTiming === DmaStartTiming.Special && ch.dstAddr === fifoAddress) {
        this.#requestBus(i);
        return;
      }
    }
  }

  /**
   * The LCD began `line` at the cycle `at`. DMA3 in Special timing is video capture: it starts a
   * transfer as each line from 2 to 161 begins, and the hardware clears its enable bit when VCOUNT
   * reaches 162 (GBATEK "Video Capture Mode"; NanoBoyAdvance ppu.cc UpdateVideoTransferDMA).
   */
  triggerVideoCapture(line: number, at: number): void {
    const ch = this.#channels[3]!;
    if (!ch.enabled || ch.startTiming !== DmaStartTiming.Special) {
      return;
    }
    if (line >= CAPTURE_FIRST_LINE && line < CAPTURE_END_LINE) {
      this.#scheduleTransfer(3, at);
    } else if (line === CAPTURE_END_LINE) {
      ch.enabled = false;
      this.#scheduler.cancel(DMA_EVENT_IDS[3]!);
      this.#waiting &= ~(1 << 3);
    }
  }

  /** DMA1 and DMA2 in Special timing serve the sound FIFOs. */
  #isSoundFifo(index: number): boolean {
    return (index === 1 || index === 2) && this.#channels[index]!.startTiming === DmaStartTiming.Special;
  }

  #scheduleTransfer(index: number, triggeredAt: number): void {
    this.#scheduler.scheduleAt(DMA_EVENT_IDS[index]!, triggeredAt + DMA_START_DELAY, () => this.#onStart(index));
  }

  /**
   * Observer for each transfer as its start delay ends (an event log's DMA rows). Sound FIFO
   * transfers ask for the bus directly from `requestSoundFifo` and bypass it.
   */
  onTransfer: ((channel: number, info: DmaTransferInfo) => void) | null = null;

  /** A triggered channel's start delay has passed: it asks for the bus. */
  #onStart(index: number): void {
    const ch = this.#channels[index]!;
    this.onTransfer?.(index, {
      source: ch.srcAddr >>> 0,
      destination: ch.dstAddr >>> 0,
      count: ch.wordCount,
      wordSize: ch.wordSize ? 4 : 2,
      timing: ch.startTiming,
      origin: ch.startOrigin,
    });
    this.#requestBus(index);
  }

  /** Channel `index` waits for the bus; the run serves it once no higher-priority channel waits. */
  #requestBus(index: number): void {
    this.#waiting |= 1 << index;
    if (!this.#moving) {
      this.#run();
    }
  }

  /**
   * Hold the bus and move units, each for the highest-priority waiting channel, until none is
   * left. When an event comes due the run pauses after the current unit and resumes as its own
   * `DmaResume` event, after the events already due.
   */
  #run(): void {
    const memory = this.#memory;
    if (!memory) {
      return;
    }
    const scheduler = this.#scheduler;
    scheduler.cancel(EventId.DmaResume);
    this.#moving = true;
    if (!this.#running) {
      this.#running = true;
      this.#current = -1;
      this.#idle(memory, RUN_EDGE_CYCLES);
    }

    let moved = false;
    let source = -1;
    for (;;) {
      const waiting = this.#waiting;
      if (waiting === 0) {
        this.#idle(memory, RUN_EDGE_CYCLES);
        this.#running = false;
        break;
      }
      if (moved && scheduler.nextEventCycle <= scheduler.currentCycle) {
        scheduler.scheduleAt(EventId.DmaResume, scheduler.currentCycle, () => this.#run());
        break;
      }
      const index = 31 - Math.clz32(waiting & -waiting);
      const ch = this.#channels[index]!;
      if (!ch.enabled) {
        this.#waiting &= ~(1 << index);
        continue;
      }
      if (index !== this.#current) {
        this.#current = index;
        this.#gamePakAccessed = false;
      }
      if (index !== source) {
        // Attribute the channel's writes to its start instruction (for watchpoints).
        source = index;
        memory.setDmaSource?.(index, ch.startOrigin);
      }
      this.#moveUnit(index, ch, memory);
      moved = true;
      if (--ch.wordCount === 0) {
        this.#waiting &= ~(1 << index);
        this.#onTransferComplete(index);
      }
    }
    memory.clearDmaSource?.();
    this.#moving = false;
  }

  /** Cycles in which the run holds the bus without an access. */
  #idle(memory: DmaMemoryAccess, cycles: number): void {
    memory.idle(cycles);
    this.#scheduler.advance(cycles);
  }

  /**
   * Move one unit from the channel's source to its destination through its latch, the read then
   * the write, each moving the clock by its cycles. A 16-bit read fills both halves of the latch,
   * and a 16-bit write takes the half the destination's bit 1 selects (mGBA GBADMAService,
   * `info->latch >> (8 * (dest & 2))`). A sound FIFO channel moves words to its fixed FIFO.
   */
  #moveUnit(index: number, ch: DmaChannel, memory: DmaMemoryAccess): void {
    const fifo = this.#isSoundFifo(index);
    const step = fifo || ch.wordSize ? 4 : 2;
    const src = ch.srcAddr >>> 0;
    const dst = ch.dstAddr >>> 0;
    let srcSequential = true;
    let dstSequential = true;
    if (!this.#gamePakAccessed) {
      if (src >= CARTRIDGE_BASE) {
        srcSequential = false;
        this.#gamePakAccessed = true;
      } else if (dst >= CARTRIDGE_BASE) {
        dstSequential = false;
        this.#gamePakAccessed = true;
      }
    }

    const scheduler = this.#scheduler;
    scheduler.advance(memory.dataCycles(src, step, srcSequential));
    if (src >= READABLE_BASE) {
      if (step === 4) {
        ch.latch = memory.read32(src) >>> 0;
      } else {
        const value = memory.read16(src) & 0xffff;
        ch.latch = (value | (value << 16)) >>> 0;
      }
    }
    scheduler.advance(memory.dataCycles(dst, step, dstSequential));
    if (step === 4) {
      memory.write32(dst, ch.latch);
      this.#busValue = ch.latch;
    } else {
      memory.write16(dst, (ch.latch >>> ((dst & 2) * 8)) & 0xffff);
      this.#busValue = ((ch.latch & 0xffff) | (ch.latch << 16)) >>> 0;
    }

    ch.srcAddr = this.#nextSource(ch.srcAddr, ch.srcControl, step);
    if (!fifo) {
      ch.dstAddr = this.#nextAddress(ch.dstAddr, ch.dstControl, step);
    }
  }

  /** A transfer moved its last unit: its IRQ, then a repeat reloads it for the next trigger. */
  #onTransferComplete(index: number): void {
    const ch = this.#channels[index]!;

    if (ch.irqEnable) {
      this.#interrupts.requestInterrupt(DMA_IRQ_FLAGS[index]!);
    }

    // A repeating VBlank, HBlank or Special channel stays enabled for its next trigger; any other
    // channel clears its enable bit once its transfer is done (GBATEK "DMA Repeat bit").
    if (ch.repeat && ch.startTiming !== DmaStartTiming.Immediately) {
      ch.wordCount = this.#unitsPerTransfer(index);
      if (ch.dstControl === DmaAddrControl.IncrementReload && !this.#isSoundFifo(index)) {
        ch.dstAddr = (ch.dstLatch & (ch.wordSize ? ~3 : ~1)) >>> 0;
      }
    } else {
      ch.enabled = false;
    }
  }

  /** The source address after a unit: a source in the game pak ROM increments whatever SAD control says (mGBA dma.c). */
  #nextSource(addr: number, control: DmaAddrControl, step: number): number {
    if (addr >>> 0 >= CARTRIDGE_BASE && addr >>> 0 < SRAM_BASE) {
      return addr + step;
    }
    return this.#nextAddress(addr, control, step);
  }

  #nextAddress(addr: number, control: DmaAddrControl, step: number): number {
    switch (control) {
      case DmaAddrControl.Increment:
      case DmaAddrControl.IncrementReload:
        return addr + step;
      case DmaAddrControl.Decrement:
        return addr - step;
      case DmaAddrControl.Fixed:
        return addr;
    }
  }

  /** After a snapshot restore: a transfer that was scheduled keeps its cycle and gets its callback back. */
  reattachEvents(): void {
    for (let i = 0; i < 4; i++) {
      const id = DMA_EVENT_IDS[i]!;
      if (this.#scheduler.isScheduled(id)) {
        this.#scheduler.reattach(id, () => this.#onStart(i));
      }
    }
    if (this.#scheduler.isScheduled(EventId.DmaResume)) {
      this.#scheduler.reattach(EventId.DmaResume, () => this.#run());
    }
  }

  /** Serialize to a plain snapshot. */
  serialize(): DmaSnapshot {
    return {
      channels: this.#channels.map((ch) => ({
        srcAddr: ch.srcAddr,
        dstAddr: ch.dstAddr,
        srcLatch: ch.srcLatch,
        dstLatch: ch.dstLatch,
        wordCount: ch.wordCount,
        wordCountLatch: ch.wordCountLatch,
        dstControl: ch.dstControl,
        srcControl: ch.srcControl,
        repeat: ch.repeat,
        wordSize: ch.wordSize,
        startTiming: ch.startTiming,
        gamePakDrq: ch.gamePakDrq,
        irqEnable: ch.irqEnable,
        enabled: ch.enabled,
        latch: ch.latch,
      })),
      waiting: this.#waiting,
      running: this.#running,
      current: this.#current,
      gamePakAccessed: this.#gamePakAccessed,
      busValue: this.#busValue,
    };
  }

  /** Restore from a snapshot. */
  deserialize(snap: DmaSnapshot): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.#channels[i]!;
      const s = snap.channels[i]!;
      ch.srcAddr = s.srcAddr;
      ch.dstAddr = s.dstAddr;
      ch.srcLatch = s.srcLatch;
      ch.dstLatch = s.dstLatch;
      ch.wordCount = s.wordCount;
      ch.wordCountLatch = s.wordCountLatch;
      ch.dstControl = s.dstControl as DmaAddrControl;
      ch.srcControl = s.srcControl as DmaAddrControl;
      ch.repeat = s.repeat;
      ch.wordSize = s.wordSize;
      ch.startTiming = s.startTiming as DmaStartTiming;
      ch.gamePakDrq = s.gamePakDrq ?? false;
      ch.irqEnable = s.irqEnable;
      ch.enabled = s.enabled;
      ch.latch = s.latch ?? 0;
    }
    // A snapshot without `running` holds a sound FIFO channel's count as CNT_L. It was taken
    // between transfers, so the count becomes the 4 words the channel's next request moves.
    if (snap.running === undefined) {
      for (let i = 1; i <= 2; i++) {
        if (this.#isSoundFifo(i)) {
          this.#channels[i]!.wordCount = FIFO_UNITS;
        }
      }
    }
    this.#waiting = snap.waiting ?? 0;
    this.#running = snap.running ?? false;
    this.#current = snap.current ?? -1;
    this.#gamePakAccessed = snap.gamePakAccessed ?? false;
    this.#busValue = snap.busValue ?? 0;
    this.#moving = false;
  }

  /** Reset all DMA channels */
  reset(): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.#channels[i]!;
      ch.srcAddr = 0;
      ch.dstAddr = 0;
      ch.srcLatch = 0;
      ch.dstLatch = 0;
      ch.wordCount = 0;
      ch.wordCountLatch = 0;
      ch.dstControl = DmaAddrControl.Increment;
      ch.srcControl = DmaAddrControl.Increment;
      ch.repeat = false;
      ch.wordSize = false;
      ch.startTiming = DmaStartTiming.Immediately;
      ch.gamePakDrq = false;
      ch.irqEnable = false;
      ch.enabled = false;
      ch.latch = 0;
      this.#scheduler.cancel(DMA_EVENT_IDS[i]!);
    }
    this.#scheduler.cancel(EventId.DmaResume);
    this.#waiting = 0;
    this.#running = false;
    this.#current = -1;
    this.#gamePakAccessed = false;
    this.#moving = false;
    this.#busValue = 0;
  }
}
