/**
 * Runs inside the Extension Development Host: start a gba-kit debug session on
 * the fixture ROM, hit a source breakpoint, inspect the stack through VS Code's
 * debug API, step a frame, open the panels, stop. What the headless DAP suite
 * cannot see: VS Code's own bookkeeping of the session and its custom events.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

function lineOf(file: string, snippet: string): number {
  const index = readFileSync(file, 'utf8')
    .split('\n')
    .findIndex((l) => l.includes(snippet));
  assert.ok(index >= 0, `no line containing ${snippet}`);
  return index + 1;
}

function waitFor<T>(
  what: string,
  subscribe: (resolve: (value: T) => void) => vscode.Disposable,
  timeoutMs = 20_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      reject(new Error(`timed out waiting for ${what}`));
    }, timeoutMs);
    const disposable = subscribe((value) => {
      clearTimeout(timer);
      disposable.dispose();
      resolve(value);
    });
  });
}

/** The next `gba-kit/state` event whose body satisfies `predicate`. */
function nextState(
  session: vscode.DebugSession,
  predicate: (body: Record<string, unknown>) => boolean,
  what: string,
): Promise<Record<string, unknown>> {
  return waitFor(what, (resolve) =>
    vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
      if (e.session.id === session.id && e.event === 'gba-kit/state' && predicate(e.body)) {
        resolve(e.body);
      }
    }),
  );
}

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the fixtures folder is the workspace');
  const fixtures = folder.uri.fsPath;
  const main = path.join(fixtures, 'source', 'main.c');
  const line = lineOf(main, 'draw();');

  // every DAP message between VS Code and the adapter, for assertions and for the failure report
  const traffic: Array<{ dir: '→' | '←'; message: Record<string, unknown> }> = [];
  vscode.debug.registerDebugAdapterTrackerFactory('gba-kit', {
    createDebugAdapterTracker: () => ({
      onWillReceiveMessage: (m: Record<string, unknown>) => traffic.push({ dir: '→', message: m }),
      onDidSendMessage: (m: Record<string, unknown>) => traffic.push({ dir: '←', message: m }),
    }),
  });
  const report = (): string =>
    traffic
      .slice(-30)
      .map((t) => `${t.dir} ${JSON.stringify(t.message).slice(0, 300)}`)
      .join('\n');

  // a breakpoint set before the session starts, the way a user leaves them
  vscode.debug.addBreakpoints([
    new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(main), new vscode.Position(line - 1, 0))),
  ]);

  const started = waitFor<vscode.DebugSession>('the session to start', (resolve) =>
    vscode.debug.onDidStartDebugSession((s) => s.type === 'gba-kit' && resolve(s)),
  );
  const ok = await vscode.debug.startDebugging(folder, {
    type: 'gba-kit',
    request: 'launch',
    name: 'fixture',
    rom: path.join(fixtures, 'build', 'thumb-O0.gba'),
    elf: path.join(fixtures, 'build', 'thumb-O0.elf'),
    cwd: fixtures,
    stopOnEntry: true,
  });
  assert.equal(ok, true, 'startDebugging');
  const session = await started;

  const entry = await nextState(session, (b) => b.state === 'stopped', 'the entry stop');
  assert.equal(entry.pc, 0x08000000);

  // VS Code sent our breakpoint during configuration, and the adapter verified it on the line asked
  const verified = traffic.find(
    (t) =>
      t.dir === '←' &&
      t.message.command === 'setBreakpoints' &&
      (
        (t.message.body as { breakpoints?: Array<{ verified: boolean; line?: number }> } | undefined)?.breakpoints ?? []
      ).some((b) => b.verified && b.line === line),
  );
  assert.ok(verified, `the breakpoint on main.c:${line} was not verified\n${report()}`);

  const hit = nextState(session, (b) => b.state === 'stopped' && (b.pc as number) !== 0x08000000, 'the breakpoint');
  await session.customRequest('continue', { threadId: 1 });
  const stopped = await hit.catch((err: Error) => {
    throw new Error(`${err.message}\n${report()}`);
  });
  const stack = (await session.customRequest('stackTrace', { threadId: 1 })) as {
    stackFrames: Array<{ name: string; line: number; source?: { path: string } }>;
  };
  assert.equal(stack.stackFrames[0]!.name, 'main');
  assert.equal(stack.stackFrames[0]!.line, line);
  assert.equal(stack.stackFrames[0]!.source!.path, main);

  // scopes and a DWARF value, through VS Code's request plumbing
  const scopes = (await session.customRequest('scopes', { frameId: 0 })) as {
    scopes: Array<{ name: string; variablesReference: number }>;
  };
  const globals = scopes.scopes.find((s) => s.name.startsWith('Globals'));
  assert.ok(globals, 'a Globals scope');
  const variables = (await session.customRequest('variables', { variablesReference: globals.variablesReference })) as {
    variables: Array<{ name: string; type?: string }>;
  };
  assert.equal(variables.variables.find((v) => v.name === 'g_player')?.type, 'struct Player');

  // an emulator-time step through the extension's command
  const frameBefore = stopped.frame as number;
  const stepped = nextState(
    session,
    (b) => b.state === 'stopped' && (b.frame as number) === frameBefore + 1,
    'the frame step',
  );
  await vscode.commands.executeCommand('gba-kit.stepFrame');
  await stepped;

  // the panels open (their contents run in a webview the test cannot read)
  await vscode.commands.executeCommand('gba-kit.showScreen');
  await vscode.commands.executeCommand('gba-kit.showTools');
  const screen = (await session.customRequest('gba-kit/frame')) as { rgba: string };
  assert.equal(Buffer.from(screen.rgba, 'base64').length, 240 * 160 * 4);

  const ended = waitFor<void>('the session to end', (resolve) =>
    vscode.debug.onDidTerminateDebugSession((s) => s.id === session.id && resolve()),
  );
  await vscode.debug.stopDebugging(session);
  await ended;
}
