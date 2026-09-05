/**
 * The standalone screen: WebSocket framing, the stream's framing and its slow
 * consumers, and the round trip adapter → pipe → page (frames) and page → pipe →
 * adapter (buttons).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { type Server, type Socket, connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { STREAM } from '../protocol.js';
import { MAX_WS_PAYLOAD, ScreenServer, decodeWebSocketFrames, encodeWebSocketFrame } from '../screen-server.js';
import { FrameStream, StreamReader, encodeStreamMessage, newPipePath } from '../stream.js';

const PIXELS = STREAM.width * STREAM.height * 4;

/** A client frame as a browser sends it: masked. */
function maskedFrame(payload: Buffer, opcode: number, fin = true): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([
    Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]),
    mask,
    Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!)),
  ]);
}

function framePayload(frame: number, width = STREAM.width, height = STREAM.height): Buffer {
  const payload = Buffer.alloc(8 + width * height * 4);
  payload.writeUInt32LE(frame, 0);
  payload.writeUInt16LE(width, 4);
  payload.writeUInt16LE(height, 6);
  return payload;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) {
      throw new Error('condition not met in time');
    }
    await wait(5);
  }
};

const tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function pipePath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gba-kit-'));
  tempDirs.push(dir);
  return process.platform === 'win32' ? `\\\\.\\pipe\\gba-kit-${name}-${process.pid}` : join(dir, `${name}.sock`);
}

/** A pipe server that remembers its sockets, so a test can pause or destroy them. */
async function pipeServer(name: string): Promise<{ path: string; server: Server; sockets: Socket[] }> {
  const path = await pipePath(name);
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, server, sockets };
}

async function closeServer(server: Server, sockets: Socket[]): Promise<void> {
  for (const s of sockets) {
    s.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('websocket framing', () => {
  it('encodes every length class and decodes masked client frames', () => {
    for (const n of [0, 125, 126, 65535, 65536, 153608]) {
      const frame = encodeWebSocketFrame(new Uint8Array(n).fill(7));
      expect(frame[0]).toBe(0x82);
      expect(frame.length - n).toBe(n < 126 ? 2 : n < 0x10000 ? 4 : 10);
    }
    // a masked text frame, as a browser sends it
    const text = Buffer.from('{"buttons":3}');
    const { frames, rest } = decodeWebSocketFrames(Buffer.concat([maskedFrame(text, 1), Buffer.from([0x81])]));
    expect(frames).toEqual([{ opcode: 1, fin: true, payload: text }]);
    expect(rest.length).toBe(1); // a partial frame stays for later
  });

  it('keeps fragments apart for the caller to join, and refuses what a browser never sends', () => {
    const { frames } = decodeWebSocketFrames(
      Buffer.concat([maskedFrame(Buffer.from('{"butt'), 1, false), maskedFrame(Buffer.from('ons":5}'), 0)]),
    );
    expect(frames.map((f) => [f.opcode, f.fin, f.payload.toString()])).toEqual([
      [1, false, '{"butt'],
      [0, true, 'ons":5}'],
    ]);
    // unmasked: not a browser (RFC 6455 requires the mask)
    expect(() => decodeWebSocketFrames(Buffer.from([0x81, 2, 0x7b, 0x7d]))).toThrow(/unmasked/);
    // a length no page's message has: a client that lies would otherwise be buffered forever
    const huge = Buffer.alloc(10 + 1000);
    huge[0] = 0x81;
    huge[1] = 0x80 | 127;
    huge.writeBigUInt64BE(BigInt(2 ** 40), 2);
    expect(() => decodeWebSocketFrames(huge)).toThrow(/frame of 1099511627776 bytes/);
    const big = Buffer.alloc(10 + 4);
    big[0] = 0x81;
    big[1] = 0x80 | 127;
    big.writeBigUInt64BE(BigInt(MAX_WS_PAYLOAD + 1), 2);
    expect(() => decodeWebSocketFrames(big)).toThrow(/frame of 65537 bytes/);
    const fits = Buffer.alloc(4 + 4 + 65535);
    fits[0] = 0x81;
    fits[1] = 0x80 | 126;
    fits.writeUInt16BE(65535, 2);
    expect(decodeWebSocketFrames(fits).frames.length).toBe(1);
  });
});

describe('stream framing', () => {
  it('delivers a whole frame, and refuses a header or frame that cannot be the stream', () => {
    const frames: number[] = [];
    const reader = new StreamReader((f) => {
      expect(f.rgba.length).toBe(PIXELS);
      frames.push(f.frame);
    });
    reader.push(encodeStreamMessage(STREAM.frame, framePayload(7)));
    expect(frames).toEqual([7]);

    const badLength = encodeStreamMessage(STREAM.frame, Buffer.alloc(0));
    badLength.writeUInt32LE(0xffffffff, 4);
    expect(() => new StreamReader(() => {}).push(badLength)).toThrow(/bad length 4294967295/);

    let delivered = 0;
    const strict = new StreamReader(() => delivered++);
    expect(() => strict.push(encodeStreamMessage(STREAM.frame, framePayload(1, 60000, 60000).subarray(0, 8)))).toThrow(
      /bad frame: 60000×60000 with 0 bytes/,
    );
    expect(() => strict.push(encodeStreamMessage(STREAM.frame, Buffer.alloc(3)))).toThrow(/bad frame/);
    expect(delivered).toBe(0);
  });
});

describe('pipe path', () => {
  it('names a pipe unique to this process and moment, in the form the platform takes', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const path = newPipePath('gba-kit-x');
      const id = `gba-kit-x-${process.pid}-${(1_000_000).toString(36)}`;
      if (process.platform === 'win32') {
        expect(path).toBe(`\\\\.\\pipe\\${id}`);
      } else {
        expect(path).toBe(join(tmpdir(), `${id}.sock`));
      }
      now.mockReturnValue(1_000_001);
      expect(newPipePath('gba-kit-x')).not.toBe(path);
      expect(newPipePath()).toContain(`gba-kit-${process.pid}-`);
    } finally {
      now.mockRestore();
    }
  });
});

