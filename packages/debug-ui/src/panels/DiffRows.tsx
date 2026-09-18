/**
 * The results of a memory diff, grouped by what holds them and collapsed until asked.
 *
 * The three tiers are three visibly different rows, not one row with different text,
 * because the difference between them is the whole point: `sized` is what the program
 * states, `inferred` is a landmark the nearest symbol happens to provide, and
 * `unnamed` is an address the program says nothing about. An inferred containment
 * dressed up as a variable name would be a lie, and on the measured target it would be
 * the lie told about 83% of the rows.
 */
import { type DiffGroupBody, type DiffRowBody, RANK_LEVELS, rankLevel } from '@gba-kit/debug-core/protocol';

import { Hex, Icon, Menu } from '../components.js';

/** What a row's tier is called and coloured by, in the order a reader trusts them. */
const TIERS = {
  sized: { className: 'gk-tier-sized', label: 'sized', title: 'the program states an extent covering this address' },
  inferred: {
    className: 'gk-tier-inferred',
    label: 'inferred',
    title: 'the nearest symbol below, in the same memory — a landmark, not a name',
  },
  through: {
    className: 'gk-tier-through',
    label: 'pointed at',
    title: 'no object declares this address; a pointer was aimed here in every capture',
  },
  unattributed: {
    className: 'gk-tier-unnamed',
    label: 'unnamed',
    title: 'no symbol of this memory reaches this address',
  },
} as const;

export interface DiffRowActions {
  /** the tags of the captures, in capture order, so a column can be read as its tag */
  tags: string[];
  onLabel(row: DiffRowBody): void;
  onBreak(row: DiffRowBody): void;
  onMute(row: DiffRowBody): void;
  /** only where the host has a watch pane to put an expression in, the way `openText` is only where there is an editor */
  onWatch?(row: DiffRowBody): void;
  busy?: boolean;
}

export function DiffGroups({
  groups,
  rows,
  open,
  onToggle,
  actions,
  total,
}: {
  groups: DiffGroupBody[];
  rows: DiffRowBody[];
  open: ReadonlySet<string>;
  onToggle(key: string): void;
  actions: DiffRowActions;
  total: number;
}) {
  // an ungrouped result is one the session had too many candidates to place: it is a
  // page of addresses in address order, and there is nothing to expand
  if (groups.length === 0) {
    return <DiffTable rows={rows} actions={actions} total={total} />;
  }
  return (
    <div className="gk-col">
      {groups.map((group) => {
        const mine = rows.filter((r) => r.group === group.key);
        const expanded = open.has(group.key);
        const tier = TIERS[group.tier];
        return (
          <div key={group.key} className="gk-col">
            <button
              type="button"
              className="gk-group-head"
              onClick={() => onToggle(group.key)}
              aria-expanded={expanded}
            >
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
              <span className={`gk-tier ${tier.className}`} title={tier.title}>
                {tier.label}
              </span>
              <span className="gk-mono">{group.label}</span>
              <span className="gk-muted gk-small">
                {/* a group counts every row it has; this page carries the ones that ranked
                    high enough to reach it, and saying so is what keeps an expanded group
                    that shows twelve of two hundred from reading as a group of twelve */}
                {mine.length === group.rows
                  ? `${group.rows} row${group.rows === 1 ? '' : 's'} · best ${rankLevel(group.topRank)}`
                  : `${mine.length} of ${group.rows} rows here · best ${rankLevel(group.topRank)}`}
              </span>
            </button>
            {expanded && <DiffTable rows={mine} actions={actions} total={mine.length} />}
          </div>
        );
      })}
    </div>
  );
}

function DiffTable({ rows, actions, total }: { rows: DiffRowBody[]; actions: DiffRowActions; total: number }) {
  return (
    <table className="gk-table gk-matrix" aria-rowcount={total}>
      <thead>
        <tr>
          <th>Where</th>
          {actions.tags.map((tag, i) => (
            <th key={i} className="gk-right" title={tag ? `tagged '${tag}'` : 'untagged'}>
              {CIRCLED[i] ?? `#${i + 1}`}
              {tag && <span className={`gk-diff-tag ${tagClass(actions.tags, tag)}`}>{tag}</span>}
            </th>
          ))}
          <th>Odds</th>
          <th aria-label="actions" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <DiffRow key={row.address} row={row} actions={actions} />
        ))}
      </tbody>
    </table>
  );
}

