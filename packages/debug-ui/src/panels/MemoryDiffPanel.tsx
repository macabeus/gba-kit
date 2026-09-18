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

import { Button, Empty, Icon, Menu, Screenshot, Select, parseNumber } from '../components.js';
import { useDebugState, useMemoryDiff, useSaveStates } from '../hooks.js';
import type { Transport } from '../transport.js';
import { CIRCLED, DiffGroups } from './DiffRows.js';

type Relation = 'same' | 'changed' | 'increased' | 'decreased' | 'any';

const RELATIONS: Array<{ value: Relation; label: string; word: string }> = [
  { value: 'changed', label: '≠ changed', word: 'changed' },
  { value: 'same', label: '= same', word: 'stayed the same' },
  { value: 'increased', label: '↑ went up', word: 'went up' },
  { value: 'decreased', label: '↓ went down', word: 'went down' },
  { value: 'any', label: '· anything', word: 'did anything' },
];

const RELATION_WORD = new Map(RELATIONS.map((r) => [r.value, r.word]));

/** The default a new link takes: "what changed here" is the question a strip is built to ask. */
const DEFAULT_RELATION: Relation = 'changed';

/**
 * The query as one sentence, under the strip that draws it. A diagram is quick to read
 * wrongly, and a query nobody can say out loud is one nobody can check.
 */
