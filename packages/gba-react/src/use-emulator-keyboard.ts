import type { EmulatorBridge } from '@gba-kit/gba-browser';
import { useEffect } from 'react';

/**
 * Registers global keyboard listeners that forward key events to the emulator.
 *
 * Uses the bridge's built-in key map (arrow keys for D-pad, Z/X for A/B,
 * Enter for Start, Backspace for Select, A/S for L/R).
 *
 * Listeners are added on mount and removed on unmount. The hook is a pure
 * side-effect — it returns nothing. Consumers that handle input differently
 * (e.g. on-screen touch controls) simply omit this hook.
 *
 * @example
 * ```tsx
 * function Game({ emulator }: { emulator: EmulatorBridge }) {
 *   useEmulatorKeyboard(emulator);
 *   const canvasRef = useEmulatorCanvas(emulator);
 *   return <canvas ref={canvasRef} />;
 * }
 * ```
 */
export function useEmulatorKeyboard(emulator: EmulatorBridge): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => emulator.handleKeyDown(e);
    const handleKeyUp = (e: KeyboardEvent) => emulator.handleKeyUp(e);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [emulator]);
}
