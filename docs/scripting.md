# Scripting Guide

`gba-kit` includes a headless Node.js runtime (`@gba-kit/gba-node`) that lets you write scripts to automate emulator actions. For example: navigate menus, capture screenshots, dump memory, manage save states, and assert on game state. Scripts run in a sandboxed VM context with top-level `await` support.

Some use cases for scripting:

- Automated testing and regression checks
- Automatic research and reverse engineering using LLM agents

## Quick Start

```typescript
import { HeadlessRuntime } from '@gba-kit/gba-node';

const runtime = await HeadlessRuntime.create({
  romPath: './game.gba',
  outputDir: './output',
  logFn: console.log,
});

await runtime.executeScript(`
  await wait({ frames: 120 });
  await takeScreenshot({ name: 'title' });

  await press('start');
  await wait({ frames: 60 });
  await takeScreenshot({ name: 'menu' });
`);
```

## Creating a Runtime

```typescript
const runtime = await HeadlessRuntime.create({
  romPath: './game.gba', // Required — path to .gba ROM file
  loadSavePath: './savestate.json', // Optional — restore a save state on startup
  outputDir: './output', // Required — directory for screenshots, snapshots, save states
  logFn: console.log, // Required — receives console.log output from scripts
});
```

The CPU is initialized in post-boot state (System mode, SP initialized, PC at `0x08000000`).

## Script API Reference

All functions below are available as globals inside `executeScript()`. Async functions must be `await`ed.

### `wait(condition)` — Timing and Flow Control

Advances the emulator until a condition is met.

**Wait for a fixed number of frames:**

```javascript
await wait({ frames: 60 }); // Run 60 frames (~1 second at 59.7 Hz)
```

**Wait for a memory value:**

```javascript
// Wait until byte at address equals a value
await wait({
  memory: { address: 0x03000010, equals: 0x01 },
  timeout: 300, // Max frames to wait (default: 600)
});

// Other comparisons
await wait({ memory: { address: 0x03000010, lessThan: 5 } });
await wait({ memory: { address: 0x03000010, greaterThan: 100 } });
await wait({ memory: { address: 0x03000010, bitSet: 0x80 } }); // Check if bit 7 is set
```

A numeric `address` is read as a **single byte**. When the runtime is created with an `elfPath`, `address` may instead be a **`symbol` or `symbol.field` path**, resolved through the DWARF and read at the field's full width, with bitfields decoded:

```javascript
await wait({ memory: { address: 'game_sm.state', equals: 5 }, timeout: 300 });
await wait({ memory: { address: 'g_game_vars.rng_info.seed', greaterThan: 0 } }); // nested fields too
```

A path throws (before running any frames) if debug info isn't loaded, the path can't be resolved, or the field is wider than 4 bytes.

**Wait for a screen pixel to match a color:**

```javascript
// Wait until pixel at (120, 80) becomes black (e.g., fade-to-black transition)
await wait({
  pixel: { x: 120, y: 80, r: 0, g: 0, b: 0 },
  timeout: 300,
});
```

**Wait for the program counter to reach an instruction:**

```javascript
await wait({ pc: 0x08001234, timeout: 600 });
await wait({ pc: 'UpdatePlayer' }); // a symbol, when debug info is loaded
```

Watched at the CPU's instruction step, so it sees every pass. Throws if the instruction isn't reached within the timeout — which means it really did not execute.

### `press(buttons, options?)` — Button Input

Presses one or more buttons, holds them for a number of frames, then releases.

```javascript
// Press A for 1 frame (default)
await press('a');

// Hold Start for 5 frames
await press('start', { hold: 5 });

// Press multiple buttons simultaneously
await press(['a', 'b'], { hold: 3 });
```

Valid button names: `a`, `b`, `select`, `start`, `right`, `left`, `up`, `down`, `r`, `l`

### `pressSequence(inputs)` — Macro Input Sequence

Executes a series of timed inputs in one call. Each entry is `[buttons, frames]` where `buttons` is a `+`-separated string (or `null` for no input).

```javascript
await pressSequence([
  ['right', 30], // walk right for 30 frames
  ['a', 5], // press A
  [null, 20], // wait 20 frames (no buttons)
  ['right+b', 20], // jump right (simultaneous)
  [null, 10], // wait at apex
  ['b', 5], // double jump
  ['right', 25], // drift right to land
]);
```

This replaces many `press()` / `wait()` calls with a single compact expression.

