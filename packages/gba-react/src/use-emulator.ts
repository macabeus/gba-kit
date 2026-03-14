import { EmulatorBridge, type EmulatorState } from '@gba-kit/gba-browser';
import { useEffect, useRef, useState } from 'react';

/**
 * Options for {@link useEmulator}.
 *
 * All callbacks are optional. They are registered once when the hook mounts
 * and updated on every render via a stable ref, so the consumer does not need
 * to memoize them.
 */
export interface UseEmulatorOptions {
  /**
   * Called after each emulated frame (during `run()`, `stepInstruction()`,
   * `stepOver()`, etc.). Useful for triggering re-renders in debug views
   * that display registers, memory, or disassembly.
   *
   * **Caution:** During normal play this fires ~60 times per second.
   * Avoid expensive work here unless the emulator is paused/stepping.
   */
  onFrame?: () => void;
  /** Called when the emulator hits an enabled breakpoint. */
  onBreakpoint?: (address: number) => void;
}

/**
 * Core hook that creates and owns a GBA {@link EmulatorBridge} instance.
 *
 * The bridge is created once and is stable for the lifetime of the component.
 * The returned `state` is reactive — it triggers a re-render when the
 * emulator transitions between `'idle'`, `'paused'`, and `'running'`.
 *
 * Cleans up the emulation loop on unmount.
 *
 * @example
 * ```tsx
 * function App() {
 *   const { emulator, state } = useEmulator({
 *     onBreakpoint: (addr) => console.log('hit', addr),
 *   });
 *
 *   return (
 *     <button onClick={() => emulator.run()}>
 *       {state === 'running' ? 'Pause' : 'Run'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useEmulator(options?: UseEmulatorOptions): {
  /** The stable emulator bridge instance. Safe to pass as a prop. */
  emulator: EmulatorBridge;
  /** Reactive emulator state — re-renders the component on transitions. */
  state: EmulatorState;
} {
  // Keep options in a ref so the callback closure always sees the latest
  // without needing the consumer to memoize.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, setState] = useState<EmulatorState>('idle');

  // Create the bridge exactly once (stable across renders).
  const emulatorRef = useRef<EmulatorBridge | null>(null);
  if (emulatorRef.current === null) {
    emulatorRef.current = new EmulatorBridge();
  }
  const emulator = emulatorRef.current;

  // Wire callbacks on mount; update the ref-based forwarding on every render.
  useEffect(() => {
    emulator.setCallbacks({
      onStateChange: (s) => setState(s),
      onFrame: () => optionsRef.current?.onFrame?.(),
      onBreakpoint: (addr) => optionsRef.current?.onBreakpoint?.(addr),
    });

    return () => {
      emulator.stop();
    };
  }, [emulator]);

  return { emulator, state };
}
