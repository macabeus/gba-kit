/**
 * The webview side: mount the panels with a transport that talks to the
 * extension host in messages. One bundle serves both the Screen panel and the
 * Tools panel; `data-root` on the container says which.
 */
import {
  DebugPanels,
  type HostToTransport,
  ScreenPanel,
  type TransportToHost,
  createMessageTransport,
} from '@gba-kit/debug-ui';
import '@gba-kit/debug-ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const transport = createMessageTransport({
  post: (message: TransportToHost) => vscode.postMessage(message),
  listen: (handler) => {
    const onMessage = (e: MessageEvent<HostToTransport>): void => handler(e.data);
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  },
});

const container = document.getElementById('root')!;
const root = container.dataset.root === 'tools' ? 'tools' : 'screen';
const scale = Number(container.dataset.screenScale) || 2;
const saved = (vscode.getState() as { panel?: string } | undefined) ?? {};

createRoot(container).render(
  <StrictMode>
    {root === 'screen' ? (
      <div style={{ padding: 8 }}>
        <ScreenPanel transport={transport} scale={scale} />
      </div>
    ) : (
      <DebugPanels
        transport={transport}
        panels={[
          'io',
          'palette',
          'tiles',
          'tilemap',
          'sprites',
          'trace',
          'events',
          'search',
          'labels',
          'states',
          'recording',
        ]}
        initial={(saved.panel as never) ?? 'io'}
        onChange={(panel) => vscode.setState({ ...saved, panel })}
      />
    )}
  </StrictMode>,
);
