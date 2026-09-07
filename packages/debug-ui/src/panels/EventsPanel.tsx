import { type EventEntry, ioRegisterAt } from '@gba-kit/debug-core';
import { useState } from 'react';

import { Button, Empty, Hex, OmittedRow, StampCells, StampHeader, newest } from '../components.js';
import { useAtStop } from '../hooks.js';
import type { Transport } from '../transport.js';

const KINDS = ['vblank', 'hblank', 'irq-request', 'irq-enter', 'dma', 'mmio-write', 'halt'] as const;

export function EventsPanel({ transport }: { transport: Transport }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(['hblank']));
  const { data, error, refresh } = useAtStop(transport, (t) => t.request('gba-kit/events', { count: 2000 }));
  const toggle = (kind: string): void =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
  return (
    <div className="gk-col">
      <div className="gk-row gk-controls">
        {KINDS.map((k) => (
          <label key={k} className="gk-check gk-small">
            <input type="checkbox" checked={!hidden.has(k)} onChange={() => toggle(k)} /> {k}
          </label>
        ))}
        <Button onClick={refresh}>Refresh</Button>
      </div>
      {error && <Empty>{error}</Empty>}
      {data && <EventsView entries={data.entries.filter((e) => !hidden.has(e.event.kind))} />}
      {!data && !error && <Empty>Stop the machine to see the event log.</Empty>}
    </div>
  );
}

/** A one-line account of a hardware event's fields, the kind aside. An I/O write names the register it landed in. */
export function describeEvent(event: EventEntry['event']): string {
  const { kind: _kind, ...rest } = event as { kind: string } & Record<string, unknown>;
  if (event.kind === 'mmio-write') {
    const register = ioRegisterAt(event.address);
    if (register) {
      rest.address = `${register.name} (0x${event.address.toString(16)})`;
    }
  }
  return Object.entries(rest)
    .map(
      ([k, v]) =>
        `${k}=${typeof v === 'number' ? (v > 255 ? '0x' + v.toString(16) : String(v)) : typeof v === 'object' && v ? JSON.stringify(v) : String(v)}`,
    )
    .join(' ');
}

/** The newest `MAX_ROWS` entries as a table, oldest first, with a count of what is older. */
export function EventsView({ entries }: { entries: EventEntry[] }) {
  if (entries.length === 0) {
    return <Empty>No events (of the kinds shown) yet.</Empty>;
  }
  const { shown, omitted } = newest(entries);
  return (
    <table className="gk-table">
      <thead>
        <tr>
          <StampHeader />
          <th>pc</th>
          <th>event</th>
          <th>details</th>
        </tr>
      </thead>
      <tbody>
        <OmittedRow omitted={omitted} columns={6} />
        {shown.map((e, i) => (
          <tr key={i}>
            <StampCells at={e} />
            <td>
              <Hex value={e.pc} />
            </td>
            <td
              className={
                e.event.kind === 'irq-enter' || e.event.kind === 'irq-request'
                  ? 'gk-warn'
                  : e.event.kind === 'dma'
                    ? 'gk-accent'
                    : ''
              }
            >
              {e.event.kind}
            </td>
            <td className="gk-muted">{describeEvent(e.event)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
