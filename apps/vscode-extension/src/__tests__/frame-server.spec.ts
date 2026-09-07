/** The pipe server a process adapter streams into, driven by the adapter's own `FrameStream`. */
import { FrameStream, STREAM, newPipePath } from '@gba-kit/debug-adapter';
import { describe, expect, it } from 'vitest';

import { type FrameServer, serveFrames } from '../frame-server.js';

const PIXELS = new Uint8Array(STREAM.width * STREAM.height * 4);

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

async function serve(): Promise<{ server: FrameServer; pipe: string; frames: number[]; audio: number[] }> {
  const pipe = newPipePath('gba-kit-test');
  const frames: number[] = [];
  const audio: number[] = [];
  const server = await serveFrames(
    pipe,
    { frame: (_rgba, frame) => frames.push(frame), audio: (samples) => audio.push(samples.length) },
    () => {},
  );
  return { server, pipe, frames, audio };
}

describe('frame server', () => {
  it('feeds the sink from the adapter, and disposing drops the adapter so nothing more arrives', async () => {
    const { server, pipe, frames, audio } = await serve();
    const stream = new FrameStream();
    try {
      await stream.connect(pipe);
      stream.sendFrame(PIXELS, 1);
      stream.sendAudio(new Float32Array(4), 32768);
      await until(() => frames.length === 1 && audio.length === 1);
      expect(audio).toEqual([4]);

      server.dispose();
      await until(() => !stream.connected); // the adapter's socket was closed, not just the listener
      stream.sendFrame(PIXELS, 2);
      await wait(50);
      expect(frames).toEqual([1]);
    } finally {
      stream.close();
      server.dispose();
    }
  });

  it('takes the newest connection: an adapter that connects again replaces its earlier socket', async () => {
    const { server, pipe, frames } = await serve();
    const first = new FrameStream();
    const second = new FrameStream();
    try {
      await first.connect(pipe);
      first.sendFrame(PIXELS, 1);
      await until(() => frames.length === 1);
      await second.connect(pipe);
      await until(() => !first.connected);
      first.sendFrame(PIXELS, 2); // nowhere to go
      second.sendFrame(PIXELS, 3);
      await until(() => frames.length === 2);
      expect(frames).toEqual([1, 3]);
    } finally {
      first.close();
      second.close();
      server.dispose();
    }
  });
});
