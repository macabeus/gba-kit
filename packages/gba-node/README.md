# @gba-kit/gba-node

[![npm](https://img.shields.io/npm/v/@gba-kit/gba-node)](https://www.npmjs.com/package/@gba-kit/gba-node)

Headless GBA emulator runtime for Node.js. Load a ROM, execute JavaScript scripts against the emulator, and capture screenshots, memory snapshots, and save states to disk.

## Install

```bash
npm install @gba-kit/gba-node
```

## Usage

### Headless Runtime

```typescript
import { HeadlessRuntime } from '@gba-kit/gba-node';

const runtime = await HeadlessRuntime.create({
  romPath: './game.gba',
  outputDir: './output',
  logFn: console.log,
});

// Execute a script against the emulator
await runtime.executeScript(`
  await wait({ frames: 60 });
  await press('start');
  await wait({ frames: 30 });
  await takeScreenshot({ name: 'title' });
`);

// Write final save state
await runtime.writeFinalSaveState();
```

### Script API

Scripts run inside a sandboxed `vm.Context` with these functions available.

See the **[Scripting Guide](https://github.com/macabeus/gba-kit/blob/main/docs/scripting.md)** for the full API reference and examples.

### Snapshot Serialization

Convert `GbaSnapshot` objects (with TypedArrays) to/from JSON using base64 encoding:

```typescript
import { deserializeSnapshot, serializeSnapshot } from '@gba-kit/gba-node';

// Save to JSON
const json = JSON.stringify(serializeSnapshot(snapshot));

// Restore from JSON
const snapshot = deserializeSnapshot(JSON.parse(json));
```

### Custom Scripting Host

Implement `ScriptingHost` to control where screenshots and snapshots are written:

```typescript
import { NodeScriptingHost } from '@gba-kit/gba-node';

const host = new NodeScriptingHost('./output', console.log);
// host.generatedFiles — list of files written during the session
```

## Exports

| Export                  | Type     | Description                                                               |
| ----------------------- | -------- | ------------------------------------------------------------------------- |
| `HeadlessRuntime`       | class    | Main runtime — loads ROM, executes scripts, manages GBA instance          |
| `NodeScriptingHost`     | class    | File-system scripting host (PNG screenshots via fast-png, JSON snapshots) |
| `serializeSnapshot()`   | function | Convert `GbaSnapshot` to JSON-safe object (base64 TypedArrays)            |
| `deserializeSnapshot()` | function | Restore `GbaSnapshot` from serialized JSON                                |

Type: `HeadlessRuntimeOptions`
