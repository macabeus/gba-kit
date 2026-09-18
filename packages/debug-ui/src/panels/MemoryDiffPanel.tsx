/**
 * Capture RAM, compare the captures, and find the variable behind a feature.
 *
 * The workflow this is shaped around: capture with the menu on item A, move to item
 * B, capture, move back to A, capture — then ask for the addresses that are equal
 * wherever the tags are equal and different wherever they differ. Everything that
 * merely moves — the mixer, the counters, the RNG — fails that on the first pair that
 * shares a tag. What is left is a handful of rows, and the matrix of values across the
 * captures says which of them is the answer faster than any filter expression could.
 *
 * An exact-value search is one of the modes, for the states that do put a number on
 * the screen.
 */
import type { DiffRowBody, MuteSource, MuteTally, SavedStateInfo } from '@gba-kit/debug-core/protocol';
import { DIFF, labelName } from '@gba-kit/debug-core/protocol';
import { useState } from 'react';

import { Button, EditableName, Empty, Icon, Menu, Screenshot, Select, parseNumber } from '../components.js';
import { useDebugState, useMemoryDiff, useSaveStates } from '../hooks.js';
import type { Transport } from '../transport.js';
import { CIRCLED, DiffGroups, tagClass } from './DiffRows.js';

type Mode = 'value' | 'changed' | 'unchanged' | 'increased' | 'decreased' | 'tags';

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'tags', label: 'Tag pattern' },
  { value: 'changed', label: 'Changed' },
  { value: 'unchanged', label: 'Unchanged' },
  { value: 'increased', label: 'Increased' },
  { value: 'decreased', label: 'Decreased' },
  { value: 'value', label: 'Exact value' },
];

/**
 * What a mute source is called where its byte count is shown. Every source has a name
 * here because the type says so: a source nothing could name would be hidden bytes the
 * panel could not account for.
 */
const SOURCES: Record<MuteSource, string> = {
  idle: 'idle churn',
  dma: 'a DMA shadow',
  stack: 'the stack',
  user: 'a mute you set',
};

