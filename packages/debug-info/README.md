# @gba-kit/debug-info

Parse ELF symbols and DWARF debug info from a (`-g`-built) GBA ELF, and answer
the queries a source-level debugger needs:

- **PC → function** (`pcToFunction`) — from `.symtab`, so it covers every linked
  function, including `INCLUDE_ASM` stubs with no DWARF.
- **name → address** / **address → symbol** (`symbolToAddress`, `addressToSymbol`).
- **PC → C `file:line`** (`pcToSource`) — from the DWARF `.debug_line` table.

It's a small, dependency-free, DOM-free parser meant to be shared by the headless
runtime, the scripting engine, and the webapp's source debug view. The shipped
`.gba` ROM carries no debug info (`objcopy -O binary` strips it); load the sidecar
ELF — its loadable bytes are identical to the ROM, so addresses line up.

## Usage

```ts
import { DebugInfo } from '@gba-kit/debug-info';

const di = DebugInfo.fromElf(new Uint8Array(elfBytes));

di.pcToSource(0x0801466a);
// → { file: 'src/code_1.c', line: 304, func: 'PlayerRespawnOrDeath' }

di.pcToFunction(0x0801466a)?.name; // 'PlayerRespawnOrDeath'
di.symbolToAddress('InitLevelGameplay'); // 0x0800ca0c
di.addressToSymbol(0x0801466a); // { name: 'PlayerRespawnOrDeath', offset: 0x46 }
```

## Develop

```bash
pnpm --filter @gba-kit/debug-info build
pnpm --filter @gba-kit/debug-info test
```

## Testing

`@gba-kit/debug-info` is tested against real GBA ELFs that are **committed** to the
repo (`packages/debug-info/test-projects/*/build/`), so tests run with no cross
toolchain.

You only need to rebuild those ELFs when you change a test project's sources,
and that's a per-project step (see[test-projects/README](packages/debug-info/test-projects/README.md)):

- `agbcc-min` — `cd packages/debug-info/test-projects/agbcc-min && ./setup.sh` (builds the agbcc submodule)
- `devkitarm-min` — `cd packages/debug-info/test-projects/devkitarm-min && ./build.sh` (builds in **Docker**, so no local devkitARM needed)

CI rebuilds both from scratch on every run to re-validate the toolchains.
