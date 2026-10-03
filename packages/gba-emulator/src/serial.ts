/**
 * GBA Serial Port — SIOCNT, RCNT, the SIO data registers and the JOY bus registers
 *
 * The link port is empty: no cable, no other GBA, no JOY bus host. In Normal mode with the
 * internal clock the GBA drives the shift clock itself, so a transfer completes after its 8 or 32
 * bits and shifts in what the idle SI line gives: all ones (GBATEK "SIO Normal Mode": SI
 * "1=High/None"). Every other transfer — Normal mode with the external clock, Multi-Player, UART,
 * JOY bus — waits for a partner and stays pending.
 *
 * RCNT bits 14-15 and SIOCNT bits 12-13 select the mode, which decides what each register reads.
 * RCNT bits 0-3 read the levels of the SC, SD, SI and SO lines. The read values are the ones
 * mgba-suite's "SIO register R/W tests" measured on hardware with nothing connected.
 *
 * The registers live in the I/O register file (`GbaSystemBus.mmioRegisters`) at their own offsets,
 * which keeps them in snapshots and the debugger's I/O view. Each holds what was written to it (or
 * what a transfer left there), and this class is their only writer.
 *
 * References: GBATEK "GBA Communication Ports" and its mode chapters; mGBA src/gba/sio.c
 * (GBASIOWriteSIOCNT, GBASIOTransferCycles); NanoBoyAdvance bus/io.cc (SIOCNT, SIOTransferDone).
 */
import type { InterruptController } from './interrupts.js';
import type { Scheduler } from './scheduler.js';
import { CPU_FREQ, EventId, IrqFlag } from './types.js';

const SIODATA32_L = 0x120; // SIOMULTI0
const SIODATA32_H = 0x122; // SIOMULTI1
const SIOMULTI2 = 0x124;
const SIOMULTI3 = 0x126;
const SIOCNT = 0x128;
const SIODATA8 = 0x12a; // SIOMLT_SEND
const RCNT = 0x134;
const JOYCNT = 0x140;
const JOY_RECV_L = 0x150;
const JOY_RECV_H = 0x152;
const JOY_TRANS_L = 0x154;
const JOY_TRANS_H = 0x156;
const JOYSTAT = 0x158;

/** Whether the I/O halfword at `offset` is a serial port register (SIO 0x120-0x12A, RCNT, JOYCNT, JOY bus 0x150-0x158). */
export function isSerialRegister(offset: number): boolean {
  return (
    (offset >= SIODATA32_L && offset <= SIODATA8) ||
    offset === RCNT ||
    offset === JOYCNT ||
    (offset >= JOY_RECV_L && offset <= JOYSTAT)
  );
}

/** The communication modes (GBATEK "SIO Control Registers Summary"). */
const enum SioMode {
  Normal8,
  Normal32,
  Multi,
  Uart,
  GeneralPurpose,
  JoyBus,
}

// SIOCNT
const SIOCNT_INTERNAL_CLOCK = 1 << 0;
const SIOCNT_2MHZ = 1 << 1;
const SIOCNT_SO_IDLE = 1 << 3;
const SIOCNT_START = 1 << 7;
const SIOCNT_IRQ = 1 << 14;
/** Bit 15 is read-only 0 (GBATEK: "Not used (Read only, always 0)"). */
const SIOCNT_WRITABLE = 0x7fff;
/**
 * The SIOCNT bits each mode reads back as written. The rest report the port: SI (and SD in
 * Multi-Player) from the lines, UART's receive-empty flag set, and the other status bits 0.
 */
const SIOCNT_NORMAL_READ = 0x7f8b;
const SIOCNT_MULTI_READ = 0x7f83;
const SIOCNT_UART_READ = 0x7f8f;
/** SIOCNT bit 2, SI: high with nothing connected. In Multi-Player mode it also says "Child". */
const SIOCNT_SI = 1 << 2;
/** SIOCNT bit 3 in Multi-Player mode, SD: high, "All GBAs Ready", as the idle line reads. */
const SIOCNT_MULTI_SD = 1 << 3;
/** SIOCNT bit 5 in UART mode: the receive FIFO is empty. */
const SIOCNT_UART_RECEIVE_EMPTY = 1 << 5;

// RCNT
/** Bits 9-13 read 0 (GBATEK: "Not used (Always 0, read only)"). */
const RCNT_WRITABLE = 0xc1ff;
const RCNT_GENERAL_PURPOSE = 1 << 15;
const RCNT_JOY_BUS = 1 << 14;
const RCNT_LINE_BITS = 0x000f;
const LINE_SC = 1 << 0;
const LINE_SD = 1 << 1;
const LINE_SI = 1 << 2;
const LINE_SO = 1 << 3;

