/** The HTML shell of a panel webview: strict CSP, the theme mapped onto the panels' variables, one script. */

export type Root = 'screen' | 'tools';

export function nonce(): string {
  let out = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function webviewHtml(options: {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  root: Root;
  nonce: string;
  screenScale: number;
}): string {
  const { cspSource, scriptUri, styleUri, root, nonce: n, screenScale } = options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; img-src ${cspSource} data:; font-src ${cspSource}; worker-src blob:; media-src blob:;">
<link rel="stylesheet" href="${styleUri}">
<style nonce="${n}">
  html, body { height: 100%; margin: 0; }
  body { background: var(--vscode-editor-background); color: var(--vscode-foreground); }
  #root { height: 100%; }
  .gk-root {
    --gk-bg: var(--vscode-editor-background);
    --gk-panel: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --gk-panel-solid: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    --gk-border: var(--vscode-panel-border, var(--vscode-widget-border, #444));
    --gk-fg: var(--vscode-foreground);
    --gk-muted: var(--vscode-descriptionForeground);
    --gk-dim: var(--vscode-descriptionForeground);
    --gk-accent: var(--vscode-textLink-foreground);
    --gk-accent-bg: var(--vscode-list-hoverBackground);
    --gk-good: var(--vscode-testing-iconPassed, #4ade80);
    --gk-warn: var(--vscode-editorWarning-foreground, #fbbf24);
    --gk-bad: var(--vscode-errorForeground, #f87171);
    --gk-rec: var(--vscode-debugIcon-breakpointForeground, #f43f5e);
    --gk-font: var(--vscode-font-family);
    --gk-mono: var(--vscode-editor-font-family);
    --gk-input-bg: var(--vscode-input-background);
    --gk-radius: 3px;
    font-size: var(--vscode-font-size, 13px);
  }
  .gk-input, .gk-select, .gk-textarea { color: var(--vscode-input-foreground); border-color: var(--vscode-input-border, var(--gk-border)); }
  .gk-button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-color: transparent; }
  .gk-button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); color: var(--vscode-button-secondaryForeground); }
  .gk-button.gk-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .gk-button.gk-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); color: var(--vscode-button-foreground); }
</style>
</head>
<body>
<div id="root" class="gk-root" data-root="${root}" data-screen-scale="${screenScale}"></div>
<script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}