describe('frame stream', () => {
  it('holds the newest frame for a slow pipe and sends it once the pipe drains', async () => {
    const { path, server, sockets } = await pipeServer('slow');
    const stream = new FrameStream();
    try {
      const frames: number[] = [];
      await stream.connect(path);
      await until(() => sockets.length === 1);
      const socket = sockets[0]!;
      const reader = new StreamReader((f) => frames.push(f.frame));
      socket.on('data', (chunk: Buffer) => reader.push(chunk));
      socket.pause();
      const rgba = new Uint8Array(PIXELS);
      for (let i = 1; i <= 20; i++) {
        stream.sendFrame(rgba, i);
      }
      stream.sendFrame(rgba, 999); // the stop's frame: the newest
      expect(stream.dropped).toBeGreaterThan(0);
      socket.resume();
      await until(() => frames.includes(999));
      expect(frames[0]).toBe(1);
      expect(frames[frames.length - 1]).toBe(999);
      // what was dropped is not replayed: only the newest frame follows the backlog
      expect(frames.length).toBeLessThan(21);
      expect(stream.connected).toBe(true);
    } finally {
      stream.close();
      await closeServer(server, sockets);
    }
  });

  it('a newer connect supersedes a pending one, and a close during a connect wins', async () => {
    const a = await pipeServer('a');
    const b = await pipeServer('b');
    const stream = new FrameStream();
    try {
      const first = stream.connect(a.path);
      const second = stream.connect(b.path);
      await expect(first).rejects.toThrow(/superseded/);
      await second;
      await wait(50);
      expect(stream.connected).toBe(true);
      expect(a.sockets.every((s) => s.destroyed)).toBe(true);
      expect(b.sockets.length).toBe(1);
      expect(b.sockets[0]!.destroyed).toBe(false);
      stream.close();
      await until(() => b.sockets[0]!.destroyed);
      expect(stream.connected).toBe(false);

      const pending = stream.connect(a.path);
      stream.close();
      await pending.catch(() => {});
      await wait(50);
      expect(stream.connected).toBe(false);
      expect(a.sockets.every((s) => s.destroyed)).toBe(true);
    } finally {
      stream.close();
      await closeServer(a.server, a.sockets);
      await closeServer(b.server, b.sockets);
    }
  });
});

/** The WebSocket handshake by hand, so a test can choose its Origin and pause the socket. */
function upgrade(port: number, origin?: string): Promise<{ socket: Socket; status: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
          (origin ? `Origin: ${origin}\r\n` : '') +
          '\r\n',
      );
    });
    socket.once('data', (chunk: Buffer) => resolve({ socket, status: chunk.toString().split('\r\n')[0]! }));
    socket.once('error', reject);
  });
}

