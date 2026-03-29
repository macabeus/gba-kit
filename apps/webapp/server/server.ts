import fs from 'fs/promises';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import path from 'path';

export interface ServerConfig {
  romPath?: string;
  mizuchiDbPath?: string;
}

export function createServer(config: ServerConfig) {
  const { romPath, mizuchiDbPath } = config;

  const app = new Hono()
    .use('/api/*', cors())
    .get('/api/loadRom', async (c) => {
      if (!romPath) {
        return c.json({ error: 'No ROM path configured' }, 404);
      }

      try {
        const romBuffer = await fs.readFile(romPath);
        return c.body(romBuffer, 200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${path.basename(romPath)}"`,
        });
      } catch {
        return c.json({ error: `ROM file not found: ${romPath}` }, 404);
      }
    })
    .get('/api/mizuchiDb', async (c) => {
      if (!mizuchiDbPath) {
        return c.json({ error: 'No mizuchi-db path configured' }, 404);
      }

      try {
        const raw = await fs.readFile(mizuchiDbPath, 'utf-8');
        const parsed = JSON.parse(raw);
        // Strip large fields not needed by the webapp (embeddings + index metadata)
        const { vectors: _vectors, indexMetadata: _meta, ...rest } = parsed;
        return c.json(rest);
      } catch {
        return c.json({ error: `Mizuchi DB file not found: ${mizuchiDbPath}` }, 404);
      }
    });

  return app;
}
