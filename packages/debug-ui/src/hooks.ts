import type { SavedStateInfo, StateBody } from '@gba-kit/debug-core/protocol';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { base64ToBytes, bytesToBase64 } from './render.js';
import type { Transport } from './transport.js';

/**
 * The debugger's state, re-read on every change. Null until the host reports one.
 * The transport is the store: what it holds is read while rendering rather than
 * copied into state, so a panel's first render already shows the machine.
 */
export function useDebugState(transport: Transport): StateBody | null {
  const snapshot = useCallback(() => transport.state, [transport]);
  return useSyncExternalStore(
    useCallback((changed) => transport.onState(changed), [transport]),
    snapshot,
    snapshot,
  );
}

/**
 * Something read from the transport, read again whenever `key` changes and on
 * demand. A null key asks for nothing and keeps what was last read, for a view with
 * nothing to ask yet (no session) or nothing worth asking now (a recording still
 * running). A response that lands after a newer read, or after the view is gone, is
 * dropped, so the slower of two reads never wins.
 */
export function useFetched<T>(
  transport: Transport,
  fetch: (transport: Transport) => Promise<T>,
  key: string | null,
): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  useEffect(() => {
    if (key === null) {
      return;
    }
    let ignore = false;
    fetchRef.current(transport).then(
      (d) => {
        if (!ignore) {
          setData(d);
          setError(null);
        }
      },
      (err: Error) => {
        if (!ignore) {
          setError(err.message);
        }
      },
    );
    return () => {
      ignore = true;
    };
  }, [transport, key, asked]);
  return { data, error, refresh: useCallback(() => setAsked((n) => n + 1), []) };
}

/**
 * Data fetched from the transport, refreshed whenever the machine stops at a new
 * revision (a panel showing memory is only meaningful at a stop; while running it
 * keeps the last stop's view). A change of `deps` refetches too, and until that
 * lands `data` is still what the previous deps fetched: a consumer that paints it
 * with the current controls must carry the controls in the data itself. `deps` are
 * read as the text they print as, so pass what a panel's controls are set to.
 */
export function useAtStop<T>(
  transport: Transport,
  fetch: (transport: Transport) => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; error: string | null; refresh: () => void; stopped: boolean } {
  const state = useDebugState(transport);
  const stopped = state?.state === 'stopped';
  const fetched = useFetched(transport, fetch, stopped ? [state.epoch, state.revision, ...deps].join('\u0000') : null);
  return { ...fetched, stopped };
}

/**
 * Paint RGBA pixels onto a canvas ref whenever they change. The one place this
 * package touches a canvas: what to paint is worked out while rendering, and only
 * the painting itself happens here, because a canvas is not React's to describe.
 */
export function usePixels(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  pixels: { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray } | null,
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
 * One thing at a time, for a view whose buttons do something that can fail: `busy`
 * while it runs, `error` when the last one did not, and both again on the next.
 */
export function useAction(): {
  busy: boolean;
  error: string | null;
  /** what `what` answered, or undefined when it failed — which `error` then says. */
  run<T>(what: () => Promise<T>, after?: () => void): Promise<T | undefined>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T>(what: () => Promise<T>, after?: () => void): Promise<T | undefined> => {
    setBusy(true);
    try {
      const answer = await what();
      setError(null);
      after?.();
      return answer;
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
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
  save: (name?: string) => Promise<SavedStateInfo | undefined>;
  /** A `.sav` the host picks, as a state named after it; false when the user picked nothing. */
  importSave: (pick: NonNullable<Transport['pickFile']>) => Promise<boolean | undefined>;
  /** The machine's cartridge backup memory, handed to whatever the host saves files with. */
  exportSave: (save: NonNullable<Transport['saveFile']>) => Promise<boolean | undefined>;
  load: (state: SavedStateInfo) => Promise<void>;
  rename: (state: SavedStateInfo, to: string) => Promise<SavedStateInfo | undefined>;
  remove: (state: SavedStateInfo) => Promise<{ deleted: boolean } | undefined>;
} {
  const connected = useDebugState(transport) !== null;
  const listed = useFetched(transport, (t) => t.request('gba-kit/listStates'), connected ? 'connected' : null);
  const action = useAction();
  const refresh = listed.refresh;

  const { run } = action;
  return {
    states: listed.data?.states ?? [],
    error: action.error ?? listed.error,
    busy: action.busy,
    refresh,
    save: (name) => run(() => transport.request('gba-kit/saveState', { name: name?.trim() || undefined }), refresh),
    importSave: (pick) =>
      run(async () => {
        const file = await pick({ title: 'Import a .sav file', filters: { 'Save files': ['sav'] } });
        if (!file) {
          return false;
        }
        await transport.request('gba-kit/importSave', {
          bytes: bytesToBase64(file.bytes),
          name: file.name.replace(/\.[^.]+$/, ''),
        });
        return true;
      }, refresh),
    exportSave: (save) =>
      run(async () => {
        const body = await transport.request('gba-kit/exportSave');
        return save({
          title: 'Export the cartridge save',
          suggestedName: 'save.sav',
          filters: { 'Save files': ['sav'] },
          bytes: base64ToBytes(body.bytes),
        });
      }),
    load: (s) => run(() => transport.request('gba-kit/loadState', { path: s.path })),
    rename: (s, to) => run(() => transport.request('gba-kit/renameState', { path: s.path, to }), refresh),
    remove: (s) => run(() => transport.request('gba-kit/deleteState', { path: s.path }), refresh),
  };
}