### `release(button)` — Manual Button Release

Immediately releases a button. Only needed if you're managing button state manually outside of `press()`.

```javascript
release('a');
```

### `takeScreenshot(options)` — Capture the Screen

Saves the current framebuffer as a 240x160 PNG.

```javascript
await takeScreenshot({ name: 'boss_fight' });
// Output: <outputDir>/screenshot-boss_fight.png
```

### `record(options)` — Record a Sprite Sheet Video

Starts capturing frames during script execution and writes them as a single **sprite sheet PNG** — all frames tiled in a grid.

```javascript
const { stopRecording } = record({
  name: 'gameplay', // Output: <outputDir>/screenshot-gameplay.png
  interval: 4, // Capture every 4th frame (default: 1)
  columns: 8, // Frames per row in the grid (default: 10)
});

// All frames between record() and stopRecording() are captured
await press('right', { hold: 60 });
await press(['right', 'b'], { hold: 20 });
await wait({ frames: 30 });

await stopRecording(); // Writes the sprite sheet PNG
```

The sprite sheet tiles each 240x160 GBA frame left-to-right, top-to-bottom. Use `interval` to control file size. Example: `interval: 4` captures every 4th frame, reducing a 300-frame recording from 300 to 75 tiles.

### `takeMemorySnapshot(options)` — Dump Memory

**Dump a named memory region:**

```javascript
await takeMemorySnapshot({ name: 'work_ram', region: 'iwram' });
// Output: <outputDir>/memory-work_ram.json
```

Available regions: `iwram`, `ewram`, `vram`, `oam`, `palette`, `io`, `sram`

**Dump a custom address range:**

```javascript
await takeMemorySnapshot({
  name: 'player_data',
  address: 0x03001000,
  length: 64,
});
```

The output JSON contains `{ address, length, data: [...] }` with byte values as a number array.

### `getRegisters()` — Read CPU Registers

Returns an object with all ARM7TDMI registers.

```javascript
const regs = getRegisters();
console.log(regs.r0); // General-purpose registers r0-r15
console.log(regs.r15); // Program counter (PC)
console.log(regs.cpsr); // Current program status register
```

### `getMemory(address, length)` — Read Raw Memory

Returns a `Uint8Array` of bytes from the given address.

```javascript
const data = getMemory(0x03000000, 16);
console.log(data[0]); // First byte
```

### `read16(address)` / `read32(address)` — Aligned Memory Reads

Read an unsigned 16-bit or 32-bit value. Both **throw** if the address is not aligned for that width, or if the bus decodes nothing there.

```javascript
const funcPtr = read32(0x08116620); // read a ROM function pointer
const entityX = read16(0x03002922); // read an entity X coordinate

read16(0x03002923); // throws: not 2-byte aligned; the hardware would read 0x03002922
read32(0x01000000); // throws: nothing is mapped there
```

The hardware would answer both: it rounds `read16(0x03002923)` down to `0x03002922`, and reads undecoded space as `0`. Either way the number is indistinguishable from the one you asked for, so these refuse instead. Use `readBytes` to read at any alignment.

A RAM mirror is not an error — `0x02F00000` reads the same byte as `0x02000000`, and neither throws.

### `readBytes(address, size)` — Unaligned Memory Reads

Read 1–4 bytes as an unsigned little-endian integer at **any** alignment, assembled byte by byte.

```javascript
readBytes(0x03002923, 2); // the two bytes at 0x...23 and 0x...24
```

Throws if any byte of the span is undecoded, or if the span runs off the end of its region.

### `write8` / `write16` / `write32` / `writeBytes(address, size, value)` — Memory Writes

The write counterparts, with the same guards: `write16` / `write32` throw on a misaligned address, all of them throw on undecoded or read-only space, and `writeBytes` stores 1–4 bytes at any alignment.

```javascript
write32(0x03001000, 0xdeadbeef);
writeBytes(0x03001003, 2, 0xabcd); // two bytes at an odd address

write16(0x03001001, 0); // throws: not 2-byte aligned
write32(0x08000000, 0); // throws: ROM is read-only
```

### `readVariable(path)` / `writeVariable(path, value)` — Named Globals

Read or write a global by a `symbol`, `symbol.field.subfield` or subscripted path. The address comes from the symbol table and the width and bit range from the DWARF type, so a bitfield is decoded on read and merged into its container on write.

