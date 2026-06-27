import fs from 'fs/promises';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import path from 'path';

export interface ServerConfig {
  romPath?: string;
  /** Sidecar `-g` ELF (DWARF + symbols) served to auto-populate the Source panel. */
  elfPath?: string;
}

export function createServer(config: ServerConfig) {
  const { romPath, elfPath } = config;

  const serveFile = async (c: Context, filePath: string | undefined, label: string) => {
    if (!filePath) {
      return c.json({ error: `No ${label} path configured` }, 404);
    }
    try {
      const buffer = await fs.readFile(filePath);
      return c.body(buffer, 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
      });
    } catch {
      return c.json({ error: `${label} file not found: ${filePath}` }, 404);
    }
  };

  const app = new Hono()
    .use('/api/*', cors())
    .get('/api/loadRom', (c) => serveFile(c, romPath, 'ROM'))
    .get('/api/loadElf', (c) => serveFile(c, elfPath, 'ELF'));

  return app;
}
