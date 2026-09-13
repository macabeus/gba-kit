/**
 * The rules that decide where a `.sav` belongs, and the messages that say why one
 * belongs nowhere: what a user reads when they pick the wrong file.
 */
import type { CartridgeSave } from '@gba-kit/gba-emulator';
import { describe, expect, it } from 'vitest';

import { MAX_SAVE_FILE_SIZE, SAVE_FILE_SIZES, checkSaveFile, freeStateName, saveFileSize } from '../cartridge-save.js';

const EEPROM: CartridgeSave = { type: 'eeprom', id: 'EEPROM_V121' };
const SRAM: CartridgeSave = { type: 'sram', id: 'SRAM_V113' };
const FLASH: CartridgeSave = { type: 'flash512', id: 'FLASH512_V130' };
const FLASH1M: CartridgeSave = { type: 'flash1m', id: 'FLASH1M_V103' };
const NOTHING: CartridgeSave = { type: null, id: null };

describe('which .sav belongs in which cartridge', () => {
  it.each([
    [EEPROM, 512],
    [EEPROM, 8192],
    [SRAM, 32768],
  ])('takes a %o file of %i bytes', (save, size) => {
    expect(() => checkSaveFile(save, size)).not.toThrow();
  });

  it.each([
    [EEPROM, 32768, 'this ROM declares EEPROM_V121, whose save is 512 or 8192 bytes; this file is 32768 bytes'],
    [SRAM, 65536, 'this ROM declares SRAM_V113, whose save is 32768 bytes; this file is 65536 bytes'],
    [EEPROM, 0, 'this ROM declares EEPROM_V121, whose save is 512 or 8192 bytes; this file is 0 bytes'],
    [SRAM, 0, 'this ROM declares SRAM_V113, whose save is 32768 bytes; this file is 0 bytes'],
    [NOTHING, 512, 'this ROM declares no save type, so there is nowhere to put a .sav'],
  ])('refuses %o at %i bytes', (save, size, message) => {
    expect(() => checkSaveFile(save, size)).toThrow(message);
  });

  it.each([
    [FLASH, 65536],
    [FLASH, 32768],
    [FLASH, 0],
    [FLASH1M, 131072],
    [FLASH1M, 65536],
  ])('refuses %o at %i bytes, because no game could read it back', (save, size) => {
    expect(() => checkSaveFile(save, size)).toThrow(
      `this ROM declares ${save.id}, a flash chip; gba-kit backs the cartridge with plain ` +
        'memory and emulates no flash chip, so a game cannot read a flash .sav back',
    );
  });
});

describe('how big the exported file is', () => {
  it.each([
    [SRAM, 0, 32768],
    [EEPROM, 512, 512],
    [EEPROM, 8192, 8192],
  ])('gives %o with a %i byte chip %i bytes', (save, eepromBytes, size) => {
    expect(saveFileSize(save, eepromBytes)).toBe(size);
  });

  it('has no size for an EEPROM nothing has sized yet', () => {
    expect(() => saveFileSize(EEPROM, 0)).toThrow(
      'this ROM declares EEPROM_V121, and nothing has said yet whether its EEPROM is 4 Kbit or 64 Kbit: ' +
        'run the game until it reads or writes its save, or import a .sav',
    );
  });

  it('has nothing to export from a ROM that declares no save', () => {
    expect(() => saveFileSize(NOTHING, 0)).toThrow('this ROM declares no save type, so it has no save to export');
  });

  it.each([FLASH, FLASH1M])('has nothing worth exporting from %o, which the game never wrote', (save) => {
    expect(() => saveFileSize(save, 0)).toThrow(/emulates no flash chip/);
  });

  it('answers with the size the declaration gives, not the array in memory', () => {
    expect(SAVE_FILE_SIZES.sram).toEqual([32768]);
  });

  it('bounds what a file could be at the biggest .sav there is, for a client checking before it sends one', () => {
    expect(MAX_SAVE_FILE_SIZE).toBe(131072);
  });
});

describe('a name no state has', () => {
  it('numbers rather than writing over what is there', async () => {
    const taken = new Set<string>();
    const free = async (): Promise<string> => {
      const name = await freeStateName('Klonoa (USA)', async (c) => taken.has(c));
      taken.add(name);
      return name;
    };
    expect(await free()).toBe('Klonoa (USA)');
    expect(await free()).toBe('Klonoa (USA) (2)');
    expect(await free()).toBe('Klonoa (USA) (3)');
  });

  it('gives up rather than looking forever', async () => {
    await expect(freeStateName('x', async () => true)).rejects.toThrow("too many states are called 'x'");
  });
});
