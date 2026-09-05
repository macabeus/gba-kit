/** The debug-core fixtures (a small game loop built as Thumb -O0 and -O2), booted the way the Debug page boots. */
import { ManualHost, Session } from '@gba-kit/debug-core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'debug-core',
  'test-fixtures',
  'build',
);

export type Variant = 'thumb-O0' | 'thumb-O2';

export const FRAME_MS = 1000 / 59.7275;

export function fixture(variant: Variant): { rom: Uint8Array; elf: Uint8Array } {
  return {
    rom: new Uint8Array(readFileSync(join(build, `${variant}.gba`))),
    elf: new Uint8Array(readFileSync(join(build, `${variant}.elf`))),
  };
}

export function bootSession(
  variant: Variant,
  host = new ManualHost(),
  options: { elf?: Uint8Array | null; projectDir?: string } = {},
): Promise<Session> {
  const { rom, elf } = fixture(variant);
  return Session.create(host, {
    rom,
    elf: 'elf' in options ? options.elf : elf,
    cwd: '/',
    projectDir: options.projectDir,
    exists: () => true,
  });
}