export function querySentence(
  captures: Array<{ id: number; name: string }>,
  links: Record<number, Relation>,
  arcs: Record<number, number>,
  values: Record<number, number>,
): string {
  const at = (id: number): string => {
    const i = captures.findIndex((c) => c.id === id);
    return captures[i]?.name || (CIRCLED[i] ?? `#${i + 1}`);
  };
  if (captures.length < 2) {
    return 'Capture the same screen in two states, then say what the value did between them.';
  }
  const parts: string[] = [];
  for (let i = 0; i + 1 < captures.length; i++) {
    const relation = links[captures[i]!.id] ?? DEFAULT_RELATION;
    parts.push(`${at(captures[i]!.id)} → ${at(captures[i + 1]!.id)} ${RELATION_WORD.get(relation)}`);
  }
  for (const [id, sameAs] of Object.entries(arcs)) {
    parts.push(`${at(Number(id))} is back to what ${at(sameAs)} held`);
  }
  for (const [id, value] of Object.entries(values)) {
    parts.push(`${at(Number(id))} held ${value}`);
  }
  return `Keep addresses where ${parts.join(', ')}.`;
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
  const [size, setSize] = useState<1 | 2 | 4>(1);
  /** what each link expects, keyed by the capture on its left */
  const [links, setLinks] = useState<Record<number, Relation>>({});
  /** the earlier capture a later one is a repeat of: the arc back over the strip */
  const [arcs, setArcs] = useState<Record<number, number>>({});
  /** an exact value a capture held, as typed */
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mutesOpen, setMutesOpen] = useState(false);
  const [frames, setFrames] = useState<number>(DIFF.noiseFramesDefault);
  const [nextName, setNextName] = useState('');
  const [dragging, setDragging] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const captures = diff.captures;
  const tags = captures.map((c) => c.tag);
  const busy = diff.busy || saves.busy;

  const values: Record<number, number> = {};
  for (const [id, text] of Object.entries(typed)) {
    const parsed = parseNumber(text);
    if (parsed !== null && captures.some((c) => c.id === Number(id))) {
      values[Number(id)] = parsed;
    }
  }

  /**
   * The edges the strip draws. A link between neighbours and an arc back to a capture a
   * later one repeats are the same kind of thing, so they are built into one list: the
   * arc is what says "I went back", and without it a chain of `changed` keeps every byte
   * that merely churns.
   */
  const edges = [
    ...captures.slice(0, -1).map((c, i) => ({
      from: c.id,
      to: captures[i + 1]!.id,
      relation: links[c.id] ?? DEFAULT_RELATION,
    })),
    ...Object.entries(arcs)
      .filter(([id, sameAs]) => captures.some((c) => c.id === Number(id)) && captures.some((c) => c.id === sameAs))
      .map(([id, sameAs]) => ({ from: sameAs, to: Number(id), relation: 'same' as Relation })),
  ];
  const query = { edges, values: Object.entries(values).map(([id, value]) => ({ capture: Number(id), value })) };

  // the query is a standing description, so the answer follows it: a link changed is a
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

  const move = (id: number, before: number | null): void => {
    const rest = captures.filter((c) => c.id !== id).map((c) => c.id);
    const at = before === null ? rest.length : rest.indexOf(before);
    rest.splice(at < 0 ? rest.length : at, 0, id);
    void diff.reorder(rest);
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
          onClick={() => void diff.capture(nextName.trim() || undefined)}
          disabled={!stopped || busy}
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
          onKeyDown={(e) => e.key === 'Enter' && stopped && !busy && void diff.capture(nextName.trim() || undefined)}
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
      {!stopped && <span className="gk-muted gk-small">Capturing needs a stopped machine.</span>}
      {(diff.error ?? problem) && <span className="gk-bad gk-small">{diff.error ?? problem}</span>}

      {captures.length === 0 ? (
        <Empty>Capture RAM on one screen, change something, capture again — then say what happened between them.</Empty>
      ) : (
        <div className="gk-strip">
          {captures.map((capture, i) => (
            <div className="gk-strip-step" key={capture.id}>
              <CaptureCard
                at={i}
                capture={capture}
                earlier={captures.slice(0, i)}
                sameAs={arcs[capture.id]}
                value={typed[capture.id] ?? ''}
                busy={busy}
                dragging={dragging === capture.id}
                onName={(name) => void diff.retag(capture.id, name)}
                onSameAs={(id) =>
                  setArcs((was) => {
                    const next = { ...was };
                    if (id === undefined) {
                      delete next[capture.id];
                    } else {
                      next[capture.id] = id;
                    }
                    return next;
                  })
                }
                onValue={(text) => setTyped((was) => ({ ...was, [capture.id]: text }))}
                onForget={() => void diff.forget(capture.id)}
                onDragStart={() => setDragging(capture.id)}
                onDragEnd={() => setDragging(null)}
                onDrop={() => dragging !== null && dragging !== capture.id && move(dragging, capture.id)}
              />
              {i + 1 < captures.length && (
                <Select
                  className="gk-link"
                  value={links[capture.id] ?? DEFAULT_RELATION}
                  options={RELATIONS}
                  onChange={(relation) => setLinks((was) => ({ ...was, [capture.id]: relation }))}
                  title={`What the value did between ${CIRCLED[i] ?? i + 1} and ${CIRCLED[i + 1] ?? i + 2}`}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="gk-row">
        <Select
          value={size}
          options={[1, 2, 4].map((n) => ({ value: n as 1 | 2 | 4, label: `${n * 8}-bit` }))}
          onChange={setSize}
          title="How wide a value to read at each address"
        />
        <span className="gk-hint">
          {querySentence(
            captures.map((c, i) => ({ id: c.id, name: c.tag || (CIRCLED[i] ?? `#${i + 1}`) })),
            links,
            arcs,
            values,
          )}
        </span>
      </div>

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
  earlier,
  sameAs,
  value,
  busy,
  dragging,
  onName,
  onSameAs,
  onValue,
  onForget,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  at: number;
  capture: { id: number; tag: string; frame: number; from: string; thumbnail: string; width: number; height: number };
  /** the captures this one could be a repeat of: an arc only ever points back */
  earlier: Array<{ id: number; tag: string }>;
  sameAs?: number;
  value: string;
  busy: boolean;
  dragging: boolean;
  onName(name: string): void;
  onSameAs(id: number | undefined): void;
  onValue(text: string): void;
  onForget(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onDrop(): void;
}) {
  const [naming, setNaming] = useState(false);
  const label = (id: number): string => {
    const i = earlier.findIndex((c) => c.id === id);
    return earlier[i]?.tag || (CIRCLED[i] ?? `#${i + 1}`);
  };
  return (
    <div
      className={`gk-card gk-diff-card${dragging ? ' gk-dragging' : ''}`}
      draggable={!busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
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
      {naming ? (
        <input
          className="gk-input gk-card-name gk-diff-tag"
          autoFocus
          defaultValue={capture.tag}
          placeholder="name"
          aria-label={`Name capture ${at + 1}`}
          onBlur={(e) => {
            setNaming(false);
            const to = e.currentTarget.value.trim();
            if (to !== capture.tag) {
              onName(to);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.currentTarget.value = capture.tag;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        // a name is a caption and nothing more: what the filter reads is the links and
        // the arcs, so an unnamed capture costs nothing but a harder sentence to read
        <button
          type="button"
          className={`gk-card-name gk-diff-tag${capture.tag ? '' : ' gk-muted'}`}
          onClick={() => setNaming(true)}
          disabled={busy}
          title={capture.tag ? `Called '${capture.tag}'` : 'Name this capture'}
          aria-label={capture.tag ? `Name capture ${at + 1}, now '${capture.tag}'` : `Name capture ${at + 1}`}
        >
          {capture.tag || '+ name'}
        </button>
      )}
      {earlier.length > 0 && (
        <Select
          className="gk-small"
          value={sameAs ?? 0}
          options={[
            { value: 0, label: 'a new state' },
            ...earlier.map((c) => ({ value: c.id, label: `same as ${label(c.id)}` })),
          ]}
          onChange={(id) => onSameAs(id === 0 ? undefined : id)}
          title="Whether this capture is a state an earlier one already holds"
        />
      )}
      <input
        className="gk-input gk-small"
        placeholder="any value"
        aria-label={`The value capture ${at + 1} held`}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        title="A value this capture held, when the screen puts a number on it"
      />
      <div className="gk-row gk-card-actions">
        <Button kind="icon danger" onClick={onForget} disabled={busy} title="Forget" label={`Forget capture ${at + 1}`}>
          <Icon name="trash" />
        </Button>
      </div>
    </div>
  );
}
