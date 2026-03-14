import fs from 'fs/promises';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import path from 'path';

export interface ServerConfig {
  romPath?: string;
}

export function createServer(config: ServerConfig) {
  const { romPath } = config;

  const app = new Hono().use('/api/*', cors()).get('/api/loadRom', async (c) => {
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
  });

  return app;
}
