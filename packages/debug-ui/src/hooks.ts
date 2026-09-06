import type { SavedStateInfo, StateBody } from '@gba-kit/debug-core/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Transport } from './transport.js';

/** The debugger's state, updated on every change. Null until the host reports one. */
export function useDebugState(transport: Transport): StateBody | null {
  const [state, setState] = useState<StateBody | null>(null);
  useEffect(() => transport.onState(setState), [transport]);
  return state;
}

/**
 * Data fetched from the transport, refreshed whenever the machine stops at a new
 * revision (a panel showing memory is only meaningful at a stop; while running it
 * keeps the last stop's view). A change of `deps` refetches too, and until that
 * lands `data` is still what the previous deps fetched: a consumer that paints it
 * with the current controls must carry the controls in the data itself. `deps`
 * is spread into the effect's dependency list, so its length must never change.
 */
export function useAtStop<T>(
  transport: Transport,
  fetch: (transport: Transport) => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; error: string | null; refresh: () => void; stopped: boolean } {
  const state = useDebugState(transport);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const revision = state?.state === 'stopped' ? `${state.epoch}:${state.revision}` : null;
  useEffect(() => {
    if (revision === null) {
      return;
    }
    let cancelled = false;
    fetchRef
      .current(transport)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [transport, revision, tick, ...deps]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, refresh, stopped: state?.state === 'stopped' };
}

/** Paint RGBA pixels onto a canvas ref whenever they change. */
export function usePixels(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  pixels: { width: number; height: number; rgba: Uint8ClampedArray } | null,
): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pixels || pixels.width === 0 || pixels.height === 0) {
      return;
    }
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const image = ctx.createImageData(pixels.width, pixels.height);
    image.data.set(pixels.rgba);
    ctx.putImageData(image, 0, 0);
  }, [canvasRef, pixels]);
}

/**
 * The save states of this ROM, and the four things a view does with them. Every
 * action refreshes the list and reports its own failure, so a view renders
 * `error` and needs no error handling of its own.
 */
export function useSaveStates(transport: Transport): {
  states: SavedStateInfo[];
  error: string | null;
  busy: boolean;
  refresh: () => void;
  save: (name?: string) => Promise<void>;
  load: (state: SavedStateInfo) => Promise<void>;
  rename: (state: SavedStateInfo, to: string) => Promise<void>;
  remove: (state: SavedStateInfo) => Promise<void>;
} {
  const state = useDebugState(transport);
  const [states, setStates] = useState<SavedStateInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = state !== null;

  const refresh = useCallback(() => {
    transport
      .request('gba-kit/listStates')
      .then((b) => setStates(b.states))
      .catch((err: Error) => setError(err.message));
  }, [transport]);
  useEffect(() => {
    if (connected) {
      refresh();
    }
  }, [refresh, connected]);

  const act = useCallback(
    async (what: () => Promise<unknown>, relist: boolean): Promise<void> => {
      setBusy(true);
      try {
        await what();
        setError(null);
        if (relist) {
          refresh();
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return {
    states,
    error,
    busy,
    refresh,
    save: (name) => act(() => transport.request('gba-kit/saveState', { name: name?.trim() || undefined }), true),
    load: (s) => act(() => transport.request('gba-kit/loadState', { path: s.path }), false),
    rename: (s, to) => act(() => transport.request('gba-kit/renameState', { path: s.path, to }), true),
    remove: (s) => act(() => transport.request('gba-kit/deleteState', { path: s.path }), true),
  };
}
