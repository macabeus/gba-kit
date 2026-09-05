/**
 * A host for Node: platform timers plus the file system for `.gba-kit/` files.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type Host, type HostFiles, timerHost } from './host.js';

export const nodeFiles: HostFiles = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  },
  async writeText(path, text) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  },
  async readBytes(path) {
    try {
      return new Uint8Array(await readFile(path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  },
  async writeBytes(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  },
  async list(dir) {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  },
  join,
};

export function createNodeHost(): Host {
  return timerHost(nodeFiles);
}

/** `exists` for the source mapper, on the real file system. */
export function fileExists(path: string): boolean {
  return existsSync(path);
}