```javascript
readVariable('g_game_vars.score');
readVariable('gPlayerFlags.invincible'); // a bitfield, decoded
readVariable('gLayers[2].width'); // an array element
readVariable('gGrid[1][3]'); // every dimension subscripted
writeVariable('g_game_vars.score', 1000);
writeVariable('gPlayerFlags.invincible', 1); // neighbouring bits survive
```

Subscripts are bounds-checked against the DWARF extent:

```javascript
readVariable('gLayers[4].width');
// throws: "gLayers" has 4 element(s) in dimension 0, so index 4 is past the end
```

Element 4 of a 4-element array is a real address — whatever the linker placed next — so without the bound it reads as plausible data and writes as corruption. A dimension the DWARF leaves unstated (`extern T x[][4]`) is not checked.

Throws if debug info isn't loaded, the path can't be resolved, the field is wider than 4 bytes, or the target is read-only.

### `symbolExtent(name)` — How Big Is That Object

Returns `{ size, source }` — a named object's byte extent and where it came from — or `null` when nothing states it. A global defined in C is sized by the assembler (`'st_size'`); one placed by the linker (`gFoo = 0x03000000;`) has no size of its own, so its extent comes from the type of a C `extern` declaration (`'dwarf'`). With neither, there is no extent.

This is the bound the write guards apply. A write starting inside a known extent and running past its end is refused:

```javascript
writeBytes(gLayersAddr + 110, 4, 0);
// throws: writing 4 bytes at 0x300349e runs past the end of "gLayers"
//         (112 bytes, from dwarf), into "gLevelStatePtr".
```

Only a span that _crosses_ a boundary is catchable this way. An address computed past an array's end lands wholly inside its neighbour, which is indistinguishable from a deliberate write there — use a subscripted `writeVariable` path instead.

### `readMember(base, member)` / `writeMember(base, member, value)` — Struct Members at a Runtime Address

The same read and write, addressed by a base plus a `MemberLocation` from `structMember()` / `variableMember()` rather than by name. Use these when the instance has no symbol of its own — one reached through a pointer, an array element, or anything placed at run time, none of which a `readVariable` path can express.

```javascript
const f = di.structMember('PlayerState', 'invincible');
const base = read32(symbolToAddress('gPlayerPtr'));
readMember(base, f); // already shifted and masked
writeMember(base, f, 1); // preserves the field's neighbours
```

The offset, width and bit range come from the ELF rather than from a hand-typed constant, so renaming the field in C makes the lookup fail loudly instead of reading the wrong bytes.

### `disassemble(address, count?, mode?)` — Instruction Disassembly

Disassembles ARM or Thumb instructions at a given address. Returns an array of `{ address, instruction, bytes }`. Auto-detects Thumb mode from CPSR if `mode` is omitted.

```javascript
const instrs = disassemble(0x0803b074, 5, 'thumb');
for (const i of instrs) {
  console.log(`0x${i.address.toString(16)}: ${i.instruction}`);
}
// 0x803b074: push {r4, lr}
// 0x803b076: movs r4, #0x0
// ...
```

### `disassembleFunction(address, mode?)` — Disassemble Complete Function

Like `disassemble()` but automatically detects the function end by scanning for return instructions (`bx lr`, `pop {pc}`).

```javascript
const fn = disassembleFunction(0x0800043c, 'thumb');
// Returns: [ { address, instruction, bytes }, ... ] until bx lr
console.log(fn.length + ' instructions'); // e.g., "5 instructions"
```

### `readString(address, maxLen?)` — Read Null-Terminated String

Reads bytes from memory until a null terminator, returning a string. Default max length: 256.

```javascript
const title = readString(0x080000a0, 12); // ROM header title
console.log(title); // e.g., "POKEMON_EMER"
```

### `getPixel(x, y)` — Read a Screen Pixel

Returns the color of a pixel on the GBA screen (240x160).

```javascript
const { r, g, b } = getPixel(120, 80); // Center of screen
console.log(`Color: rgb(${r}, ${g}, ${b})`);
```

### `getScreenRegion(x, y, width, height)` — Read a Screen Region

Returns an RGBA `Uint8Array` for a rectangular area of the screen. Useful for comparing regions or computing simple hashes to detect state changes.

```javascript
// Read the top HUD strip
const hud = getScreenRegion(0, 0, 240, 16);
console.log(hud.length); // 240 * 16 * 4 = 15360 bytes
```

### `searchMemory(options)` — Scan RAM for a Value

