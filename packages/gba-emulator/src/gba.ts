/**
 * GBA System Coordinator
 *
 * Wires up all subsystems and runs the main emulation loop.
 * The CPU runs until the next scheduled event, then the event fires
 * and may schedule further events.
 *
 * Time is counted in CPU cycles: each instruction moves the scheduler's clock by
 * what it cost on the ARM7TDMI, wait states included, as the CPU reports it, and
 * DMA transfers, BIOS calls and interrupt entry move it by theirs.
 *
 * Execution is owned here, not by the CPU: timers, DMA, the PPU's scanline
 * chain, IRQ delivery and HALT all advance together. A debugger stops the
 * machine through `StopPredicate` — checked before each instruction and while
 * the CPU is halted — so a stop never charges a cycle for an instruction that
 * did not run, and the next `runFrame` finishes the same hardware frame.
 */
import { ArmCpu, MODE_SYS } from '@gba-kit/arm-emulator/arm-cpu';

import { Apu } from './apu/apu.js';
import { buildBiosImage } from './bios-image.js';
import { handleSwi } from './bios.js';
import { DisplayStatus } from './display-status.js';
import { DmaController, type DmaTransferInfo } from './dma.js';
import { InputController } from './input.js';
import { InterruptController } from './interrupts.js';
import { Ppu } from './ppu/ppu.js';
import type { GbaSnapshot } from './savestate.js';
import { Scheduler } from './scheduler.js';
import { SerialPort } from './serial.js';
import { GbaSystemBus } from './system-bus.js';
import { TimerController } from './timers.js';
import {
  BIOS_LATCH_AFTER_SWI,
  BOOT_STACK_POINTERS,
  CYCLES_PER_SCANLINE,
  DISPCNT_LATCH_CYCLE,
  DmaStartTiming,
  EventId,
  GbaButton,
  HBLANK_START_CYCLE,
  MMIO,
  TOTAL_SCANLINES,
  VISIBLE_SCANLINES,
} from './types.js';
import { captureOrigin } from './write-source.js';

/** The BIOS region's contents: the HLE BIOS's ARM code (bios-image.ts). */
const BIOS_IMAGE = buildBiosImage();

/** Where the BIOS's boot code hands over to the cartridge. */
const CARTRIDGE_ENTRY = 0x08000000;

/** PPU rendering interface */
export interface PpuInterface {
  /** Line-start work, at the first cycle of every scanline (0-227) */
  beginScanline(line: number, bus: GbaSystemBus): void;
  /** Latch DISPCNT, DISPCNT_LATCH_CYCLE into every scanline (0-227) */
  latchDispcnt(line: number, bus: GbaSystemBus): void;
  /** Render a single visible scanline */
  renderScanline(line: number, bus: GbaSystemBus): void;
  /** Get the framebuffer */
  getFramebuffer(): Uint32Array;
  /** Reset */
  reset(): void;
}

/**
 * Asked before every instruction, and while the CPU is halted before advancing to
 * the next event. Return true to stop: the instruction at `armCpu.registers[15]`
 * has NOT executed and no cycle has been charged.
 */
export type StopPredicate = () => boolean;

/**
 * How a run ended:
 * - `done`: the requested extent (a frame, a scanline) completed;
 * - `stopped`: the predicate or a CPU debug hook stopped it first;
 * - `halted`: the CPU stopped itself at the sentinel return address and cannot continue;
 * - `stalled`: the CPU is halted and no event is scheduled to wake it.
 */
export type RunOutcome = 'done' | 'stopped' | 'halted' | 'stalled';

/**
 * A hardware event, delivered as it happens and carrying no timestamp: a sink that needs one
 * reads the machine's cycle, frame and scanline when it fires.
 */
export type HardwareEvent =
  | { kind: 'irq-request'; flag: number }
  | { kind: 'irq-enter'; pc: number }
  | { kind: 'dma'; channel: number; info: DmaTransferInfo }
  | { kind: 'mmio-write'; address: number; value: number; size: 1 | 2 | 4 }
  | { kind: 'vblank' }
  | { kind: 'hblank'; scanline: number }
  | { kind: 'halt' };

