/**
 * GBA DMA Controller
 *
 * 4 DMA channels with priority (0 highest, 3 lowest).
 * Supports immediate, VBlank, HBlank, and special (sound FIFO, video capture) start modes.
 *
 * A channel copies SAD, DAD and CNT_L into its internal counters when its enable bit goes from 0
 * to 1, and only then (GBATEK "DMA Transfers": "Upon DMA Enable (Bit 15) changing from 0 to 1:
 * Reloads SAD, DAD, CNT_L"). Each unit passes through the channel's data latch: a source below
 * EWRAM (the BIOS and the unused region after it) answers nothing, and the channel writes what
 * its latch holds from its last read (mGBA dma.c GBADMAService; mgba-suite "DMA tests").
 *
 * A transfer holds the bus, so the CPU stops while it runs and the clock advances by all of it:
 * n units take 2N+2(n-1)S+xI, a read and a write each, the first pair nonsequential (GBATEK "DMA
 * Transfers": Transfer Rate/Timing). x is 2 when either end is outside the game pak and 0 when
 * both are in it, as mGBA counts it (dma.c GBADMAService) against the timings mgba-suite measured
 * on hardware. A channel starts 3 cycles after its trigger.
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
  /** Word count (12-bit for DMA0-2, 16-bit for DMA3) */
  wordCount: number;
  /** Latched word count */
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
  /** Game Pak DRQ (DMA3CNT_H bit 11): stored and readable; DMA0-2 have no such bit */
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
  /** What one access costs, wait states included (the bus's `accessCycles`). */
  accessCycles(address: number, width: 2 | 4, sequential: boolean): number;
}

/** Cycles from a channel's trigger to its first access (mGBA GBADMAWriteCNT_HI: "DMAs take 3 cycles to start"). */
const DMA_START_DELAY = 3;

/** The internal cycles that end a transfer touching memory outside the game pak (mGBA GBADMAService). */
const DMA_END_CYCLES = 2;