/**
 * How much a row looks like a variable, as one of three words. The score behind it is an
 * ordering rather than a measurement, so the words are what is shown and the criteria
 * that earned them are what the title says — a number alone gives nobody a way to
 * disagree with the order it put the rows in.
 */
function Odds({ row }: { row: DiffRowBody }) {
  const level = rankLevel(row.rank);
  const why = row.reasons.length > 0 ? `: ${row.reasons.join(', ')}` : '';
  return (
    <span className={`gk-odds gk-odds-${level}`} title={`${RANK_LEVELS[level]}${why}`}>
      {level}
    </span>
  );
}

function DiffRow({ row, actions }: { row: DiffRowBody; actions: DiffRowActions }) {
  const tier = TIERS[row.tier];
  return (
    <tr className={tier.className}>
      <td>
        <Where row={row} />
      </td>
      {row.values.map((value, i) => (
        <td key={i} className="gk-right gk-matrix-cell">
          <span className={i > 0 && row.values[i - 1] !== value ? 'gk-accent' : undefined}>
            {row.formatted?.[i] ?? value}
          </span>
        </td>
      ))}
      <td>
        <Odds row={row} />
      </td>
      <td>
        <Menu
          label={`what to do with 0x${row.address.toString(16)}`}
          disabled={actions.busy}
          items={[
            { label: 'Add as a label', onSelect: () => actions.onLabel(row) },
            ...(actions.onWatch ? [{ label: 'Watch', onSelect: () => actions.onWatch!(row) }] : []),
            { label: 'Break on write', onSelect: () => actions.onBreak(row) },
            { label: 'Mute this address', onSelect: () => actions.onMute(row) },
          ]}
        />
      </td>
    </tr>
  );
}

/**
 * What a row leads with. A path leads the row only where the object it names begins at
 * the address, since that is the one case it names the address rather than an object
 * the address is a byte of. A `sized` symbol with no type to walk leads with an offset
 * from it, which claims a containment and no name. Everything else leads with the
 * address, and whatever the program does say follows it as a landmark that states in
 * words how far away it is.
 */
function Where({ row }: { row: DiffRowBody }) {
  if (row.tier === 'sized' && row.path && row.pathOffset !== undefined) {
    return (
      <span>
        <Hex value={row.address} />
        <span className="gk-mono gk-muted gk-small">{` in ${row.path} + 0x${row.pathOffset.toString(16)}`}</span>
      </span>
    );
  }
  if (row.tier === 'sized' && row.path) {
    return (
      <span className="gk-mono">
        {row.path}
        {row.type && <span className="gk-muted"> : {row.type}</span>}
        {row.alternatives && (
          <Caveat text={`or .${row.alternatives.join(', .')}`} title="a union: these members cover the same bytes" />
        )}
        {row.straddles && <Caveat text="straddles" title="the read crosses out of this object" />}
      </span>
    );
  }
  if (row.tier === 'sized' && row.symbol) {
    return <span className="gk-mono">{`${row.symbol.name}+0x${row.symbol.offset.toString(16)}`}</span>;
  }
  return (
    <span>
      <Hex value={row.address} />
      {row.symbol && (
        <span className="gk-muted gk-small">{` near ${row.symbol.name} + 0x${row.symbol.offset.toString(16)}`}</span>
      )}
      {row.path && row.extrapolated && (
        <span className="gk-mono gk-muted gk-small">
          {` ${row.path}`}
          <Caveat text="extrapolated" title="nothing states this array has that many elements" />
        </span>
      )}
    </span>
  );
}

function Caveat({ text, title }: { text: string; title: string }) {
  return (
    <span className="gk-warn gk-small" title={title}>
      {` (${text})`}
    </span>
  );
}

/** Captures are named by their place in the strip, the way a screenshot of one is read. */
export const CIRCLED = [...'①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'];

/** Equal tags get equal colour, so `A B A` is visible before any filter has run. */
export function tagClass(tags: string[], tag: string): string {
  const order = [...new Set(tags.filter((t) => t))];
  return `gk-tag-${(order.indexOf(tag) % 4) + 1}`;
}
