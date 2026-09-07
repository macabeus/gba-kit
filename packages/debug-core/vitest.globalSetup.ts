/**
 * The debugger tests run against ROM/ELF pairs built from the C sources in
 * test-fixtures/ — three variants of one program (Thumb -O0, Thumb -O2, ARM -O0), so
 * stepping, locals and unwinding are exercised on unoptimized and optimized DWARF.
 *
 * The built artifacts are committed, so a clone runs the tests with no toolchain.
 * On CI (process.env.CI) they are rebuilt natively to re-validate the recipe. Locally
 * they are only rebuilt by hand after changing the sources: `cd test-fixtures &&
 * ./build.sh` (Docker) or `make` with devkitARM / arm-none-eabi-gcc installed.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'test-fixtures');
const ARTIFACTS = ['thumb-O0.elf', 'thumb-O0.gba', 'thumb-O2.elf', 'thumb-O2.gba', 'arm-O0.elf', 'arm-O0.gba'];

export default function setup(): void {
  if (process.env.CI) {
    execSync('make -B', { cwd: fixtures, stdio: 'inherit' });
    return;
  }
  const missing = ARTIFACTS.filter((f) => !existsSync(join(fixtures, 'build', f)));
  if (missing.length > 0) {
    throw new Error(
      `[test-fixtures] committed ${missing.map((f) => `build/${f}`).join(', ')} missing.\n` +
        'Rebuild them, then commit the refreshed build/ artifacts:\n  cd test-fixtures && ./build.sh   # builds in Docker',
    );
  }
}
