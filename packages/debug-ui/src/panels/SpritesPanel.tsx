import type { SpriteInfo } from '@gba-kit/debug-core';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Empty, Hex } from '../components.js';
import { useAtStop } from '../hooks.js';
import { base64ToBytes, spriteToRgba } from '../render.js';
import type { Transport } from '../transport.js';

export function SpritesPanel({ transport }: { transport: Transport }) {
  const [onlyEnabled, setOnlyEnabled] = useState(true);
  const { data, error } = useAtStop(transport, async (t) => {
    const [sprites, tiles, palette, io] = await Promise.all([
      t.request('gba-kit/ppu', { kind: 'sprites' }),
      t.request('gba-kit/ppu', { kind: 'tiles', charBase: 0x10000, bpp: 4, count: 1024 }),
      t.request('gba-kit/ppu', { kind: 'palette' }),
      t.request('gba-kit/ioRegisters'),
    ]);
    if (sprites.kind !== 'sprites' || tiles.kind !== 'tiles' || palette.kind !== 'palette') {
      return null;
    }
    const dispcnt = io.registers.find((r) => r.name === 'DISPCNT')?.value ?? 0;
    return {
      sprites: sprites.sprites,
      tiles4: base64ToBytes(tiles.pixels),
      palette: palette.obj,
      oneDimensional: (dispcnt & 0x40) !== 0,
    };
  });
  if (error) {
    return <Empty>{error}</Empty>;
  }
  if (!data) {
    return <Empty>Stop the machine to see the sprites.</Empty>;
  }
  return (
    <SpritesView
      sprites={data.sprites}
      objTiles4={data.tiles4}
      objPalette={data.palette}
      oneDimensional={data.oneDimensional}
      onlyEnabled={onlyEnabled}
      onOnlyEnabled={setOnlyEnabled}
    />
  );
}

/** 8bpp sprites read the same VRAM as two 4bpp tiles each; re-pack the 4bpp indices into 8bpp tiles. */
function repack8bpp(tiles4: Uint8Array): Uint8Array {
  const out = new Uint8Array(tiles4.length / 2);
  for (let i = 0; i < out.length; i++) {
    // 4bpp tile t holds bytes t*32..; two 4bpp tiles hold one 8bpp tile's 64 bytes
    const lo = tiles4[i * 2]!;
    const hi = tiles4[i * 2 + 1]!;
    out[i] = lo | (hi << 4);
  }
  return out;
}

export function SpritesView({
  sprites,
  objTiles4,
  objPalette,
  oneDimensional,
  onlyEnabled,
  onOnlyEnabled,
}: {
  sprites: SpriteInfo[];
  objTiles4: Uint8Array;
  objPalette: number[];
  oneDimensional: boolean;
  onlyEnabled: boolean;
  onOnlyEnabled: (v: boolean) => void;
}) {
  const tiles8 = useMemo(() => repack8bpp(objTiles4), [objTiles4]);
  const shown = onlyEnabled ? sprites.filter((s) => s.enabled) : sprites;
  return (
    <div className="gk-col">
      <div className="gk-row" style={{ padding: '6px 10px 0' }}>
        <label className="gk-check">
          <input type="checkbox" checked={onlyEnabled} onChange={(e) => onOnlyEnabled(e.target.checked)} /> only enabled
        </label>
        <span className="gk-muted gk-small">
          {shown.length} of {sprites.length} · {oneDimensional ? '1D' : '2D'} mapping
        </span>
      </div>
      {shown.length === 0 ? (
        <Empty>No sprite is enabled.</Empty>
      ) : (
        <table className="gk-table">
          <thead>
            <tr>
              <th>#</th>
              <th></th>
              <th className="gk-right">x</th>
              <th className="gk-right">y</th>
              <th>size</th>
              <th className="gk-right">tile</th>
              <th className="gk-right">pal</th>
              <th className="gk-right">prio</th>
              <th>flags</th>
              <th>OAM</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.index}>
                <td>{s.index}</td>
                <td>
                  <SpritePreview
                    sprite={s}
                    objTiles={s.bpp === 8 ? tiles8 : objTiles4}
                    objPalette={objPalette}
                    oneDimensional={oneDimensional}
                  />
                </td>
                <td className="gk-right">{s.x}</td>
                <td className="gk-right">{s.y}</td>
                <td>
                  {s.width}×{s.height}
                </td>
                <td className="gk-right">{s.tile}</td>
                <td className="gk-right">{s.bpp === 8 ? '256c' : s.palette}</td>
                <td className="gk-right">{s.priority}</td>
                <td className="gk-muted">
                  {[
                    s.hFlip && 'hflip',
                    s.vFlip && 'vflip',
                    s.mode === 1 && 'blend',
                    s.mode === 2 && 'window',
                    !s.enabled && 'off',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </td>
                <td>
                  <Hex value={0x07000000 + s.index * 8} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SpritePreview({
  sprite,
  objTiles,
  objPalette,
  oneDimensional,
}: {
  sprite: SpriteInfo;
  objTiles: Uint8Array;
  objPalette: number[];
  oneDimensional: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const { width, height, rgba } = spriteToRgba(sprite, objTiles, objTiles.length / 64, objPalette, oneDimensional);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const image = ctx.createImageData(width, height);
    image.data.set(rgba);
    ctx.putImageData(image, 0, 0);
  }, [sprite, objTiles, objPalette, oneDimensional]);
  const scale = sprite.height > 32 ? 1 : 2;
  return (
    <canvas
      ref={canvasRef}
      className="gk-sprite-preview"
      style={{ width: sprite.width * scale, height: sprite.height * scale }}
    />
  );
}
