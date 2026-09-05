/**
 * The frame/audio side channel: a pipe the client owns, which the adapter connects
 * to and writes framed messages into (see `STREAM` in protocol.ts). Frames never
 * travel over the DAP connection, which stays free for inspection; one pending
 * frame at a time, so a slow consumer sees a fresh frame late rather than every
 * frame later.
 */
import { type Socket, connect } from 'node:net';

import { STREAM } from './protocol.js';

/** A frame's payload is larger than this many bytes of backlog: drop it instead of queueing. */
const MAX_BACKLOG = 2 * (STREAM.headerBytes + 8 + STREAM.width * STREAM.height * 4);

export class FrameStream {
  #socket: Socket | null = null;
  #connecting: Promise<void> | null = null;
  #dropped = 0;

  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  /** How many frames were dropped because the pipe was slow (a client can show it). */
  get dropped(): number {
    return this.#dropped;
  }

  /** Connect to the client's pipe. Resolves once connected; rejects if the pipe is not there. */
  connect(path: string): Promise<void> {
    this.close();
    this.#connecting = new Promise<void>((resolve, reject) => {
      const socket = connect(path);
      socket.once('connect', () => {
        socket.removeListener('error', reject);
        socket.on('error', () => this.close());
        socket.on('close', () => {
          if (this.#socket === socket) {
            this.#socket = null;
          }
        });
        this.#socket = socket;
        resolve();
      });
      socket.once('error', reject);
    });
    return this.#connecting;
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }

  /** Send a frame. Skipped when the pipe already holds an unsent frame. */
  sendFrame(rgba: Uint8Array, frame: number): void {
    const socket = this.#socket;
    if (!socket) {
      return;
    }
    if (socket.writableLength > MAX_BACKLOG) {
      this.#dropped++;
      return;
    }
    const payload = Buffer.allocUnsafe(8 + rgba.byteLength);
    payload.writeUInt32LE(frame >>> 0, 0);
    payload.writeUInt16LE(STREAM.width, 4);
    payload.writeUInt16LE(STREAM.height, 6);
    payload.set(rgba, 8);
    this.#write(STREAM.frame, payload);
  }

  sendAudio(samples: Float32Array, sampleRate: number): void {
    const socket = this.#socket;
    if (!socket || socket.writableLength > MAX_BACKLOG) {
      return;
    }
    const payload = Buffer.allocUnsafe(4 + samples.byteLength);
    payload.writeUInt32LE(sampleRate, 0);
    payload.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 4);
    this.#write(STREAM.audio, payload);
  }

  #write(type: number, payload: Buffer): void {
    const header = Buffer.allocUnsafe(STREAM.headerBytes);
    header.writeUInt16LE(STREAM.magic, 0);
    header.writeUInt8(type, 2);
    header.writeUInt8(0, 3);
    header.writeUInt32LE(payload.byteLength, 4);
    this.#socket?.write(Buffer.concat([header, payload]));
  }
}

/** Parses the stream on the receiving side; what a client (or a test) feeds socket data into. */
export class StreamReader {
  #buffer = Buffer.alloc(0);

  constructor(
    readonly onFrame: (frame: { frame: number; width: number; height: number; rgba: Uint8Array }) => void,
    readonly onAudio: (audio: { sampleRate: number; samples: Float32Array }) => void = () => {},
  ) {}

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
      if (this.#buffer.length < STREAM.headerBytes + length) {
        return;
      }
      const payload = this.#buffer.subarray(STREAM.headerBytes, STREAM.headerBytes + length);
      this.#buffer = this.#buffer.subarray(STREAM.headerBytes + length);
      if (type === STREAM.frame) {
        this.onFrame({
          frame: payload.readUInt32LE(0),
          width: payload.readUInt16LE(4),
          height: payload.readUInt16LE(6),
          rgba: new Uint8Array(payload.subarray(8)),
        });
      } else if (type === STREAM.audio) {
        const bytes = payload.subarray(4);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        this.onAudio({ sampleRate: payload.readUInt32LE(0), samples: new Float32Array(copy.buffer) });
      }
    }
  }
}
