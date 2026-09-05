import { useState } from 'react';

import { Empty, Hex, Panel } from '../components.js';
import { useAtStop } from '../hooks.js';
import { cssColor, unpackRgb } from '../render.js';
import type { Transport } from '../transport.js';

export function PalettePanel({ transport }: { transport: Transport }) {
  const { data, error } = useAtStop(transport, async (t) => {
    const body = await t.request('gba-kit/ppu', { kind: 'palette' });
    return body.kind === 'palette' ? body : null;
  });
  if (error) {
    return <Empty>{error}</Empty>;
  }
  if (!data) {
    return <Empty>Stop the machine to see the palette.</Empty>;
  }
  return <PaletteView bg={data.bg} obj={data.obj} />;
}

/** Two 16×16 grids of swatches; hovering or clicking one names its index and color. */
export function PaletteView({ bg, obj }: { bg: number[]; obj: number[] }) {
  const [picked, setPicked] = useState<{ kind: 'bg' | 'obj'; index: number } | null>(null);
  const pickedColor = picked ? (picked.kind === 'bg' ? bg : obj)[picked.index] : undefined;
  const [r, g, b] = pickedColor !== undefined ? unpackRgb(pickedColor) : [0, 0, 0];
  const bgr555 = pickedColor !== undefined ? (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10) : 0;
  return (
    <div className="gk-row" style={{ alignItems: 'flex-start', padding: 8 }}>
      {(['bg', 'obj'] as const).map((kind) => (
        <Panel key={kind} title={kind === 'bg' ? 'Background' : 'Sprites'} pad>
          <div className="gk-swatches" role="grid">
            {(kind === 'bg' ? bg : obj).map((color, i) => (
              <div
                key={i}
                className={`gk-swatch${picked?.kind === kind && picked.index === i ? ' gk-selected' : ''}`}
                style={{ background: cssColor(color) }}
                title={`${kind} ${i} (bank ${i >> 4}, entry ${i & 15}): ${cssColor(color)}`}
                onMouseEnter={() => setPicked({ kind, index: i })}
                onClick={() => setPicked({ kind, index: i })}
              />
            ))}
          </div>
        </Panel>
      ))}
      <div className="gk-col gk-mono">
        {picked && pickedColor !== undefined ? (
          <>
            <div>
              {picked.kind} #{picked.index}{' '}
              <span className="gk-muted">
                (bank {picked.index >> 4}, entry {picked.index & 15})
              </span>
            </div>
            <div className="gk-row">
              <span className="gk-swatch" style={{ width: 24, height: 24, background: cssColor(pickedColor) }} />
              <span>{cssColor(pickedColor)}</span>
            </div>
            <div className="gk-muted">
              BGR555 <Hex value={bgr555} digits={4} /> · r {r >> 3} g {g >> 3} b {b >> 3}
            </div>
            <div className="gk-muted">
              at <Hex value={0x05000000 + (picked.kind === 'obj' ? 0x200 : 0) + picked.index * 2} />
            </div>
          </>
        ) : (
          <span className="gk-muted">Hover a color.</span>
        )}
      </div>
    </div>
  );
}
