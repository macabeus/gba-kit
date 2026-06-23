/**
 * GBA DMA Controller
 *
 * 4 DMA channels with priority (0 highest, 3 lowest).
 * Supports immediate, VBlank, HBlank, and special (sound FIFO) start modes.
 * DMA halts the CPU during transfers.
 */
import type { InterruptController } from './interrupts.js';
import type { DmaSnapshot } from './savestate.js';
import type { Scheduler } from './scheduler.js';
import { DmaAddrControl, DmaStartTiming, EventId, IrqFlag } from './types.js';
import type { WriteOrigin, WriteSource } from './write-source.js';

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
  /** IRQ on completion */
  irqEnable: boolean;
  /** DMA enabled */
  enabled: boolean;
  /**
   * CPU location captured when this channel was last enabled (the instruction
   * that started the DMA). Reported to data watchpoints as the origin of DMA
   * writes, since the per-word copies don't belong to any single instruction.
   */
  startOrigin: WriteOrigin;
}

const ZERO_ORIGIN: WriteOrigin = { pc: 0, instructionAddress: 0, thumb: false };

/** Memory read/write functions injected from the system bus */
export interface DmaMemoryAccess {
  read16(address: number): number;
  read32(address: number): number;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
  /** Current CPU location (used to attribute the DMA's origin). Optional. */
  getOrigin?(): WriteOrigin;
  /** Whether any data watchpoint is set — lets DMA skip source-tagging work when unused. Optional. */
  hasWatchpoints?(): boolean;
  /** Run `fn` with writes attributed to `source` (for data watchpoints). Optional. */
  withSource?<T>(source: WriteSource, fn: () => T): T;
}

