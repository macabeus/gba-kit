/**
 * Launch an Extension Development Host with this extension and the debug-core
 * fixtures as the workspace, and run `suite.ts` inside it. Downloads VS Code on
 * first use (`@vscode/test-electron`).
 */
import { runTests } from '@vscode/test-electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  const workspace = path.resolve(extensionDevelopmentPath, '..', '..', 'packages', 'debug-core', 'test-fixtures');
  // VS Code opens its instance lock as a Unix socket under the user data directory,
  // and a socket path over 103 characters cannot be bound: a checkout under a long
  // path (a worktree beside the repo, say) would never start the host at all. A
  // temporary directory is short wherever the checkout is, and a fresh one keeps one
  // run's settings out of the next.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'gk-vscode-'));
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-workspace-trust',
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${path.join(userDataDir, 'extensions')}`,
    ],
  });
}

main().catch((err) => {
  console.error('Extension Development Host tests failed:', err);
  process.exit(1);
});