export class Gba {
  readonly scheduler: Scheduler;
  readonly interrupts: InterruptController;
  readonly timers: TimerController;
  readonly dma: DmaController;
  readonly input: InputController;
  readonly bus: GbaSystemBus;
  readonly display: DisplayStatus;
  readonly serial: SerialPort;
  readonly ppu: Ppu;
  readonly apu: Apu;
  readonly armCpu: ArmCpu;

  #currentScanline = 0;
  #frameCount = 0;
  #running = false;
  /** Set when a `StopPredicate` or a CPU debug hook refused an instruction during the current run. */
  #stopped = false;
  #eventSink: ((event: HardwareEvent) => void) | null = null;

  constructor() {
    this.scheduler = new Scheduler();
    this.interrupts = new InterruptController(this.scheduler);
    this.timers = new TimerController(this.scheduler, this.interrupts);
    this.dma = new DmaController(this.scheduler, this.interrupts);
    this.input = new InputController(this.interrupts);
    this.bus = new GbaSystemBus();
    this.display = new DisplayStatus(this.bus.mmioRegisters, this.interrupts);
    this.serial = new SerialPort(this.bus.mmioRegisters, this.scheduler, this.interrupts);
    this.ppu = new Ppu();
    this.apu = new Apu();

    // Create CPU with GBA BIOS SWI handler. A call the HLE runs in TypeScript leaves the BIOS's
    // read-protection latch where the real BIOS's shared return code leaves it (mGBA GBASwi16); a
    // call the BIOS image runs goes through the SWI exception and fetches that code itself.
    this.armCpu = new ArmCpu(this.bus, {
      swiHandler: (cpu, swiNumber) => {
        const cycles = handleSwi(cpu, swiNumber);
        if (cycles !== null) {
          this.bus.latchBiosOpcode(BIOS_LATCH_AFTER_SWI);
        }
        return cycles;
      },
    });

    // Wire subsystem references
    this.bus.connect({
      interrupts: this.interrupts,
      timers: this.timers,
      dma: this.dma,
      input: this.input,
      apu: this.apu,
      display: this.display,
      serial: this.serial,
      cpu: this.armCpu,
    });

    // Connect APU to timers for DirectSound FIFO playback
    this.apu.connectTimers(this.timers);
    // Connect APU to DMA for sound FIFO refills
    this.apu.connectDma(this.dma);

    // Wire PPU ref point reload: when the game writes BG2X/BG2Y/BG3X/BG3Y, the PPU reloads
    // its internal accumulator at the next line start (for per-scanline affine effects).
    this.ppu.mmioRegisters = this.bus.mmioRegisters;
    this.bus.onBgRefPointWrite = (bgIndex, isX) => {
      this.ppu.reloadBgRefPoint(bgIndex, isX);
    };

    // DMA needs memory access through the bus
    this.dma.setMemoryAccess({
      read16: (addr) => this.bus.read16(addr),
      read32: (addr) => this.bus.read32(addr),
      write16: (addr, val) => this.bus.write16(addr, val),
      write32: (addr, val) => this.bus.write32(addr, val),
      // Data-watchpoint attribution for DMA writes (armCpu is created below; invoked during DMA).
      getOrigin: () => captureOrigin(this.armCpu.registers[15]!, this.armCpu.cpsr),
      setDmaSource: (channel, origin) => this.bus.setDmaSource(channel, origin),
      clearDmaSource: () => this.bus.clearDmaSource(),
      accessCycles: (addr, width, sequential) => this.bus.accessCycles(addr, width, sequential),
    });

    this.bus.loadBios(BIOS_IMAGE);
    this.#skipBiosBoot();

    // Start at line 0, where the V-count comparison runs like on any other line
    this.display.setScanline(0);
    this.#beginLine(this.scheduler.currentCycle);
  }

