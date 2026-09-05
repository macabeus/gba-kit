/**
 * A `@gba-kit/debug-core` session over the machine the Play page runs, alive
 * while the Debug page is shown. Play and Debug take turns driving the same
 * `Gba`: entering Debug pauses the bridge and resyncs the session (the bridge
 * may have run frames behind its back); leaving Debug pauses the session, takes
 * its hooks off the machine and repaints Play's canvas with the screen it left.
 */
import { Machine, Session, type SessionState, romHash, timerHost } from '@gba-kit/debug-core';
import type { EmulatorBridge } from '@gba-kit/gba-browser';
import { useCallback, useEffect, useRef, useState } from 'react';

import { browserStorage, storageFiles } from './browser-files';

export interface DebugSessionHandle {
  session: Session | null;
  /** bumps on every stop, resume, machine change and label edit: re-read what you show */
  revision: number;
  state: SessionState | 'none';
  error: string | null;
  /** the Play page loaded a save state: the session catches up now when Debug is shown, else on the next entry */
  onStateLoaded: () => void;
}

/** The session's project directory: one per ROM, so a ROM's labels are never loaded onto another. */
function projectDirFor(hash: string): string {
  return `/roms/${hash}`;
}

export function useDebugSession(
  emulator: EmulatorBridge,
  romData: ArrayBuffer | null,
  elfData: Uint8Array | null,
  active: boolean,
): DebugSessionHandle {
  const [session, setSession] = useState<Session | null>(null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<SessionState | 'none'>('none');
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);

  // (re)create the session when the ROM or ELF changes, once Debug is entered
  useEffect(() => {
    if (!romData || !active) {
      return;
    }
    if (sessionRef.current) {
      return;
    }
    let cancelled = false;
    const rom = new Uint8Array(romData);
    const storage = browserStorage();
    romHash(rom)
      .then((hash) =>
        Session.create(timerHost(storage && storageFiles(storage)), {
          rom,
          elf: elfData,
          cwd: '/',
          projectDir: projectDirFor(hash),
          exists: () => true,
          machine: new Machine(rom, emulator.gba),
        }),
      )
      .then((created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        sessionRef.current = created;
        setSession(created);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [emulator, romData, elfData, active]);

  // a different ROM or ELF: the session is rebuilt from scratch
  useEffect(() => {
    return () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      setSession(null);
      setState('none');
    };
  }, [emulator, romData, elfData]);

  // events → re-render
  useEffect(() => {
    if (!session) {
      return;
    }
    const bump = (): void => {
      setRevision((r) => r + 1);
      setState(session.state);
    };
    bump();
    return session.on({ stopped: bump, continued: bump, state: bump, labels: bump });
  }, [session]);

  // take turns with the Play page
  useEffect(() => {
    if (!session) {
      return;
    }
    if (active) {
      emulator.pause();
      session.resync('back from Play');
      return;
    }
    session.pause();
    // The session rendered through its own screen: Play's canvas shows what the
    // bridge last drew until it re-reads the machine.
    emulator.refreshFrame();
    // Play's frames are not the debugger's to watch or log: the hooks come off once
    // the session has stopped — now, or when a running loop reaches its frame
    // boundary. That stop is heard from inside a session event, where the session
    // refuses a detach, so it waits for the event to finish.
    let cancelled = false;
    const yieldMachine = (): void => {
      if (cancelled || session.state !== 'stopped') {
        return;
      }
      session.detach();
      emulator.refreshFrame();
    };
    if (session.state === 'stopped') {
      yieldMachine();
      return;
    }
    const off = session.on({ stopped: () => queueMicrotask(yieldMachine) });
    return () => {
      cancelled = true;
      off();
    };
  }, [session, active, emulator]);

  // A state loaded while Play is showing is caught up with when Debug is entered.
  const onStateLoaded = useCallback(() => {
    if (active) {
      sessionRef.current?.resync('a save state was loaded');
    }
  }, [active]);

  return { session, revision, state, error, onStateLoaded };
}