describe('screen server', () => {
  it('relays frames to the page and buttons back to the adapter', async () => {
    const server = new ScreenServer({ pipe: await pipePath('screen') });
    await server.listen();
    try {
      expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
      const page = await fetch(server.url);
      expect(await page.text()).toContain('<canvas');

      // the adapter side of the pipe
      const stream = new FrameStream();
      const pressed: number[] = [];
      stream.onInput = (mask) => pressed.push(mask);
      await stream.connect(server.pipe);
      await until(() => server.connected);

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
      const rgba = new Uint8Array(PIXELS).fill(9);
      stream.sendFrame(rgba, 42);
      const data = await received;
      const view = new DataView(data);
      expect(view.getUint32(0, true)).toBe(42);
      expect(view.getUint16(4, true)).toBe(240);
      expect(data.byteLength).toBe(8 + rgba.length);

      ws.send(JSON.stringify({ buttons: 0b101 }));
      await until(() => pressed.length > 0);
      expect(pressed).toEqual([0b101]);
      ws.close();
      stream.close();
    } finally {
      await server.close();
    }
  });

  it('lets only its own page connect: another origin is refused before it sees a frame', async () => {
    const server = new ScreenServer({ pipe: await pipePath('origin') });
    await server.listen();
    const sockets: Socket[] = [];
    try {
      const evil = await upgrade(server.port, 'http://evil.example');
      sockets.push(evil.socket);
      expect(evil.status).toBe('HTTP/1.1 403 Forbidden');
      await until(() => evil.socket.destroyed || evil.socket.readyState === 'closed');

      const stream = new FrameStream();
      await stream.connect(server.pipe);
      await until(() => server.connected);
      const frames = new Map<string, number>();
      for (const [name, origin] of [
        ['same', `http://127.0.0.1:${server.port}`],
        ['localhost', `http://localhost:${server.port}`],
        ['none', undefined],
      ] as const) {
        const ok = await upgrade(server.port, origin);
        sockets.push(ok.socket);
        expect(ok.status, name).toBe('HTTP/1.1 101 Switching Protocols');
        ok.socket.on('data', (chunk: Buffer) => frames.set(name, (frames.get(name) ?? 0) + chunk.length));
      }
      const wrongPort = await upgrade(server.port, `http://localhost:${server.port + 1}`);
      sockets.push(wrongPort.socket);
      expect(wrongPort.status).toBe('HTTP/1.1 403 Forbidden');
      stream.sendFrame(new Uint8Array(PIXELS), 1);
      await until(() => ['same', 'localhost', 'none'].every((n) => (frames.get(n) ?? 0) >= 8 + PIXELS));
      stream.close();
    } finally {
      for (const s of sockets) {
        s.destroy();
      }
      await server.close();
    }
  });

  it('joins a fragmented button message, and catches a page up with the newest frame once it drains', async () => {
    const server = new ScreenServer({ pipe: await pipePath('drain') });
    await server.listen();
    const stream = new FrameStream();
    let page: Socket | null = null;
    try {
      const pressed: number[] = [];
      stream.onInput = (mask) => pressed.push(mask);
      await stream.connect(server.pipe);
      await until(() => server.connected);
      ({ socket: page } = await upgrade(server.port));
      page.write(Buffer.concat([maskedFrame(Buffer.from('{"butt'), 1, false), maskedFrame(Buffer.from('ons":5}'), 0)]));
      await until(() => pressed.length > 0);
      expect(pressed).toEqual([5]);

      const seen: number[] = [];
      let pending: Buffer = Buffer.alloc(0);
      page.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        // server frames: a 10-byte header (length class 127) then the payload
        while (pending.length >= 10 + 8 + PIXELS) {
          seen.push(pending.readUInt32LE(10));
          pending = pending.subarray(10 + 8 + PIXELS);
        }
      });
      page.pause();
      for (let i = 1; i <= 30; i++) {
        stream.sendFrame(new Uint8Array(PIXELS), i);
        await wait(2);
      }
      stream.sendFrame(new Uint8Array(PIXELS), 999);
      await wait(20);
      page.resume();
      await until(() => seen.includes(999), 5000);
      expect(seen[seen.length - 1]).toBe(999);
      expect(seen.length).toBeLessThan(31);
    } finally {
      stream.close();
      page?.destroy();
      await server.close();
    }
  });

  it('honors the port it was given, and leaves nothing bound when that port is taken', async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const port = (taken.address() as { port: number }).port;
    const server = new ScreenServer({ pipe: await pipePath('busy'), port });
    try {
      await expect(server.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      // the pipe was released with the failure: it can be bound again
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(server.pipe, resolve);
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
    const free = new ScreenServer({ pipe: await pipePath('free'), port, host: '127.0.0.1' });
    await free.listen();
    try {
      expect(free.port).toBe(port);
      expect(free.url).toBe(`http://127.0.0.1:${port}/`);
    } finally {
      await free.close();
    }
  });
});
