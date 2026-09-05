// Three bundles from one workspace:
//   dist/extension.js  the extension host side (CommonJS, `vscode` provided by the host)
//   dist/adapter.js    the debug adapter as a standalone Node process (CommonJS)
//   dist/webview.js    the panels for the webviews (browser, React + @gba-kit/debug-ui)
//   dist/test/*.js     the Extension Development Host tests
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const node = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...node,
    entryPoints: { extension: 'src/extension.ts', 'test/run': 'src/test/run.ts', 'test/suite': 'src/test/suite.ts' },
    outdir: 'dist',
    external: ['vscode', '@vscode/test-electron'],
  }),
  esbuild.context({
    ...node,
    entryPoints: { adapter: 'src/adapter.ts' },
    outdir: 'dist',
  }),
  esbuild.context({
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: !watch,
    logLevel: 'info',
    entryPoints: { webview: 'src/webview/main.tsx' },
    outdir: 'dist',
    define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
    loader: { '.css': 'css' },
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
