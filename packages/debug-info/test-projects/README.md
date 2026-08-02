# Test projects for `@gba-kit/debug-info`

Four tiny programs that produce real ELFs with symbols + DWARF, used as the test
inputs for the parser — so the tests run against actual toolchain output across
both byte orders and three architectures:

| Project         | Toolchain                                                          | Target                 | DWARF (line) |
| --------------- | ------------------------------------------------------------------ | ---------------------- | ------------ |
| `agbcc-min`     | agbcc (GCC 2.95), as a git submodule                               | ARM, little-endian     | v2           |
| `devkitarm-min` | modern `arm-none-eabi-gcc`, GCC 14 (devkitARM / ARM GNU Toolchain) | ARM, little-endian     | v3+          |
| `mips-min`      | `mips-linux-gnu-gcc` (stock Ubuntu cross package)                  | MIPS o32, big-endian   | v3+          |
| `ppc-min`       | `powerpc-linux-gnu-gcc` (stock Ubuntu cross package)               | PowerPC 32, big-endian | v3+          |

The ARM pair compiles the same core shape — `add` / `square` (adjacent, exercises
the sequence-boundary case), `bump`, `triple` (in a second `util.c` → multi-CU),
`main`, and a global `g_counter` — with `-g -O2`.

`agbcc-min` additionally carries the producer-quirk shapes `producer-quirks.spec.ts`
pins (a struct forward-declared in the first CU and defined in the second, zero-length
and unsized-extern arrays, an asm-defined table in `crt0.s`) — all appended after the
shared core shape, which stays line-stable.

`devkitarm-min` additionally carries a few shapes agbcc (GCC 2.95) can't compile:
an anonymous union (`struct Shape`), an 8-byte `long long` global (`g_wide`),
and a flexible array member (`struct Blob`). It's covered by a devkitarm-only test block.

It also vendors `build/macinfo.o`: its `main.c` compiled with
`-gdwarf-2 -g3 -gstrict-dwarf` — the macro-sidecar recipe — whose `.debug_macinfo`
records the fixture `#define`s at the end of that file (asserted by exact line number
in `debug-macro.spec.ts`, so append there, never insert above).

## The big-endian pair

`mips-min` and `ppc-min` compile one shared source (their `main.c` / `util.c` are
byte-identical) with `-g -O2 -fno-eliminate-unused-debug-types`. Both the ELF
container and the whole DWARF payload are stored MSB-first. Every declaration in
that `main.c` is one shape the parser classifies: a scalar, a pointer, an array, a
`const` array, a `volatile` scalar, a struct with named members, a struct with
**bitfields**, and a struct with a member-level `volatile` next to a signed narrow
member.

The bitfields are the assertion class the little-endian projects structurally
cannot make: a big-endian target allocates them from the **most** significant end
of the storage unit, so the identical C declaration lands mirrored — `cross` is a
2-byte read at offset 0 shifted right by 4 here, by 5 on ARM. The compilers' own
read-modify-write of that field is the ground truth: MIPS
`lhu $t2 ; ins $t2,$v0,0x4,0x7 ; sh $t2`, PowerPC `lhz r6 ; rlwimi r6,r9,4,21,27 ; sth r6`.

`ppc-min` also vendors `build/main.o`, a **relocatable** object. PowerPC uses RELA
relocations, so in a `.o` the `.debug_*` sections hold zeros where string and
section offsets belong, and the real values sit in `.rela.<section>` addends — 59
of them in the vendored object. None of its DWARF resolves until `ElfFile.sectionData` applies
`symbol value + addend`, which makes it the only artifact shape that exercises
that path.

## What's committed, and what runs the tests

Each project's built artifacts (`build/min.elf` + `build/oracle.json`, plus
`ppc-min`'s `build/main.o` + `build/oracle-obj.json`) are **committed** (the rest
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
rebuild it and commit the refreshed `build/` artifacts:

```bash
# agbcc-min — builds the GCC 2.95 compiler from the submodule, then the ELF + oracle.
# Needs a host C compiler + arm-none-eabi binutils + node on PATH.
git submodule update --init --recursive      # first time only
cd agbcc-min && ./setup.sh

# The other three build in Docker, so no local cross toolchain is required:
#   devkitarm-min      → devkitpro/devkitarm
#   mips-min, ppc-min  → ubuntu:24.04 + the stock gcc-{mips,powerpc}-linux-gnu packages
cd devkitarm-min && ./build.sh
cd mips-min && ./build.sh
cd ppc-min && ./build.sh
```

`agbcc-min/agbcc` is the [`Dream-Atelier/agbcc`](https://github.com/Dream-Atelier/agbcc)
submodule, pinned by commit. CI rebuilds **all four** projects natively from scratch on
every run (see `../../../.github/workflows/ci.yml`), so the committed artifacts stay
honest — `globalSetup` rebuilds when `process.env.CI` is set.

These ELFs are never executed — they exist purely so the toolchains emit real
symbol tables and DWARF for the parser to consume.
