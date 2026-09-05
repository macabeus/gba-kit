/**
 * A screen for editors that have none: a small HTTP server that serves a page
 * with the GBA display and a keyboard-driven gamepad, fed by the adapter's frame
 * stream. The page talks WebSocket to this server; this server owns the pipe the
 * adapter is told about with `gba-kit/stream`. Frames go down, button masks go
 * up. No dependencies: the WebSocket side is the few frames it needs.
 */
import { createHash } from 'node:crypto';
import { type Server as HttpServer, type IncomingMessage, createServer as createHttpServer } from 'node:http';
import { type Server, type Socket, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { STREAM } from './protocol.js';
import { StreamReader, encodeInput } from './stream.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A WebSocket frame from the server: unmasked, one fragment. */
export function encodeWebSocketFrame(payload: Uint8Array, opcode: 1 | 2 | 8 | 10 = 2): Buffer {
  const length = payload.byteLength;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Frames from a client (masked, as browsers send them). Returns the frames and what is left unparsed. */
export function decodeWebSocketFrames(buffer: Buffer): {
  frames: Array<{ opcode: number; payload: Buffer }>;
  rest: Buffer;
} {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) {
      break;
    }
    const opcode = buffer[offset]! & 0x0f;
    const masked = (buffer[offset + 1]! & 0x80) !== 0;
    let length = buffer[offset + 1]! & 0x7f;
    let p = offset + 2;
    if (length === 126) {
      if (buffer.length < p + 2) {
        break;
      }
      length = buffer.readUInt16BE(p);
      p += 2;
    } else if (length === 127) {
      if (buffer.length < p + 8) {
        break;
      }
      length = Number(buffer.readBigUInt64BE(p));
      p += 8;
    }
    const maskBytes = masked ? 4 : 0;
    if (buffer.length < p + maskBytes + length) {
      break;
    }
    const payload = Buffer.from(buffer.subarray(p + maskBytes, p + maskBytes + length));
    if (masked) {
      for (let i = 0; i < length; i++) {
        payload[i] = payload[i]! ^ buffer[p + (i & 3)]!;
      }
    }
    frames.push({ opcode, payload });
    offset = p + maskBytes + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export interface ScreenServerOptions {
  /** HTTP port for the page (0 picks one) */
  port?: number;
  /** the pipe the adapter connects to (default: a fresh path under the temp dir) */
  pipe?: string;
  host?: string;
}

export class ScreenServer {
  readonly pipe: string;
  readonly #http: HttpServer;
  readonly #pipeServer: Server;
  readonly #clients = new Set<Socket>();
  #adapter: Socket | null = null;
  #lastFrame: Buffer | null = null;
  #port = 0;

  constructor(options: ScreenServerOptions = {}) {
    this.pipe = options.pipe ?? defaultPipe();
    this.#http = createHttpServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(PAGE);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.#http.on('upgrade', (req, socket) => this.#upgrade(req, socket as Socket));
    this.#pipeServer = createServer((socket) => this.#adapterConnected(socket));
    void options.host;
  }

  get port(): number {
    return this.#port;
  }

  get url(): string {
    return `http://localhost:${this.#port}/`;
  }

  /** Whether the adapter is connected to the pipe. */
  get connected(): boolean {
    return this.#adapter !== null;
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#pipeServer.once('error', reject);
      this.#pipeServer.listen(this.pipe, () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(port, host, () => resolve());
    });
    const address = this.#http.address();
    this.#port = typeof address === 'object' && address ? address.port : port;
  }

  async close(): Promise<void> {
    for (const c of this.#clients) {
      c.destroy();
    }
    this.#adapter?.destroy();
    await Promise.all([
      new Promise<void>((resolve) => this.#http.close(() => resolve())),
      new Promise<void>((resolve) => this.#pipeServer.close(() => resolve())),
    ]);
  }

  #adapterConnected(socket: Socket): void {
    this.#adapter?.destroy();
    this.#adapter = socket;
    const reader = new StreamReader(
      (f) => {
        // the page gets the raw payload: u32 frame, u16 w, u16 h, RGBA
        const payload = Buffer.allocUnsafe(8 + f.rgba.byteLength);
        payload.writeUInt32LE(f.frame, 0);
        payload.writeUInt16LE(f.width, 4);
        payload.writeUInt16LE(f.height, 6);
        payload.set(f.rgba, 8);
        this.#lastFrame = encodeWebSocketFrame(payload);
        this.#broadcast(this.#lastFrame);
      },
      () => {},
    );
    socket.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.#adapter === socket) {
        this.#adapter = null;
      }
    });
  }

  #broadcast(frame: Buffer): void {
    for (const c of this.#clients) {
      if (c.writableLength < frame.length * 2) {
        c.write(frame);
      }
    }
  }

  #upgrade(req: IncomingMessage, socket: Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (req.url !== '/ws' || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.#clients.add(socket);
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const { frames, rest } = decodeWebSocketFrames(pending);
      pending = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 8) {
          socket.end(encodeWebSocketFrame(Buffer.alloc(0), 8));
        } else if (f.opcode === 9) {
          socket.write(encodeWebSocketFrame(f.payload, 10));
        } else if (f.opcode === 1) {
          this.#input(f.payload.toString('utf8'));
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.#clients.delete(socket));
    if (this.#lastFrame) {
      socket.write(this.#lastFrame);
    }
  }

  #input(text: string): void {
    try {
      const { buttons } = JSON.parse(text) as { buttons?: number };
      if (typeof buttons === 'number') {
        this.#adapter?.write(encodeInput(buttons));
      }
    } catch {
      // not ours
    }
  }
}

