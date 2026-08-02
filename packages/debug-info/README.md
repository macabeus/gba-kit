# @gba-kit/debug-info

Parse ELF symbols and DWARF debug info from a (`-g`-built) ELF32, and answer the
queries a source-level debugger needs:

- **PC → function** (`pcToFunction`) — from `.symtab`, so it covers every linked
  function, including `INCLUDE_ASM` stubs with no DWARF.
- **name → address** / **address → symbol** (`symbolToAddress`, `addressToSymbol`).
- **PC → C `file:line`** (`pcToSource`) — from the DWARF `.debug_line` table.
- **type layout** (`struct`, `structMember`, `enumValues`) and **declaration shape**
  (`types.variableShape`) — from `.debug_info`.
- **function signatures** (`types.functionSignature`) — return and parameter types of
  every function the ELF compiled from C; `null` means "not compiled here", never
  "takes no arguments".
- **the `-g3` macro table** (`macros`, `parseDebugMacinfo`) — the only place an
  address-cast `#define gCounter (*(u16 *)0x03001234)` name survives: a macro leaves
  no symbol and no DIE.

This is the general ELF/DWARF piece of gba-kit, not a GBA-only one:

- **both byte orders** — the order is read from `e_ident` and threaded through the
  container and the DWARF payload alike. Big-endian bitfields are allocated from
  the most significant end of the storage unit, and are reported that way.
- **linked ELFs and relocatable objects** — in a `.o` whose relocations are
  RELA-style (PowerPC), the raw `.debug_*` fields are zeros and the real values sit
  in `.rela.<section>` addends; those are applied on read.
- **DWARF 2 through 5**, as emitted by anything from GCC 2.95 to GCC 14.

It is exercised against real ARM, MIPS and PowerPC toolchain output (see
[Testing](#testing)). It's a small, dependency-free, DOM-free parser, shared by
the headless runtime, the scripting engine, and the webapp's source debug view.
For the GBA case: the shipped `.gba` ROM carries no debug info
(`objcopy -O binary` strips it); load the sidecar ELF — its loadable bytes are
identical to the ROM, so addresses line up.

## Usage

```ts
import { DebugInfo } from '@gba-kit/debug-info';

const di = DebugInfo.fromElf(new Uint8Array(elfBytes));

di.pcToSource(0x0801466a);
// → { file: 'src/code_1.c', line: 304, func: 'PlayerRespawnOrDeath' }

di.pcToFunction(0x0801466a)?.name; // 'PlayerRespawnOrDeath'
di.symbolToAddress('InitLevelGameplay'); // 0x0800ca0c
di.addressToSymbol(0x0801466a); // { name: 'PlayerRespawnOrDeath', offset: 0x46 }

di.types.variableShape('gSineTable');
// → { kind: 'array', elemSize: 2, elemSigned: true, length: null, const: true, volatile: false }
di.types.functionSignature('ReadUnalignedU16');
// → { returns: { size: 4, signed: false }, params: [{ name: 'ptr', size: 4, pointer: true, ... }], prototyped: true, ... }
di.macros.find((m) => m.name === 'gGfxStreamBuffer'); // (a -g3 build records the macro table)
// → { name: 'gGfxStreamBuffer', body: '(*(u32 *)0x030007C8)', line: 191 }
```

## Develop

```bash
pnpm --filter @gba-kit/debug-info build
pnpm --filter @gba-kit/debug-info test
```

## Testing

`@gba-kit/debug-info` is tested against real ELFs from four minimal projects,
**committed** to the repo (`packages/debug-info/test-projects/*/build/`), so tests
run with no cross toolchain:

| Project         | Toolchain                       | Target                 |
| --------------- | ------------------------------- | ---------------------- |
| `agbcc-min`     | agbcc (GCC 2.95), git submodule | ARM, little-endian     |
| `devkitarm-min` | `arm-none-eabi-gcc` (GCC 14)    | ARM, little-endian     |
| `mips-min`      | `mips-linux-gnu-gcc`            | MIPS o32, big-endian   |
| `ppc-min`       | `powerpc-linux-gnu-gcc`         | PowerPC 32, big-endian |

`ppc-min` vendors a relocatable `main.o` as well as the linked ELF — the artifact
shape that exercises the RELA path.

You only need to rebuild those ELFs when you change a test project's sources,
and that's a per-project step (see [test-projects/README](test-projects/README.md)):
`agbcc-min` builds the agbcc submodule via `./setup.sh`, the other three build in
**Docker** via `./build.sh`, so no local cross toolchain is needed.

CI rebuilds all four from scratch on every run to re-validate the toolchains.
