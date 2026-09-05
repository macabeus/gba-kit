/**
 * The adapter as another editor sees it: a child process on stdio, driven with
 * hand-framed DAP messages. The first "second client", so a VS Code-only
 * assumption shows up here before it does in a real editor.
 */
import type { DebugProtocol } from '@vscode/debugprotocol';
import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', '..');
const fixtures = join(pkg, '..', 'debug-core', 'test-fixtures');

class StdioClient {
  readonly child: ChildProcess;
  readonly messages: DebugProtocol.ProtocolMessage[] = [];
  #seq = 1;
  #buffer = Buffer.alloc(0);
  #waiters: Array<{
    match: (m: DebugProtocol.ProtocolMessage) => boolean;
    resolve: (m: DebugProtocol.ProtocolMessage) => void;
  }> = [];

  constructor() {
    // tsx resolves the `.js` imports of the TypeScript sources, so no build is needed
    this.child = spawn(process.execPath, ['--import', 'tsx', join(pkg, 'src', 'cli.ts')], {
      cwd: pkg,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child.stdout!.on('data', (chunk: Buffer) => this.#onData(chunk));
  }

  send(command: string, args?: unknown): Promise<DebugProtocol.Response> {
    const seq = this.#seq++;
    const json = JSON.stringify({ seq, type: 'request', command, arguments: args });
    this.child.stdin!.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
    return this.wait(
      (m) => m.type === 'response' && (m as DebugProtocol.Response).request_seq === seq,
    ) as Promise<DebugProtocol.Response>;
  }

  wait(
    match: (m: DebugProtocol.ProtocolMessage) => boolean,
    timeoutMs = 15_000,
  ): Promise<DebugProtocol.ProtocolMessage> {
    const found = this.messages.find(match);
    if (found) {
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeoutMs);
      this.#waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  event(name: string, after = 0): Promise<DebugProtocol.Event> {
    let seen = 0;
    return this.wait(
      (m) => m.type === 'event' && (m as DebugProtocol.Event).event === name && seen++ >= after,
    ) as Promise<DebugProtocol.Event>;
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const end = this.#buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        return;
      }
      const length = Number(/Content-Length: (\d+)/.exec(this.#buffer.subarray(0, end).toString())?.[1]);
      if (this.#buffer.length < end + 4 + length) {
        return;
      }
      const message = JSON.parse(
        this.#buffer.subarray(end + 4, end + 4 + length).toString(),
      ) as DebugProtocol.ProtocolMessage;
      this.#buffer = this.#buffer.subarray(end + 4 + length);
      this.messages.push(message);
      this.#waiters = this.#waiters.filter((w) => {
        if (w.match(message)) {
          w.resolve(message);
          return false;
        }
        return true;
      });
    }
  }
}

let client: StdioClient | null = null;

afterEach(() => {
  client?.child.kill();
  client = null;
});

describe('the adapter as a process', () => {
  it('debugs the fixture over stdio, and exits when the client disconnects', async () => {
    client = new StdioClient();
    const init = await client.send('initialize', { adapterID: 'gba-kit', pathFormat: 'path', linesStartAt1: true });
    expect(init.success).toBe(true);
    expect((init.body as DebugProtocol.Capabilities).supportsStepBack).toBe(true);

    const launch = client.send('launch', {
      rom: join(fixtures, 'build', 'thumb-O0.gba'),
      elf: join(fixtures, 'build', 'thumb-O0.elf'),
      cwd: fixtures,
      stopOnEntry: true,
    });
    await client.event('initialized');
    const bps = await client.send('setFunctionBreakpoints', { breakpoints: [{ name: 'add_bonus' }] });
    expect((bps.body as DebugProtocol.SetFunctionBreakpointsResponse['body']).breakpoints[0]!.verified).toBe(true);
    await client.send('configurationDone');
    expect((await launch).success).toBe(true);
    const entry = await client.event('stopped');
    expect((entry.body as { reason: string }).reason).toBe('entry');

    await client.send('continue', { threadId: 1 });
    const hit = await client.event('stopped', 1);
    expect((hit.body as { reason: string }).reason).toBe('function breakpoint');
    const stack = await client.send('stackTrace', { threadId: 1 });
    expect((stack.body as DebugProtocol.StackTraceResponse['body']).stackFrames.map((f) => f.name)).toEqual([
      'add_bonus',
      'update',
      'main',
    ]);
    const state = await client.send('gba-kit/state');
    expect((state.body as { state: string }).state).toBe('stopped');

    const exited = new Promise<number | null>((resolve) => client!.child.once('exit', resolve));
    expect((await client.send('disconnect')).success).toBe(true);
    expect(await exited).toBe(0);
  });
});
