/**
 * Ensures the vendored test artifacts (each project's ELF, plus its build/oracle.json)
 * are present before the suite runs. They are checked into git, so a normal clone runs
 * the tests with NO toolchain at all:
 *
 *   - test-projects/agbcc-min      → agbcc (GCC 2.95), ARM, little-endian, DWARF-2
 *   - test-projects/devkitarm-min  → arm-none-eabi-gcc (GCC 14), little-endian, DWARF-3+
 *   - test-projects/mips-min       → mips-linux-gnu-gcc, MIPS o32, big-endian
 *   - test-projects/ppc-min        → powerpc-linux-gnu-gcc, PowerPC 32, big-endian
 *                                    (also a relocatable main.o, for the RELA path)
 *
 * Behaviour:
 *   - On CI (process.env.CI): always rebuild natively, so every CI run re-validates
 *     that the vendored toolchains still produce the expected artifacts.
 *   - Locally: use the committed artifacts as-is. They only need rebuilding when you
 *     change a project's sources — and that is a manual, per-project step (see the
 *     error message / test-projects/README.md): agbcc-min via its submodule
 *     (./setup.sh), the others via Docker (./build.sh). globalSetup never builds
 *     locally, so it never needs Docker or a cross toolchain on a contributor's box.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projects = join(here, 'test-projects');

interface Project {
  dir: string;
  /** Files under build/ that are committed and that the tests read. */
  artifacts: string[];
  /** How a developer rebuilds this project's committed artifacts locally. */
  rebuildHint: string;
}

const ELF_AND_ORACLE = ['min.elf', 'oracle.json'];

const PROJECTS: Project[] = [
  {
    dir: join(projects, 'agbcc-min'),
    artifacts: ELF_AND_ORACLE,
    rebuildHint: 'cd test-projects/agbcc-min && ./setup.sh   # builds the agbcc submodule',
  },
  {
    dir: join(projects, 'devkitarm-min'),
    artifacts: ELF_AND_ORACLE,
    rebuildHint: 'cd test-projects/devkitarm-min && ./build.sh   # builds in Docker',
  },
  {
    dir: join(projects, 'mips-min'),
    artifacts: ELF_AND_ORACLE,
    rebuildHint: 'cd test-projects/mips-min && ./build.sh   # builds in Docker',
  },
  {
    dir: join(projects, 'ppc-min'),
    artifacts: [...ELF_AND_ORACLE, 'main.o', 'oracle-obj.json'],
    rebuildHint: 'cd test-projects/ppc-min && ./build.sh   # builds in Docker',
  },
];

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

/** Rebuild a project's artifacts natively (used on CI only). */
function buildNative(dir: string): void {
  const isAgbcc = dir.endsWith('agbcc-min');
  if (isAgbcc && !existsSync(join(dir, 'agbcc', 'agbcc'))) {
    // No prebuilt agbcc (compiler not provided by an earlier CI step): build it.
    run('./setup.sh', dir);
  } else {
    run('make -B', dir); // -B: rebuild regardless of checkout mtimes
  }
}

export default function setup(): void {
  for (const { dir, artifacts, rebuildHint } of PROJECTS) {
    if (process.env.CI) {
      buildNative(dir);
      continue;
    }
    const missing = artifacts.filter((file) => !existsSync(join(dir, 'build', file)));
    if (missing.length > 0) {
      throw new Error(
        `[test-projects] ${dir}: committed ${missing.map((f) => `build/${f}`).join(', ')} missing.\n` +
          `Rebuild it, then commit the refreshed build/ artifacts:\n  ${rebuildHint}`,
      );
    }
    // Artifacts present → use the committed ones (no toolchain needed).
  }
}
