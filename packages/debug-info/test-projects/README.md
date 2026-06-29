# Test projects for `@gba-kit/debug-info`

Two tiny GBA programs that produce real ELFs with symbols + DWARF, used as the
test inputs for the parser — so the tests run against actual toolchain output
across the two ecosystems GBA developers use:

| Project         | Toolchain                                                          | DWARF (line) |
| --------------- | ------------------------------------------------------------------ | ------------ |
| `agbcc-min`     | agbcc (GCC 2.95), as a git submodule                               | v2           |
| `devkitarm-min` | modern `arm-none-eabi-gcc`, GCC 14 (devkitARM / ARM GNU Toolchain) | v3+          |

Both compile the same core shape — `add` / `square` (adjacent, exercises the
sequence-boundary case), `bump`, `triple` (in a second `util.c` → multi-CU),
`main`, and a global `g_counter` — with `-g -O2`.

`devkitarm-min` additionally carries a few shapes agbcc (GCC 2.95) can't compile:
an anonymous union (`struct Shape`), an 8-byte `long long` global (`g_wide`),
and a flexible array member (`struct Blob`). It's covered by a devkitarm-only test block.

## What's committed, and what runs the tests

Each project's `build/min.elf` and `build/oracle.json` are **committed** (the rest
of `build/` — `.o`/`.i`/`.s` intermediates — is git-ignored). So a normal clone
runs `pnpm --filter @gba-kit/debug-info test` with **no toolchain**: vitest's
`globalSetup` just checks the committed artifacts exist and the tests read them.

`oracle.json` is the test's reference data: a dump of GNU binutils' own `nm`
(symbol → address) and `addr2line` (function entry → `{func, file, line}`) for that
exact ELF, produced by the shared `tools/gen-oracle.mjs`. The tests assert
`@gba-kit/debug-info` agrees with it — no hard-coded addresses, and no
subprocess/parsing in the test itself. Paths are reduced to basenames so the file
is machine-independent.

## Rebuilding (only when you change a project's sources)

The build is per-project and rarely needed. After editing a project's sources,
rebuild it and commit the refreshed `build/min.elf` + `build/oracle.json`:

```bash
# agbcc-min — builds the GCC 2.95 compiler from the submodule, then the ELF + oracle.
# Needs a host C compiler + arm-none-eabi binutils + node on PATH.
git submodule update --init --recursive      # first time only
cd agbcc-min && ./setup.sh

# devkitarm-min — builds in Docker (devkitpro/devkitarm), so no local devkitARM
# or arm-none-eabi install is required. Node is installed inside the container for
# the oracle step.
cd devkitarm-min && ./build.sh
```

`agbcc-min/agbcc` is the [`Dream-Atelier/agbcc`](https://github.com/Dream-Atelier/agbcc)
submodule, pinned by commit. CI rebuilds **both** projects natively from scratch on
every run (see `../../../.github/workflows/ci.yml`), so the committed artifacts stay
honest — `globalSetup` rebuilds when `process.env.CI` is set.

These ELFs are never executed — they exist purely so the toolchains emit real
symbol tables and DWARF for the parser to consume.