const DMA_EVENT_IDS = [EventId.Dma0, EventId.Dma1, EventId.Dma2, EventId.Dma3] as const;
const DMA_IRQ_FLAGS = [IrqFlag.Dma0, IrqFlag.Dma1, IrqFlag.Dma2, IrqFlag.Dma3] as const;

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
        irqEnable: false,
        enabled: false,
        startOrigin: ZERO_ORIGIN,
      });
    }
  }

  /** Set memory access functions (called during system bus setup to break circular dep) */
  setMemoryAccess(memory: DmaMemoryAccess): void {
    this.#memory = memory;
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
      ((ch.startTiming & 3) << 12) |
      (ch.irqEnable ? 1 << 14 : 0) |
      (ch.enabled ? 1 << 15 : 0)
    );
  }

  /** Write control register (DMAx_CNT_H) */
  writeControl(index: number, value: number): void {
    const ch = this.#channels[index]!;
    const wasEnabled = ch.enabled;

    ch.dstControl = ((value >> 5) & 3) as DmaAddrControl;
    ch.srcControl = ((value >> 7) & 3) as DmaAddrControl;
    ch.repeat = (value & (1 << 9)) !== 0;
    ch.wordSize = (value & (1 << 10)) !== 0;
    ch.startTiming = ((value >> 12) & 3) as DmaStartTiming;
    ch.irqEnable = (value & (1 << 14)) !== 0;
    ch.enabled = (value & (1 << 15)) !== 0;

    if (ch.enabled) {
      // Capture the PC of the code that started this DMA (this control write runs
      // mid-instruction, so registers[15] is the trigger). Reported to watchpoints
      // as the origin of the channel's writes, including later scheduled/timed ones.
      ch.startOrigin = this.#memory?.getOrigin?.() ?? ZERO_ORIGIN;
      // (Re-)enabling DMA always reloads addresses and word count from latches,
      // whether transitioning from disabled→enabled OR re-writing while enabled.
      // Real GBA hardware reloads on any control write with enable=1.
      ch.srcAddr = ch.srcLatch;
      ch.dstAddr = ch.dstLatch;
      ch.wordCount = ch.wordCountLatch === 0 ? (index === 3 ? 0x10000 : 0x4000) : ch.wordCountLatch;

      if (ch.startTiming === DmaStartTiming.Immediately) {
        // Immediate DMA executes synchronously (blocks the CPU on real GBA)
        this.#executeTransfer(index);
      }
    } else if (wasEnabled && !ch.enabled) {
      this.#scheduler.cancel(DMA_EVENT_IDS[index]!);
    }
  }

  /** Trigger DMA channels waiting for a specific start timing */
  trigger(timing: DmaStartTiming): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.#channels[i]!;
      if (ch.enabled && ch.startTiming === timing) {
        this.#scheduleTransfer(i);
      }
    }
  }

  /** Trigger sound FIFO DMA (channels 1 and 2 with Special timing) */
  triggerSoundFifo(channel: 1 | 2): void {
    const ch = this.#channels[channel]!;
    if (ch.enabled && ch.startTiming === DmaStartTiming.Special) {
      this.#executeFifoTransfer(channel);
    }
  }

  #scheduleTransfer(index: number): void {
    // DMA transfers happen "immediately" in emulation terms (2 cycles startup)
    this.#scheduler.schedule(DMA_EVENT_IDS[index]!, 2, () => {
      this.#executeTransfer(index);
    });
  }

  /** Run `fn` with this channel's writes attributed to its DMA source (for watchpoints). */
  #withChannelSource(index: number, fn: () => void): void {
    const mem = this.#memory;
    // Skip the source object + closure wrapping entirely when no watchpoint is set
    // (the common case): DMA fires constantly, this keeps it allocation-free.
    if (!mem?.withSource || (mem.hasWatchpoints && !mem.hasWatchpoints())) {
      fn();
      return;
    }
    const source: WriteSource = { kind: 'dma', channel: index, origin: this.#channels[index]!.startOrigin };
    mem.withSource(source, fn);
  }

  #executeTransfer(index: number): void {
    const memory = this.#memory;
    if (!memory) {
      return;
    }
    const ch = this.#channels[index]!;
    const step = ch.wordSize ? 4 : 2;

    this.#withChannelSource(index, () => {
      for (let i = 0; i < ch.wordCount; i++) {
        if (ch.wordSize) {
          const value = memory.read32(ch.srcAddr);
          memory.write32(ch.dstAddr, value);
        } else {
          const value = memory.read16(ch.srcAddr);
          memory.write16(ch.dstAddr, value);
        }

        // Update source address
        ch.srcAddr = this.#updateAddr(ch.srcAddr, ch.srcControl, step);
        // Update destination address
        ch.dstAddr = this.#updateAddr(ch.dstAddr, ch.dstControl, step);
      }
    });

    this.#onTransferComplete(index);
  }

  /** Special FIFO transfer: always 4 words of 32-bit, destination fixed */
  #executeFifoTransfer(index: number): void {
    const memory = this.#memory;
    if (!memory) {
      return;
    }
    const ch = this.#channels[index]!;

    this.#withChannelSource(index, () => {
      for (let i = 0; i < 4; i++) {
        const value = memory.read32(ch.srcAddr);
        memory.write32(ch.dstAddr, value);
        ch.srcAddr = this.#updateAddr(ch.srcAddr, ch.srcControl, 4);
        // Destination fixed for FIFO
      }
    });

    // FIFO DMA always repeats — don't disable
    if (ch.irqEnable) {
      this.#interrupts.requestInterrupt(DMA_IRQ_FLAGS[index]!);
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
        ch.dstAddr = ch.dstLatch;
      }
    } else {
      ch.enabled = false;
    }
  }

  #updateAddr(addr: number, control: DmaAddrControl, step: number): number {
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
        irqEnable: ch.irqEnable,
        enabled: ch.enabled,
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
      ch.irqEnable = s.irqEnable;
      ch.enabled = s.enabled;
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
      ch.irqEnable = false;
      ch.enabled = false;
      this.#scheduler.cancel(DMA_EVENT_IDS[i]!);
    }
  }
}