  /**
   * The machine as the BIOS's boot code leaves it when it jumps to the cartridge, where the
   * emulator starts instead of running a boot ROM it does not have (mGBA gba.c GBASkipBIOS and
   * io.c GBAIOInit; NanoBoyAdvance Core::SkipBootScreen):
   * - I/O: DISPCNT 0x0080 (forced blank), BG2 and BG3 PA and PD 0x0100, RCNT 0x8000, SOUNDBIAS
   *   0x0200 and POSTFLG 1. The boot code writes them, so they go through the bus while the CPU
   *   still sits at the reset vector, in the BIOS.
   * - CPU: the IRQ, SVC and SYS stacks of BOOT_STACK_POINTERS, SYS mode, ARM state, IRQs and FIQs
   *   enabled, PC at the cartridge's entry point.
   * The BIOS read-protection latch starts at BIOS_LATCH_AFTER_BOOT with the bus.
   */
  #skipBiosBoot(): void {
    const cpu = this.armCpu;
    cpu.resetState();
    this.bus.write16(MMIO.DISPCNT, 0x0080);
    for (const identity of [MMIO.BG2PA, MMIO.BG2PD, MMIO.BG3PA, MMIO.BG3PD]) {
      this.bus.write16(identity, 0x0100);
    }
    this.bus.write16(MMIO.RCNT, 0x8000);
    this.bus.write16(MMIO.SOUNDBIAS, 0x0200);
    this.bus.write8(MMIO.POSTFLG, 1);