export function MemoryDiffPanel({ transport }: { transport: Transport }) {
  const state = useDebugState(transport);
  const stopped = state?.state === 'stopped';
  const diff = useMemoryDiff(transport);
  const saves = useSaveStates(transport);
  const [mode, setMode] = useState<Mode>('tags');
  const [size, setSize] = useState<1 | 2 | 4>(1);
  const [value, setValue] = useState('');
  const [pair, setPair] = useState<{ from: number; to: number }>({ from: 0, to: 0 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mutesOpen, setMutesOpen] = useState(false);
  const [frames, setFrames] = useState<number>(DIFF.noiseFramesDefault);
  const [problem, setProblem] = useState<string | null>(null);

  const captures = diff.captures;
  const tags = captures.map((c) => c.tag);
  const busy = diff.busy || saves.busy;
  const pairwise = mode !== 'tags' && mode !== 'value';
  // a capture that has been forgotten is no longer one of the two a filter can compare,
  // so the pair falls back to the ends of the strip rather than naming a card that is gone
  const held = (id: number): boolean => captures.some((c) => c.id === id);
  const from = held(pair.from) ? pair.from : (captures[0]?.id ?? 0);
  const to = held(pair.to) ? pair.to : (captures[captures.length - 1]?.id ?? 0);

  const filter = (): { mode: Parameters<typeof diff.apply>[0]; size: 1 | 2 | 4 } | null => {
    setProblem(null);
    if (mode === 'value') {
      const parsed = parseNumber(value);
      if (parsed === null) {
        setProblem('enter a number (decimal or 0x…)');
        return null;
      }
      return { mode: { kind: 'value', value: parsed }, size };
    }
    if (mode === 'tags') {
      return { mode: { kind: 'tags' }, size };
    }
    return { mode: { kind: mode, from, to }, size };
  };

  const act = (what: (args: { mode: Parameters<typeof diff.apply>[0]; size: 1 | 2 | 4 }) => void): void => {
    const args = filter();
    if (args) {
      what(args);
    }
  };

  const toggle = (key: string): void =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });

  const select = (address: number, on: boolean): void =>
    setSelected((was) => {
      const next = new Set(was);
      if (on) {
        next.add(address);
      } else {
        next.delete(address);
      }
      return next;
    });

  const muteAddresses = (addresses: number[], note: string): void => {
    if (addresses.length > 0) {
      const width = diff.result?.size ?? size;
      void diff.mute({ ranges: addresses.map((a) => ({ lo: a, hi: a + width })), note });
      setSelected(new Set());
    }
  };

  /**
   * A row action that says so when it fails. Every other control here reports through
   * the hook's own `run`; these two reach the session directly, and a label or a
   * breakpoint that was never created must not look like one that was.
   */
  const attempt = (what: () => Promise<unknown>): void => {
    setProblem(null);
    void what().catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  const label = (row: DiffRowBody): void => {
    attempt(() =>
      transport.request('gba-kit/setLabel', {
        address: row.address,
        label: nameFor(row),
        size: diff.result?.size ?? size,
      }),
    );
  };

  const result = diff.result;
  const adoptable = saves.states.filter((s) => s.thumbnail);

  return (
    <div className="gk-col gk-pad">
      <div className="gk-row">
        <Button
          onClick={() => void diff.capture()}
          disabled={!stopped || busy}
          kind="primary"
          title="Keep RAM as it is now"
        >
          <Icon name="add" />
          Capture
        </Button>
        {adoptable.length > 0 && (
          <Menu
            label="Adopt a save state as a capture"
            disabled={busy}
            items={adoptable.map((s: SavedStateInfo) => ({
              label: `From '${s.name}'`,
              onSelect: () => void diff.adopt(s),
            }))}
          />
        )}
        <Button
          onClick={() => void diff.findNoise(frames)}
          disabled={!stopped || busy}
          title="Run idle frames and mute whatever moves on its own — take it where the captures are taken, since a look only covers the churn that happens while it runs"
        >
          Find background noise
        </Button>
        <Select
          value={frames}
          options={DIFF.noiseChoices.map((n) => ({ value: n, label: `${n} frames` }))}
          onChange={setFrames}
          title="How long to watch for churn; a longer look leaves fewer candidates standing"
        />
      </div>
      {!stopped && <span className="gk-muted gk-small">Capturing needs a stopped machine.</span>}
      {(diff.error ?? problem) && <span className="gk-bad gk-small">{diff.error ?? problem}</span>}

      {captures.length === 0 ? (
        <Empty>Capture RAM on one screen, change something, capture again — then compare them.</Empty>
      ) : (
        <div className="gk-cards">
          {captures.map((capture, i) => (
            <CaptureCard
              key={capture.id}
              at={i}
              capture={capture}
              tags={tags}
              busy={busy}
              onRetag={(tag) => void diff.retag(capture.id, tag)}
              onForget={() => void diff.forget(capture.id)}
            />
          ))}
        </div>
      )}

      <div className="gk-row">
        <Select
          value={mode}
          options={MODES}
          onChange={(next) => {
            // a preview answers for the filter it was taken of; the moment that filter
            // changes it describes something nobody is about to apply
            diff.clearPreview();
            setMode(next);
          }}
          title="What to ask of the captures"
        />
        <Select
          value={size}
          options={[1, 2, 4].map((n) => ({ value: n as 1 | 2 | 4, label: `${n * 8}-bit` }))}
          onChange={(next) => {
            diff.clearPreview();
            setSize(next);
          }}
        />
        {mode === 'value' && (
          <input
            className="gk-input"
            style={{ width: 100 }}
            placeholder="value"
            value={value}
            onChange={(e) => {
              diff.clearPreview();
              setValue(e.target.value);
            }}
            onKeyDown={(e) => e.key === 'Enter' && act((args) => void diff.apply(args.mode, args.size))}
          />
        )}
        {pairwise && captures.length > 0 && (
          <>
            <Select
              value={from}
              options={captures.map((c, i) => ({ value: c.id, label: `${CIRCLED[i] ?? i + 1} ${c.tag || c.frame}` }))}
              onChange={(id) => {
                diff.clearPreview();
                setPair({ from: id, to });
              }}
              title="Compare from"
            />
            <Select
              value={to}
              options={captures.map((c, i) => ({ value: c.id, label: `${CIRCLED[i] ?? i + 1} ${c.tag || c.frame}` }))}
              onChange={(id) => {
                diff.clearPreview();
                setPair({ from, to: id });
              }}
              title="Compare to"
            />
          </>
        )}
        <Button
          onClick={() => act((args) => void diff.runPreview(args.mode, args.size))}
          disabled={busy}
          title="What this would remove, without removing it"
        >
          Preview
        </Button>
        <Button onClick={() => act((args) => void diff.apply(args.mode, args.size))} disabled={busy} kind="primary">
          Apply
        </Button>
        <Button
          onClick={() => void diff.undo()}
          disabled={busy || !result || result.undoDepth === 0}
          title="Put the previous candidates back"
        >
          Undo{result && result.undoDepth > 0 ? ` (${result.undoDepth})` : ''}
        </Button>
        <Button onClick={() => void diff.reset()} disabled={busy || !result}>
          Reset
        </Button>
      </div>

      {diff.preview && (
        <span className="gk-hint">
          would keep {diff.preview.kept} of {diff.preview.kept + diff.preview.removed} {diff.preview.size * 8}-bit
          addresses
          {hiddenText(diff.preview.hidden)}
        </span>
      )}

      <div className="gk-drawer">
        <div className="gk-row">
          <button
            type="button"
            className="gk-drawer-bar"
            onClick={() => setMutesOpen(!mutesOpen)}
            aria-expanded={mutesOpen}
          >
            <Icon name={mutesOpen ? 'chevron-down' : 'chevron-right'} />
            <span>
              Muted ranges ({diff.mutes.length}) — {diff.mutes.reduce((sum, m) => sum + (m.enabled ? m.bytes : 0), 0)}{' '}
              bytes hidden
            </span>
          </button>
          <Button
            onClick={() => muteAddresses([...selected], 'muted from the results')}
            disabled={busy || selected.size === 0}
          >
            Mute {selected.size} selected
          </Button>
        </div>
        {mutesOpen &&
          (diff.mutes.length === 0 ? (
            <span className="gk-muted gk-small">
              Nothing is muted. Find background noise mutes what moves on its own — as address ranges, never by name.
            </span>
          ) : (
            diff.mutes.map((mute) => (
              <div key={mute.id} className="gk-row gk-mute-row">
                <input
                  type="checkbox"
                  className="gk-check"
                  checked={mute.enabled}
                  onChange={(e) => void diff.mute({ id: mute.id, enabled: e.target.checked })}
                  aria-label={`${mute.source} mute`}
                />
                <span className={`gk-tier gk-mute-${mute.source === 'user' ? 'yours' : 'found'}`}>{mute.source}</span>
                <span className="gk-mono gk-small">
                  {mute.ranges.length === 1
                    ? `0x${mute.ranges[0]!.lo.toString(16)}..0x${mute.ranges[0]!.hi.toString(16)}`
                    : `${mute.ranges.length} ranges`}
                </span>
                <span className="gk-muted gk-small">
                  {mute.bytes} bytes — {mute.note}
                </span>
                <Button
                  kind="icon danger"
                  onClick={() => void diff.mute({ id: mute.id, remove: true })}
                  label="Remove this mute"
                  title="Remove"
                >
                  <Icon name="trash" />
                </Button>
              </div>
            ))
          ))}
      </div>

      {result && (
        <>
          <span className="gk-muted gk-small">
            {result.total} candidate{result.total === 1 ? '' : 's'} at {result.size * 8}-bit
            {hiddenText(result.hidden)}
            {result.capped && ` — more than ${result.detail}, too many to group or rank; narrow further`}
          </span>
          {result.total > result.rows.length && (
            <div className="gk-row">
              <Button
                onClick={() => void diff.page(Math.max(0, diff.from - DIFF.rowsDefault))}
                disabled={busy || diff.from === 0}
              >
                <Icon name="chevron-left" />
                Previous
              </Button>
              <span className="gk-muted gk-small">
                {`rows ${diff.from + 1}–${diff.from + result.rows.length} of ${result.total}`}
              </span>
              <Button
                onClick={() => void diff.page(diff.from + result.rows.length)}
                disabled={busy || diff.from + result.rows.length >= result.total}
              >
                Next
                <Icon name="chevron-right" />
              </Button>
            </div>
          )}
          {result.total === 0 ? (
            <Empty>Nothing survives that. Undo puts the previous candidates back.</Empty>
          ) : (
            <DiffGroups
              groups={result.groups}
              rows={result.rows}
              open={open}
              onToggle={toggle}
              total={result.total}
              actions={{
                tags,
                selected,
                busy,
                onSelect: select,
                onLabel: label,
                onBreak: (row) =>
                  attempt(() => transport.request('gba-kit/breakOnWrite', { address: row.address, size: result.size })),
                onWatch: transport.watch && ((row) => transport.watch!(watchExpression(row, result.size))),
                onMute: (row) => muteAddresses([row.address], 'muted from the results'),
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * What to call an address a row found. A typed path names the address only where the
 * program states an extent covering it — everywhere else the path is a landmark's
 * hypothesis, and a label is a claim that outlives this panel: it reaches disassembly,
 * the `.sym` export and the project's labels file, none of which say which tier it came
 * from. What survives that round trip is an identifier, which is what `labelName` makes.
 */
export function nameFor(row: DiffRowBody): string {
  return names(row) ? labelName(row.path!) : `gUnk_${row.address.toString(16).padStart(8, '0')}`;
}

/**
 * Whether the program names *this address*, rather than an object it is one byte of.
 * A path reaching the address is not enough: every byte of one `s32` carries the same
 * path, so four rows would mint one name at four addresses and the `.sym` export would
 * carry the identifier four times.
 */
function names(row: DiffRowBody): boolean {
  return row.tier === 'sized' && !row.extrapolated && !row.straddles && !row.pathOffset && row.path !== undefined;
}

/**
 * What a row hands the watch pane. Where the program names the address, the typed path
 * is the variable rather than the address it sits at today; everywhere else a read of
 * the row's own width says exactly what its column of the matrix says.
 */
export function watchExpression(row: DiffRowBody, size: 1 | 2 | 4): string {
  return names(row) ? row.path! : `u${size * 8}(0x${row.address.toString(16).padStart(8, '0')})`;
}

/** What each mute source took, named the way the mute list names it. */
function hiddenText(hidden: MuteTally): string {
  const parts = (Object.keys(SOURCES) as MuteSource[])
    .filter((source) => (hidden[source] ?? 0) > 0)
    .map((source) => `${hidden[source]!} hidden by ${SOURCES[source]}`);
  return parts.length === 0 ? '' : `; ${parts.join(', ')}`;
}

function CaptureCard({
  at,
  capture,
  tags,
  busy,
  onRetag,
  onForget,
}: {
  at: number;
  capture: { id: number; tag: string; frame: number; from: string; thumbnail: string; width: number; height: number };
  tags: string[];
  busy: boolean;
  onRetag(tag: string): void;
  onForget(): void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className={`gk-card gk-diff-card ${capture.tag ? tagClass(tags, capture.tag) : ''}`}>
      <Screenshot
        rgba={capture.thumbnail}
        width={capture.width}
        height={capture.height}
        label={`the screen at frame ${capture.frame}`}
      />
      <div className="gk-row">
        <span className="gk-mono">{CIRCLED[at] ?? `#${at + 1}`}</span>
        <span className="gk-muted gk-small">
          frame {capture.frame}
          {capture.from === 'state' ? ' · from a state' : ''}
        </span>
      </div>
      <EditableName
        name={capture.tag || 'untagged'}
        editing={editing}
        className="gk-card-name gk-diff-tag"
        onStop={() => setEditing(false)}
        onRename={onRetag}
      />
      <div className="gk-row gk-card-actions">
        <Button
          kind="icon"
          onClick={() => setEditing(true)}
          disabled={busy}
          title="Tag"
          label={`Tag capture ${at + 1}`}
        >
          <Icon name="edit" />
        </Button>
        <Button kind="icon danger" onClick={onForget} disabled={busy} title="Forget" label={`Forget capture ${at + 1}`}>
          <Icon name="trash" />
        </Button>
      </div>
    </div>
  );
}
