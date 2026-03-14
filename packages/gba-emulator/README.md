# @gba-kit/gba-emulator

Full Game Boy Advance hardware emulation built on top of `@gba-kit/arm-emulator`. Emulates PPU (graphics), APU (audio), DMA, timers, interrupts, input, and the memory-mapped I/O system bus. Includes HLE BIOS for SWI calls.

## Install

```bash
npm install @gba-kit/gba-emulator
```

## Usage

### Basic Emulation

```typescript
import { Gba } from '@gba-kit/gba-emulator';

const gba = new Gba();

// Load ROM and set up CPU for post-BIOS boot
gba.loadRom(romData); // Uint8Array
gba.armCpu.cpsr = 0x1f; // SYS mode
gba.armCpu.registers[15] = 0x08000000; // ROM entry point
gba.runFrame();

// Read framebuffer (240x160, ABGR format)
const pixels = gba.ppu.getFramebuffer();
```

### Scripting Engine

Attach a scripting host to control the emulator programmatically:

```typescript
import { Gba, ScriptingEngine } from '@gba-kit/gba-emulator';

const engine = new ScriptingEngine(gba, host);
await engine.wait({ frames: 60 });
await engine.press('a');
await engine.takeScreenshot({ name: 'title-screen' });
```

### Save States

```typescript
// Save
const snapshot = gba.serialize();

// Restore
gba.deserialize(snapshot);
```

## Exports

### Main entry (`@gba-kit/gba-emulator`)

| Export                | Description                                                                             |
| --------------------- | --------------------------------------------------------------------------------------- |
| `Gba`                 | Main GBA system coordinator: creates ARM CPU, wires subsystems, runs the emulation loop |
| `GbaSystemBus`        | Memory-mapped I/O bus with region dispatch                                              |
| `Scheduler`           | Cycle-accurate event scheduler                                                          |
| `InterruptController` | IRQ controller                                                                          |
| `TimerController`     | 4-channel timer/counter system                                                          |
| `DmaController`       | 4-channel DMA controller                                                                |
| `InputController`     | Button input controller                                                                 |
| `ScriptingEngine`     | Programmatic emulator control (wait, press, screenshot, memory search)                  |

Types: `ScriptingHost`, `DmaMemoryAccess`

Constants: `CPU_FREQ`, `CYCLES_PER_FRAME`, `CYCLES_PER_SCANLINE`, `FRAME_RATE`, `SCREEN_WIDTH`, `SCREEN_HEIGHT`, `GbaButton`, `IrqFlag`, `MMIO`, `EventId`, and more.

### Subpath exports

| Subpath                           | Description                                                              |
| --------------------------------- | ------------------------------------------------------------------------ |
| `@gba-kit/gba-emulator/savestate` | `GbaSnapshot` and all snapshot types for serializing full emulator state |

## Architecture

```
Gba (coordinator)
 ├── ArmCpu (ARM7TDMI with GBA BIOS SWI handler)
 ├── Scheduler (cycle-accurate event loop)
 ├── GbaSystemBus (memory-mapped I/O)
 │    ├── EWRAM (256 KB)
 │    ├── IWRAM (32 KB)
 │    ├── Palette RAM, VRAM, OAM
 │    ├── SRAM / EEPROM
 │    └── Game Pak ROM
 ├── PPU (pixel processing)
 │    ├── Backgrounds (modes 0-5, affine)
 │    ├── Sprites (OBJ layer)
 │    └── Compositor (priority, windowing)
 ├── APU (audio processing)
 │    ├── PSG (channels 1-4)
 │    └── Direct Sound (channels A/B)
 ├── DMA (4 channels)
 ├── Timers (4 channels, cascade)
 ├── Interrupts (IME/IE/IF)
 └── Input (10 buttons)
```
