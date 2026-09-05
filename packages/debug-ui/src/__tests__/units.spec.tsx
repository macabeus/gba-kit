/**
 * The pieces that need no browser: the transport plumbing, the pixel helpers,
 * the key maps, and the presentational views rendered to HTML.
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buttonForKey, gamepadMask } from '../keys.js';
import { EventsView, describeEvent } from '../panels/EventsPanel.js';
import { IoRegistersView } from '../panels/IoRegistersPanel.js';
import { LabelsView } from '../panels/LabelsPanel.js';
import { PaletteView } from '../panels/PalettePanel.js';
import { TraceView } from '../panels/TracePanel.js';
import { base64ToBytes, cssColor, spriteToRgba, tilemapToRgba, tilesToRgba } from '../render.js';
import type { HostToTransport, TransportToHost } from '../transport.js';
import { createMessageTransport, serveTransport } from '../transport.js';

describe('message transport', () => {
  it('matches responses to requests, rejects errors, and fans events out', async () => {
    const toHost: TransportToHost[] = [];
    let deliver: (m: HostToTransport) => void = () => {};
    const transport = createMessageTransport({
      post: (m) => toHost.push(m),
      listen: (h) => {
        deliver = h;
        return () => {};
      },
    });
    const states: number[] = [];
    transport.onState((s) => states.push(s.frame));
    expect(toHost).toEqual([{ type: 'subscribe', what: 'state' }]);

    const pending = transport.request('gba-kit/state');
    const req = toHost[1] as { type: 'request'; id: number };
    expect(req.type).toBe('request');
    deliver({ type: 'response', id: req.id, body: { frame: 7 } });
    expect(await pending).toEqual({ frame: 7 });

    const failing = transport.request('gba-kit/nope' as never);
    deliver({ type: 'response', id: (toHost[2] as { id: number }).id, error: 'unknown' });
    await expect(failing).rejects.toThrow('unknown');

    deliver({ type: 'state', state: { frame: 3 } as never });
    expect(states).toEqual([3]);
    // a late subscriber gets the last state immediately
    transport.onState((s) => states.push(s.frame * 10));
    expect(states).toEqual([3, 30]);
  });

  it('serves a webview transport on the host side', async () => {
    const replies: HostToTransport[] = [];
    const backend = {
      request: async (command: string, args: unknown) => ({ command, args }),
      control: async () => {},
      subscribe: () => {},
    };
    await serveTransport({ type: 'request', id: 1, command: 'gba-kit/state', args: { a: 1 } }, backend, (m) =>
      replies.push(m),
    );
    await serveTransport({ type: 'control', id: 2, action: 'continue' }, backend, (m) => replies.push(m));
    await serveTransport(
      { type: 'request', id: 3, command: 'x' },
      { ...backend, request: async () => Promise.reject(new Error('boom')) },
      (m) => replies.push(m),
    );
    expect(replies).toEqual([
      { type: 'response', id: 1, body: { command: 'gba-kit/state', args: { a: 1 } } },
      { type: 'response', id: 2 },
      { type: 'response', id: 3, error: 'boom' },
    ]);
  });
});

describe('pixels', () => {
  const palette = Array.from({ length: 256 }, (_, i) => (i << 16) | (i << 8) | i);

  it('lays tiles out in a grid and paints indices through the palette bank', () => {
    const pixels = new Uint8Array(2 * 64);
    pixels.fill(1, 0, 64); // tile 0: index 1
    pixels[64] = 5; // tile 1: one pixel of index 5, rest transparent
    const { width, height, rgba } = tilesToRgba(pixels, 2, 2, 4, palette, 1);
    expect([width, height]).toEqual([16, 8]);
    expect(Array.from(rgba.subarray(0, 4))).toEqual([17, 17, 17, 255]); // bank 1, index 1 = color 17
    expect(Array.from(rgba.subarray(8 * 4, 8 * 4 + 4))).toEqual([21, 21, 21, 255]); // tile 1 pixel 0 = color 16 + 5
    expect(rgba[9 * 4 + 3]).toBe(0); // transparent
  });

  it('paints a tilemap with flips', () => {
    const tiles = new Uint8Array(64);
    tiles[0] = 2; // top-left pixel of tile 0
    const entries = [
      { tile: 0, hFlip: false, vFlip: false, palette: 0 },
      { tile: 0, hFlip: true, vFlip: true, palette: 0 },
    ];
    const { width, rgba } = tilemapToRgba(entries, 2, 1, tiles, 1, 8, palette);
    expect(width).toBe(16);
    expect(rgba[3]).toBe(255); // (0,0)
    expect(rgba[(7 * 16 + 15) * 4 + 3]).toBe(255); // flipped both ways: (15,7)
  });

  it('paints a 16×16 sprite in 1D and 2D mapping', () => {
    const tiles = new Uint8Array(64 * 40);
    tiles[64 * 1] = 3; // tile 1 pixel (0,0)
    tiles[64 * 32] = 4; // tile 32 pixel (0,0)
    const sprite = {
      index: 0,
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      tile: 0,
      palette: 0,
      priority: 0,
      hFlip: false,
      vFlip: false,
      enabled: true,
      bpp: 4 as const,
      mode: 0,
    };
    const oneD = spriteToRgba(sprite, tiles, 40, palette, true);
    expect(oneD.rgba[(0 * 16 + 8) * 4 + 3]).toBe(255); // 1D: tile 1 is the top-right quadrant
    const twoD = spriteToRgba(sprite, tiles, 40, palette, false);
    expect(twoD.rgba[(8 * 16 + 0) * 4 + 3]).toBe(255); // 2D: tile 32 is the bottom-left quadrant
  });

  it('decodes base64 and formats colors', () => {
    expect(Array.from(base64ToBytes('AQID'))).toEqual([1, 2, 3]);
    expect(cssColor(0x0080ff)).toBe('#0080ff');
  });
});

describe('keys', () => {
  it('maps the keyboard and a standard gamepad', () => {
    expect(buttonForKey('z')).toBe(0);
    expect(buttonForKey('Z')).toBe(0);
    expect(buttonForKey('ArrowUp')).toBe(6);
    expect(buttonForKey('q')).toBe(-1);
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
    buttons[9] = { pressed: true }; // start
    expect(gamepadMask(buttons, [0, 0])).toBe(1 << 3);
    expect(gamepadMask(buttons, [-1, 0.9])).toBe((1 << 3) | (1 << 5) | (1 << 7));
  });
});

describe('views', () => {
  it('renders I/O registers with decoded fields', () => {
    const html = renderToString(
      <IoRegistersView
        registers={[
          {
            name: 'DISPCNT',
            address: 0x04000000,
            size: 2,
            fields: [],
            value: 0x0403,
            decoded: [
              { name: 'mode', value: 3 },
              { name: 'bg2', value: 1 },
            ],
          } as never,
          { name: 'IME', address: 0x04000208, size: 2, fields: [], value: 1, decoded: [] } as never,
        ]}
        filter="disp"
      />,
    );
    expect(html).toContain('DISPCNT');
    expect(html).toContain('0x0403');
    expect(html).not.toContain('IME');
  });

  it('renders a palette, labels, a trace and events', () => {
    const palette = renderToString(<PaletteView bg={Array(256).fill(0xff0000)} obj={Array(256).fill(0)} />);
    expect((palette.match(/gk-swatch/g) ?? []).length).toBeGreaterThanOrEqual(512);
    const labels = renderToString(
      <LabelsView labels={[{ address: 0x03005220, label: 'gUnk_03005220', comment: 'player', source: 'user' }]} />,
    );
    expect(labels).toContain('gUnk_03005220');
    expect(labels).toContain('0x03005220');
    const trace = renderToString(
      <TraceView
        entries={[
          { frame: 1, scanline: 2, cycle: 3, pc: 0x08000100, thumb: true, opcode: 0x4770, r0: 1, r1: 2, r2: 3, r3: 4 },
        ]}
      />,
    );
    expect(trace).toContain('0x08000100');
    expect(trace).toContain('0x4770');
    const events = renderToString(
      <EventsView
        entries={[{ frame: 1, scanline: 160, cycle: 9, pc: 0x08000100, event: { kind: 'vblank' } as never }]}
      />,
    );
    expect(events).toContain('vblank');
    expect(describeEvent({ kind: 'mmio-write', address: 0x04000000, value: 0x403, size: 2 } as never)).toBe(
      'address=0x4000000 value=0x403 size=2',
    );
  });
});
