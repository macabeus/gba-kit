import type { IoRegisterValue } from '@gba-kit/debug-core';
import { useState } from 'react';

import { Empty, Hex } from '../components.js';
import { useAtStop } from '../hooks.js';
import type { Transport } from '../transport.js';

export function IoRegistersPanel({ transport }: { transport: Transport }) {
  const [filter, setFilter] = useState('');
  const { data, error } = useAtStop(transport, (t) => t.request('gba-kit/ioRegisters'));
  if (error) {
    return <Empty>{error}</Empty>;
  }
  if (!data) {
    return <Empty>Stop the machine to see the I/O registers.</Empty>;
  }
  return (
    <div className="gk-col">
      <div className="gk-row" style={{ padding: '6px 10px 0' }}>
        <input
          className="gk-input gk-fill"
          placeholder="filter (DISPCNT, DMA, TM…)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <IoRegistersView registers={data.registers} filter={filter} />
    </div>
  );
}

export function IoRegistersView({ registers, filter = '' }: { registers: IoRegisterValue[]; filter?: string }) {
  const f = filter.trim().toLowerCase();
  const shown = f ? registers.filter((r) => r.name.toLowerCase().includes(f)) : registers;
  if (shown.length === 0) {
    return <Empty>No register matches.</Empty>;
  }
  return (
    <div>
      {shown.map((reg) => (
        <div key={reg.address} className="gk-io-reg">
          <div className="gk-row" style={{ justifyContent: 'space-between' }}>
            <span className="gk-accent gk-mono">{reg.name}</span>
            <span className="gk-mono gk-muted">
              <Hex value={reg.address} /> = <Hex value={reg.value} digits={reg.size * 2} />
            </span>
          </div>
          {reg.decoded.length > 0 && (
            <div className="gk-io-fields">
              {reg.decoded.map((field) => (
                <div key={field.name} className="gk-io-field">
                  <span className="gk-muted">{field.name}</span>
                  <span className={field.label ? '' : field.value ? 'gk-good' : 'gk-dim'}>
                    {field.label ?? field.value}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
