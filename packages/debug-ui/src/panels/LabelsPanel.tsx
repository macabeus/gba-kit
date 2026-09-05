import type { Label } from '@gba-kit/debug-core';
import { useCallback, useEffect, useState } from 'react';

import { Button, Empty, Hex, parseNumber } from '../components.js';
import type { Transport } from '../transport.js';

/** Names for addresses the ELF does not name: persisted per project, shown in disassembly, usable in expressions. */
export function LabelsPanel({ transport }: { transport: Transport }) {
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'list' | 'import' | 'export'>('list');
  const [importText, setImportText] = useState('');
  const [exportText, setExportText] = useState('');
  const [form, setForm] = useState({ address: '', label: '', comment: '' });

  const load = useCallback(() => {
    transport
      .request('gba-kit/labels')
      .then((b) => setLabels(b.labels))
      .catch((err: Error) => setError(err.message));
  }, [transport]);
  useEffect(() => {
    load();
    return transport.onLabels(load);
  }, [transport, load]);

  const submit = async (): Promise<void> => {
    const address = parseNumber(form.address);
    if (address === null) {
      setError('address must be a number (0x03005220)');
      return;
    }
    try {
      const b = await transport.request('gba-kit/setLabel', {
        address: address >>> 0,
        label: form.label.trim(),
        comment: form.comment.trim() || undefined,
      });
      setLabels(b.labels);
      setForm({ address: '', label: '', comment: '' });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (address: number): Promise<void> => {
    const b = await transport.request('gba-kit/setLabel', { address, label: '' });
    setLabels(b.labels);
  };
  const doImport = async (): Promise<void> => {
    const { imported } = await transport.request('gba-kit/importLabels', { text: importText });
    setImportText('');
    setMode('list');
    setError(
      imported === 0
        ? 'nothing recognized: expected lines like `03005220 gUnk_03005220` or `gFoo = 0x03000000;`'
        : null,
    );
    load();
  };
  const doExport = async (): Promise<void> => {
    const { text } = await transport.request('gba-kit/exportLabels');
    setExportText(text);
    setMode('export');
    transport.openText?.(text, 'plaintext', 'labels.sym');
  };

  return (
    <div className="gk-col" style={{ height: '100%' }}>
      <div className="gk-row" style={{ padding: '6px 10px 0' }}>
        <Button onClick={() => setMode('list')} active={mode === 'list'}>
          {labels?.length ?? 0} labels
        </Button>
        <Button onClick={() => setMode('import')} active={mode === 'import'}>
          Import .sym
        </Button>
        <Button onClick={() => void doExport()}>Export</Button>
      </div>
      {error && (
        <span className="gk-bad gk-small" style={{ padding: '0 10px' }}>
          {error}
        </span>
      )}
      {mode === 'import' && (
        <div className="gk-col" style={{ padding: 10 }}>
          <textarea
            className="gk-textarea"
            rows={8}
            placeholder={'03005220 gUnk_03005220\ngFoo = 0x03000000;'}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div className="gk-row">
            <Button onClick={() => void doImport()} kind="primary" disabled={!importText.trim()}>
              Import
            </Button>
            <span className="gk-muted gk-small">no$gba / mGBA symbol files, or linker-script assignments</span>
          </div>
        </div>
      )}
      {mode === 'export' && (
        <pre className="gk-pre" style={{ flex: 1 }}>
          {exportText || '(no labels)'}
        </pre>
      )}
      {mode === 'list' && (
        <>
          <div className="gk-fill" style={{ overflow: 'auto' }}>
            {labels && labels.length > 0 ? (
              <LabelsView
                labels={labels}
                onRemove={(a) => void remove(a)}
                onEdit={(l) =>
                  setForm({ address: `0x${l.address.toString(16)}`, label: l.label, comment: l.comment ?? '' })
                }
              />
            ) : (
              <Empty>No labels yet. Name an address below, or import a symbol file.</Empty>
            )}
          </div>
          <form
            className="gk-label-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              className="gk-input"
              placeholder="0x03005220"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
            <input
              className="gk-input"
              placeholder="gPlayerState"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
            <input
              className="gk-input"
              placeholder="comment"
              value={form.comment}
              onChange={(e) => setForm({ ...form, comment: e.target.value })}
            />
            <Button onClick={() => void submit()} kind="primary" disabled={!form.address.trim()}>
              Set
            </Button>
          </form>
        </>
      )}
    </div>
  );
}

export function LabelsView({
  labels,
  onRemove,
  onEdit,
}: {
  labels: Label[];
  onRemove?: (address: number) => void;
  onEdit?: (label: Label) => void;
}) {
  return (
    <table className="gk-table">
      <thead>
        <tr>
          <th>address</th>
          <th>label</th>
          <th>comment</th>
          <th className="gk-right">size</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {labels.map((l) => (
          <tr key={l.address} onDoubleClick={() => onEdit?.(l)}>
            <td>
              <Hex value={l.address} />
            </td>
            <td className="gk-accent">{l.label}</td>
            <td className="gk-muted">{l.comment ?? ''}</td>
            <td className="gk-right gk-muted">{l.size ?? ''}</td>
            <td>
              {onRemove && (
                <button type="button" className="gk-button gk-small" onClick={() => onRemove(l.address)} title="Remove">
                  ✕
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
