/** What the extension-host bundle carries: the host serves transports and streams, so React stays in the webview bundle. */
import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('extension bundle', () => {
  it('bundles no React and no panel into the extension host', async () => {
    const { metafile } = await esbuild.build({
      entryPoints: [join(root, 'src', 'extension.ts')],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['vscode'],
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.some((p) => p.includes('debug-ui/dist/transport.js'))).toBe(true);
    expect(inputs.filter((p) => /node_modules\/react/.test(p))).toEqual([]);
    expect(inputs.filter((p) => /debug-ui\/dist\/panels\//.test(p))).toEqual([]);
  }, 30_000);
});
