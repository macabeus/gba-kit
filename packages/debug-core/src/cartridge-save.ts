/**
 * A `.sav` file is a raw dump of a cartridge's battery-backed memory and says nothing
 * about itself: which chip it belongs in follows from the save type the ROM declares
 * and the file's size together. A file those two do not account for is refused —
 * padded or truncated into the wrong chip it would read as a corrupt save, which looks
 * like a game bug rather than a wrong file.
 *
 * Every rule and every message lives here, so the debug adapter and the in-process
 * transport agree by construction rather than by care.
 */
import type { CartridgeSave, SaveType } from '@gba-kit/gba-emulator';

/** The `.sav` sizes each declared save type has; the flash ones bound what a file could be, since no flash save is taken. */
export const SAVE_FILE_SIZES: Record<SaveType, readonly number[]> = {
  eeprom: [512, 8192], // 4 Kbit and 64 Kbit, which the chip's address width tells apart, not the file
  sram: [32768],
  flash512: [65536],
  flash1m: [131072],
};

/** No `.sav` of any kind is bigger, so a file past it is one a host handed over by mistake. */
export const MAX_SAVE_FILE_SIZE = Math.max(...Object.values(SAVE_FILE_SIZES).flat());

/** How many states may share a name before `freeStateName` gives up looking for a free one. */
const MAX_SAME_NAME = 999;

/**
 * gba-kit serves the 0x0E window as plain memory and emulates no flash chip: the
 * identify sequence a flash driver starts with is not answered, so the game reads save
 * bytes where a chip ID should be, gives up, and never reads the save at all — while
 * the command bytes it wrote land in the save as data. A 1 Mbit chip is further out of
 * reach still: two banks of 64 KB, where there is one window and no bank register.
 */
function refuseFlash(save: CartridgeSave): never {
  throw new Error(
    `this ROM declares ${save.id}, a flash chip; gba-kit backs the cartridge with plain ` +
      'memory and emulates no flash chip, so a game cannot read a flash .sav back',
  );
}

/** `512 or 8192 bytes`: the sizes a type's file is allowed to be, as a message says them. */
function sizesOf(type: SaveType): string {
  const sizes = SAVE_FILE_SIZES[type];
  return `${sizes.join(' or ')} bytes`;
}

/**
 * Where a `.sav` of `byteLength` bytes belongs in this cartridge. Throws the reason it
 * belongs nowhere, which is what a user is shown.
 */
export function checkSaveFile(save: CartridgeSave, byteLength: number): void {
  if (save.type === null) {
    throw new Error('this ROM declares no save type, so there is nowhere to put a .sav');
  }
  if (save.type === 'flash512' || save.type === 'flash1m') {
    refuseFlash(save);
  }
  if (!SAVE_FILE_SIZES[save.type].includes(byteLength)) {
    throw new Error(
      `this ROM declares ${save.id}, whose save is ${sizesOf(save.type)}; this file is ${byteLength} bytes`,
    );
  }
}

/**
 * How many bytes of a cartridge's backup memory belong in its `.sav`: the declared
 * type's size, never the array's — the SRAM window is always 64 KB in memory but an
 * `SRAM_V` cartridge's file is 32 KB. An EEPROM's size is not in the string, so it
 * comes from the address width, and while nothing has settled that there is no answer
 * to give.
 */
export function saveFileSize(save: CartridgeSave, eepromAddrBits: number): number {
  if (save.type === null) {
    throw new Error('this ROM declares no save type, so it has no save to export');
  }
  if (save.type === 'flash512' || save.type === 'flash1m') {
    refuseFlash(save);
  }
  if (save.type !== 'eeprom') {
    return SAVE_FILE_SIZES[save.type][0]!;
  }
  if (eepromAddrBits === 0) {
    throw new Error(
      `this ROM declares ${save.id}, and nothing has said yet whether its EEPROM is 4 Kbit or 64 Kbit: ` +
        'run the game until it reads or writes its save, or import a .sav',
    );
  }
  return eepromAddrBits === 6 ? 512 : 8192;
}

/**
 * The first of `name`, `name (2)`, `name (3)`… that `taken` does not answer to: an
 * import never writes over the one before it.
 */
export async function freeStateName(name: string, taken: (candidate: string) => Promise<boolean>): Promise<string> {
  for (let n = 1; n <= MAX_SAME_NAME; n++) {
    const candidate = n === 1 ? name : `${name} (${n})`;
    if (!(await taken(candidate))) {
      return candidate;
    }
  }
  throw new Error(`too many states are called '${name}'`);
}
