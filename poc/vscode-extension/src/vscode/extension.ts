/**
 * VS Code layer — deliberately thin.
 *
 * - registers the `gba-kit` debugger with an inline adapter (same process, so the
 *   screen webview can subscribe to the frame stream directly instead of pushing
 *   150 KB frames through the DAP JSON channel);
 * - owns the Screen webview panel;
 * - exposes a few commands that are one custom DAP request each.
 *
 * Everything that needs to know about GBA memory, symbols or stepping lives below
 * the DAP seam. Another IDE re-implements only this file.
 */
import * as vscode from 'vscode';

import type { DebugCore } from '../core/debug-core.js';
import { GbaDebugSession } from '../dap/session.js';
import { ScreenPanel } from './screen-panel.js';

const sessions = new Map<string, GbaDebugSession>();
let screen: ScreenPanel | null = null;
/** The session the screen is bound to; rebinding on each launch keeps input going to the live one. */
let bound: { session: vscode.DebugSession; core: DebugCore; unsubscribe: () => void } | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const factory: vscode.DebugAdapterDescriptorFactory = {
    createDebugAdapterDescriptor(session) {
      const adapter = new GbaDebugSession();
      sessions.set(session.id, adapter);
      adapter.onCore((core) => attachScreen(context, session, core));
      return new vscode.DebugAdapterInlineImplementation(adapter);
    },
  };

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('gba-kit', factory),

    vscode.debug.onDidTerminateDebugSession((session) => {
      sessions.delete(session.id);
      if (bound?.session.id === session.id) {
        bound.unsubscribe();
        bound = null;
        screen?.setState({ state: 'terminated', frame: 0, pc: 0 });
      }
    }),

    // State changes travel as DAP custom events: the same path a remote adapter would use.
    vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
      if (e.session.type === 'gba-kit' && e.event === 'gba-kit/state') {
        screen?.setState(e.body);
      }
    }),

    vscode.commands.registerCommand('gba-kit.showScreen', () => {
      const session = activeSession();
      if (!session) {
        return;
      }
      const adapter = sessions.get(session.id);
      adapter?.onCore((core) => attachScreen(context, session, core));
    }),

    vscode.commands.registerCommand('gba-kit.stepFrame', () => customRequest('gba-kit/stepFrame')),

    vscode.commands.registerCommand('gba-kit.rewind', () => customRequest('gba-kit/rewind', { keyframes: 6 })),

    vscode.commands.registerCommand('gba-kit.runScript', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Open a script in an editor first');
        return;
      }
      const code = editor.document.getText();
      const name = editor.document.fileName.split('/').pop() ?? '<script>';
      await customRequest('gba-kit/runScript', { code, name });
    }),

    vscode.commands.registerCommand('gba-kit.toggleRecording', async () => {
      const state = (await customRequest('gba-kit/state')) as { recording?: boolean } | undefined;
      if (!state) {
        return;
      }
      if (state.recording) {
        const result = (await customRequest('gba-kit/recordStop')) as { script: string } | undefined;
        if (result) {
          const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: result.script });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
        }
        screen?.setRecording(false);
      } else {
        await customRequest('gba-kit/recordStart');
        screen?.setRecording(true);
        vscode.window.setStatusBarMessage('GBA: recording inputs — run the command again to stop', 5000);
      }
    }),
  );
}

export function deactivate(): void {
  screen?.dispose();
  screen = null;
}

function activeSession(): vscode.DebugSession | undefined {
  const s = vscode.debug.activeDebugSession;
  if (!s || s.type !== 'gba-kit') {
    vscode.window.showWarningMessage('No gba-kit debug session is active');
    return undefined;
  }
  return s;
}

async function customRequest(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const session = activeSession();
  if (!session) {
    return undefined;
  }
  try {
    return await session.customRequest(command, args);
  } catch (err) {
    vscode.window.showErrorMessage(`GBA: ${(err as Error).message}`);
    return undefined;
  }
}

function attachScreen(context: vscode.ExtensionContext, session: vscode.DebugSession, core: DebugCore): void {
  if (!screen) {
    // Callbacks go through `bound`, so a panel that outlives a session follows the next one.
    screen = new ScreenPanel(context, {
      onInput: (button, down) =>
        void bound?.session.customRequest('gba-kit/input', { button, down }).then(undefined, () => {}),
      onCommand: async (name) => {
        switch (name) {
          case 'continue':
            return vscode.commands.executeCommand('workbench.action.debug.continue');
          case 'pause':
            return vscode.commands.executeCommand('workbench.action.debug.pause');
          case 'stepFrame':
            return bound?.session.customRequest('gba-kit/stepFrame');
          case 'rewind':
            return bound?.session.customRequest('gba-kit/rewind', { keyframes: 6 });
          case 'record':
            return vscode.commands.executeCommand('gba-kit.toggleRecording');
        }
      },
      onDispose: () => {
        bound?.unsubscribe();
        bound = null;
        screen = null;
      },
    });
  }
  screen.reveal();
  if (bound?.core !== core) {
    bound?.unsubscribe();
    const unsubscribe = core.on({ frame: (rgba, frame) => screen?.pushFrame(rgba, frame) });
    bound = { session, core, unsubscribe };
  }
  core.requestFrame();
  screen.setState({ state: core.state, frame: core.frame, pc: core.pc });
}
