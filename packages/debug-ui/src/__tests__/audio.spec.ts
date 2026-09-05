/**
 * The audio player against a stand-in Web Audio API: what happens to a graph
 * still being built when the player is closed, muted, or started again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioPlayer } from '../audio.js';

class FakeContext {
  static all: FakeContext[] = [];
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly destination = {};
  readonly log: string[] = [];
  resolveModule: () => void = () => {};
  readonly audioWorklet = {
    addModule: (): Promise<void> => new Promise<void>((resolve) => (this.resolveModule = resolve)),
  };

  constructor(readonly options: { sampleRate: number }) {
    FakeContext.all.push(this);
  }

  get sampleRate(): number {
    return this.options.sampleRate;
  }

  resume(): Promise<void> {
    if (this.state === 'closed') {
      return Promise.reject(new Error('resume on a closed context'));
    }
    this.state = 'running';
    this.log.push('resume');
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    if (this.state === 'closed') {
      return Promise.reject(new Error('suspend on a closed context'));
    }
    this.state = 'suspended';
    this.log.push('suspend');
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    this.log.push('close');
    return Promise.resolve();
  }

  createScriptProcessor(): never {
    throw new Error('no fallback in this test');
  }
}

class FakeWorkletNode {
  static all: FakeWorkletNode[] = [];
  readonly port = { postMessage: vi.fn() };
  connected = false;

  constructor(readonly context: FakeContext) {
    if (context.state === 'closed') {
      throw new Error('node on a closed context');
    }
    FakeWorkletNode.all.push(this);
  }

  connect(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('audio player', () => {
  beforeEach(() => {
    FakeContext.all = [];
    FakeWorkletNode.all = [];
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a close during the build abandons it: no node on the closed context, and start settles', async () => {
    const player = new AudioPlayer();
    const started = player.start(32768);
    const [context] = FakeContext.all;
    player.close();
    context!.resolveModule();
    await expect(started).resolves.toBeUndefined();
    await tick();
    expect(FakeWorkletNode.all).toEqual([]);
    expect(context!.log).toEqual(['close']);
    expect(player.enabled).toBe(false);
  });

  it('a start after a close builds a second graph; pushes go there once it is ready', async () => {
    const player = new AudioPlayer();
    const first = player.start(32768);
    player.close();
    const second = player.start(32768);
    expect(FakeContext.all.length).toBe(2);
    FakeContext.all[1]!.resolveModule();
    FakeContext.all[0]!.resolveModule();
    await Promise.all([first, second]);
    expect(FakeWorkletNode.all.length).toBe(1);
    expect(FakeWorkletNode.all[0]!.context).toBe(FakeContext.all[1]);
    expect(FakeContext.all[1]!.state).toBe('running');
    player.push(new Float32Array([0.1, 0.2]));
    expect(FakeWorkletNode.all[0]!.port.postMessage).toHaveBeenCalledTimes(1);
  });

  it('concurrent starts share one build, and a push after either resolves is heard', async () => {
    const player = new AudioPlayer();
    const a = player.start(32768);
    const b = player.start(32768);
    expect(FakeContext.all.length).toBe(1);
    player.push(new Float32Array(2)); // before the graph exists: dropped, not queued for later
    FakeContext.all[0]!.resolveModule();
    await b;
    player.push(new Float32Array([0.5, 0.5]));
    await a;
    expect(FakeWorkletNode.all.length).toBe(1);
    expect(FakeWorkletNode.all[0]!.port.postMessage).toHaveBeenCalledTimes(1);
  });

  it('mute flushes what the worklet holds and suspends; start resumes without rebuilding', async () => {
    const player = new AudioPlayer();
    const started = player.start(32768);
    FakeContext.all[0]!.resolveModule();
    await started;
    const node = FakeWorkletNode.all[0]!;
    player.mute();
    expect(node.port.postMessage).toHaveBeenCalledWith('flush');
    expect(player.enabled).toBe(false);
    player.push(new Float32Array(2));
    expect(node.port.postMessage).toHaveBeenCalledTimes(1); // muted: nothing more posted
    await player.start(32768);
    expect(FakeContext.all.length).toBe(1);
    expect(FakeContext.all[0]!.log).toEqual(['resume', 'suspend', 'resume']);
    expect(player.enabled).toBe(true);
  });

  it('a mute during the build leaves the graph suspended when it is ready', async () => {
    const player = new AudioPlayer();
    const started = player.start(32768);
    player.mute();
    FakeContext.all[0]!.resolveModule();
    await started;
    expect(FakeContext.all[0]!.state).toBe('suspended');
    expect(FakeWorkletNode.all.length).toBe(1); // built all the same, ready for the next start
  });
});
