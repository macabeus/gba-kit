/** The package runs in browsers: nothing may make it install, or import, the Node debug adapter. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('package manifest', () => {
  it('depends on the protocol through debug-core, never on the adapter', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).toEqual(['@gba-kit/debug-core']);
    expect(pkg.devDependencies).not.toHaveProperty('@gba-kit/debug-adapter');
  });
});
