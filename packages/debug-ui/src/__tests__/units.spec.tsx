/**
 * The pieces that need no browser: the transport plumbing, the pixel helpers,
 * the key maps, and the presentational views rendered to HTML.
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Button, MAX_ROWS, Tabs, attempt, newest, tabIds } from '../components.js';
import { buttonForKey, gamepadMask } from '../keys.js';
import { EventsView, describeEvent } from '../panels/EventsPanel.js';
import { IoRegistersView } from '../panels/IoRegistersPanel.js';
import { LabelsView } from '../panels/LabelsPanel.js';
import { PaletteView } from '../panels/PalettePanel.js';
import { MAP_TILES } from '../panels/TilemapPanel.js';
import { paintTiles } from '../panels/TilesPanel.js';
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

    // a panel request goes to the host; the host's answer reaches whoever renders the tabs
    const shown: string[] = [];
    transport.onShowPanel!((panel) => shown.push(panel));
    expect(toHost.at(-1)).toEqual({ type: 'subscribe', what: 'showPanel' });
    transport.showPanel!('recording');
    expect(toHost.at(-1)).toEqual({ type: 'showPanel', panel: 'recording' });
    deliver({ type: 'showPanel', panel: 'trace' });
    expect(shown).toEqual(['trace']);
  });

  it('tells the host when the last listener of a feed leaves, and subscribes again for the next', () => {
    const toHost: TransportToHost[] = [];
    const transport = createMessageTransport({ post: (m) => toHost.push(m), listen: () => () => {} });
    const offFrameA = transport.onFrame(() => {});
    const offFrameB = transport.onFrame(() => {});
    const offAudio = transport.onAudio(() => {});
    // every frame listener subscribes (the host resends the last frame); audio once
    expect(toHost).toEqual([
      { type: 'subscribe', what: 'frame' },
      { type: 'subscribe', what: 'frame' },
      { type: 'subscribe', what: 'audio' },
    ]);
    offFrameA();
    expect(toHost.length).toBe(3); // one frame listener remains
    offFrameB();
    offFrameB(); // gone already: nothing more to say
    offAudio();
    expect(toHost.slice(3)).toEqual([
      { type: 'unsubscribe', what: 'frame' },
      { type: 'unsubscribe', what: 'audio' },
    ]);
    transport.onFrame(() => {});
    transport.onAudio(() => {});
    expect(toHost.slice(5)).toEqual([
      { type: 'subscribe', what: 'frame' },
      { type: 'subscribe', what: 'audio' },
    ]);
  });

  it('serves a webview transport on the host side', async () => {
    const replies: HostToTransport[] = [];
    const feeds: string[] = [];
    const backend = {
      request: async (command: string, args: unknown) => ({ command, args }),
      control: async () => {},
      subscribe: (what: string) => feeds.push(`+${what}`),
      unsubscribe: (what: string) => feeds.push(`-${what}`),
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
    const panels: string[] = [];
    await serveTransport({ type: 'showPanel', panel: 'recording' }, backend, (m) => replies.push(m)); // no host view: ignored
    await serveTransport(
      { type: 'showPanel', panel: 'recording' },
      { ...backend, showPanel: (p) => panels.push(p) },
      () => {},
    );
    expect(panels).toEqual(['recording']);
    expect(replies.length).toBe(3);
    await serveTransport({ type: 'subscribe', what: 'audio' }, backend, () => {});
    await serveTransport({ type: 'unsubscribe', what: 'audio' }, backend, () => {});
    expect(feeds).toEqual(['+audio', '-audio']);
  });

  it("routes a click's failure to the panel's error line instead of an unhandled rejection", async () => {
    const errors: Array<string | null> = [];
    attempt((m) => errors.push(m), Promise.reject(new Error('EACCES: labels.json')));
    attempt((m) => errors.push(m), Promise.resolve('fine'));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.sort()).toEqual(['EACCES: labels.json', null]);
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

  it('a text map reaches every one of its 1024 tiles in 8bpp too', () => {
    const tiles = new Uint8Array(MAP_TILES * 64);
    tiles[600 * 64] = 7; // tile 600: past the 512 tiles a 16 KB block holds, still addressable by a 10-bit index
    const entries = [{ tile: 600, hFlip: false, vFlip: false, palette: 0 }];
    expect(tilemapToRgba(entries, 1, 1, tiles, MAP_TILES, 8, palette).rgba[3]).toBe(255);
    expect(tilemapToRgba(entries, 1, 1, tiles, 512, 8, palette).rgba[3]).toBe(0);
  });

  it('paints a tile sheet at the depth and count it was fetched with', () => {
    const sheet = { pixels: new Uint8Array(256 * 64).fill(3), palette, bpp: 8 as const, count: 256 };
    const painted = paintTiles(sheet, 0);
    expect([painted.width, painted.height]).toEqual([32 * 8, (256 / 32) * 8]);
    expect(Array.from(painted.rgba.subarray(painted.rgba.length - 4))).toEqual([3, 3, 3, 255]); // the last pixel is real, not read past the buffer
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
    // every swatch is a named, pressable button; nothing claims to be an ARIA grid
    expect(palette).not.toContain('role="grid"');
    expect((palette.match(/<button type="button" class="gk-swatch"/g) ?? []).length).toBe(512);
    expect(palette).toContain('aria-label="bg 0: #ff0000"');
    expect(palette).toContain('aria-label="obj 255: #000000"');
    expect((palette.match(/aria-pressed="false"/g) ?? []).length).toBe(512);
    const labels = renderToString(
      <LabelsView
        labels={[{ address: 0x03005220, label: 'gUnk_03005220', comment: 'player', source: 'user' }]}
        onEdit={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(labels).toContain('gUnk_03005220');
    expect(labels).toContain('0x03005220');
    expect(labels).toContain('aria-label="Edit label gUnk_03005220"');
    expect(labels).toContain('aria-label="Remove label gUnk_03005220"');
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

  it('mounts at most MAX_ROWS rows of a log, the newest, and counts the rest', () => {
    const traceEntries = Array.from({ length: MAX_ROWS + 500 }, (_, i) => ({
      frame: i,
      scanline: 0,
      cycle: i,
      pc: 0x08000000 + i * 2,
      thumb: true,
      opcode: 0x4770,
      r0: 0,
      r1: 0,
      r2: 0,
      r3: 0,
    }));
    const trace = renderToString(<TraceView entries={traceEntries} />);
    expect((trace.match(/<tr/g) ?? []).length).toBe(MAX_ROWS + 2); // the header and the count of what is older
    expect(trace).toContain('… 500 older not shown');
    expect(trace).toContain(`>0x${(0x08000000 + (MAX_ROWS + 499) * 2).toString(16).padStart(8, '0')}<`); // the newest survives
    expect(trace).not.toContain('>0x08000000<'); // the oldest does not
    const eventEntries = Array.from({ length: 2000 }, (_, i) => ({
      frame: i,
      scanline: 0,
      cycle: i,
      pc: 0x08000100,
      event: { kind: 'vblank' } as never,
    }));
    const events = renderToString(<EventsView entries={eventEntries} />);
    expect((events.match(/<tr/g) ?? []).length).toBe(MAX_ROWS + 2);
    expect(events).toContain('… 1000 older not shown');
    expect(newest([1, 2, 3])).toEqual({ shown: [1, 2, 3], omitted: 0 });
  });

  it('announces a toggle button and wires tabs to their panels', () => {
    const button = renderToString(
      <Button onClick={() => {}} active label="Mute sound">
        🔊
      </Button>,
    );
    expect(button).toContain('aria-label="Mute sound"');
    expect(button).toContain('aria-pressed="true"');
    expect(renderToString(<Button onClick={() => {}}>plain</Button>)).not.toContain('aria-pressed');
    const tabs = renderToString(
      <Tabs
        tabs={[
          { id: 'io', label: 'I/O' },
          { id: 'trace', label: 'Trace' },
        ]}
        active="trace"
        onChange={() => {}}
      />,
    );
    expect(tabs).toContain(`id="${tabIds('gk', 'trace').tab}"`);
    expect(tabs).toContain(`aria-controls="${tabIds('gk', 'trace').panel}"`);
    expect(tabs).toContain('aria-selected="true"');
    expect(tabs).toContain('tabindex="-1"'); // only the active tab is in the tab order; arrows move between them
  });
});
