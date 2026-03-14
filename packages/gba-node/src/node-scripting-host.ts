/**
 * Node.js Scripting Host
 *
 * Implements ScriptingHost for Node.js: writes PNG screenshots via fast-png,
 * JSON memory snapshots, and save states to disk.
 */
import type { ScriptingHost } from '@gba-kit/gba-emulator';
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';
import { encode } from 'fast-png';
import fs from 'fs/promises';
import path from 'path';

import { deserializeSnapshot, serializeSnapshot } from './snapshot-serializer.js';

export class NodeScriptingHost implements ScriptingHost {
  readonly #outputDir: string;
  readonly #logFn: (message: string) => void;
  readonly #generatedFiles: string[] = [];

  constructor(outputDir: string, logFn: (message: string) => void) {
    this.#outputDir = outputDir;
    this.#logFn = logFn;
  }

  get generatedFiles(): readonly string[] {
    return this.#generatedFiles;
  }

  async writeScreenshot(name: string, rgbaData: Uint8Array, width: number, height: number): Promise<void> {
    const pngBytes = encode({
      width,
      height,
      data: rgbaData,
      channels: 4,
    });
    const filePath = path.join(this.#outputDir, `screenshot-${name}.png`);
    await fs.writeFile(filePath, pngBytes);
    this.#generatedFiles.push(`screenshot-${name}.png`);
  }

  async writeMemorySnapshot(name: string, data: Record<string, unknown>): Promise<void> {
    const filePath = path.join(this.#outputDir, `memory-${name}.json`);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    this.#generatedFiles.push(`memory-${name}.json`);
  }

  async writeSaveState(name: string, snapshot: GbaSnapshot): Promise<void> {
    const filePath = path.join(this.#outputDir, `savestate-${name}.json`);
    const serialized = serializeSnapshot(snapshot);
    await fs.writeFile(filePath, JSON.stringify(serialized, null, 2));
    this.#generatedFiles.push(`savestate-${name}.json`);
  }

  async readSaveState(filePath: string): Promise<GbaSnapshot> {
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    return deserializeSnapshot(parsed);
  }

  log(message: string): void {
    this.#logFn(message);
  }
}
