/**
 * A minimal DAP client for tests: drives a `GbaDebugSession` over in-memory
 * streams with the real wire framing, so what the tests see is what an editor
 * sees — responses, events, and their order.
 */
import type { DebugProtocol } from '@vscode/debugprotocol';
import { PassThrough } from 'node:stream';

import { GbaDebugSession } from '../session.js';

export type Message = DebugProtocol.ProtocolMessage & { type: 'response' | 'event'; seq: number };

export class DapClient {
  readonly adapter: GbaDebugSession;
  /** every message received, in order */
  readonly log: Message[] = [];
  readonly #input = new PassThrough();
  readonly #output = new PassThrough();
  readonly #pending = new Map<number, { resolve: (r: DebugProtocol.Response) => void }>();
  readonly #waiters: Array<{ match: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
  #seq = 1;
  #buffer = Buffer.alloc(0);

  constructor() {
    this.adapter = new GbaDebugSession();
    // A server-mode adapter does not exit the process on disconnect.
    this.adapter.setRunAsServer(true);
    this.#output.on('data', (chunk: Buffer) => this.#onData(chunk));
    this.adapter.start(this.#input, this.#output);
  }

  /** Send a request; resolves with its response (successful or not). */
  request<R extends DebugProtocol.Response = DebugProtocol.Response>(command: string, args?: unknown): Promise<R> {
    const seq = this.#seq++;
    const request: DebugProtocol.Request = { seq, type: 'request', command, arguments: args };
    const promise = new Promise<R>((resolve) =>
      this.#pending.set(seq, { resolve: resolve as (r: DebugProtocol.Response) => void }),
    );
    const json = JSON.stringify(request);
    this.#input.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    return promise;
  }

  /** A successful response's body; throws with the adapter's message otherwise. */
  async body<B>(command: string, args?: unknown): Promise<B> {
    const r = await this.request(command, args);
    if (!r.success) {
      throw new Error(`${command}: ${r.message ?? 'failed'}`);
    }
    return r.body as B;
  }

  /**
   * The first event named `event` (optionally matching `predicate`) at or after log
   * index `since`: one already received, or the next to come. Pass `log.length`
   * from before an action to wait for what that action causes.
   */
  event<E extends DebugProtocol.Event = DebugProtocol.Event>(
    event: string,
    predicate: (e: E) => boolean = () => true,
    timeoutMs = 10_000,
    since = 0,
  ): Promise<E> {
    const match = (m: Message): boolean =>
      m.type === 'event' && (m as DebugProtocol.Event).event === event && predicate(m as unknown as E);
    const received = this.log.slice(since).find(match);
    if (received) {
      return Promise.resolve(received as unknown as E);
    }
    return new Promise<E>((resolve, reject) => {
      const waiter = {
        match,
        resolve: (m: Message) => {
          clearTimeout(timer);
          resolve(m as unknown as E);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        reject(new Error(`no '${event}' event within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  /** Events of a kind received so far. */
  events<E extends DebugProtocol.Event = DebugProtocol.Event>(event: string): E[] {
    return this.log.filter(
      (m): m is Message & E => m.type === 'event' && (m as DebugProtocol.Event).event === event,
    ) as unknown as E[];
  }

  /** Text of every output event so far. */
  output(): string {
    return this.events<DebugProtocol.OutputEvent>('output')
      .map((e) => e.body.output)
      .join('');
  }

  /** The sequence of message kinds since `from`, for ordering assertions: 'response:next', 'event:stopped', ... */
  kinds(from = 0): string[] {
    return this.log
      .slice(from)
      .map((m) =>
        m.type === 'response'
          ? `response:${(m as DebugProtocol.Response).command}`
          : `event:${(m as DebugProtocol.Event).event}`,
      );
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const header = this.#buffer.subarray(0, headerEnd).toString('utf8');
      const length = Number(/Content-Length: (\d+)/.exec(header)?.[1]);
      const start = headerEnd + 4;
      if (this.#buffer.length < start + length) {
        return;
      }
      const message = JSON.parse(this.#buffer.subarray(start, start + length).toString('utf8')) as Message;
      this.#buffer = this.#buffer.subarray(start + length);
      this.#dispatch(message);
    }
  }

  #dispatch(message: Message): void {
    this.log.push(message);
    if (message.type === 'response') {
      const response = message as unknown as DebugProtocol.Response;
      this.#pending.get(response.request_seq)?.resolve(response);
      this.#pending.delete(response.request_seq);
    }
    // Waiters only see messages dispatched after they were registered; `event()` scans the log for earlier ones.
    for (let i = 0; i < this.#waiters.length; i++) {
      if (this.#waiters[i]!.match(message)) {
        const [w] = this.#waiters.splice(i, 1);
        w!.resolve(message);
        i--;
      }
    }
  }

  /** Wait for a stop after `action`, returning its event. */
  async stopAfter(action: () => Promise<unknown>): Promise<DebugProtocol.StoppedEvent> {
    const stopped = this.event<DebugProtocol.StoppedEvent>('stopped', () => true, 10_000, this.log.length);
    await action();
    return stopped;
  }
}