    for (const [mode, sp] of BOOT_STACK_POINTERS) {
      cpu.switchMode(mode);
      cpu.registers[13] = sp;
    }
    cpu.switchMode(MODE_SYS);
    cpu.cpsr = MODE_SYS;
    cpu.registers[15] = CARTRIDGE_ENTRY;
  }

  /** Load a ROM into the system */
  loadRom(data: Uint8Array): void {
    this.bus.loadRom(data);
  }

  /** Press a button */
  pressButton(button: GbaButton): void {
    this.input.press(button);
  }

  /** Release a button */
  releaseButton(button: GbaButton): void {
    this.input.release(button);
  }

  /**
   * Observe hardware events (interrupt requests and entries, DMA transfers, I/O
   * writes, VBlank/HBlank, halts). One sink, or null to stop observing; the
   * subsystems' hooks stay unset when nobody listens so the hot paths pay nothing.
   */
  set onHardwareEvent(sink: ((event: HardwareEvent) => void) | null) {
    this.#eventSink = sink;
    this.interrupts.onRequest = sink ? (flag) => sink({ kind: 'irq-request', flag }) : null;
    this.dma.onTransfer = sink ? (channel, info) => sink({ kind: 'dma', channel, info }) : null;
    this.bus.onMmioWrite = sink ? (address, value, size) => sink({ kind: 'mmio-write', address, value, size }) : null;
  }

  get onHardwareEvent(): ((event: HardwareEvent) => void) | null {
    return this.#eventSink;
  }

  /** Hardware frames completed since reset (a frame ends when the scanline wraps to 0). */
  get frameCount(): number {
    return this.#frameCount;
  }

  /** The scanline the PPU is on (0–227; 160–227 is VBlank). */
  get scanline(): number {
    return this.#currentScanline;
  }

  /**
   * Run until the current hardware frame ends (the scanline wraps to 0), or until
   * `shouldStop` says so. After a stop, the next call finishes the SAME frame: frames
   * stay aligned to the hardware however often the debugger interrupts them.
   */
  runFrame(shouldStop?: StopPredicate): RunOutcome {
    const target = this.#frameCount + 1;
    return this.#run(() => this.#frameCount >= target, shouldStop);
  }

  /** Run until the PPU moves to the next scanline (or the frame ends), or until `shouldStop`. */
  runScanline(shouldStop?: StopPredicate): RunOutcome {
    const line = this.#currentScanline;
    const frame = this.#frameCount;
    return this.#run(() => this.#currentScanline !== line || this.#frameCount !== frame, shouldStop);
  }

  /** The emulation loop: advance the whole machine until `done`, `shouldStop`, or the CPU gives up. */
  #run(done: () => boolean, shouldStop?: StopPredicate): RunOutcome {
    this.#running = true;
    this.#stopped = false;
    let outcome: RunOutcome = 'done';
    const scheduler = this.scheduler;

    while (this.#running && !done()) {
      // Due events fire one per pass, so a frame that ends among them ends the run.
      if (scheduler.runNextDueEvent()) {
        continue;
      }

      const start = scheduler.currentCycle;
      if (this.interrupts.halted) {
        // A halted CPU sleeps until the next event; the APU keeps running.
        if (shouldStop?.()) {
          outcome = 'stopped';
          break;
        }
        const next = scheduler.nextEventCycle;
        if (next === Infinity) {
          outcome = 'stalled';
          break;
        }
        scheduler.advance(next - scheduler.currentCycle);
      } else {
        this.#runCpu(shouldStop);
      }
      this.apu.tick(scheduler.currentCycle - start);

      if (this.#stopped) {
        outcome = 'stopped';
        break;
      }
      if (!this.#running) {
        outcome = 'halted';
        break;
      }
    }

    this.#running = false;
    return outcome;
  }

  /**
   * Run the CPU until the next event is due. Each instruction moves the clock by its cycles as it
   * completes, so an I/O access sees the cycle its instruction began at, and an event an access
   * schedules earlier than the others ends the run in time.
   */
  #runCpu(shouldStop?: StopPredicate): void {
    const cpu = this.armCpu;
    const scheduler = this.scheduler;
    // Bound the run when nothing is scheduled, so `done` is asked again.
    const limit = scheduler.currentCycle + CYCLES_PER_SCANLINE;

    while (scheduler.currentCycle < scheduler.nextEventCycle && scheduler.currentCycle < limit) {
      // Check for pending IRQ before each instruction. Entering it takes cycles, so look at the
      // clock again before running the handler's first instruction.
      if (this.interrupts.irqPending() && this.#handleIrq()) {
        continue;
      }

      // If halted (e.g. by SWI Halt/VBlankIntrWait), stop running CPU
      // The outer loop will fast-forward to the next event
      if (this.interrupts.halted) {
        this.#eventSink?.({ kind: 'halt' });
        break;
      }

      // The debugger's turn: the instruction at PC has not run and costs nothing.
      if (shouldStop?.()) {
        this.#stopped = true;
        break;
      }

      const cycles = cpu.step();
      if (cycles === 0) {
        // Either the CPU halted itself, or a debug hook refused the instruction. In
        // both cases nothing executed, so nothing is charged.
        if (cpu.halted) {
          this.#running = false;
        } else {
          this.#stopped = true;
        }
        break;
      }
      scheduler.advance(cycles);
    }
  }

  /** Handle an IRQ by switching the CPU to the IRQ handler; returns whether the CPU took it. */
  #handleIrq(): boolean {
    // Don't fire if CPU has IRQs disabled (CPSR I bit)
    if (this.armCpu.irqDisabled()) {
      return false;
    }

    this.#eventSink?.({ kind: 'irq-enter', pc: this.armCpu.registers[15]! });
    this.scheduler.advance(this.armCpu.enterIrq());
    return true;
  }

  // ─── Scanline Timing ──────────────────────────────────────────────

  /**
   * A line began at the cycle `lineStart`: the PPU takes its line-start state (affine reference
   * points, mosaic counters, window flip-flops, the OBJ line), latches DISPCNT DISPCNT_LATCH_CYCLE
   * later, and HBlank comes HBLANK_START_CYCLE later.
   */
  #beginLine(lineStart: number): void {
    this.ppu.beginScanline(this.#currentScanline, this.bus);
    this.scheduler.scheduleAt(EventId.DispcntLatch, lineStart + DISPCNT_LATCH_CYCLE, () => this.#onDispcntLatch());
    this.scheduler.scheduleAt(EventId.HBlank, lineStart + HBLANK_START_CYCLE, (due) => this.#onHBlank(due));
  }

  #onDispcntLatch(): void {
    this.ppu.latchDispcnt(this.#currentScanline, this.bus);
  }

  #onHBlank(due: number): void {
    // The PPU has drawn the line when HBlank begins, from the registers and memory as the CPU left
    // them during the line's HDraw, so a write a V-count IRQ handler makes shows on that same line
    // (mGBA video.c _startHblank calls drawScanline here).
    if (this.#currentScanline < VISIBLE_SCANLINES) {
      this.ppu.renderScanline(this.#currentScanline, this.bus);
    }

    this.#eventSink?.({ kind: 'hblank', scanline: this.#currentScanline });
    this.display.enterHBlank(due);

    if (this.#currentScanline < VISIBLE_SCANLINES) {
      this.dma.trigger(DmaStartTiming.HBlank, due);
    }

    // The line ends 1232 cycles after it began, on the hardware grid however late this ran.
    this.scheduler.scheduleAt(EventId.HBlankEnd, due + CYCLES_PER_SCANLINE - HBLANK_START_CYCLE, (end) =>
      this.#onHBlankEnd(end),
    );
  }

  #onHBlankEnd(due: number): void {
    this.display.leaveHBlank();

    // Advance scanline; after the last line the frame ends and line 0 begins
    this.#currentScanline++;
    if (this.#currentScanline === TOTAL_SCANLINES) {
      this.#currentScanline = 0;
      this.#frameCount++;
    }
    this.display.setScanline(this.#currentScanline, due);
    this.dma.triggerVideoCapture(this.#currentScanline, due);

    if (this.#currentScanline === VISIBLE_SCANLINES) {
      this.#onVBlankStart(due);
    }

    this.#beginLine(due);
  }

  #onVBlankStart(due: number): void {
    this.#eventSink?.({ kind: 'vblank' });
    this.display.enterVBlank(due);

    // Trigger VBlank DMA
    this.dma.trigger(DmaStartTiming.VBlank, due);
  }

  // ─── Save State ─────────────────────────────────────────────────

  /** Serialize the entire emulator state to a snapshot. */
  serialize(): GbaSnapshot {
    return {
      version: 1,
      cpu: this.armCpu.serialize(),
      currentScanline: this.#currentScanline,
      frameCount: this.#frameCount,
      scheduler: this.scheduler.serialize(),
      interrupts: this.interrupts.serialize(),
      timers: this.timers.serialize(),
      dma: this.dma.serialize(),
      input: this.input.serialize(),
      bus: this.bus.serialize(),
      ppu: (this.ppu as Ppu).serialize(),
      apu: this.apu.serialize(),
    };
  }

  /**
   * Restore from a snapshot. ROM/BIOS must already be loaded.
   *
   * Scheduled events come back at exactly the cycles the snapshot recorded — only
   * their callbacks (which cannot be serialized) are reattached. Running K frames
   * from a restored snapshot therefore yields the same machine as running K frames
   * from the original — what replay-based rewind relies on.
   */
  deserialize(snap: GbaSnapshot): void {
    this.#running = false;
    this.#stopped = false;
    this.#currentScanline = snap.currentScanline;
    this.#frameCount = snap.frameCount ?? 0;

    // Restore subsystems
    this.interrupts.deserialize(snap.interrupts);
    this.input.deserialize(snap.input);
    this.scheduler.deserialize(snap.scheduler);
    this.timers.deserialize(snap.timers);
    this.dma.deserialize(snap.dma);
    this.bus.deserialize(snap.bus);
    this.ppu.deserialize(snap.ppu);
    if (snap.apu) {
      this.apu.deserialize(snap.apu);
    }

    // Restore CPU state
    if (snap.cpu) {
      this.armCpu.deserialize(snap.cpu);
    }

    this.#reattachSchedulerCallbacks();
  }

  /** Give every pending event its callback back, without moving it. */
  #reattachSchedulerCallbacks(): void {
    if (this.scheduler.isScheduled(EventId.HBlank)) {
      this.scheduler.reattach(EventId.HBlank, (due) => this.#onHBlank(due));
    }
    if (this.scheduler.isScheduled(EventId.HBlankEnd)) {
      this.scheduler.reattach(EventId.HBlankEnd, (due) => this.#onHBlankEnd(due));
    }
    // A snapshot from before the DISPCNT latch event restores without it: that one line keeps the
    // previous line's latch, and the next line start schedules it again.
    if (this.scheduler.isScheduled(EventId.DispcntLatch)) {
      this.scheduler.reattach(EventId.DispcntLatch, () => this.#onDispcntLatch());
    }
    this.interrupts.reattachEvents();
    this.timers.reattachEvents();
    this.dma.reattachEvents();
    this.serial.reattachEvents();
  }

  /** Stop emulation */
  stop(): void {
    this.#running = false;
  }

  /** Reset the entire system */
  reset(): void {
    this.#running = false;
    this.#stopped = false;
    this.#currentScanline = 0;
    this.#frameCount = 0;
    this.scheduler.reset();
    this.interrupts.reset();
    this.timers.reset();
    this.dma.reset();
    this.input.reset();
    this.bus.reset();
    this.ppu.reset();
    this.apu.reset();
    this.#skipBiosBoot();
    this.display.setScanline(0);
    this.#beginLine(this.scheduler.currentCycle);
  }
}
