import { useMemo, useRef, useState } from 'react';

import { Button, Empty, Hex, Select } from '../components.js';
import { useAtStop, usePixels } from '../hooks.js';
import { base64ToBytes, tilesToRgba } from '../render.js';
import type { Transport } from '../transport.js';

const CHAR_BASES = [
  { value: 0x0000, label: 'BG block 0 (0x06000000)' },
  { value: 0x4000, label: 'BG block 1 (0x06004000)' },
  { value: 0x8000, label: 'BG block 2 (0x06008000)' },
  { value: 0xc000, label: 'BG block 3 (0x0600c000)' },
  { value: 0x10000, label: 'OBJ (0x06010000)' },
  { value: 0x14000, label: 'OBJ upper (0x06014000)' },
];
const PER_ROW = 32;

/** One fetch of a tile sheet, with the depth and count it was fetched at: what a repaint reads it with. */
export interface TileSheet {
  pixels: Uint8Array;
  palette: number[];
  bpp: 4 | 8;
  count: number;
}

/**
 * Paint a sheet with its own depth and count, never the panel's current controls:
 * between a control change and the refetch it causes, the previous sheet stays
 * consistent instead of being read past its end or at the wrong depth.
 */
export function paintTiles(sheet: TileSheet, bank: number): { width: number; height: number; rgba: Uint8ClampedArray } {
  return tilesToRgba(sheet.pixels, sheet.count, PER_ROW, sheet.bpp, sheet.palette, bank, true);
}

export function TilesPanel({ transport }: { transport: Transport }) {
  const [charBase, setCharBase] = useState(0);
  const [bpp, setBpp] = useState<4 | 8>(4);
  const [bank, setBank] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const count = bpp === 4 ? 512 : 256; // one 16 KB block
  const { data, error } = useAtStop(
    transport,
    async (t): Promise<TileSheet | null> => {
      const [tiles, palette] = await Promise.all([
        t.request('gba-kit/ppu', { kind: 'tiles', charBase, bpp, count }),
        t.request('gba-kit/ppu', { kind: 'palette' }),
      ]);
      if (tiles.kind !== 'tiles' || palette.kind !== 'palette') {
        return null;
      }
      return {
        pixels: base64ToBytes(tiles.pixels),
        palette: charBase >= 0x10000 ? palette.obj : palette.bg,
        bpp: tiles.bpp,
        count: tiles.count,
      };
    },
    [charBase, bpp, count],
  );
  const pixels = useMemo(() => (data ? paintTiles(data, bank) : null), [data, bank]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  usePixels(canvasRef, pixels);

  const onPick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = rect.width / (PER_ROW * 8);
    const x = Math.floor((e.clientX - rect.left) / scale / 8);
    const y = Math.floor((e.clientY - rect.top) / scale / 8);
    setSelected(y * PER_ROW + x);
  };

  const bytesPerTile = bpp === 4 ? 32 : 64;
  return (
    <div className="gk-col gk-pad">
      <div className="gk-row">
        <Select value={charBase} options={CHAR_BASES} onChange={setCharBase} />
        <Button onClick={() => setBpp(bpp === 4 ? 8 : 4)} title="Bits per pixel">
          {bpp} bpp
        </Button>
        {bpp === 4 && (
          <Select
            value={bank}
            options={Array.from({ length: 16 }, (_, i) => ({ value: i, label: `palette ${i}` }))}
            onChange={setBank}
            title="16-color palette bank to paint with"
          />
        )}
        <span className="gk-muted gk-small">
          {count} tiles · {PER_ROW} per row
        </span>
      </div>
      {error && <Empty>{error}</Empty>}
      {!data && !error && <Empty>Stop the machine to see the tiles.</Empty>}
      {data && (
        <div className="gk-row" style={{ alignItems: 'flex-start' }}>
          <canvas
            ref={canvasRef}
            className="gk-pixels"
            role="img"
            aria-label="Tile sheet; click a tile to inspect it"
            style={{ width: PER_ROW * 8 * 2 }}
            onClick={onPick}
          />
          <div className="gk-col gk-mono gk-small">
            {selected !== null && selected < count ? (
              <>
                <div>tile {selected}</div>
                <div className="gk-muted">
                  at <Hex value={0x06000000 + charBase + selected * bytesPerTile} />
                </div>
                <div className="gk-muted">{bytesPerTile} bytes</div>
              </>
            ) : (
              <span className="gk-muted">Click a tile.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
