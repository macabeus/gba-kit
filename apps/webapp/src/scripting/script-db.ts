/**
 * Recorded Script IndexedDB Storage
 *
 * Stores recorded scripts in IndexedDB, following the same pattern as
 * savestate-db.ts in @gba-kit/gba-browser. Uses a separate database to
 * avoid version conflicts with save state storage.
 */
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';

export interface ScriptRecord {
  id: number;
  label: string;
  timestamp: number;
  romHash: string;
  script: string;
  snapshot: GbaSnapshot;
}

export type ScriptMeta = Omit<ScriptRecord, 'snapshot' | 'script'>;

const DB_NAME = 'gba-kit-scripts';
const DB_VERSION = 1;
const STORE_NAME = 'scripts';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

/** Save a recorded script to IndexedDB. Returns the auto-generated ID. */
export async function saveScript(
  romHash: string,
  script: string,
  snapshot: GbaSnapshot,
  label: string,
): Promise<number> {
  const db = await openDb();
  const record: Omit<ScriptRecord, 'id'> = {
    label,
    timestamp: Date.now(),
    romHash,
    script,
    snapshot,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.add(record);
    request.onsuccess = () => resolve(request.result as number);
    request.onerror = () => reject(request.error);
  });
}

/** Load a full script record by ID. */
export async function loadScriptRecord(id: number): Promise<ScriptRecord | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result as ScriptRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Delete a script by ID. */
export async function deleteScript(id: number): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** List script metadata (no snapshot/script data) for a specific ROM. */
export async function listScriptsByRom(romHash: string): Promise<ScriptMeta[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const all = request.result as ScriptRecord[];
      const filtered = all
        .filter((r) => r.romHash === romHash)
        .map(({ id, label, timestamp, romHash }) => ({ id, label, timestamp, romHash }))
        .sort((a, b) => b.timestamp - a.timestamp);
      resolve(filtered);
    };
    request.onerror = () => reject(request.error);
  });
}
