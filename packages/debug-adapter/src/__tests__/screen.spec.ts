/**
 * The standalone screen: WebSocket framing, and the round trip adapter → pipe →
 * page (frames) and page → pipe → adapter (buttons).
 */
import { describe, expect, it } from 'vitest';

import { ScreenServer, decodeWebSocketFrames, encodeWebSocketFrame } from '../screen-server.js';
import { FrameStream } from '../stream.js';

describe('websocket framing', () => {
  it('encodes every length class and decodes masked client frames', () => {
    for (const n of [0, 125, 126, 65535, 65536, 153608]) {
      const frame = encodeWebSocketFrame(new Uint8Array(n).fill(7));
      expect(frame[0]).toBe(0x82);
      expect(frame.length - n).toBe(n < 126 ? 2 : n < 0x10000 ? 4 : 10);
    }
    // a masked text frame, as a browser sends it
    const text = Buffer.from('{"buttons":3}');
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.concat([
      Buffer.from([0x81, 0x80 | text.length]),
      mask,
      Buffer.from(text.map((b, i) => b ^ mask[i & 3]!)),
    ]);
    const { frames, rest } = decodeWebSocketFrames(Buffer.concat([masked, Buffer.from([0x81])]));
    expect(frames).toEqual([{ opcode: 1, payload: text }]);
    expect(rest.length).toBe(1); // a partial frame stays for later
  });
});

describe('screen server', () => {
  it('relays frames to the page and buttons back to the adapter', async () => {
    const server = new ScreenServer();
    await server.listen(0);
    try {
      expect(server.url).toMatch(/^http:\/\/localhost:\d+\/$/);
      const page = await fetch(server.url);
      expect(await page.text()).toContain('<canvas');

      // the adapter side of the pipe
      const stream = new FrameStream();
      const pressed: number[] = [];
      stream.onInput = (mask) => pressed.push(mask);
      await stream.connect(server.pipe);
      await new Promise((r) => setTimeout(r, 20));
      expect(server.connected).toBe(true);

      // the page side
      const ws = new WebSocket(server.url.replace('http', 'ws') + 'ws');
      ws.binaryType = 'arraybuffer';
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('websocket failed'));
      });
      const received = new Promise<ArrayBuffer>((resolve) => {
        ws.onmessage = (e) => resolve(e.data as ArrayBuffer);
      });
      const rgba = new Uint8Array(240 * 160 * 4).fill(9);
      stream.sendFrame(rgba, 42);
      const data = await received;
      const view = new DataView(data);
      expect(view.getUint32(0, true)).toBe(42);
      expect(view.getUint16(4, true)).toBe(240);
      expect(data.byteLength).toBe(8 + rgba.length);

      ws.send(JSON.stringify({ buttons: 0b101 }));
      await new Promise((r) => setTimeout(r, 50));
      expect(pressed).toEqual([0b101]);
      ws.close();
      stream.close();
    } finally {
      await server.close();
    }
  });
});
