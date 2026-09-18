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
import { useEffect, useRef, useState } from 'react';

import { Button, Empty, Icon, Menu, Select, parseNumber } from '../components.js';
import { useDebugState, useMemoryDiff, useSaveStates, useWatchpoints } from '../hooks.js';
import type { Transport } from '../transport.js';
import { DiffGraph, type GraphEdge, RELATION_WORD } from './DiffGraph.js';
import { CIRCLED, DiffGroups } from './DiffRows.js';

/**
 * The query as one sentence, under whichever picture is drawing it. A graph is quick to
 * read wrongly and a query nobody can say out loud is one nobody can check, so the words
 * are what both views are held to.
 */
export function querySentence(
  captures: Array<{ id: number; tag: string }>,
  edges: GraphEdge[],
  values: Record<number, number>,
): string {
  const at = (id: number): string => {
    const i = captures.findIndex((c) => c.id === id);
    return captures[i]?.tag || (CIRCLED[i] ?? `#${i + 1}`);
  };
  if (captures.length < 2) {
    return 'Capture the same screen in two states, then say what the value did between them.';
  }
  const parts = [
    ...edges.map((e) =>
      e.relation === 'same'
        ? `${at(e.to)} is back to what ${at(e.from)} held`
        : `${at(e.from)} → ${at(e.to)} ${RELATION_WORD.get(e.relation)}`,
    ),
    ...Object.entries(values).map(([id, value]) => `${at(Number(id))} held ${value}`),
  ];
  return parts.length === 0
    ? 'Nothing is asked of these captures, so every address is kept. Draw an arrow between two of them.'
    : `Keep addresses where ${parts.join(', ')}.`;
}

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
  const watches = useWatchpoints(transport);
  const [size, setSize] = useState<1 | 2 | 4>(1);
  /** every arrow drawn, which is the query: the strip and the graph are two ways of drawing it */
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  /** an exact value a capture held, as typed */
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [mutesOpen, setMutesOpen] = useState(false);
  const [frames, setFrames] = useState<number>(DIFF.noiseFramesDefault);
  const [nextName, setNextName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const captures = diff.captures;
  const tags = captures.map((c) => c.tag);
  const busy = diff.busy || saves.busy;

  // a capture arrives joined to the one before it, which is the run as it was played;
  // an arrow to a capture that has been forgotten is an arrow to nothing
  useEffect(() => {
    setEdges((was) => {
      const held = new Set(captures.map((c) => c.id));
      const kept = was.filter((e) => held.has(e.from) && held.has(e.to));
      const last = captures[captures.length - 1];
      const previous = captures[captures.length - 2];
      if (last && previous && !kept.some((e) => e.from === last.id || e.to === last.id)) {
        kept.push({ from: previous.id, to: last.id, relation: 'changed' });
      }
      return kept.length === was.length && kept.every((e, i) => e === was[i]) ? was : kept;
    });
  }, [captures]);

  const values: Record<number, number> = {};
  for (const [id, text] of Object.entries(typed)) {
    const parsed = parseNumber(text);
    if (parsed !== null && captures.some((c) => c.id === Number(id))) {
      values[Number(id)] = parsed;
    }
  }

  const query = { edges, values: Object.entries(values).map(([id, value]) => ({ capture: Number(id), value })) };

  // the query is a standing description, so the answer follows it: an arrow changed is a
  // question changed, and a pass over both regions costs tens of milliseconds
  const asked = JSON.stringify({ query, size });
  const lastAsked = useRef<string | null>(null);
  useEffect(() => {
    if (lastAsked.current === asked || busy) {
      return;
    }
    lastAsked.current = asked;
    if (captures.length < 2) {
      void diff.reset();
      return;
    }
    void diff.apply(query, size);
    // `asked` is the query and the size serialized, so the effect runs when what is being
    // asked changes rather than when the objects carrying it are rebuilt
  }, [asked, captures.length, busy, diff, query, size]);

  const toggle = (key: string): void =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });

  /** Hide an address the results turned up: a mute is a range, and a row is one value wide. */
  const muteAddress = (address: number, note: string): void => {
    const width = diff.result?.size ?? size;
    void diff.mute({ ranges: [{ lo: address, hi: address + width }], note });
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
          onClick={() => void diff.capture(nextName.trim() || undefined)}
          disabled={busy}
          kind="primary"
          title="Keep RAM as it is now"
        >
          <Icon name="add" />
          Capture
        </Button>
        <input
          className="gk-input"
          style={{ width: 120 }}
          placeholder="name"
          aria-label="Name for the next capture"
          value={nextName}
          onChange={(e) => setNextName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && void diff.capture(nextName.trim() || undefined)}
          // the name stays after a capture: a run comes back to the same state, and the
          // sentence under the strip reads in the user's words rather than in ①②③
          title="What this capture shows, so the strip reads as the run it describes"
        />
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
      {!stopped && <span className="gk-muted gk-small">Looking for background noise needs a stopped machine.</span>}
      {(diff.error ?? problem) && <span className="gk-bad gk-small">{diff.error ?? problem}</span>}

      {captures.length === 0 ? (
        <Empty>Capture RAM on one screen, change something, capture again — then say what happened between them.</Empty>
      ) : (
        <DiffGraph
          captures={captures}
          edges={edges}
          values={typed}
          busy={busy}
          onEdges={setEdges}
          onName={(id, name) => void diff.retag(id, name)}
          onValue={(id, text) => setTyped((was) => ({ ...was, [id]: text }))}
          onForget={(id) => void diff.forget(id)}
          onOrder={(ids) => void diff.reorder(ids)}
        />
      )}

      <div className="gk-row">
        <Select
          value={size}
          options={[1, 2, 4].map((n) => ({ value: n as 1 | 2 | 4, label: `${n * 8}-bit` }))}
          onChange={setSize}
          title="How wide a value to read at each address"
        />
        <span className="gk-hint">{querySentence(captures, edges, values)}</span>
      </div>

      {watches.watchpoints.length > 0 && (
        <div className="gk-drawer">
          {/* VS Code's Breakpoints view has no data breakpoint to list, so a watch set
              from here is shown here or nowhere */}
          <span className="gk-muted gk-small">
            Watched for writes — these do not reach the editor's Breakpoints view.
          </span>
          {watches.watchpoints.map((w) => (
            <div key={`${w.address}:${w.length}:${w.access}`} className="gk-row gk-mute-row">
              <span className={`gk-tier gk-mute-${w.verified ? 'found' : 'yours'}`}>{w.access}</span>
              <span className="gk-mono gk-small">{w.name}</span>
              <span className="gk-muted gk-small">
                {w.length} byte{w.length === 1 ? '' : 's'} · {w.hits} hit{w.hits === 1 ? '' : 's'}
                {w.verified ? '' : ` · ${w.message ?? 'not watching'}`}
              </span>
              <Button
                kind="icon danger"
                onClick={() => void watches.unwatch(w)}
                label={`Stop watching ${w.name}`}
                title="Stop watching"
              >
                <Icon name="trash" />
              </Button>
            </div>
          ))}
        </div>
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
        </div>
        {mutesOpen &&
          (diff.mutes.length === 0 ? (
            <span className="gk-muted gk-small">
              Nothing is muted. Find background noise mutes what moves on its own — as address ranges, never by name.
            </span>
          ) : (
            diff.mutes.map((mute) => (
              <div key={mute.id} className="gk-row gk-mute-row">
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
                busy,
                onLabel: label,
                onBreak: (row) =>
                  attempt(async () => {
                    await transport.request('gba-kit/breakOnWrite', { address: row.address, size: result.size });
                    watches.refresh();
                  }),
                onWatch: transport.watch && ((row) => transport.watch!(watchExpression(row, result.size))),
                onMute: (row) => muteAddress(row.address, 'muted from the results'),
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
