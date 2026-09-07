/**
 * Plays the interleaved stereo samples the emulator produces. An `AudioWorklet`
 * fed from a queue of sample chunks, created on the first user gesture (browsers
 * require one); a `ScriptProcessorNode` when worklets are unavailable (a strict
 * CSP). The queue holds about 100 ms: enough to ride out a slow frame, little
 * enough that a button press is heard promptly.
 */
const WORKLET_SOURCE = `
class GbaKitPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.queue = []; this.offset = 0; return; }
      this.queue.push(e.data);
      // keep at most ~100 ms queued: drop the oldest when the host outruns us
      let total = 0;
      for (const q of this.queue) total += q.length / 2;
      while (total > sampleRate / 10 && this.queue.length > 1) total -= this.queue.shift().length / 2;
    };
  }
  process(_inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] ?? left;
    for (let i = 0; i < left.length; i++) {
      const chunk = this.queue[0];
      if (!chunk) { left[i] = 0; right[i] = 0; continue; }
      left[i] = chunk[this.offset];
      right[i] = chunk[this.offset + 1];
      this.offset += 2;
      if (this.offset >= chunk.length) { this.queue.shift(); this.offset = 0; }
    }
    return true;
  }
}
registerProcessor('gba-kit-player', GbaKitPlayer);
`;

export class AudioPlayer {
  #context: AudioContext | null = null;
  #worklet: AudioWorkletNode | null = null;
  #fallback: ScriptProcessorNode | null = null;
  #queue: Float32Array[] = [];
  #offset = 0;
  /** resolves once the graph exists; the same promise for every `start` until `close` */
  #ready: Promise<void> | null = null;
  /** bumped by `close`, so a graph still being built for a closed context is abandoned */
  #generation = 0;
  #muted = false;

  get enabled(): boolean {
    return this.#context !== null && !this.#muted;
  }

  /**
   * Create the audio graph (call from a user gesture), or resume it after `mute`.
   * Resolves once samples pushed will be heard; concurrent calls share the build.
   */
  start(sampleRate: number): Promise<void> {
    this.#muted = false;
    const generation = this.#generation;
    this.#ready ??= this.#build(sampleRate, generation);
    return this.#ready.then(() => {
      // resume undoes mute()'s suspend; after a close() there is nothing to resume
      if (this.#generation === generation && this.#context && !this.#muted) {
        return this.#context.resume();
      }
    });
  }

  async #build(sampleRate: number, generation: number): Promise<void> {
    const context = new AudioContext({ sampleRate });
    this.#context = context;
    const abandoned = (): boolean => this.#generation !== generation;
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (abandoned()) {
        return;
      }
      const node = new AudioWorkletNode(context, 'gba-kit-player', { outputChannelCount: [2] });
      node.connect(context.destination);
      this.#worklet = node;
    } catch (err) {
      if (abandoned()) {
        return;
      }
      // the fallback plays, with more latency: say so, since a CSP that refuses the worklet is the usual cause
      console.warn('gba-kit: AudioWorklet unavailable, playing through a ScriptProcessorNode', err);
      const node = context.createScriptProcessor(2048, 0, 2);
      node.onaudioprocess = (e) => this.#fill(e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1));
      node.connect(context.destination);
      this.#fallback = node;
    }
  }

  /** Silence now: what is queued is dropped, so nothing stale plays on the next `start`. */
  mute(): void {
    this.#muted = true;
    this.#queue = [];
    this.#offset = 0;
    this.#worklet?.port.postMessage('flush');
    void this.#context?.suspend().catch(() => {});
  }

  push(samples: Float32Array): void {
    if (!this.#context || this.#muted) {
      return;
    }
    if (this.#worklet) {
      const copy = samples.slice();
      this.#worklet.port.postMessage(copy, [copy.buffer]);
    } else if (this.#fallback) {
      this.#queue.push(samples.slice());
      let total = 0;
      for (const q of this.#queue) {
        total += q.length / 2;
      }
      while (total > this.#context.sampleRate / 10 && this.#queue.length > 1) {
        total -= this.#queue.shift()!.length / 2;
      }
    }
  }

  #fill(left: Float32Array, right: Float32Array): void {
    for (let i = 0; i < left.length; i++) {
      const chunk = this.#queue[0];
      if (!chunk) {
        left[i] = 0;
        right[i] = 0;
        continue;
      }
      left[i] = chunk[this.#offset]!;
      right[i] = chunk[this.#offset + 1]!;
      this.#offset += 2;
      if (this.#offset >= chunk.length) {
        this.#queue.shift();
        this.#offset = 0;
      }
    }
  }

  /** Tear the graph down; a build still in flight for it stops short of touching the closed context. */
  close(): void {
    this.#generation++;
    this.#worklet?.disconnect();
    this.#fallback?.disconnect();
    void this.#context?.close().catch(() => {});
    this.#context = null;
    this.#worklet = null;
    this.#fallback = null;
    this.#ready = null;
    this.#queue = [];
    this.#offset = 0;
  }
}