Scans IWRAM and/or EWRAM for all addresses holding a given value. Returns an array of matching addresses. This is step 1 of the classic cheat-device workflow.

```javascript
// Find all locations holding the value 3 (e.g., 3 hearts)
let matches = searchMemory({ value: 3 });
console.log(matches.length); // e.g., 830 candidates

// Options:
searchMemory({ value: 3, size: 8 }); // 8-bit (default)
searchMemory({ value: 1000, size: 16 }); // 16-bit
searchMemory({ value: 0x08000000, size: 32 }); // 32-bit
searchMemory({ value: 3, region: 'iwram' }); // IWRAM only
searchMemory({ value: 3, region: 'ewram' }); // EWRAM only
searchMemory({ value: 3, region: 'both' }); // Both (default)
```

### `watchMemory(options)` — Data Watchpoint (find _which code_ writes an address)

Registers a write watchpoint over a memory range. Every time a write **commits** to the range, a hit is appended to the returned handle's `hits` array, recording **which code performed the write** — a CPU instruction, or a DMA channel.

`address` is a raw address, or a symbol name when debug info is loaded — in which case the watch covers the whole object rather than one byte.

```javascript
const w = watchMemory({ address: 0x03005220 }); // watch 1 byte
const g = watchMemory({ address: 'gPlayerState' }); // watch all of it
await press('right', { hold: 30 }); // make the value change
w.stop(); // remove the watchpoint
for (const h of w.hits) {
  // h.instructionAddress is the responsible instruction (pc-2 in Thumb, pc-4 in ARM)
  const dis = disassemble(h.instructionAddress, 1, h.thumb ? 'thumb' : 'arm')[0];
  console.log(`${h.source} wrote ${h.value} at 0x${h.instructionAddress.toString(16)}: ${dis.instruction}`);
}
```

Each hit has: `pc`, `instructionAddress`, `address`, `value`, `size`, `thumb`, and `source` (`'cpu'` or `'dma0'`..`'dma3'`). For a **DMA** write, `instructionAddress` is the instruction that started the DMA, so a watchpoint on a DMA-filled buffer (VRAM, palette, OAM) points at the code that kicked off the copy.

**Options:**

- `length` — watch a multi-byte range (default 1).
- `filter(hit)` — record only matching hits, so you can watch a wide region without the `hits` array exploding.
- `maxHits` — cap recorded hits (keeps the first N). The handle's `dropped` counts the rest, so a full `hits` array is never mistaken for the whole story.

### `watchExecution(target, options?)` — Execution Watchpoint (find _whether_ code runs)

The execution counterpart to `watchMemory`. `target` is an address, or a symbol name when debug info is loaded.

```javascript
const w = watchExecution('UpdatePlayer');
await wait({ frames: 60 });
w.stop();
console.log(w.count); // exact number of executions; 0 means it did not run
for (const h of w.hits) console.log(h.callerLocation); // who called it
```

The handle carries `hits` (recorded, subject to `maxHits`), `count` (every execution seen, always exact), `dropped`, and `stop()`. A numeric `target` may carry the Thumb bit — a function pointer read out of a callback table does — and it is cleared, so the pointer and the symbol name reach the same instruction. Each hit has `address`, `lr` — the caller's return address — `thumb`, and `callerLocation` when debug info covers the caller.

Counted from the CPU's instruction step rather than sampled, so `count === 0` is evidence the code did not run.

```javascript
watchMemory({
  address: 0x03000000,
  length: 0x8000, // all of IWRAM
  filter: (h) => h.source === 'cpu' && (h.value & 0xff) <= 6,
  maxHits: 1000,
});
```

`clearWatchpoints()` removes the watchpoints you created.

### `filterMemory(addresses, options)` — Narrow Down Candidates

Takes addresses from a previous `searchMemory` call and keeps only those matching a new value. This is step 2+: change the game state, then filter for the new value.

```javascript
// Step 1: 3 hearts → search for 3
let matches = searchMemory({ value: 3 }); // 830 candidates

// Step 2: Take damage (now 2 hearts) → filter for 2
matches = filterMemory(matches, { value: 2 }); // 2 candidates

// Step 3: Take damage again (1 heart) → filter for 1
matches = filterMemory(matches, { value: 1 }); // 1 candidate — found it!

// Use the discovered address with existing APIs
const healthAddr = matches[0];
await wait({ memory: { address: healthAddr, equals: 0 }, timeout: 600 });
```

### `readOAM()` — Read Sprite Table

