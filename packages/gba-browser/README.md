# @gba-kit/gba-browser

Framework-agnostic browser runtime for GBA emulation.

Provides `EmulatorBridge`, a class that connects the GBA emulator to a browser canvas with keyboard input, save states, breakpoints, disassembly, and IndexedDB-backed save state persistence.

## Install

```bash
npm install @gba-kit/gba-browser
```

## Usage

### EmulatorBridge

The core class that wraps `@gba-kit/gba-emulator` for browser use:

```typescript
import { EmulatorBridge } from '@gba-kit/gba-browser';

const emulator = new EmulatorBridge();

// Attach a canvas for rendering
emulator.attachCanvas(document.querySelector('canvas')!);

// Load a ROM and start emulation
emulator.loadRom(romArrayBuffer);
emulator.run();

// Pause / step
emulator.pause();
emulator.stepInstruction();

// Keyboard input (wire to your own event listeners)
window.addEventListener('keydown', (e) => emulator.handleKeyDown(e));
window.addEventListener('keyup', (e) => emulator.handleKeyUp(e));

// Breakpoints
emulator.addBreakpoint(0x08001234);

// Save/load states
const { snapshot, thumbnail } = await emulator.saveState();
emulator.loadState(snapshot);

// Disassembly
const instructions = emulator.disassembleAt(0x08000000, 20);

// Memory access
const data = emulator.readMemory(0x03000000, 256);
```

### Save State Persistence

IndexedDB-backed storage for save states with thumbnail previews:

```typescript
import { computeRomHash, deleteState, listByRom, loadState, saveState } from '@gba-kit/gba-browser';

const hash = await computeRomHash(romArrayBuffer);

const id = await saveState(hash, snapshot, thumbnailBlob, 'My Save');

const saves = await listByRom(hash);

const record = await loadState(id);
```

## Exports

| Export             | Description                                                                  |
| ------------------ | ---------------------------------------------------------------------------- |
| `EmulatorBridge`   | Browser GBA emulator wrapper with canvas, keyboard, breakpoints, save states |
| `computeRomHash()` | SHA-256 hash of ROM header for identity                                      |
| `saveState()`      | Save snapshot + thumbnail to IndexedDB                                       |
| `loadState()`      | Load a save state record by ID                                               |
| `deleteState()`    | Delete a save state by ID                                                    |
| `renameState()`    | Rename a save state                                                          |
| `listByRom()`      | List save state metadata for a ROM                                           |

Types: `EmulatorState`, `EmulatorCallbacks`, `Breakpoint`, `SaveStateRecord`, `SaveStateMeta`

## See Also

- [`@gba-kit/gba-react`](../gba-react) — React hooks that wrap this package
- [`@gba-kit/gba-node`](../gba-node) — Headless Node.js runtime for scripted emulation
