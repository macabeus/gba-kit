/**
 * Ensures the two vendored test ELFs (and their build/oracle.json) are present
 * before the suite runs. They are checked into git, so a normal clone runs the
 * tests with NO toolchain at all:
 *
 *   - test-projects/agbcc-min      → agbcc (GCC 2.95), DWARF-2
 *   - test-projects/devkitarm-min  → modern arm-none-eabi-gcc (GCC 14), DWARF-3+
 *
 * Behaviour:
 *   - On CI (process.env.CI): always rebuild natively, so every CI run re-validates
 *     that the vendored toolchains still produce the expected ELFs.
 *   - Locally: use the committed artifacts as-is. They only need rebuilding when you
 *     change a project's sources — and that is a manual, per-project step (see the
 *     error message / test-projects/README.md): agbcc-min via its submodule
 *     (./setup.sh), devkitarm-min via Docker (./build.sh). globalSetup never builds
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
  /** How a developer rebuilds this project's committed artifacts locally. */
  rebuildHint: string;
}

const PROJECTS: Project[] = [
  {
    dir: join(projects, 'agbcc-min'),
    rebuildHint: 'cd test-projects/agbcc-min && ./setup.sh   # builds the agbcc submodule',
  },
  {
    dir: join(projects, 'devkitarm-min'),
    rebuildHint: 'cd test-projects/devkitarm-min && ./build.sh   # builds in Docker',
  },
];

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

/** Rebuild a project's ELF + oracle natively (used on CI only). */
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
  for (const { dir, rebuildHint } of PROJECTS) {
    if (process.env.CI) {
      buildNative(dir);
      continue;
    }
    const haveArtifacts = existsSync(join(dir, 'build', 'min.elf')) && existsSync(join(dir, 'build', 'oracle.json'));
    if (!haveArtifacts) {
      throw new Error(
        `[test-projects] ${dir}: committed build/min.elf or build/oracle.json is missing.\n` +
          `Rebuild it, then commit build/min.elf + build/oracle.json:\n  ${rebuildHint}`,
      );
    }
    // Artifacts present → use the committed ones (no toolchain needed).
  }
}
