# @gba-kit/arm-emulator

Pure ARM7TDMI CPU emulator supporting both Thumb (16-bit) and ARM (32-bit) instruction sets.

> Note: It doesn't include any GBA-specific logic. The CPU accepts a `MemoryBus` interface and an optional SWI handler callback, so it can be embedded in any ARM7TDMI-based system.

## Install

```bash
npm install @gba-kit/arm-emulator
```

## Usage

### ARM CPU

```typescript
import { GbaMemory } from '@gba-kit/arm-emulator';
import { ArmCpu } from '@gba-kit/arm-emulator/arm-cpu';

const memory = new GbaMemory();
const cpu = new ArmCpu(memory, {
  swiHandler: (cpu, swiNumber) => {
    // Platform-specific SWI handling
  },
});

cpu.registers[15] = 0x08000000; // set PC
cpu.step(); // execute one instruction
```

### Disassembly

```typescript
import { disassembleArm, disassembleThumb } from '@gba-kit/arm-emulator/disassembler';

const mnemonic = disassembleThumb(0x4770, 0x08000000);
// "bx lr"
```

## Exports

### Main entry (`@gba-kit/arm-emulator`)

| Export                            | Type  | Description                     |
| --------------------------------- | ----- | ------------------------------- |
| `GbaMemory`                       | class | Memory bus with region dispatch |
| `PC`, `LR`, `SP`, `SENTINEL_ADDR` | const | Register index constants        |

Types: `CpsrFlags`, `DebugAction`, `DebugHooks`, `ExecutionResult`, `ExternalCall`, `MemoryBus`, `MemoryWrite`, `CpuSnapshot`

### Subpath exports

| Subpath                              | Description                                                          |
| ------------------------------------ | -------------------------------------------------------------------- |
| `@gba-kit/arm-emulator/arm-cpu`      | `ArmCpu` class — full ARM7TDMI with mode switching, banked registers |
| `@gba-kit/arm-emulator/disassembler` | `disassembleArm()`, `disassembleThumb()` functions                   |
| `@gba-kit/arm-emulator/cpu-snapshot` | `CpuSnapshot` interface for serializable CPU state                   |

## Testing

```bash
pnpm test
```
