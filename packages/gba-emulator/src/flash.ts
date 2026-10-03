/**
 * GBA Flash — the 64 KB and 128 KB flash chips a cartridge wires to the 0x0E window.
 *
 * The chip sits on the cartridge's 8-bit bus with a 16-bit address, so the window shows
 * one 64 KB bank at a time and mirrors it every 64 KB. Reads return the array; writes are
 * commands, each opened by two unlock writes:
 *
 *   [E005555]=AAh, [E002AAA]=55h, [E005555]=cmd
 *
 *   90h  ID mode: [E000000] reads the manufacturer, [E000001] the device; command F0h leaves it
 *   80h  erase: a second unlock, then 10h at [E005555] erases the chip, 30h at [E00n000] sector n
 *   A0h  program: the next write programs one byte, anywhere in the bank
 *   B0h  bank select (128 KB chips): the next write, at [E000000], picks bank 0 or 1
 *
 * These are NOR flash parts: programming drives bits from 1 to 0 and an erase brings them
 * back to 1, so an erased byte reads FFh and programming over a written byte leaves the
 * AND of the two, which is why a game erases a sector before it writes one. Erase and
 * program complete at once: a game polling for completion sees the final data on its
 * first read.
 *
 * The chip IDs are the ones mGBA reports: the Panasonic MN63F805MNP (device 1Bh,
 * manufacturer 32h) for 64 KB and the Sanyo LE26FV10N1TS (13h, 62h) for 128 KB. The
 * SDK's flash library accepts either, along with the Atmel, SST and Macronix parts
 * GBATEK lists.
 *
 * References: GBATEK "GBA Cart Backup Flash ROM"; mGBA src/gba/savedata.c
 * (GBASavedataReadFlash, GBASavedataWriteFlash); NanoBoyAdvance src/nba/src/hw/rom/backup/flash.cc.
 */
import type { FlashSnapshot } from './savestate.js';

/** One bank: what the 16-bit address the cartridge bus carries reaches. */
export const FLASH_BANK_BYTES = 0x10000;

/** What an erased flash cell reads as, and what SRAM holds before anything writes it (mGBA GBASavedataInitSRAM). */
export const ERASED_BYTE = 0xff;

const SECTOR_BYTES = 0x1000;
const UNLOCK_ADDRESS_1 = 0x5555;
const UNLOCK_ADDRESS_2 = 0x2aaa;

/** The ID a chip answers in ID mode, per GBATEK "GBA Cart Backup Flash ROM". */
interface FlashChipId {
  manufacturer: number;
  device: number;
}

/** Panasonic MN63F805MNP, 64 KB: ID 1B32h. */
const PANASONIC_MN63F805MNP: FlashChipId = { manufacturer: 0x32, device: 0x1b };

/** Sanyo LE26FV10N1TS, 128 KB: ID 1362h. */
const SANYO_LE26FV10N1TS: FlashChipId = { manufacturer: 0x62, device: 0x13 };

/** How far into a command's unlock sequence the chip is. */
const enum FlashUnlock {
  Locked = 0,
  /** AAh reached 5555h */
  First = 1,
  /** 55h reached 2AAAh: the next write is the command */
  Second = 2,
}

/** The command in effect, by its command byte. */
const enum FlashCommand {
  None = 0x00,
  Erase = 0x80,
  Id = 0x90,
  Program = 0xa0,
  SwitchBank = 0xb0,
}

const ERASE_CHIP = 0x10;
const ERASE_SECTOR = 0x30;
const LEAVE_ID_MODE = 0xf0;

export class GbaFlash {
  /** The whole chip, bank 0 first; empty while the cartridge has no flash */
  #data = new Uint8Array(0);

  /** The ID mode answer; the chip's identity, like its size */
  #id: FlashChipId = PANASONIC_MN63F805MNP;

  #unlock: FlashUnlock = FlashUnlock.Locked;
  #command: FlashCommand = FlashCommand.None;
  /** Where the bank the window shows starts in #data: 0, or FLASH_BANK_BYTES for bank 1 */
  #bankBase = 0;

  /**
   * Fit the chip the cartridge carries: `banks` 64 KB banks (1 or 2), erased; 0 for a
   * cartridge without flash.
   */
  insert(banks: number): void {
    this.#data = new Uint8Array(banks * FLASH_BANK_BYTES).fill(ERASED_BYTE);
    this.#id = banks > 1 ? SANYO_LE26FV10N1TS : PANASONIC_MN63F805MNP;
    this.#idle();
  }

  /** How many bytes the chip holds: 65536, 131072, or 0 without one. */
  get size(): number {
    return this.#data.length;
  }