Parses the GBA's 128-entry Object Attribute Memory into structured sprite data.

```javascript
const sprites = readOAM();
const active = sprites.filter((s) => s.enabled);
for (const s of active) {
  console.log(`Sprite #${s.index} at (${s.x},${s.y}) tile=${s.tileId} ${s.width}x${s.height}`);
}
// Sprite #0 at (32,88) tile=0 32x32
// Sprite #1 at (61,88) tile=296 32x32
```

Each entry has: `index`, `x`, `y`, `tileId`, `width`, `height`, `palette`, `priority`, `hFlip`, `vFlip`, `enabled`, `mode`.

### `readBgScroll(layer)` — Read Camera Position

Returns the scroll register values for a background layer (0–3). Most games use this to scroll the camera with the player.

```javascript
const scroll = readBgScroll(1); // BG1 is often the main game layer
console.log(scroll.x, scroll.y); // e.g., 240, 0
```

### `readBgTilemap(layer)` — Read Level Tile Grid

Reads the background tilemap from VRAM as a 2D grid of tile entries. Reveals level geometry — solid tiles vs. empty space.

```javascript
const tm = readBgTilemap(0);
console.log(`${tm.width}x${tm.height} tiles, tileSize=${tm.tileSize}`);
// Check if a specific tile position is empty
const idx = row * tm.width + col;
console.log(tm.tiles[idx].id === 0 ? 'empty' : 'solid');
```

Each tile entry has: `id` (10-bit tile index), `hFlip`, `vFlip`, `palette`.

### `readDisplayControl()` — Active Display Configuration

Parses the DISPCNT register to reveal which background layers, sprites, and windows are currently enabled.

```javascript
const dc = readDisplayControl();
console.log(`Mode ${dc.mode}, sprites=${dc.obj}`);
console.log(
  `Active layers: ${dc.bg
    .map((on, i) => (on ? 'BG' + i : null))
    .filter(Boolean)
    .join(', ')}`,
);
// Mode 1, sprites=true
// Active layers: BG0, BG1, BG2
```

### `hashRegion(x, y, w, h)` — Fast Screen Fingerprint

Computes a 32-bit FNV-1a hash of a screen rectangle. Much cheaper than comparing full pixel data.

```javascript
const before = hashRegion(0, 0, 240, 160);
await press('right', { hold: 30 });
const after = hashRegion(0, 0, 240, 160);
console.log(before === after ? 'STUCK' : 'MOVED');
```

### `onFrame(callback)` — Per-Frame Hook

Registers a function called after every emulated frame during `wait()`, `press()`, and `pressSequence()`. Pass `null` to unregister.

```javascript
const scrollLog = [];
onFrame(() => {
  scrollLog.push(readBgScroll(1).x);
});
await press('right', { hold: 60 });
onFrame(null);
// scrollLog now has 60 entries showing camera X per frame
```

### `saveState(options)` — Save Emulator State

Serializes the complete emulator state (CPU, memory, PPU, APU, timers, DMA, scheduler) to a JSON file.

```javascript
await saveState({ name: 'before_boss' });
// Output: <outputDir>/savestate-before_boss.json
```

### `loadState(path)` — Restore Emulator State

Loads a previously saved state from a JSON file.

```javascript
await loadState('./output/savestate-before_boss.json');
```

### `assert(condition)` — Verify State

Throws an error if the condition is not met.

**Assert a memory value:**

```javascript
assert({
  memory: { address: 0x03000010, equals: 42 },
});
```

As with `wait({ memory })`, `address` may be a numeric address (single byte) or a `symbol`/`symbol.field` path (full width, bitfields decoded):

```javascript
assert({ memory: { address: 'g_game_vars.score', equals: 1000 } });
```

**Assert a register value:**

```javascript
assert({
  register: { name: 'r0', equals: 0x1000 },
});
```

### `console.log(...args)` — Logging

Prints messages via the runtime's `logFn`.

```javascript
console.log('Current HP:', getMemory(0x03001020, 1)[0]);
```

## GBA Memory Map

| Address Range             | Region  | Size        | Description                 |
| ------------------------- | ------- | ----------- | --------------------------- |
| `0x00000000`–`0x00003FFF` | BIOS    | 16 KB       | System ROM (read-protected) |
| `0x02000000`–`0x0203FFFF` | EWRAM   | 256 KB      | External work RAM           |
| `0x03000000`–`0x03007FFF` | IWRAM   | 32 KB       | Internal work RAM (fast)    |
| `0x04000000`–`0x040003FE` | I/O     | ~1 KB       | Hardware registers (MMIO)   |
| `0x05000000`–`0x050003FF` | Palette | 1 KB        | Color palette RAM           |
| `0x06000000`–`0x06017FFF` | VRAM    | 96 KB       | Video RAM                   |
| `0x07000000`–`0x070003FF` | OAM     | 1 KB        | Sprite attribute memory     |
| `0x08000000`–`0x09FFFFFF` | ROM     | up to 32 MB | Game Pak ROM                |
| `0x0E000000`–`0x0E00FFFF` | SRAM    | 64 KB       | Game Pak save RAM           |

## Examples

### Automated Screenshot Capture

```typescript
await runtime.executeScript(`
  // Wait for intro to finish
  await wait({ frames: 300 });
  await takeScreenshot({ name: '01-title' });

  // Press Start to go to main menu
  await press('start');
  await wait({ frames: 60 });
  await takeScreenshot({ name: '02-menu' });

  // Navigate to "New Game"
  await press('down');
  await wait({ frames: 10 });
  await press('a');
  await wait({ frames: 120 });
  await takeScreenshot({ name: '03-intro' });
`);
```

### Memory Polling and Assertions

```typescript
await runtime.executeScript(`
  // Start the game
  await press('start');

  // Wait for the game state byte to indicate "in-game"
  await wait({
    memory: { address: 0x03000000, equals: 0x03 },
    timeout: 600,
  });

  // Verify player health is initialized to 3
  const hp = getMemory(0x03001020, 1)[0];
  console.log('Player HP:', hp);
  assert({ memory: { address: 0x03001020, equals: 3 } });

  // Save a checkpoint
  await saveState({ name: 'game_start' });
`);
```

### Save State Round-Trip

```typescript
await runtime.executeScript(`
  await wait({ frames: 120 });
  await saveState({ name: 'checkpoint' });
  console.log('State saved');
`);

