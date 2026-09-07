/**
 * The session's project files over Web Storage: what a label edit saves is what
 * a session rebuilt for the same ROM loads, and another ROM's session never sees.
 */
import { ManualHost } from '@gba-kit/debug-core';
import { describe, expect, it } from 'vitest';

import { type KeyValueStorage, storageFiles } from '../session/browser-files';
import { bootSession } from './fixtures';

/** `Storage` over a map, the way a browser's local storage behaves. */
function memoryStorage(): KeyValueStorage & { keys(): string[] } {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    keys: () => [...map.keys()],
  };
}

describe('storageFiles', () => {
  it('round-trips text and bytes, lists a directory, and joins paths', async () => {
    const storage = memoryStorage();
    const files = storageFiles(storage);
    expect(files.join('/', '.gba-kit', 'labels.json')).toBe('/.gba-kit/labels.json');
    expect(files.join('/roms/abc/', '/.gba-kit', 'x')).toBe('/roms/abc/.gba-kit/x');

    expect(await files.readText('/a/b.txt')).toBeNull();
    await files.writeText('/a/b.txt', 'hello');
    expect(await files.readText('a/b.txt')).toBe('hello');

    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    await files.writeBytes('/a/c.bin', bytes);
    expect(await files.readBytes('/a/c.bin')).toEqual(bytes);
    expect(await files.readBytes('/a/missing.bin')).toBeNull();

    await files.writeText('/a/d/e.txt', 'nested');
    expect(await files.list('/a')).toEqual(['b.txt', 'c.bin']);
    expect(await files.list('/a/d')).toEqual(['e.txt']);
    expect(await files.list('/none')).toEqual([]);
    expect(storage.keys().every((k) => k.startsWith('gba-kit:file:/'))).toBe(true);
  });

  it("keeps a ROM's labels for the session rebuilt after it, under that ROM alone", async () => {
    const host = new ManualHost(storageFiles(memoryStorage()));
    const first = await bootSession('thumb-O0', host, { projectDir: '/roms/a' });
    const address = first.program.symbolAddress('add_bonus')!;
    first.labels.set({ address, label: 'AddBonus' });
    expect(await first.saveLabels()).toBe('/roms/a/.gba-kit/labels.json');
    expect(first.labels.dirty).toBe(false);

    const rebuilt = await bootSession('thumb-O0', host, { projectDir: '/roms/a' });
    expect(rebuilt.labels.at(address)?.label).toBe('AddBonus');
    expect(rebuilt.disassemble(address, 1)[0]!.label).toBe('AddBonus');

    const another = await bootSession('thumb-O0', host, { projectDir: '/roms/b' });
    expect(another.labels.size).toBe(0);
  });
});
