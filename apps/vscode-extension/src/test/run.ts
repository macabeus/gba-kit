/**
 * Launch an Extension Development Host with this extension and the debug-core
 * fixtures as the workspace, and run `suite.ts` inside it. Downloads VS Code on
 * first use (`@vscode/test-electron`).
 */
import { runTests } from '@vscode/test-electron';
import path from 'node:path';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  const workspace = path.resolve(extensionDevelopmentPath, '..', '..', 'packages', 'debug-core', 'test-fixtures');
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
  });
}

main().catch((err) => {
  console.error('Extension Development Host tests failed:', err);
  process.exit(1);
});
