// Bundle the extension + debug adapter + gba-kit (ESM) into one CommonJS file the
// VS Code extension host can `require`. `vscode` is provided by the host.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const ctx = await esbuild.context({
  entryPoints: {
    extension: 'src/vscode/extension.ts',
    'adapter-cli': 'src/dap/adapter-cli.ts',
    dap: 'src/dap/index.ts',
  },
  bundle: true,
  outdir: 'dist',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});
if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
