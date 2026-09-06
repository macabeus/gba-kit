import type { TraceEntry } from '@gba-kit/debug-core';
import { useState } from 'react';

import { Button, Empty, Hex, Icon, MAX_ROWS, Select, newest } from '../components.js';
import { useAtStop, useDebugState } from '../hooks.js';
import type { Transport } from '../transport.js';

export function TracePanel({ transport }: { transport: Transport }) {
  const state = useDebugState(transport);
  const [count, setCount] = useState(200);
  const { data, error, refresh } = useAtStop(transport, (t) => t.request('gba-kit/trace', { count }), [count]);
  // the state body follows every toggle, running or not; the entries only refetch at a stop
  const enabled = state?.tracing ?? data?.enabled ?? false;
  const toggle = async (): Promise<void> => {
    await transport.request('gba-kit/trace', { enabled: !enabled, count: 0 });
    refresh();
  };
  return (
    <div className="gk-col">
      <div className="gk-row" style={{ padding: '6px 10px 0' }}>
        <Button
          onClick={() => void toggle()}
          active={enabled}
          title="Record every executed instruction (slows the machine)"
        >
          <Icon name={enabled ? 'debug-stop' : 'record'} />
          {enabled ? 'Stop tracing' : 'Trace'}
        </Button>
        <Select
          value={count}
          options={[50, 200, MAX_ROWS].map((n) => ({ value: n, label: `last ${n}` }))}
          onChange={setCount}
        />
        <Button onClick={refresh}>Refresh</Button>
      </div>
      {error && <Empty>{error}</Empty>}
      {!error && (!data || data.entries.length === 0) && (
        <Empty>{enabled ? 'Nothing traced yet: run the machine.' : 'Tracing is off.'}</Empty>
      )}
      {data && data.entries.length > 0 && <TraceView entries={data.entries} />}
    </div>
  );
}

/** The newest `MAX_ROWS` entries as a table, oldest first, with a count of what is older. */
export function TraceView({ entries }: { entries: TraceEntry[] }) {
  const { shown, omitted } = newest(entries);
  return (
    <table className="gk-table">
      <thead>
        <tr>
          <th className="gk-right">frame</th>
          <th className="gk-right">line</th>
          <th className="gk-right">cycle</th>
          <th>pc</th>
          <th>op</th>
          <th>r0</th>
          <th>r1</th>
          <th>r2</th>
          <th>r3</th>
        </tr>
      </thead>
      <tbody>
        {omitted > 0 && (
          <tr>
            <td colSpan={9} className="gk-muted">{`… ${omitted} older not shown`}</td>
          </tr>
        )}
        {shown.map((e, i) => (
          <tr key={i}>
            <td className="gk-right gk-muted">{e.frame}</td>
            <td className="gk-right gk-muted">{e.scanline}</td>
            <td className="gk-right gk-muted">{e.cycle}</td>
            <td>
              <Hex value={e.pc} />
              <span className="gk-muted"> {e.thumb ? 't' : 'a'}</span>
            </td>
            <td>
              <Hex value={e.opcode} digits={e.thumb ? 4 : 8} />
            </td>
            <td>
              <Hex value={e.r0} />
            </td>
            <td>
              <Hex value={e.r1} />
            </td>
            <td>
              <Hex value={e.r2} />
            </td>
            <td>
              <Hex value={e.r3} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
