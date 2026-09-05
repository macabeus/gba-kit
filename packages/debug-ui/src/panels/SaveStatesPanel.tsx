import type { SavedStateInfo } from '@gba-kit/debug-core/protocol';
import { useCallback, useEffect, useState } from 'react';

import { Button, Empty } from '../components.js';
import { useDebugState } from '../hooks.js';
import type { Transport } from '../transport.js';

export function SaveStatesPanel({ transport }: { transport: Transport }) {
  const state = useDebugState(transport);
  const [states, setStates] = useState<SavedStateInfo[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stopped = state?.state === 'stopped';

  const load = useCallback(() => {
    transport
      .request('gba-kit/listStates')
      .then((b) => setStates(b.states))
      .catch((err: Error) => setError(err.message));
  }, [transport]);
  useEffect(load, [load]);

  const save = async (): Promise<void> => {
    try {
      await transport.request('gba-kit/saveState', { name: name.trim() || undefined });
      setName('');
      setError(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const restore = async (s: SavedStateInfo): Promise<void> => {
    try {
      await transport.request('gba-kit/loadState', { path: s.path });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="gk-col">
      <div className="gk-row" style={{ padding: '6px 10px 0' }}>
        <input
          className="gk-input gk-fill"
          placeholder={`name (default: frame-${state?.frame ?? 0})`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
        <Button onClick={() => void save()} kind="primary" disabled={!stopped}>
          Save state
        </Button>
        <Button onClick={load}>Refresh</Button>
      </div>
      {error && (
        <span className="gk-bad gk-small" style={{ padding: '0 10px' }}>
          {error}
        </span>
      )}
      {!states || states.length === 0 ? (
        <Empty>No saved states for this ROM. States live under the project's .gba-kit/states/.</Empty>
      ) : (
        <table className="gk-table">
          <thead>
            <tr>
              <th>name</th>
              <th className="gk-right">frame</th>
              <th>saved</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {states.map((s) => (
              <tr key={s.path}>
                <td>{s.name}</td>
                <td className="gk-right gk-muted">{s.frame}</td>
                <td className="gk-muted">{s.createdAt ? new Date(s.createdAt).toLocaleString() : ''}</td>
                <td>
                  <Button onClick={() => void restore(s)} disabled={!stopped}>
                    Load
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
