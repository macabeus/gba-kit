/**
 * The frame/audio side channel: a pipe the client owns, which the adapter connects
 * to and writes framed messages into (see `STREAM` in protocol.ts). Frames never
 * travel over the DAP connection, which stays free for inspection. The pipe holds
 * about two frames unsent at most: past that, frames are dropped and counted, but
 * the newest is kept and written once the pipe drains — so a slow consumer sees
 * fresh frames late rather than every frame later, and the frame of a stop, which
 * is the newest, always arrives.
 */
import { type Socket, connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { STREAM } from './protocol.js';

/** Bytes the pipe may hold unsent before a frame or audio message is dropped: about two full frames. */
const MAX_BACKLOG = 2 * (STREAM.headerBytes + 8 + STREAM.width * STREAM.height * 4);

/**
 * A fresh path for a pipe a client can listen on and hand to `gba-kit/stream`: a
 * named pipe on Windows, a socket file under the temp dir elsewhere, unique to
 * this process and moment.
 */
export function newPipePath(prefix = 'gba-kit'): string {
  const id = `${prefix}-${process.pid}-${Date.now().toString(36)}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(tmpdir(), `${id}.sock`);
}

/** The largest message the stream carries (a frame); a longer length in a header is corruption. */
export const MAX_STREAM_MESSAGE = 8 + STREAM.width * STREAM.height * 4;

/** One message of the stream, framed. */
export function encodeStreamMessage(type: number, payload: Uint8Array): Buffer {
  const header = Buffer.allocUnsafe(STREAM.headerBytes);
  header.writeUInt16LE(STREAM.magic, 0);
  header.writeUInt8(type, 2);
  header.writeUInt8(0, 3);
  header.writeUInt32LE(payload.byteLength, 4);
  return Buffer.concat([header, payload]);
}

/** The message a client writes back to press buttons. */
export function encodeInput(mask: number): Buffer {
  const payload = Buffer.allocUnsafe(2);
  payload.writeUInt16LE(mask & 0x3ff, 0);
  return encodeStreamMessage(STREAM.input, payload);
}

export class FrameStream {
  #socket: Socket | null = null;
  /** a socket still connecting; superseded by a newer `connect` or a `close` */
  #pending: Socket | null = null;
  /** the newest frame that did not fit, written when the pipe drains */
  #held: Buffer | null = null;
  #dropped = 0;
  /** buttons the client pressed through the pipe */
  onInput: ((mask: number) => void) | null = null;

  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  /** How many frames were dropped because the pipe was slow (each replaced by a newer one). */
  get dropped(): number {
    return this.#dropped;
  }

  /**
   * Connect to the client's pipe. Resolves once connected; rejects if the pipe is
   * not there, or if a newer `connect` or a `close` came before this one connected.
   */
  connect(path: string): Promise<void> {
    this.close();
    return new Promise<void>((resolve, reject) => {
      const socket = connect(path);
      this.#pending = socket;
      let settled = false;
      const fail = (err: Error): void => {
        if (!settled) {
          settled = true;
          if (this.#pending === socket) {
            this.#pending = null;
          }
          reject(err);
        }
      };
      socket.once('error', fail);
      socket.once('close', () => fail(new Error('superseded: the stream was closed or reconnected first')));
      socket.once('connect', () => {
        if (this.#pending !== socket) {
          socket.destroy(); // a newer connect, or a close, came first: its 'close' rejects
          return;
        }
        settled = true;
        this.#pending = null;
        socket.removeAllListeners('error');
        socket.on('error', () => this.close());
        socket.on('close', () => {
          if (this.#socket === socket) {
            this.#socket = null;
            this.#held = null;
          }
        });
        socket.on('drain', () => this.#flush(socket));
        const reader = new StreamReader(
          () => {},
          () => {},
          (mask) => this.onInput?.(mask),
        );
        socket.on('data', (chunk: Buffer) => {
          try {
            reader.push(chunk);
          } catch {
            this.close();
          }
        });
        this.#socket = socket;
        resolve();
      });
    });
  }

  close(): void {
    this.#pending?.destroy();
    this.#pending = null;
    this.#socket?.destroy();
    this.#socket = null;
    this.#held = null;
  }

  /**
   * Send a frame. When the pipe already holds `MAX_BACKLOG` bytes unsent the
   * frame is held instead — replacing (and counting as dropped) an older held one —
   * and written once the pipe drains.
   */
  sendFrame(rgba: Uint8Array, frame: number): void {
    const socket = this.#socket;
    if (!socket) {
      return;
    }
    const payload = Buffer.allocUnsafe(8 + rgba.byteLength);
    payload.writeUInt32LE(frame >>> 0, 0);
    payload.writeUInt16LE(STREAM.width, 4);
    payload.writeUInt16LE(STREAM.height, 6);
    payload.set(rgba, 8);
    const message = encodeStreamMessage(STREAM.frame, payload);
    if (socket.writableLength > MAX_BACKLOG) {
      if (this.#held) {
        this.#dropped++;
      }
      this.#held = message;
      return;
    }
    socket.write(message);
  }

  /** Send audio. Dropped when the pipe is backed up: late audio is worse than none. */
  sendAudio(samples: Float32Array, sampleRate: number): void {
    const socket = this.#socket;
    if (!socket || socket.writableLength > MAX_BACKLOG) {
      return;
    }
    const payload = Buffer.allocUnsafe(4 + samples.byteLength);
    payload.writeUInt32LE(sampleRate, 0);
    payload.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 4);
    socket.write(encodeStreamMessage(STREAM.audio, payload));
  }

  /** The pipe drained: the held frame goes out now. */
  #flush(socket: Socket): void {
    const held = this.#held;
    if (held && this.#socket === socket) {
      this.#held = null;
      socket.write(held);
    }
  }
}

/** Parses the stream on the receiving side; what a client (or a test) feeds socket data into. */
export class StreamReader {
  #buffer = Buffer.alloc(0);

  constructor(
    readonly onFrame: (frame: { frame: number; width: number; height: number; rgba: Uint8Array }) => void,
    readonly onAudio: (audio: { sampleRate: number; samples: Float32Array }) => void = () => {},
    readonly onInput: (mask: number) => void = () => {},
  ) {}

  /**
   * Feed bytes from the pipe. Throws on a header that is not the stream's (a bad
   * magic, a length no message has) or a frame whose size is not its pixels': the
   * stream cannot be resynchronized, so the caller drops the connection.
   */
  push(chunk: Uint8Array): void {
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#buffer.length < STREAM.headerBytes) {
        return;
      }
      if (this.#buffer.readUInt16LE(0) !== STREAM.magic) {
        throw new Error('gba-kit stream: bad magic');
      }
      const type = this.#buffer.readUInt8(2);
      const length = this.#buffer.readUInt32LE(4);
      if (length > MAX_STREAM_MESSAGE) {
        throw new Error(`gba-kit stream: bad length ${length}`);
      }
      if (this.#buffer.length < STREAM.headerBytes + length) {
        return;
      }
      const payload = this.#buffer.subarray(STREAM.headerBytes, STREAM.headerBytes + length);
      this.#buffer = this.#buffer.subarray(STREAM.headerBytes + length);
      if (type === STREAM.frame) {
        if (payload.length < 8) {
          throw new Error('gba-kit stream: bad frame');
        }
        const width = payload.readUInt16LE(4);
        const height = payload.readUInt16LE(6);
        const rgba = payload.subarray(8);
        if (rgba.length !== width * height * 4) {
          throw new Error(`gba-kit stream: bad frame: ${width}×${height} with ${rgba.length} bytes`);
        }
        this.onFrame({ frame: payload.readUInt32LE(0), width, height, rgba: new Uint8Array(rgba) });
      } else if (type === STREAM.audio) {
        const bytes = payload.subarray(4);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        this.onAudio({ sampleRate: payload.readUInt32LE(0), samples: new Float32Array(copy.buffer) });
      } else if (type === STREAM.input && payload.length >= 2) {
        this.onInput(payload.readUInt16LE(0));
      }
    }
  }
}