// JOY bus
/** JOYCNT bits 0-2 are flags a write of 1 acknowledges, bit 6 is the reset IRQ enable. */
const JOYCNT_FLAGS = 0x0007;
const JOYCNT_IRQ = 0x0040;
/** JOYSTAT bits 4-5 are general-purpose flags; bits 1 and 3 report transfers with a JOY bus host. */
const JOYSTAT_WRITABLE = 0x0030;
const JOYSTAT_READABLE = 0x003a;

/** CPU cycles per bit of the internal shift clock: 256 KHz or 2 MHz (GBATEK "SIO Normal Mode"). */
const CYCLES_PER_BIT_256K = CPU_FREQ / 262144;
const CYCLES_PER_BIT_2M = CPU_FREQ / 2097152;

export class SerialPort {
  readonly #io: Uint8Array;
  readonly #scheduler: Scheduler;
  readonly #interrupts: InterruptController;

  constructor(io: Uint8Array, scheduler: Scheduler, interrupts: InterruptController) {
    this.#io = io;
    this.#scheduler = scheduler;
    this.#interrupts = interrupts;
  }

  /** The serial register at `offset` as the CPU reads it. Reading has no side effects. */
  read16(offset: number): number {
    switch (offset) {
      case SIOCNT:
        return this.#readSiocnt();
      case SIODATA8:
        // In UART mode SIODATA8 reads the receive FIFO, which stays empty.
        return this.#mode() === SioMode.Uart ? 0 : this.#load(SIODATA8);
      case RCNT:
        return (this.#load(RCNT) & ~RCNT_LINE_BITS) | this.#lines();
      case JOYCNT:
        return this.#load(JOYCNT) & (JOYCNT_FLAGS | JOYCNT_IRQ);
      case JOY_TRANS_L:
      case JOY_TRANS_H:
        return 0; // the JOY bus host reads the send registers; the CPU reads 0
      case JOYSTAT:
        return this.#load(JOYSTAT) & JOYSTAT_READABLE;
      default:
        return this.#load(offset);
    }
  }

  /** Write the byte lanes `mask` selects of the serial register at `offset`. */
  write16(offset: number, value: number, mask: number): void {
    const merged = ((this.#load(offset) & ~mask) | (value & mask)) & 0xffff;
    switch (offset) {
      case SIODATA32_L:
      case SIODATA32_H:
        // These are SIODATA32 in Normal 32-bit mode and take the write; in the other modes they
        // are SIOMULTI0-1, which a transfer fills.
        if (this.#mode() === SioMode.Normal32) {
          this.#store(offset, merged);
        }
        return;
      case SIOMULTI2:
      case SIOMULTI3:
      case JOY_RECV_L:
      case JOY_RECV_H:
        return; // receive registers: a transfer fills them
      case SIODATA8:
        // In UART mode the write goes to the send FIFO, and reads return the receive FIFO.
        if (this.#mode() !== SioMode.Uart) {
          this.#store(offset, merged);
        }
        return;
      case SIOCNT:
        this.#writeSiocnt(merged);
        return;
      case RCNT:
        this.#store(RCNT, merged & RCNT_WRITABLE);
        return;
      case JOYCNT: {
        // A 1 written to a flag acknowledges it, in the written byte lanes only.
        const acknowledged = value & mask & JOYCNT_FLAGS;
        this.#store(JOYCNT, (this.#load(JOYCNT) & JOYCNT_FLAGS & ~acknowledged) | (merged & JOYCNT_IRQ));
        return;
      }
      case JOYSTAT:
        this.#store(JOYSTAT, (this.#load(JOYSTAT) & ~JOYSTAT_WRITABLE) | (merged & JOYSTAT_WRITABLE));
        return;
      default:
        this.#store(offset, merged); // JOY_TRANS
    }
  }

  /** After a snapshot restore: a transfer in progress keeps its cycle and gets its callback back. */
  reattachEvents(): void {
    if (this.#scheduler.isScheduled(EventId.Serial)) {
      this.#scheduler.reattach(EventId.Serial, (due) => this.#finishTransfer(due));
    }
  }

  /** Whether a Normal-mode transfer is shifting. */
  get #transferring(): boolean {
    return this.#scheduler.isScheduled(EventId.Serial);
  }

  #mode(): SioMode {
    const rcnt = this.#load(RCNT);
    if (rcnt & RCNT_GENERAL_PURPOSE) {
      return rcnt & RCNT_JOY_BUS ? SioMode.JoyBus : SioMode.GeneralPurpose;
    }
    return ((this.#load(SIOCNT) >> 12) & 3) as SioMode;
  }

  /**
   * SIOCNT reads by the layout its bits 12-13 select, whatever RCNT says (GBATEK: in General
   * Purpose mode its bits "still exist and are read- and/or write-able in the same manner").
   */
  #readSiocnt(): number {
    const siocnt = this.#load(SIOCNT);
    switch ((siocnt >> 12) & 3) {
      case SioMode.Multi:
        return (siocnt & SIOCNT_MULTI_READ) | SIOCNT_SI | SIOCNT_MULTI_SD;
      case SioMode.Uart:
        return (siocnt & SIOCNT_UART_READ) | SIOCNT_UART_RECEIVE_EMPTY;
      default:
        return (siocnt & SIOCNT_NORMAL_READ) | SIOCNT_SI;
    }
  }

  /**
   * A SIOCNT write. The start bit belongs to a running transfer until it completes (NanoBoyAdvance
   * keeps it set against writes). Setting it in Normal mode with the internal clock starts a
   * transfer of 8 or 32 bits at 256 KHz or 2 MHz (mGBA GBASIOTransferCycles).
   */
  #writeSiocnt(value: number): void {
    const siocnt = value & SIOCNT_WRITABLE;
    if (this.#transferring) {
      this.#store(SIOCNT, siocnt | SIOCNT_START);
      return;
    }
    this.#store(SIOCNT, siocnt);
    const mode = this.#mode();
    if (
      (mode === SioMode.Normal8 || mode === SioMode.Normal32) &&
      siocnt & SIOCNT_START &&
      siocnt & SIOCNT_INTERNAL_CLOCK
    ) {
      const bits = mode === SioMode.Normal32 ? 32 : 8;
      const cycles = bits * (siocnt & SIOCNT_2MHZ ? CYCLES_PER_BIT_2M : CYCLES_PER_BIT_256K);
      this.#scheduler.schedule(EventId.Serial, cycles, (due) => this.#finishTransfer(due));
    }
  }

  /**
   * The last bit has shifted at the cycle `due`: the data register holds the bits shifted in from
   * the idle SI line, the start bit clears, and the serial IRQ is requested when enabled.
   */
  #finishTransfer(due: number): void {
    const siocnt = this.#load(SIOCNT) & ~SIOCNT_START;
    this.#store(SIOCNT, siocnt);
    if ((siocnt >> 12) & 1) {
      this.#store(SIODATA32_L, 0xffff);
      this.#store(SIODATA32_H, 0xffff);
    } else {
      this.#store(SIODATA8, this.#load(SIODATA8) | 0x00ff); // the shift register is the low byte
    }
    if (siocnt & SIOCNT_IRQ) {
      this.#interrupts.requestInterrupt(IrqFlag.Serial, due);
    }
  }

