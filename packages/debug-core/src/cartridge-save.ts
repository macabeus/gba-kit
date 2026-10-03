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

/** The `.sav` sizes each declared save type has. */
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
  if (!SAVE_FILE_SIZES[save.type].includes(byteLength)) {
    throw new Error(
      `this ROM declares ${save.id}, whose save is ${sizesOf(save.type)}; this file is ${byteLength} bytes`,
    );
  }
}

/**
 * How many bytes of a cartridge's backup memory belong in its `.sav`: for SRAM and flash,
 * the size the declared type gives. An EEPROM's string does not give its size and its
 * array is 8 KB either way, so `eepromSaveBytes` (the bus's) answers; while it is 0, the
 * size is still unknown and this throws.
 */
export function saveFileSize(save: CartridgeSave, eepromSaveBytes: number): number {
  if (save.type === null) {
    throw new Error('this ROM declares no save type, so it has no save to export');
  }
  if (save.type !== 'eeprom') {
    return SAVE_FILE_SIZES[save.type][0]!;
  }
  if (eepromSaveBytes === 0) {
    throw new Error(
      `this ROM declares ${save.id}, and nothing has said yet whether its EEPROM is 4 Kbit or 64 Kbit: ` +
        'run the game until it reads or writes its save, or import a .sav',
    );
  }
  return eepromSaveBytes;
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
