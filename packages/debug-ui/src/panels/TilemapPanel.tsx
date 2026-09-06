import { useMemo, useRef, useState } from 'react';

import { Empty, Hex, Select } from '../components.js';
import { useAtStop, usePixels } from '../hooks.js';
import { base64ToBytes, tilemapToRgba } from '../render.js';
import type { Transport } from '../transport.js';

/** A text map's tile index is 10 bits in either depth: every one of the 1024 tiles from the character base is reachable. */
export const MAP_TILES = 1024;

export function TilemapPanel({ transport }: { transport: Transport }) {
  const [index, setIndex] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const { data, error } = useAtStop(
    transport,
    async (t) => {
      const [map, palette] = await Promise.all([
        t.request('gba-kit/ppu', { kind: 'tilemap', index }),
        t.request('gba-kit/ppu', { kind: 'palette' }),
      ]);
      if (map.kind !== 'tilemap' || palette.kind !== 'palette' || !map.tilemap) {
        return null;
      }
      const bg = map.tilemap.background;
      const tiles = await t.request('gba-kit/ppu', {
        kind: 'tiles',
        charBase: bg.charBase,
        bpp: bg.bpp,
        count: MAP_TILES,
      });
      if (tiles.kind !== 'tiles') {
        return null;
      }
      return { map: map.tilemap, tiles: base64ToBytes(tiles.pixels), tileCount: MAP_TILES, palette: palette.bg };
    },
    [index],
  );
  const pixels = useMemo(() => {
    if (!data) {
      return null;
    }
    const bg = data.map.background;
    return tilemapToRgba(data.map.entries, bg.width, bg.height, data.tiles, data.tileCount, bg.bpp, data.palette);
  }, [data]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  usePixels(canvasRef, pixels);

  const bg = data?.map.background;
  const entry = bg && hover ? data.map.entries[hover.y * bg.width + hover.x] : undefined;
  return (
    <div className="gk-col gk-pad">
      <div className="gk-row">
        <Select value={index} options={[0, 1, 2, 3].map((i) => ({ value: i, label: `BG${i}` }))} onChange={setIndex} />
        {bg && (
          <span className="gk-muted gk-small gk-mono">
            {bg.enabled ? 'on' : 'off'} · prio {bg.priority} · {bg.width}×{bg.height} tiles · {bg.bpp} bpp · char{' '}
            <Hex value={0x06000000 + bg.charBase} /> · map <Hex value={0x06000000 + bg.screenBase} /> · scroll{' '}
            {bg.scrollX},{bg.scrollY}
            {bg.affine ? ' · affine' : ''}
          </span>
        )}
      </div>
      {error && <Empty>{error}</Empty>}
      {!data && !error && <Empty>Stop the machine to see the map.</Empty>}
      {data && bg && (
        <div className="gk-row" style={{ alignItems: 'flex-start' }}>
          <canvas
            ref={canvasRef}
            className="gk-pixels"
            role="img"
            aria-label={`Background ${index} map; hover a cell to inspect its entry`}
            style={{ width: Math.min(bg.width * 8, 512) }}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const scale = rect.width / (bg.width * 8);
              setHover({
                x: Math.floor((e.clientX - rect.left) / scale / 8),
                y: Math.floor((e.clientY - rect.top) / scale / 8),
              });
            }}
            onMouseLeave={() => setHover(null)}
          />
          <div className="gk-col gk-mono gk-small">
            {entry && hover ? (
              <>
                <div>
                  map ({hover.x}, {hover.y})
                </div>
                <div className="gk-muted">tile {entry.tile}</div>
                <div className="gk-muted">
                  palette {entry.palette}
                  {entry.hFlip ? ' · h-flip' : ''}
                  {entry.vFlip ? ' · v-flip' : ''}
                </div>
                <div className="gk-muted">
                  entry at{' '}
                  <Hex value={0x06000000 + bg.screenBase + (hover.y * bg.width + hover.x) * (bg.affine ? 1 : 2)} />
                </div>
              </>
            ) : (
              <span className="gk-muted">Hover the map.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