function defaultPipe(): string {
  const id = `gba-kit-screen-${process.pid}-${Date.now().toString(36)}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(tmpdir(), `${id}.sock`);
}

const PAGE = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GBA screen</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: #0f172a; color: #94a3b8; font: 13px ui-sans-serif, system-ui, sans-serif; }
  canvas { image-rendering: pixelated; width: min(96vw, calc((100vh - 80px) * 1.5)); aspect-ratio: 3 / 2; background: #000; outline: 2px solid transparent; border-radius: 4px; }
  canvas:focus { outline-color: #38bdf8; }
  #status { font-family: ui-monospace, monospace; }
  .hint { font-size: 11px; color: #64748b; }
</style>
</head>
<body>
<canvas id="c" width="${STREAM.width}" height="${STREAM.height}" tabindex="0"></canvas>
<div id="status">connecting…</div>
<div class="hint">Click the screen, then: arrows = D-pad · Z = A · X = B · Enter = Start · Backspace = Select · A = R · S = L</div>
<script>
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(${STREAM.width}, ${STREAM.height});
  const status = document.getElementById('status');
  const KEYS = { ArrowRight: 4, ArrowLeft: 5, ArrowUp: 6, ArrowDown: 7, z: 0, x: 1, Backspace: 2, Enter: 3, a: 8, s: 9 };
  let mask = 0;
  let ws = null;
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { status.textContent = 'connected · waiting for frames'; };
    ws.onmessage = (e) => {
      const view = new DataView(e.data);
      const frame = view.getUint32(0, true);
      image.data.set(new Uint8Array(e.data, 8, ${STREAM.width * STREAM.height * 4}));
      ctx.putImageData(image, 0, 0);
      status.textContent = 'frame ' + frame;
    };
    ws.onclose = () => { status.textContent = 'disconnected · retrying'; setTimeout(connect, 1000); };
  }
  function send() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ buttons: mask })); }
  function key(e, down) {
    const button = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (button === undefined) return;
    e.preventDefault();
    const next = down ? mask | (1 << button) : mask & ~(1 << button);
    if (next !== mask) { mask = next; send(); }
  }
  canvas.addEventListener('keydown', (e) => key(e, true));
  canvas.addEventListener('keyup', (e) => key(e, false));
  canvas.addEventListener('blur', () => { if (mask) { mask = 0; send(); } });
  connect();
</script>
</body>
</html>`;
