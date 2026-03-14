/**
 * Save State IndexedDB Storage
 *
 * Stores GBA save states with thumbnail previews in IndexedDB.
 * Uses structured clone for efficient storage of typed arrays.
 */
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';

export interface SaveStateRecord {
  id: number;
  label: string;
  timestamp: number;
  romHash: string;
  thumbnail: Blob;
  snapshot: GbaSnapshot;
}

export type SaveStateMeta = Omit<SaveStateRecord, 'snapshot'>;

const DB_NAME = 'gba-kit-savestates';
const DB_VERSION = 1;
const STORE_NAME = 'slots';

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

/** Compute a ROM hash from the first 192 bytes of the ROM. */
export async function computeRomHash(rom: ArrayBuffer): Promise<string> {
  const header = rom.slice(0, 192);
  const hash = await crypto.subtle.digest('SHA-256', header);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Save a snapshot to IndexedDB. Returns the auto-generated ID. */
export async function saveState(
  romHash: string,
  snapshot: GbaSnapshot,
  thumbnail: Blob,
  label?: string,
): Promise<number> {
  const db = await openDb();
  const record: Omit<SaveStateRecord, 'id'> = {
    label: label ?? `Save #${Date.now()}`,
    timestamp: Date.now(),
    romHash,
    thumbnail,
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

/** Load a full save state record by ID. */
export async function loadState(id: number): Promise<SaveStateRecord | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result as SaveStateRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Delete a save state by ID. */
export async function deleteState(id: number): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** Rename a save state. */
export async function renameState(id: number, label: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const record = getReq.result as SaveStateRecord | undefined;
      if (!record) {
        reject(new Error(`Save state ${id} not found`));
        return;
      }
      record.label = label;
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/** List save state metadata (no snapshot data) for a specific ROM. */
export async function listByRom(romHash: string): Promise<SaveStateMeta[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const all = request.result as SaveStateRecord[];
      const filtered = all
        .filter((r) => r.romHash === romHash)
        .map(({ id, label, timestamp, romHash, thumbnail }) => ({
          id,
          label,
          timestamp,
          romHash,
          thumbnail,
        }))
        .sort((a, b) => b.timestamp - a.timestamp);
      resolve(filtered);
    };
    request.onerror = () => reject(request.error);
  });
}
