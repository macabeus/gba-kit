import {
  type CaptureInfo,
  type GbaKitRequests,
  MAX_SAVE_FILE_SIZE,
  type MuteBody,
  type SavedStateInfo,
  type StateBody,
} from '@gba-kit/debug-core/protocol';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { base64ToBytes, bytesToBase64 } from './render.js';
import { NO_FILE_DIALOG, type Transport } from './transport.js';

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

/** The host capability an action needs: a view offers only what its transport carries, so reaching this means it never looked. */
function need<T>(capability: T | undefined): T {
  if (!capability) {
    throw new Error(NO_FILE_DIALOG);
  }
  return capability;
}

/**
 * The save states of this ROM, and the six things a view does with them. Every
 * action reports its own failure, so a view renders `error` and needs no error
 * handling of its own, and the ones that change the list refresh it.
 */
export function useSaveStates(transport: Transport): {
  states: SavedStateInfo[];
  error: string | null;
  busy: boolean;
  refresh: () => void;
  save: (name?: string) => Promise<SavedStateInfo | undefined>;
  /** A `.sav` the host picks, as a state named after it; false when the user picked nothing. */
  importSave: () => Promise<boolean | undefined>;
  /** The machine's cartridge backup memory, handed to whatever the host saves files with. */
  exportSave: () => Promise<boolean | undefined>;
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
    importSave: () =>
      run(async () => {
        const pick = need(transport.pickFile);
        // a mis-picked ROM is turned away by `maxBytes`, wherever the host read it, rather
        // than after megabytes of it have been encoded and posted across
        const file = await pick({
          title: 'Import a .sav file',
          filters: { 'Save files': ['sav'] },
          maxBytes: MAX_SAVE_FILE_SIZE,
        });
        if (!file) {
          return false;
        }
        await transport.request('gba-kit/importSave', {
          bytes: bytesToBase64(file.bytes),
          name: file.name.replace(/\.[^.]+$/, ''),
        });
        return true;
      }, refresh),
    exportSave: () =>
      run(async () => {
        const save = need(transport.saveFile);
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

type DiffFilterBody = GbaKitRequests['gba-kit/diffFilter']['body'];
type DiffQuery = NonNullable<NonNullable<GbaKitRequests['gba-kit/diffFilter']['args']>['query']>;
type SetMuteArgs = GbaKitRequests['gba-kit/setMute']['args'];
type FilterArgs = NonNullable<GbaKitRequests['gba-kit/diffFilter']['args']>;

/**
 * The memory diff: the captures, the mutes, and the candidate set the last filter
 * left. Everything a panel does with them reports its own failure through `error`,
 * and every action that changes the state answers with the new one, so nothing has
 * to be refetched to stay in step.
 *
 * The RAM itself never arrives here — a capture is a thumbnail and a tag, a result is
 * a count and one page of rows — so a dozen captures cost the page nothing.
 */
export function useMemoryDiff(transport: Transport): {
  captures: CaptureInfo[];
  mutes: MuteBody[];
  result: DiffFilterBody | null;
  /** where the page of rows begins, for a view that says which of them it is showing */
  from: number;
  error: string | null;
  busy: boolean;
  capture: (tag?: string) => Promise<unknown>;
  adopt: (state: SavedStateInfo, tag?: string) => Promise<unknown>;
  retag: (id: number, tag: string) => Promise<unknown>;
  forget: (id: number) => Promise<unknown>;
  findNoise: (frames?: number) => Promise<unknown>;
  mute: (args: SetMuteArgs) => Promise<unknown>;
  reorder: (ids: number[]) => Promise<unknown>;
  apply: (query: DiffQuery, size: 1 | 2 | 4) => Promise<unknown>;
  reset: () => Promise<unknown>;
  page: (from: number) => Promise<unknown>;
} {
  const state = useDebugState(transport);
  const epoch = state?.epoch;
  const [captures, setCaptures] = useState<CaptureInfo[]>([]);
  const [mutes, setMutes] = useState<MuteBody[]>([]);
  const [result, setResult] = useState<DiffFilterBody | null>(null);
  const [from, setFrom] = useState(0);
  const action = useAction();
  const { run } = action;

  // a restart boots a different machine and the session dropped what it held of the old
  // one; a state load keeps every capture and the standing answer, so what is read back
  // here is the session's own answer either way rather than an assumption. A set no
  // query has been asked of is every address there is, which is not a result anyone
  // asked for — `asked` is what tells the two apart.
  useEffect(() => {
    let ignore = false;
    Promise.all([
      transport.request('gba-kit/captures'),
      transport.request('gba-kit/mutes'),
      transport.request('gba-kit/diffFilter', {}),
    ]).then(
      ([c, m, f]) => {
        if (!ignore) {
          setCaptures(c.captures);
          setMutes(m.mutes);
          setResult(f.asked ? f : null);
          setFrom(f.asked ? f.from : 0);
        }
      },
      () => undefined,
    );
    return () => {
      ignore = true;
    };
  }, [transport, epoch]);

  const filter = useCallback(
    (args: FilterArgs, at = 0) =>
      run(async () => {
        const body = await transport.request('gba-kit/diffFilter', { ...args, from: at });
        setResult(body);
        setFrom(body.from);
        return body;
      }),
    [run, transport],
  );

  /**
   * The result as the session reports it now, asking nothing of it: a mute switched on
   * or a capture forgotten changes what the candidates are and what each row's values
   * mean, and a matrix left standing under a changed set of columns is misread by eye.
   * Nothing is read back where no filter has run, since there is no matrix yet.
   *
   * It reads and does not show, so a caller that also changes the capture strip can put
   * both on screen together — or neither, when the read fails.
   */
  const reread = (at: number): Promise<DiffFilterBody | null> =>
    result === null ? Promise.resolve(null) : transport.request('gba-kit/diffFilter', { from: at });

  const show = (body: DiffFilterBody | null): void => {
    if (body) {
      setResult(body);
      setFrom(body.from);
    }
  };

  return {
    captures,
    mutes,
    result,
    from,
    error: action.error,
    busy: action.busy,
    capture: (tag) =>
      run(async () => {
        await transport.request('gba-kit/capture', { tag });
        const list = await transport.request('gba-kit/captures');
        const body = await reread(from);
        setCaptures(list.captures);
        show(body);
      }),
    adopt: (state, tag) =>
      run(async () => {
        await transport.request('gba-kit/capture', { path: state.path, tag });
        const list = await transport.request('gba-kit/captures');
        const body = await reread(from);
        setCaptures(list.captures);
        show(body);
      }),
    retag: (id, tag) =>
      run(async () => {
        const list = await transport.request('gba-kit/retagCapture', { id, tag });
        const body = await reread(from);
        setCaptures(list.captures);
        show(body);
      }),
    forget: (id) =>
      run(async () => {
        const list = await transport.request('gba-kit/forgetCapture', { id });
        const body = await reread(0);
        setCaptures(list.captures);
        show(body);
      }),
    findNoise: (frames) =>
      run(async () => {
        const found = await transport.request('gba-kit/discoverNoise', { frames });
        const body = await reread(0);
        setMutes(found.mutes);
        show(body);
      }),
    mute: (args) =>
      run(async () => {
        const list = await transport.request('gba-kit/setMute', args);
        const body = await reread(0);
        setMutes(list.mutes);
        show(body);
      }),
    reorder: (ids) =>
      run(async () => {
        const list = await transport.request('gba-kit/reorderCaptures', { ids });
        const body = await reread(0);
        setCaptures(list.captures);
        show(body);
      }),
    apply: (query, size) => filter({ query, size }),
    reset: () => filter({ reset: true }),
    page: (at) => filter({}, at),
  };
}