// Later, in another script or run:
await runtime.executeScript(`
  await loadState('./output/savestate-checkpoint.json');
  console.log('State restored');
  await takeScreenshot({ name: 'restored' });
`);
```

### Input Sequences

```typescript
await runtime.executeScript(`
  // Enter a cheat code: Up, Up, Down, Down, Left, Right, Left, Right, B, A
  const code = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right', 'b', 'a'];
  for (const btn of code) {
    await press(btn);
    await wait({ frames: 5 });
  }
  await press('start');
`);
```

## Programmatic API

For more control, you can use `HeadlessRuntime` directly in your own Node.js code instead of writing inline scripts:

```typescript
import { HeadlessRuntime } from '@gba-kit/gba-node';

const runtime = await HeadlessRuntime.create({
  romPath: './game.gba',
  outputDir: './output',
  logFn: console.log,
});

// Access the underlying ScriptingEngine
const engine = runtime.engine;
await engine.wait({ frames: 60 });
await engine.press('a');
await engine.takeScreenshot({ name: 'test' });

// Access the GBA emulator directly
const gba = runtime.gba;
const byte = gba.bus.read8(0x03000000);

// Write a final save state when done
await runtime.writeFinalSaveState();
// Output: <outputDir>/final_save.json
```

## Output Files

All output is written to the `outputDir` specified when creating the runtime:

| File Pattern            | Source                                          |
| ----------------------- | ----------------------------------------------- |
| `screenshot-{name}.png` | `takeScreenshot()` or `record()` (sprite sheet) |
| `memory-{name}.json`    | `takeMemorySnapshot()`                          |
| `savestate-{name}.json` | `saveState()`                                   |
| `final_save.json`       | `runtime.writeFinalSaveState()`                 |

## Notes

- **Sandboxed VM context**: Scripts can't access the file system, network, or Node.js APIs directly. All I/O goes through the scripting API.
- **Async API functions**: All async API functions must be awaited. Top-level `await` is supported.
- **Frame timing**: The GBA runs at ~59.7 Hz. `wait({ frames: 60 })` is roughly 1 second.
- **Button press lifecycle**: `press()` automatically releases after the hold duration. You only need `release()` for manual button state management.
- **Timeouts**: `wait()` with memory or PC conditions defaults to a 600-frame (~10 second) timeout and throws if not met.
- **Assertions**: `assert()` throws an `Error` with a descriptive message on failure, including expected and actual values in both decimal and hex.
