/**
 * The extension's end of a process adapter's frame stream: a pipe server the
 * adapter is told about with `gba-kit/stream`, whose frames and audio go to a
 * sink. No VS Code types in it, so a `FrameStream` client can test it.
 */
import { StreamReader } from '@gba-kit/debug-adapter';
import { type Socket, createServer } from 'node:net';

export interface FrameSink {
  frame(rgba: Uint8Array, frame: number): void;
  audio(samples: Float32Array, sampleRate: number): void;
}

export interface FrameServer {
  /** Stop listening and drop the adapter's connection: nothing it still writes reaches the sink. */
  dispose(): void;
}

/**
 * Listen on `pipe` and feed the sink from one adapter at a time: a newer
 * connection (the adapter told to stream again, say with audio now) replaces
 * the one before it, whose socket is dropped so its frames never interleave.
 */
export function serveFrames(pipe: string, sink: FrameSink, onError: (message: string) => void): Promise<FrameServer> {
  let live: Socket | null = null;
  const server = createServer((socket) => {
    live?.destroy();
    live = socket;
    const reader = new StreamReader(
      (f) => sink.frame(f.rgba, f.frame),
      (a) => sink.audio(a.samples, a.sampleRate),
    );
    socket.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk);
      } catch (err) {
        onError((err as Error).message);
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (live === socket) {
        live = null;
      }
    });
  });
  return new Promise((resolve, reject) => {
    const onListenError = (err: Error): void => reject(err);
    server.once('error', onListenError);
    server.listen(pipe, () => {
      server.removeListener('error', onListenError);
      // an error after the bind (an accept failing) must not take the extension host down
      server.on('error', () => {});
      resolve({
        dispose: () => {
          live?.destroy();
          live = null;
          server.close();
        },
      });
    });
  });
}
