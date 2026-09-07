/**
 * `HostFiles` over Web Storage. The browser has no project directory, so the
 * session's `.gba-kit/` files (its labels) live under one storage key per path,
 * and survive a reload or a rebuilt session the way a file on disk would.
 */
import type { HostFiles } from '@gba-kit/debug-core';

/** The part of `Storage` the files use, so a test can hand in a map. */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = 'gba-kit:file:';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** Paths are `/`-joined and normalized, so `join('/', '.gba-kit', 'x')` and `/.gba-kit/x` name the same key. */
function normalize(path: string): string {
  return '/' + path.split('/').filter(Boolean).join('/');
}

export function storageFiles(storage: KeyValueStorage): HostFiles {
  const keyOf = (path: string): string => KEY_PREFIX + normalize(path);
  return {
    readText: async (path) => storage.getItem(keyOf(path)),
    writeText: async (path, text) => storage.setItem(keyOf(path), text),
    readBytes: async (path) => {
      const text = storage.getItem(keyOf(path));
      return text === null ? null : fromBase64(text);
    },
    writeBytes: async (path, bytes) => storage.setItem(keyOf(path), toBase64(bytes)),
    list: async (dir) => {
      const prefix = keyOf(dir) + '/';
      const names: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) {
          const name = key.slice(prefix.length);
          if (!name.includes('/')) {
            names.push(name);
          }
        }
      }
      return names.sort();
    },
    join: (...parts) => normalize(parts.join('/')),
  };
}

/** The page's local storage, or nothing when it may not use one (a sandboxed frame, storage switched off). */
export function browserStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
