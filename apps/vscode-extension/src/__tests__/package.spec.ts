/**
 * What `vsce package` would ship, from a manifest vsce accepts: the bundles and
 * stylesheet the extension loads at run time, plus package.json, README and LICENSE.
 * `.vscodeignore` is an allowlist, so a new bundle or asset has to be named there, and
 * a dropped one shows up here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('package', () => {
  beforeAll(() => {
    // the listing needs the bundles on disk; CI builds before it tests, a bare checkout does not
    if (!existsSync(join(root, 'dist', 'extension.js'))) {
      execFileSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'ignore' });
    }
  }, 120_000);

  it('ships the three bundles, the stylesheet, the manifest, the README and the license, and nothing else', () => {
    const listed = execFileSync(join(root, 'node_modules', '.bin', 'vsce'), ['ls', '--no-dependencies'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(listed.trim().split('\n').sort()).toEqual([
      'LICENSE',
      'README.md',
      'dist/adapter.js',
      'dist/extension.js',
      'dist/webview.css',
      'dist/webview.js',
      'package.json',
    ]);
  }, 30_000);
});
