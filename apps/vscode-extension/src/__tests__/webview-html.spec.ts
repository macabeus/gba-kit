import { describe, expect, it } from 'vitest';

import { nonce, webviewHtml } from '../webview-html.js';

/** The CSP of a page, directive by directive. */
function directives(html: string): Record<string, string> {
  const content = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
  expect(content).toBeDefined();
  const out: Record<string, string> = {};
  for (const directive of content!.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) {
      out[name] = sources.join(' ');
    }
  }
  return out;
}

describe('webview html', () => {
  it('makes a fresh nonce for every webview', () => {
    const a = nonce();
    const b = nonce();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64').length).toBe(16);
  });

  it('locks the CSP to the nonce and the extension resources, with blob: scripts for the audio worklet', () => {
    const n = nonce();
    const html = webviewHtml({
      cspSource: 'vscode-resource:',
      scriptUri: 'x/webview.js',
      styleUri: 'x/webview.css',
      root: 'tools',
      nonce: n,
      screenScale: 3,
    });
    expect(directives(html)).toEqual({
      'default-src': "'none'",
      'style-src': "vscode-resource: 'unsafe-inline'",
      'script-src': `'nonce-${n}' blob:`,
      'img-src': 'vscode-resource: data:',
      'font-src': 'vscode-resource:',
    });
    expect(html).toContain(`<script nonce="${n}" src="x/webview.js">`);
    expect(html).toContain('<style>\n'); // style-src has no nonce source: a nonce there would mean nothing
    expect(html).toContain('<link rel="stylesheet" href="x/webview.css">');
    expect(html).toContain('data-root="tools"');
    expect(html).toContain('data-screen-scale="3"');
    expect(html).toContain('--gk-accent: var(--vscode-textLink-foreground)');
  });
});