/** Where the game pak's address space begins; a transfer entirely at or above it ends without internal cycles. */
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
      // The channel's address counters hold transfer-width units: a misaligned SAD/DAD loses its
      // low bits here (mGBA GBADMAWriteCNT_HI: `nextSource &= -width`). Sound FIFO DMA moves words.
      const alignMask = ch.wordSize || this.#isSoundFifo(index) ? ~3 : ~1;
      ch.srcAddr = (ch.srcLatch & alignMask) >>> 0;
      ch.dstAddr = (ch.dstLatch & alignMask) >>> 0;
      ch.wordCount = ch.wordCountLatch === 0 ? (index === 3 ? 0x10000 : 0x4000) : ch.wordCountLatch;

      if (ch.startTiming === DmaStartTiming.Immediately) {
        this.#scheduleTransfer(index, this.#scheduler.currentCycle);
      }
    } else if (wasEnabled && !ch.enabled) {
      this.#scheduler.cancel(DMA_EVENT_IDS[index]!);
    }
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
        this.#executeFifoTransfer(i);
        return;
      }
    }
  }

  /**
   * The LCD began `line` at the cycle `at`. DMA3 in Special timing is video capture: it runs like
   * an HBlank DMA from line 2 to line 161, and the hardware clears its enable bit when VCOUNT
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
    }
  }

  /** DMA1 and DMA2 in Special timing serve the sound FIFOs. */
  #isSoundFifo(index: number): boolean {
    return (index === 1 || index === 2) && this.#channels[index]!.startTiming === DmaStartTiming.Special;
  }

  #scheduleTransfer(index: number, triggeredAt: number): void {
    this.#scheduler.scheduleAt(DMA_EVENT_IDS[index]!, triggeredAt + DMA_START_DELAY, () => {
      this.#executeTransfer(index);
    });
  }

  /** Observer for every transfer as it starts (an event log's DMA rows). */
  onTransfer: ((channel: number, info: DmaTransferInfo) => void) | null = null;

  #executeTransfer(index: number): void {
    const memory = this.#memory;
    if (!memory) {
      return;
    }
    const ch = this.#channels[index]!;
    const step = ch.wordSize ? 4 : 2;
    this.onTransfer?.(index, {
      source: ch.srcAddr >>> 0,
      destination: ch.dstAddr >>> 0,
      count: ch.wordCount,
      wordSize: ch.wordSize ? 4 : 2,
      timing: ch.startTiming,
      origin: ch.startOrigin,
    });

    // Attribute this channel's writes to its start instruction (for watchpoints).
    memory.setDmaSource?.(index, ch.startOrigin);
    let cycles = 0;
    for (let i = 0; i < ch.wordCount; i++) {
      cycles += memory.accessCycles(ch.srcAddr, step, i > 0) + memory.accessCycles(ch.dstAddr, step, i > 0);
      this.#moveUnit(ch, memory, step);
      ch.srcAddr = this.#nextSource(ch.srcAddr, ch.srcControl, step);
      ch.dstAddr = this.#nextAddress(ch.dstAddr, ch.dstControl, step);
    }
    memory.clearDmaSource?.();
    this.#scheduler.advance(cycles + this.#endCycles(ch.srcAddr, ch.dstAddr));

    this.#onTransferComplete(index);
  }

  /**
   * Move one unit from the channel's source to its destination through its latch. A 16-bit read
   * fills both halves of the latch, and a 16-bit write takes the half the destination's bit 1
   * selects (mGBA GBADMAService, `info->latch >> (8 * (dest & 2))`).
   */
  #moveUnit(ch: DmaChannel, memory: DmaMemoryAccess, step: 2 | 4): void {
    const readable = ch.srcAddr >>> 0 >= READABLE_BASE;
    if (step === 4) {
      if (readable) {
        ch.latch = memory.read32(ch.srcAddr) >>> 0;
      }
      memory.write32(ch.dstAddr, ch.latch);
    } else {
      if (readable) {
        const value = memory.read16(ch.srcAddr) & 0xffff;
        ch.latch = (value | (value << 16)) >>> 0;
      }
      memory.write16(ch.dstAddr, (ch.latch >>> ((ch.dstAddr & 2) * 8)) & 0xffff);
    }
  }

  /** The internal cycles a transfer ends with, from where its last unit went. */
  #endCycles(src: number, dst: number): number {
    return src >>> 0 < CARTRIDGE_BASE || dst >>> 0 < CARTRIDGE_BASE ? DMA_END_CYCLES : 0;
  }

  /** Sound FIFO transfer: 4 words into the FIFO, whose address stays fixed. */
  #executeFifoTransfer(index: number): void {
    const memory = this.#memory;
    if (!memory) {
      return;
    }
    const ch = this.#channels[index]!;

    memory.setDmaSource?.(index, ch.startOrigin);
    let cycles = 0;
    for (let i = 0; i < FIFO_UNITS; i++) {
      cycles += memory.accessCycles(ch.srcAddr, 4, i > 0) + memory.accessCycles(ch.dstAddr, 4, i > 0);
      this.#moveUnit(ch, memory, 4);
      ch.srcAddr = this.#nextSource(ch.srcAddr, ch.srcControl, 4);
    }
    memory.clearDmaSource?.();
    this.#scheduler.advance(cycles + this.#endCycles(ch.srcAddr, ch.dstAddr));

    if (ch.irqEnable) {
      this.#interrupts.requestInterrupt(DMA_IRQ_FLAGS[index]!);
    }
    // Without the repeat bit the channel serves one request (GBATEK "DMA Repeat bit").
    if (!ch.repeat) {
      ch.enabled = false;
    }
  }

  #onTransferComplete(index: number): void {
    const ch = this.#channels[index]!;

    if (ch.irqEnable) {
      this.#interrupts.requestInterrupt(DMA_IRQ_FLAGS[index]!);
    }

    if (ch.repeat && ch.startTiming !== DmaStartTiming.Immediately) {
      // Reload word count, optionally reload destination
      ch.wordCount = ch.wordCountLatch === 0 ? (index === 3 ? 0x10000 : 0x4000) : ch.wordCountLatch;

      if (ch.dstControl === DmaAddrControl.IncrementReload) {
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
        this.#scheduler.reattach(id, () => this.#executeTransfer(i));
      }
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
  }
}
