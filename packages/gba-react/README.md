# @gba-kit/gba-react

[![npm](https://img.shields.io/npm/v/@gba-kit/gba-react)](https://www.npmjs.com/package/@gba-kit/gba-react)

Headless React hooks for GBA emulation. Wraps [`@gba-kit/gba-browser`](../gba-browser) with proper React lifecycle management.

## Install

```bash
npm install @gba-kit/gba-react
```

## Hooks

### `useEmulator(options?)`

Creates and owns an `EmulatorBridge` instance. The instance is stable across re-renders and cleaned up on unmount.

Returns `{ emulator, state }` where `state` is reactive (`'idle' | 'paused' | 'running'`).

```tsx
import { useEmulator } from '@gba-kit/gba-react';

function App() {
  const { emulator, state } = useEmulator({
    onFrame: () => {
      /* called after each emulated frame */
    },
    onBreakpoint: (addr) => console.log('breakpoint hit at', addr),
  });

  return (
    <div>
      <p>State: {state}</p>
      <button onClick={() => emulator.run()}>Run</button>
      <button onClick={() => emulator.pause()}>Pause</button>
    </div>
  );
}
```

### `useEmulatorCanvas(emulator)`

Binds a `<canvas>` element to the emulator's display output. Returns a ref to attach to your own canvas. The hook handles `attachCanvas` on mount and `detachCanvas` on unmount.

The canvas dimensions are set to 240x160 (native GBA resolution) by the emulator. Control display size with CSS.

```tsx
import { useEmulatorCanvas } from '@gba-kit/gba-react';

function Screen({ emulator }) {
  const canvasRef = useEmulatorCanvas(emulator);
  return <canvas ref={canvasRef} style={{ width: 720, height: 480, imageRendering: 'pixelated' }} />;
}
```

### `useEmulatorKeyboard(emulator)`

Registers global `keydown`/`keyup` listeners that forward to the emulator's built-in key map. It's pure side-effect and returns nothing.

Default key map: Arrow keys = D-pad, Z = A, X = B, Enter = Start, Backspace = Select, A/S = L/R.

Omit this hook if you handle input differently (e.g. on-screen touch controls).

```tsx
import { useEmulatorKeyboard } from '@gba-kit/gba-react';

function Game({ emulator }) {
  useEmulatorKeyboard(emulator);
  // ...
}
```

## Full Example

```tsx
import { useEmulator, useEmulatorCanvas, useEmulatorKeyboard } from '@gba-kit/gba-react';

function GbaPlayer({ romUrl }: { romUrl: string }) {
  const { emulator, state } = useEmulator();
  const canvasRef = useEmulatorCanvas(emulator);
  useEmulatorKeyboard(emulator);

  const loadAndRun = async () => {
    const res = await fetch(romUrl);
    const data = await res.arrayBuffer();
    emulator.loadRom(data);
    emulator.run();
  };

  return (
    <div>
      {state === 'idle' ? (
        <button onClick={loadAndRun}>Load ROM</button>
      ) : (
        <canvas ref={canvasRef} style={{ width: 480, height: 320 }} />
      )}
    </div>
  );
}
```

## Exports

| Export                | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `useEmulator`         | Create and own an `EmulatorBridge` with reactive state |
| `useEmulatorCanvas`   | Bind a canvas ref to the emulator display              |
| `useEmulatorKeyboard` | Register global keyboard input listeners               |

Type: `UseEmulatorOptions`

## See Also

- [`@gba-kit/gba-browser`](../gba-browser) — The underlying browser runtime (framework-agnostic)
- [`@gba-kit/gba-node`](../gba-node) — Headless Node.js runtime for scripted emulation
