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
    // the icon font is a stylesheet rather than code; the graph canvas is the one runtime
    // dependency these panels carry, and what a host pays for the graph view
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@gba-kit/debug-core', '@vscode/codicons', '@xyflow/react']);
    expect(pkg.devDependencies).not.toHaveProperty('@gba-kit/debug-adapter');
  });
});
