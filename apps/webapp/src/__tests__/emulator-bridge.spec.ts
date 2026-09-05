/**
 * The Play page's bridge over a machine the Debug session also drives: what its
 * canvas and save-state thumbnails show after the session moved the `Gba`, and
 * whose CPU debug hooks `run()` may clear. The DOM the bridge touches (ImageData,
 * canvases, the animation frame) is stubbed so each paint can be read back.
 */
import { Machine, ManualHost, Session } from '@gba-kit/debug-core';
import { EmulatorBridge } from '@gba-kit/gba-browser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixture } from './fixtures';

/** A 2d context that keeps what was painted onto it and which canvas was drawn into it. */
interface FakeContext {
  imageSmoothingEnabled: boolean;
  painted: Uint8ClampedArray | null;
  drawn: FakeCanvas | null;
  putImageData(image: ImageData, x: number, y: number): void;
  drawImage(source: FakeCanvas, ...rest: number[]): void;
}

interface FakeCanvas {
  width: number;
  height: number;
  ctx: FakeContext;
  getContext(kind: string): FakeContext;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
}

function fakeCanvas(): FakeCanvas {
  const ctx: FakeContext = {
    imageSmoothingEnabled: true,
    painted: null,
    drawn: null,
    putImageData(image) {
      ctx.painted = new Uint8ClampedArray(image.data);
    },
    drawImage(source) {
      ctx.drawn = source;
    },
  };
  return {
    width: 0,
    height: 0,
    ctx,
    getContext: () => ctx,
    toBlob: (callback) => callback(new Blob([])),
  };
}

/** Every canvas `document.createElement` handed out, in creation order. */
const created: FakeCanvas[] = [];

class FakeImageData {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

const saved: Partial<Record<'ImageData' | 'document' | 'requestAnimationFrame' | 'cancelAnimationFrame', unknown>> = {};

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const name of ['ImageData', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    saved[name] = g[name];
  }
  g['ImageData'] = FakeImageData;
  g['document'] = {
    createElement: (): FakeCanvas => {
      const canvas = fakeCanvas();
      created.push(canvas);
      return canvas;
    },
  };
  g['requestAnimationFrame'] = (): number => 1;
  g['cancelAnimationFrame'] = (): void => {};
});

afterAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete g[name];
    } else {
      g[name] = value;
    }
  }
});

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A bridge with the ROM loaded, and a session over the same `Gba`, the way the Debug page boots one. */
async function bootShared(): Promise<{ bridge: EmulatorBridge; session: Session; rom: Uint8Array }> {
  const { rom, elf } = fixture('thumb-O0');
  const bridge = new EmulatorBridge();
  bridge.loadRom(bufferOf(rom));
  const session = await Session.create(new ManualHost(), {
    rom,
    elf,
    cwd: '/',
    exists: () => true,
    machine: new Machine(rom, bridge.gba),
  });
  return { bridge, session, rom };
}

function live(session: Session): Uint8ClampedArray {
  return new Uint8ClampedArray(session.machine.framebufferRgba());
}

describe('EmulatorBridge over a machine the debug session moves', () => {
  it('thumbnails the screen as it is now, and refreshFrame repaints the canvas with it', async () => {
    const { bridge, session } = await bootShared();
    const playCanvas = fakeCanvas();
    bridge.attachCanvas(playCanvas as unknown as HTMLCanvasElement);
    for (let i = 0; i < 60; i++) {
      bridge.runOneFrame();
    }
    const beforeDebug = playCanvas.ctx.painted!;
    expect(beforeDebug).toEqual(live(session));
    bridge.detachCanvas();

    // Debug takes the machine and renders through the session's own screen
    session.resync('back from Play');
    for (let i = 0; i < 120; i++) {
      session.stepFrame();
    }
    const now = live(session);
    expect(now).not.toEqual(beforeDebug);

    created.length = 0;
    const { snapshot } = await bridge.saveState();
    expect(snapshot.cpu.registers[15]).toBe(session.pc);
    const [thumb, source] = created;
    expect(thumb!.ctx.drawn).toBe(source);
    expect(source!.ctx.painted).toEqual(now);

    // back to Play: the canvas is attached, then the bridge is told the machine moved
    const again = fakeCanvas();
    bridge.attachCanvas(again as unknown as HTMLCanvasElement);
    bridge.refreshFrame();
    expect(again.ctx.painted).toEqual(now);
  });

  it('run() leaves a CPU debug hook it did not install in place, and clears only its own', async () => {
    const { bridge } = await bootShared();
    let seen = 0;
    bridge.gba.armCpu.setDebugHooks({ onInstructionPost: () => void seen++ });

    bridge.run(); // runs one frame before the (stubbed) animation frame is asked for
    bridge.pause();
    expect(seen).toBeGreaterThan(0);

    const afterRun = seen;
    bridge.runOneFrame();
    expect(seen).toBeGreaterThan(afterRun);

    // the bridge's breakpoint hooks take the slot; removing its last breakpoint empties it
    bridge.addBreakpoint(0x08000000);
    const withBreakpoint = seen;
    bridge.runOneFrame();
    expect(seen).toBe(withBreakpoint);
    bridge.removeBreakpoint(0x08000000);
    bridge.runOneFrame();
    expect(seen).toBe(withBreakpoint);
  });
});
