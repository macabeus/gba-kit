/**
 * The emulated GBA as the session sees it: boot, run, inspect, snapshot. Every
 * read the debugger shows goes through the bus's side-effect-free `peek`, every
 * write through `poke`, and the run loop is the machine's own (`runFrame` with a
 * stop predicate), never the CPU stepped by hand.
 */
import { MODE_SYS } from '@gba-kit/arm-emulator/arm-cpu';
import type { HardwareEvent, RunOutcome, StopPredicate } from '@gba-kit/gba-emulator';
import { BOOT_STACK_POINTERS, Gba } from '@gba-kit/gba-emulator';
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';

/**
 * Below this there is no program code: the region holds the BIOS and its exception
 * stubs, which is what makes a return address landing here a mode boundary rather
 * than a caller, and what no program symbol may name.
 */
export const LOWEST_PROGRAM_ADDRESS = 0x4000;

/** The two regions a stack or a memory search lives in; both are mirrored every `size`. */
export const RAM_REGIONS = {
  iwram: { base: 0x03000000, size: 0x8000 },
  ewram: { base: 0x02000000, size: 0x40000 },
} as const;

/** The boot layout by mode, for asking about one mode rather than replaying the sequence. */
const BOOT_STACKS = new Map(BOOT_STACK_POINTERS);

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
    for (const [mode, sp] of BOOT_STACK_POINTERS) {
      cpu.switchMode(mode);
      cpu.registers[13] = sp;
    }
    cpu.switchMode(MODE_SYS);
    cpu.cpsr = MODE_SYS; // SYS mode, IRQs enabled, ARM state
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

  get onHardwareEvent(): ((event: HardwareEvent) => void) | null {
    return this.gba.onHardwareEvent;
  }
}

/** Which region an address belongs to, or null when nothing decodes it. */
export function regionOf(
  address: number,
): 'bios' | 'ewram' | 'iwram' | 'mmio' | 'palette' | 'vram' | 'oam' | 'rom' | 'sram' | null {
  switch ((address >>> 24) & 0xff) {
    case 0x00:
      return (address & 0x00ffffff) < LOWEST_PROGRAM_ADDRESS ? 'bios' : null;
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

/**
 * The highest address a stack of `mode` can reach, which is what bounds how deep a
 * call stack can be — the real bound, where a constant frame limit is a guess.
 *
 * Each mode's stack ends where the BIOS left its pointer, and the modes are
 * stacked on each other at the top of IWRAM: searching past a SYS stack's top
 * reads the IRQ stack above it, whose words belong to no frame of this one. A
 * pointer that is not under its mode's boot top is a program that moved its own
 * stack, and then the region holding it is all that bounds it — rounded up from
 * the pointer, because both RAM regions are mirrored every region size, so a stack
 * in IWRAM's 0x03ffxxxx mirror is the same memory far above the top of the first
 * copy.
 */
export function stackBoundFor(mode: number, sp: number | undefined): number {
  const bootTop = BOOT_STACKS.get(mode);
  const fallback = bootTop ?? (RAM_REGIONS.iwram.base + RAM_REGIONS.iwram.size) >>> 0;
  if (sp === undefined) {
    return fallback;
  }
  const region = regionOf(sp);
  if (bootTop !== undefined && sp <= bootTop && region === regionOf(bootTop)) {
    return bootTop;
  }
  if (region === 'iwram' || region === 'ewram') {
    const size = RAM_REGIONS[region].size;
    return ((sp & ~(size - 1)) + size) >>> 0;
  }
  return fallback;
}

/**
 * SHA-256 of a ROM, hex — the identity save states and recordings are bound to.
 * A host without `crypto.subtle` (an insecure origin, say) gets a length-based
 * stand-in.
 */
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
