import { useState } from 'react';

import { Button, Empty, Hex, Select, parseNumber } from '../components.js';
import { useDebugState } from '../hooks.js';
import type { Transport } from '../transport.js';

/** Find a value in RAM, then narrow the candidates as it changes: the "find the HP variable" tool. */
export function MemorySearchPanel({ transport }: { transport: Transport }) {
  const state = useDebugState(transport);
  const [text, setText] = useState('');
  const [size, setSize] = useState<1 | 2 | 4>(2);
  const [region, setRegion] = useState<'iwram' | 'ewram' | 'both'>('both');
  const [results, setResults] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stopped = state?.state === 'stopped';

  const run = async (narrow: boolean): Promise<void> => {
    const value = parseNumber(text);
    if (value === null) {
      setError('enter a number (decimal or 0x…)');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body =
        narrow && results
          ? await transport.request('gba-kit/filterMemory', { addresses: results, value, size })
          : await transport.request('gba-kit/searchMemory', { value, size, region });
      setResults(body.addresses);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gk-col gk-pad">
      <div className="gk-row">
        <input
          className="gk-input"
          style={{ width: 120 }}
          placeholder="value"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run(results !== null)}
        />
        <Select
          value={size}
          options={[1, 2, 4].map((n) => ({ value: n as 1 | 2 | 4, label: `${n * 8}-bit` }))}
          onChange={setSize}
        />
        <Select
          value={region}
          options={[
            { value: 'both', label: 'IWRAM + EWRAM' },
            { value: 'iwram', label: 'IWRAM' },
            { value: 'ewram', label: 'EWRAM' },
          ]}
          onChange={setRegion}
        />
        <Button onClick={() => void run(false)} disabled={!stopped || busy} kind="primary">
          Search
        </Button>
        <Button
          onClick={() => void run(true)}
          disabled={!stopped || busy || !results || results.length === 0}
          title="Keep the addresses that now hold the value"
        >
          Narrow
        </Button>
        {results && (
          <Button onClick={() => setResults(null)} title="Start over">
            Clear
          </Button>
        )}
      </div>
      {error && <span className="gk-bad gk-small">{error}</span>}
      {!stopped && <span className="gk-muted gk-small">Searching needs a stopped machine.</span>}
      {results && (
        <>
          <span className="gk-muted gk-small">
            {results.length} match{results.length === 1 ? '' : 'es'}
            {results.length >= 10_000 ? ' (capped)' : ''}. Change the value in the game, then Narrow.
          </span>
          {results.length === 0 ? (
            <Empty>Nothing holds that value.</Empty>
          ) : (
            <div
              className="gk-mono gk-small"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 2 }}
            >
              {results.slice(0, 512).map((a) => (
                <span key={a}>
                  <Hex value={a} />
                </span>
              ))}
              {results.length > 512 && <span className="gk-muted">… {results.length - 512} more</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