  /**
   * RCNT bits 0-3: the SC, SD, SI and SO lines (GBATEK: "current SC,SD,SI,SO state"). In General
   * Purpose mode an output pin reads what RCNT drives and an input reads its pull-up, high. In the
   * other modes the port drives them: Normal mode idles SC high and puts SIOCNT bit 3 on SO, with
   * SI pulled high and SD low; Multi-Player and UART idle every line high; JOY bus holds SC and SD
   * low ("SC and SD are set to low") with SI and SO high.
   */
  #lines(): number {
    const rcnt = this.#load(RCNT);
    switch (this.#mode()) {
      case SioMode.GeneralPurpose: {
        const outputs = (rcnt >> 4) & RCNT_LINE_BITS;
        return (rcnt & outputs) | (~outputs & RCNT_LINE_BITS);
      }
      case SioMode.JoyBus:
        return LINE_SI | LINE_SO;
      case SioMode.Multi:
      case SioMode.Uart:
        return LINE_SC | LINE_SD | LINE_SI | LINE_SO;
      default:
        return LINE_SC | LINE_SI | (this.#load(SIOCNT) & SIOCNT_SO_IDLE ? LINE_SO : 0);
    }
  }

  #load(offset: number): number {
    return this.#io[offset]! | (this.#io[offset + 1]! << 8);
  }

  #store(offset: number, value: number): void {
    this.#io[offset] = value & 0xff;
    this.#io[offset + 1] = (value >>> 8) & 0xff;
  }
}
