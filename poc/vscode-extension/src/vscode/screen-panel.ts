/**
 * The GBA screen as a webview: a 240x160 canvas, keyboard -> gamepad, and a small
 * transport bar. Frames arrive as raw RGBA `Uint8Array`s (VS Code transfers typed
 * arrays to webviews without JSON encoding).
 */
import * as vscode from 'vscode';

export interface ScreenPanelCallbacks {
  onInput(button: number, down: boolean): void;
  onCommand(name: 'continue' | 'pause' | 'stepFrame' | 'rewind' | 'record'): void;
  onDispose(): void;
}

export class ScreenPanel {
  readonly #panel: vscode.WebviewPanel;
  readonly #disposeHooks: Array<() => void> = [];
  #lastRgba: Uint8Array | null = null;

  constructor(context: vscode.ExtensionContext, callbacks: ScreenPanelCallbacks) {
    this.#panel = vscode.window.createWebviewPanel('gba-kit.screen', 'GBA Screen', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.#panel.webview.html = html(this.#panel.webview.cspSource);
    this.#panel.webview.onDidReceiveMessage((msg: { type: string; button?: number; down?: boolean; name?: string }) => {
      if (msg.type === 'input' && typeof msg.button === 'number') {
        callbacks.onInput(msg.button, !!msg.down);
      } else if (msg.type === 'command' && msg.name) {
        callbacks.onCommand(msg.name as Parameters<ScreenPanelCallbacks['onCommand']>[0]);
      } else if (msg.type === 'ready' && this.#lastRgba) {
        this.pushFrame(this.#lastRgba, -1);
      }
    });
    this.#panel.onDidDispose(() => {
      for (const hook of this.#disposeHooks) {
        hook();
      }
      callbacks.onDispose();
    });
    void context;
  }

  reveal(): void {
    this.#panel.reveal(undefined, true);
  }

  onDisposed(hook: () => void): void {
    this.#disposeHooks.push(hook);
  }

  pushFrame(rgba: Uint8Array, frame: number): void {
    this.#lastRgba = rgba;
    void this.#panel.webview.postMessage({ type: 'frame', rgba, frame });
  }

  setState(state: { state: string; frame: number; pc: number }): void {
    void this.#panel.webview.postMessage({ type: 'state', ...state });
  }

  setRecording(recording: boolean): void {
    void this.#panel.webview.postMessage({ type: 'recording', recording });
  }

  dispose(): void {
    this.#panel.dispose();
  }
}

function html(cspSource: string): string {
  const nonce = Math.random().toString(36).slice(2);
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 8px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); user-select: none; }
  #wrap { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  canvas { width: 480px; height: 320px; max-width: 100%; image-rendering: pixelated; background: #000; outline: 2px solid transparent; }
  canvas:focus { outline-color: var(--vscode-focusBorder); }
  #bar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 4px 10px; border-radius: 3px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.rec { color: #f55; }
  #status { font-family: var(--vscode-editor-font-family); font-size: 12px; opacity: .8; }
  #hint { font-size: 11px; opacity: .6; }
</style>
</head>
<body>
<div id="wrap">
  <canvas id="c" width="240" height="160" tabindex="0"></canvas>
  <div id="bar">
    <button data-cmd="continue">▶ Run</button>
    <button data-cmd="pause">⏸ Pause</button>
    <button data-cmd="stepFrame">⏭ Frame</button>
    <button data-cmd="rewind">⏪ Rewind 1s</button>
    <button data-cmd="record" id="rec">● Record</button>
    <span id="status">idle</span>
  </div>
  <div id="hint">Click the screen, then: arrows = D-pad · Z = A · X = B · Enter = Start · Backspace = Select · A = R · S = L</div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(240, 160);
  const status = document.getElementById('status');
  const KEYS = { ArrowRight: 4, ArrowLeft: 5, ArrowUp: 6, ArrowDown: 7, z: 0, x: 1, Backspace: 2, Enter: 3, a: 8, s: 9 };
  const held = new Set();

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'frame') {
      image.data.set(msg.rgba);
      ctx.putImageData(image, 0, 0);
      if (msg.frame >= 0) status.dataset.frame = msg.frame;
    } else if (msg.type === 'state') {
      status.textContent = msg.state + ' · frame ' + msg.frame + ' · pc 0x' + (msg.pc >>> 0).toString(16).padStart(8, '0');
    } else if (msg.type === 'recording') {
      document.getElementById('rec').classList.toggle('rec', msg.recording);
      document.getElementById('rec').textContent = msg.recording ? '■ Stop recording' : '● Record';
    }
  });

  function key(e, down) {
    const button = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (button === undefined) return;
    e.preventDefault();
    if (down === held.has(button)) return;
    if (down) held.add(button); else held.delete(button);
    vscode.postMessage({ type: 'input', button, down });
  }
  canvas.addEventListener('keydown', (e) => key(e, true));
  canvas.addEventListener('keyup', (e) => key(e, false));
  canvas.addEventListener('blur', () => { for (const b of held) vscode.postMessage({ type: 'input', button: b, down: false }); held.clear(); });
  for (const b of document.querySelectorAll('button[data-cmd]')) {
    b.addEventListener('click', () => { vscode.postMessage({ type: 'command', name: b.dataset.cmd }); canvas.focus(); });
  }
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
