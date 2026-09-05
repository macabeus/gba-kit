/**
 * A `@gba-kit/debug-core` session over the machine the Play page runs, alive
 * while the Debug page is shown. Play and Debug take turns driving the same
 * `Gba`: entering Debug pauses the bridge and resyncs the session (the bridge
 * may have run frames behind its back), leaving Debug pauses the session.
 */
import { Machine, Session, type SessionState, timerHost } from '@gba-kit/debug-core';
import type { EmulatorBridge } from '@gba-kit/gba-browser';
import { useEffect, useRef, useState } from 'react';

export interface DebugSessionHandle {
  session: Session | null;
  /** bumps on every stop, resume and machine change: re-read what you show */
  revision: number;
  state: SessionState | 'none';
  error: string | null;
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
    Session.create(timerHost(), {
      rom,
      elf: elfData,
      cwd: '/',
      exists: () => true,
      machine: new Machine(rom, emulator.gba),
    })
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
    return session.on({ stopped: bump, continued: bump, state: bump });
  }, [session]);

  // take turns with the Play page
  useEffect(() => {
    if (!session) {
      return;
    }
    if (active) {
      emulator.pause();
      session.resync('back from Play');
    } else {
      session.pause();
    }
  }, [session, active, emulator]);

  return { session, revision, state, error };
}
