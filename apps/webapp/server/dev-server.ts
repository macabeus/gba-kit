/**
 * Development server for the webapp with hot reload.
 *
 * Usage: npx tsx apps/webapp/server/dev-server.ts --rom ./game.gba
 */
import { serve } from '@hono/node-server';
import path from 'path';
import { fileURLToPath } from 'url';
import { type Plugin, createServer as createViteServer } from 'vite';

import { createServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  let romPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rom' && args[i + 1]) {
      romPath = path.resolve(args[i + 1]!);
      i++;
    }
  }

  const hasRom = !!romPath;

  // Start the API backend on port 3001
  const apiApp = createServer({ romPath });
  const apiPort = 3001;

  await new Promise<void>((resolve) => {
    serve({ fetch: apiApp.fetch, port: apiPort }, () => resolve());
  });

  // Vite plugin to inject window.__GBAKIT_CONFIG__ into the HTML
  const injectConfigPlugin: Plugin = {
    name: 'inject-gba-kit-config',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const config = JSON.stringify({
          serverBaseUrl: '',
          hasRom,
        });
        const script = `<script>window.__GBAKIT_CONFIG__ = ${config};</script>`;
        return html.replace('</head>', `${script}\n</head>`);
      },
    },
  };

  // Create Vite dev server
  const server = await createViteServer({
    configFile: path.resolve(__dirname, '../vite.config.ts'),
    plugins: [injectConfigPlugin],
  });

  await server.listen();

  const vitePort = server.config.server.port;
  console.log(`\n  gba-kit Dev Server`);
  console.log(`  ------------------`);
  console.log(`  UI:       http://localhost:${vitePort}/`);
  console.log(`  API:      http://localhost:${apiPort}/ (proxied via /api)`);
  if (romPath) {
    console.log(`  ROM:      ${romPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
