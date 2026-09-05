/**
 * The emulated GBA as the session sees it: boot, run, inspect, snapshot. Every
 * read the debugger shows goes through the bus's side-effect-free `peek`, every
 * write through `poke`, and the run loop is the machine's own (`runFrame` with a
 * stop predicate), never the CPU stepped by hand.
 */
import type { GbaButton, HardwareEvent, RunOutcome, StopPredicate } from '@gba-kit/gba-emulator';
import { Gba, SCREEN_HEIGHT, SCREEN_WIDTH } from '@gba-kit/gba-emulator';
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';

export const REGISTER_NAMES = [
  'r0',
  'r1',
  'r2',
  'r3',
  'r4',
  'r5',
  'r6',
  'r7',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'sp',
  'lr',
  'pc',
] as const;

export class Machine {
  readonly gba: Gba;
  readonly rom: Uint8Array;

  /**
   * A fresh machine booted with `rom`, or a wrapper around an existing `gba` that
   * already runs it (a page that plays the ROM and debugs it in turns): the
   * existing one is left exactly as it is.
   */
  constructor(rom: Uint8Array, gba?: Gba) {
    this.rom = rom;
    if (gba) {
      this.gba = gba;
    } else {
      this.gba = new Gba();
      this.boot();
    }
  }

  /** Reset to the post-BIOS boot state the real BIOS leaves behind, ROM loaded. */
  boot(): void {
    this.gba.reset();
    this.gba.loadRom(this.rom);
    const cpu = this.gba.armCpu;
    cpu.resetState();
    cpu.switchMode(0x12); // IRQ
    cpu.registers[13] = 0x03007fa0;
    cpu.switchMode(0x13); // SVC
    cpu.registers[13] = 0x03007fe0;
    cpu.switchMode(0x1f); // SYS
    cpu.registers[13] = 0x03007f00;
    cpu.cpsr = 0x1f; // SYS mode, IRQs enabled, ARM state
    cpu.registers[15] = 0x08000000;
  }

  get pc(): number {
    return this.gba.armCpu.registers[15]!;
  }

  get thumb(): boolean {
    return this.gba.armCpu.getT();
  }

  get cpsr(): number {
    return this.gba.armCpu.cpsr >>> 0;
  }

  get mode(): number {
    return this.gba.armCpu.getMode();
  }

  get registers(): Uint32Array {
    return this.gba.armCpu.registers;
  }

  get frame(): number {
    return this.gba.frameCount;
  }

  get scanline(): number {
    return this.gba.scanline;
  }

  get cycle(): number {
    return this.gba.scheduler.currentCycle;
  }

  get halted(): boolean {
    return this.gba.interrupts.halted;
  }

  runFrame(shouldStop?: StopPredicate): RunOutcome {
    return this.gba.runFrame(shouldStop);
  }

  runScanline(shouldStop?: StopPredicate): RunOutcome {
    return this.gba.runScanline(shouldStop);
  }

  /** `size` bytes at `address`, or null when any of them is unmapped. */
  peek(address: number, size: number): Uint8Array | null {
    const { data, readable } = this.gba.bus.peek(address, size);
    return readable === size ? data : null;
  }

  /** Up to `size` bytes at `address`, with how many were mapped. */
  peekPartial(address: number, size: number): { data: Uint8Array; readable: number } {
    return this.gba.bus.peek(address, size);
  }

  peekWord(address: number): number | undefined {
    const b = this.peek(address, 4);
    return b ? (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0 : undefined;
  }

  /** Little-endian unsigned integer of `size` bytes, or undefined. */
  peekUnsigned(address: number, size: number): number | undefined {
    const b = this.peek(address, size);
    if (!b) {
      return undefined;
    }
    let v = 0;
    for (let i = size - 1; i >= 0; i--) {
      v = v * 256 + b[i]!;
    }
    return v >>> 0;
  }

  /** Store bytes; returns how many landed (ROM, BIOS and EEPROM refuse). */
  poke(address: number, bytes: Uint8Array): number {
    return this.gba.bus.poke(address, bytes);
  }

  /** The framebuffer as RGBA bytes (a fresh copy). ABGR words are RGBA in memory order. */
  framebufferRgba(): Uint8Array {
    const fb = this.gba.ppu.getFramebuffer();
    return new Uint8Array(fb.buffer, fb.byteOffset, fb.byteLength).slice();
  }

  /** Interleaved stereo samples at the APU's rate; returns how many frames were filled. */
  readAudio(out: Float32Array): number {
    return this.gba.apu.readSamples(out);
  }

  snapshot(): GbaSnapshot {
    return this.gba.serialize();
  }

  restore(snapshot: GbaSnapshot): void {
    this.gba.deserialize(snapshot);
  }

  setButton(button: number, down: boolean): void {
    if (button < 0 || button > 9) {
      return;
    }
    if (down) {
      this.gba.input.press(button as GbaButton);
    } else {
      this.gba.input.release(button as GbaButton);
    }
  }

  setButtons(mask: number): void {
    this.gba.input.setButtons(mask);
  }

  /** Buttons held now (bit set = pressed). */
  get buttons(): number {
    return ~this.gba.input.readKeyInput() & 0x3ff;
  }

  set onHardwareEvent(sink: ((event: HardwareEvent) => void) | null) {
    this.gba.onHardwareEvent = sink;
  }

  static readonly SCREEN_WIDTH = SCREEN_WIDTH;
  static readonly SCREEN_HEIGHT = SCREEN_HEIGHT;
}

/** Which region an address belongs to, or null when nothing decodes it. */
export function regionOf(
  address: number,
): 'bios' | 'ewram' | 'iwram' | 'mmio' | 'palette' | 'vram' | 'oam' | 'rom' | 'sram' | null {
  switch ((address >>> 24) & 0xff) {
    case 0x00:
      return (address & 0x00ffffff) < 0x4000 ? 'bios' : null;
    case 0x02:
      return 'ewram';
    case 0x03:
      return 'iwram';
    case 0x04:
      return (address & 0x00ffffff) < 0x400 ? 'mmio' : null;
    case 0x05:
      return 'palette';
    case 0x06:
      return 'vram';
    case 0x07:
      return 'oam';
    case 0x08:
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
      return 'rom';
    case 0x0e:
    case 0x0f:
      return 'sram';
    default:
      return null;
  }
}

/** Whether a return address is worth following: mapped, and in a region that holds code. */
export function isCodeAddress(address: number): boolean {
  const region = regionOf(address);
  return region === 'rom' || region === 'iwram' || region === 'ewram' || region === 'bios';
}

/** SHA-256 of a ROM, hex — the identity save states and recordings are bound to. */
export async function romHash(rom: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return `len-${rom.length}`;
  }
  const digest = await subtle.digest('SHA-256', rom as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