  /** An erased chip in read mode at bank 0, keeping its size and ID. */
  reset(): void {
    this.#data.fill(ERASED_BYTE);
    this.#idle();
  }

  /** Read mode at bank 0, with no command half sent. */
  #idle(): void {
    this.#unlock = FlashUnlock.Locked;
    this.#command = FlashCommand.None;
    this.#bankBase = 0;
  }

  serialize(): FlashSnapshot {
    return {
      data: new Uint8Array(this.#data),
      unlock: this.#unlock,
      command: this.#command,
      bank: this.#bankBase / FLASH_BANK_BYTES,
    };
  }

  deserialize(snap: FlashSnapshot): void {
    this.#data.fill(ERASED_BYTE);
    this.#data.set(snap.data.subarray(0, this.#data.length));
    this.#unlock = snap.unlock as FlashUnlock;
    this.#command = snap.command as FlashCommand;
    const bankBase = snap.bank * FLASH_BANK_BYTES;
    this.#bankBase = bankBase < this.#data.length ? bankBase : 0;
  }

  /** The chip's contents, as a `.sav` file holds them: bank 0, then bank 1. */
  readAll(): Uint8Array {
    return new Uint8Array(this.#data);
  }

  /** Put a `.sav` in the chip, erased past its end, in read mode at bank 0. */
  install(bytes: Uint8Array): void {
    this.#data.fill(ERASED_BYTE);
    this.#data.set(bytes);
    this.#idle();
  }

  /** The byte a CPU read of the window returns at `address`; side-effect free. */
  read8(address: number): number {
    const offset = address & (FLASH_BANK_BYTES - 1);
    if (this.#command === FlashCommand.Id && offset < 2) {
      return offset === 0 ? this.#id.manufacturer : this.#id.device;
    }
    return this.#data[this.#bankBase + offset]!;
  }

  /** Debugger write: store `value` in the bank the window shows, outside the protocol. */
  poke8(address: number, value: number): void {
    this.#data[this.#bankBase + (address & (FLASH_BANK_BYTES - 1))] = value;
  }

  /** A CPU write of the window: one step of the command protocol. */
  write8(address: number, value: number): void {
    const offset = address & (FLASH_BANK_BYTES - 1);
    if (this.#unlock === FlashUnlock.Locked) {
      // A program or bank-select command takes the very next write as its operand.
      if (this.#command === FlashCommand.Program) {
        this.#data[this.#bankBase + offset]! &= value;
        this.#command = FlashCommand.None;
        return;
      }
      if (this.#command === FlashCommand.SwitchBank) {
        // GBATEK: "[E000000h]=bnk (write bank number 0..1)", the two values mGBA
        // GBASavedataWriteFlash takes
        if (offset === 0 && value < 2) {
          this.#bankBase = value * FLASH_BANK_BYTES;
        }
        this.#command = FlashCommand.None;
        return;
      }
      if (offset === UNLOCK_ADDRESS_1 && value === 0xaa) {
        this.#unlock = FlashUnlock.First;
      }
      return;
    }
    if (this.#unlock === FlashUnlock.First) {
      this.#unlock = offset === UNLOCK_ADDRESS_2 && value === 0x55 ? FlashUnlock.Second : FlashUnlock.Locked;
      return;
    }
    this.#unlock = FlashUnlock.Locked;
    this.#runCommand(offset, value);
  }

  /** The write that follows a complete unlock sequence. */
  #runCommand(offset: number, value: number): void {
    switch (this.#command) {
      case FlashCommand.Erase:
        // The erase command's second half: the chip at 5555h, or the sector the address names.
        if (offset === UNLOCK_ADDRESS_1 && value === ERASE_CHIP) {
          this.#data.fill(ERASED_BYTE);
        } else if (value === ERASE_SECTOR) {
          const start = this.#bankBase + (offset & ~(SECTOR_BYTES - 1));
          this.#data.fill(ERASED_BYTE, start, start + SECTOR_BYTES);
        }
        this.#command = FlashCommand.None;
        return;
      case FlashCommand.Id:
        // ID mode holds until its terminate command.
        if (offset === UNLOCK_ADDRESS_1 && value === LEAVE_ID_MODE) {
          this.#command = FlashCommand.None;
        }
        return;
      default:
        break;
    }
    if (offset !== UNLOCK_ADDRESS_1) {
      return;
    }
    switch (value) {
      case FlashCommand.Erase:
      case FlashCommand.Id:
      case FlashCommand.Program:
        this.#command = value as FlashCommand;
        break;
      case FlashCommand.SwitchBank:
        // Bank select is a command of the 128 KB chips only.
        if (this.#data.length > FLASH_BANK_BYTES) {
          this.#command = FlashCommand.SwitchBank;
        }
        break;
      default:
        break;
    }
  }
}
