import type { EmulatorBridge } from '@gba-kit/gba-browser';
import { type RefObject, useEffect, useRef } from 'react';

/**
 * Binds a `<canvas>` element to the emulator's display output.
 *
 * Returns a ref that the consumer attaches to their own `<canvas>`.
 * The hook calls {@link EmulatorBridge.attachCanvas} when the canvas mounts
 * and {@link EmulatorBridge.detachCanvas} when it unmounts, so the
 * emulator's framebuffer is always blitted to the visible canvas.
 *
 * The canvas dimensions are set to 240x160 (native GBA resolution) by the
 * bridge. The consumer controls the display size via CSS.
 *
 * @example
 * ```tsx
 * function Screen({ emulator }: { emulator: EmulatorBridge }) {
 *   const canvasRef = useEmulatorCanvas(emulator);
 *   return <canvas ref={canvasRef} style={{ width: 720, height: 480 }} />;
 * }
 * ```
 */
export function useEmulatorCanvas(emulator: EmulatorBridge): RefObject<HTMLCanvasElement | null> {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    emulator.attachCanvas(canvas);
    return () => {
      emulator.detachCanvas();
    };
  }, [emulator]);

  return canvasRef;
}
