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

import { STREAM } from './protocol.js';
import { StreamReader, encodeInput, newPipePath } from './stream.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** The page only ever sends a short JSON button mask, a ping or a close: anything longer is not the page. */
export const MAX_WS_PAYLOAD = 64 * 1024;
/** Frames a page may hold unread before further frames are skipped (it gets the newest once it drains). */
const BROADCAST_BACKLOG_FRAMES = 2;

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

export interface WebSocketFrame {
  opcode: number;
  /** the last fragment of its message (a continuation has opcode 0) */
  fin: boolean;
  payload: Buffer;
}

/**
 * Frames from a client, which a browser masks (RFC 6455 requires it: an unmasked
 * frame, or one longer than `MAX_WS_PAYLOAD`, throws so the caller can drop the
 * connection). Returns the complete frames and what is left unparsed.
 */
export function decodeWebSocketFrames(buffer: Buffer): { frames: WebSocketFrame[]; rest: Buffer } {
  const frames: WebSocketFrame[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) {
      break;
    }
    const fin = (buffer[offset]! & 0x80) !== 0;
    const opcode = buffer[offset]! & 0x0f;
    const masked = (buffer[offset + 1]! & 0x80) !== 0;
    if (!masked) {
      throw new Error('websocket: unmasked client frame');
    }
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
    if (length > MAX_WS_PAYLOAD) {
      throw new Error(`websocket: frame of ${length} bytes`);
    }
    if (buffer.length < p + 4 + length) {
      break;
    }
    const payload = Buffer.from(buffer.subarray(p + 4, p + 4 + length));
    for (let i = 0; i < length; i++) {
      payload[i] = payload[i]! ^ buffer[p + (i & 3)]!;
    }
    frames.push({ opcode, fin, payload });
    offset = p + 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export interface ScreenServerOptions {
  /** HTTP port for the page (default 0: pick one); `listen` may name another */
  port?: number;
  /** the pipe the adapter connects to (default: a fresh path under the temp dir) */
  pipe?: string;
  /** the address the page is served on (default `127.0.0.1`: this machine's browsers only) */
  host?: string;
}

export class ScreenServer {
  readonly pipe: string;
  readonly #http: HttpServer;
  readonly #pipeServer: Server;
  readonly #clients = new Set<Socket>();
  /** pages whose socket is full: they get the newest frame once they drain */
  readonly #behind = new Set<Socket>();
  #adapter: Socket | null = null;
  #lastFrame: Buffer | null = null;
  readonly #defaultPort: number;
  #host: string;
  #port = 0;

  constructor(options: ScreenServerOptions = {}) {
    this.pipe = options.pipe ?? newPipePath('gba-kit-screen');
    this.#defaultPort = options.port ?? 0;
    this.#host = options.host ?? '127.0.0.1';
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
    // A server's error after `listen` (an accept failing) must not take the process down.
    this.#http.on('error', () => {});
    this.#pipeServer.on('error', () => {});
  }

  get port(): number {
    return this.#port;
  }

  /** Where the page is, on the host it was bound to (`localhost` for a wildcard). */
  get url(): string {
    const host = this.#host === '0.0.0.0' || this.#host === '::' ? 'localhost' : this.#host;
    return `http://${host.includes(':') ? `[${host}]` : host}:${this.#port}/`;
  }

  /** Whether the adapter is connected to the pipe. */
  get connected(): boolean {
    return this.#adapter !== null;
  }

  /** Bind the pipe and the HTTP server; when the latter fails (a port in use) nothing stays bound. */
  async listen(port = this.#defaultPort, host = this.#host): Promise<void> {
    this.#host = host;
    await bind(this.#pipeServer, (server) => server.listen(this.pipe));
    try {
      await bind(this.#http, (server) => server.listen(port, host));
    } catch (err) {
      await new Promise<void>((resolve) => this.#pipeServer.close(() => resolve()));
      throw err;
    }
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

  /** Every page gets the frame, except one that has not read the last few: it is caught up once it drains. */
  #broadcast(frame: Buffer): void {
    for (const c of this.#clients) {
      if (c.writableLength < frame.length * BROADCAST_BACKLOG_FRAMES) {
        c.write(frame);
      } else {
        this.#behind.add(c);
      }
    }
  }

  /**
   * The WebSocket handshake. A browser page may only connect from this server's
   * own origin: any other page open in the same browser could otherwise watch the
   * screen and press buttons. A client without an `Origin` is not a browser.
   */
  #upgrade(req: IncomingMessage, socket: Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (req.url !== '/ws' || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    if (!this.#sameOrigin(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.#clients.add(socket);
    let pending: Buffer = Buffer.alloc(0);
    // a message split over fragments: its first opcode and the pieces so far
    let fragments: { opcode: number; parts: Buffer[] } | null = null;
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let frames: WebSocketFrame[];
      try {
        if (pending.length > MAX_WS_PAYLOAD + 14) {
          throw new Error('websocket: too much unparsed data');
        }
        ({ frames, rest: pending } = decodeWebSocketFrames(pending));
        pending = Buffer.from(pending);
      } catch {
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.opcode === 8) {
          socket.end(encodeWebSocketFrame(Buffer.alloc(0), 8));
        } else if (f.opcode === 9) {
          socket.write(encodeWebSocketFrame(f.payload, 10));
        } else if (f.opcode === 1 || f.opcode === 2 || f.opcode === 0) {
          if (f.opcode !== 0) {
            fragments = { opcode: f.opcode, parts: [] };
          }
          if (!fragments) {
            continue; // a continuation of nothing
          }
          fragments.parts.push(f.payload);
          if (f.fin) {
            if (fragments.opcode === 1) {
              this.#input(Buffer.concat(fragments.parts).toString('utf8'));
            }
            fragments = null;
          }
        }
      }
    });
    socket.on('drain', () => {
      if (this.#behind.delete(socket) && this.#lastFrame) {
        socket.write(this.#lastFrame);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.#clients.delete(socket);
      this.#behind.delete(socket);
    });
    if (this.#lastFrame) {
      socket.write(this.#lastFrame);
    }
  }

  #sameOrigin(origin: string | undefined): boolean {
    if (origin === undefined) {
      return true;
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    const local = new Set(['localhost', '127.0.0.1', '[::1]', this.#host]);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return local.has(url.hostname) && port === String(this.#port);
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

/** `listen` as a promise whose rejection listener does not outlive the bind. */
function bind<S extends HttpServer | Server>(server: S, listen: (server: S) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    listen(server);
  });
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
  const PIXEL_BYTES = ${STREAM.width * STREAM.height * 4};
  let mask = 0;
  let ws = null;
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { status.textContent = 'connected · waiting for frames'; };
    ws.onmessage = (e) => {
      if (e.data.byteLength < 8 + PIXEL_BYTES) return; // not a whole frame
      const view = new DataView(e.data);
      const frame = view.getUint32(0, true);
      image.data.set(new Uint8Array(e.data, 8, PIXEL_BYTES));
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
