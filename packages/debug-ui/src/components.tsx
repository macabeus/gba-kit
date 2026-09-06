/** Small building blocks the panels share. */
import { type ReactNode, useMemo, useRef } from 'react';

import { usePixels } from './hooks.js';
import { base64ToBytes } from './render.js';

export function Panel({
  title,
  right,
  children,
  pad = false,
  className,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  pad?: boolean;
  className?: string;
}) {
  return (
    <section className={`gk-panel${className ? ` ${className}` : ''}`}>
      <header className="gk-panel-head">
        <span className="gk-panel-title">{title}</span>
        {right}
      </header>
      <div className={`gk-panel-body${pad ? ' gk-pad' : ''}`}>{children}</div>
    </section>
  );
}

/**
 * The icons are VS Code's own, named as the editor names them, so a panel shown in
 * an editor uses the same glyph for the same idea as the rest of the editor does.
 * The set is closed: an icon this package has no name for is one to add here.
 */
export type IconName =
  | 'add'
  | 'chevron-down'
  | 'chevron-right'
  | 'debug-continue'
  | 'debug-pause'
  | 'debug-restart'
  | 'debug-step-back'
  | 'debug-step-over'
  | 'debug-stop'
  | 'edit'
  | 'go-to-file'
  | 'mute'
  | 'play'
  | 'record'
  | 'refresh'
  | 'trash'
  | 'unmute';

/** An icon, hidden from screen readers: whatever carries it says what it does in words. */
export function Icon({ name }: { name: IconName }) {
  return <span className={`codicon codicon-${name}`} aria-hidden="true" />;
}

export function Button({
  children,
  onClick,
  disabled,
  kind,
  active,
  title,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /**
   * `primary` for the one action a view is for. `icon` is the editor's own toolbar
   * button: the glyph alone, no border until it is hovered, and `danger` colours
   * that hover as a warning rather than shouting before it is reached.
   */
  kind?: 'primary' | 'icon' | 'icon danger';
  /** a toggle's state: shown, and announced as `aria-pressed` */
  active?: boolean;
  title?: string;
  /** what a screen reader announces, for a button whose content is an icon */
  label?: string;
}) {
  const classes = [
    'gk-button',
    kind === 'primary' && 'gk-primary',
    kind?.startsWith('icon') && 'gk-icon-button',
    kind === 'icon danger' && 'gk-danger',
    active && 'gk-active',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  title,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  title?: string;
}) {
  const numeric = typeof value === 'number';
  return (
    <select
      className="gk-select"
      value={String(value)}
      title={title}
      onChange={(e) => onChange((numeric ? Number(e.target.value) : e.target.value) as T)}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** The element id of a tab and of the panel it controls, so the two can name each other. */
export function tabIds(prefix: string, id: string): { tab: string; panel: string } {
  return { tab: `${prefix}-tab-${id}`, panel: `${prefix}-tabpanel-${id}` };
}

/**
 * A tab strip in the ARIA tabs pattern: each tab controls a panel the host renders
 * with `tabIds(prefix, id).panel` as its id, and the arrow keys move between tabs.
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  prefix = 'gk',
}: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
  /** distinguishes the ids of several strips on one page */
  prefix?: string;
}) {
  const move = (from: number, key: string): T | null => {
    const last = tabs.length - 1;
    const to =
      key === 'ArrowRight'
        ? (from + 1) % tabs.length
        : key === 'ArrowLeft'
          ? (from + last) % tabs.length
          : key === 'Home'
            ? 0
            : key === 'End'
              ? last
              : -1;
    return to < 0 ? null : (tabs[to]?.id ?? null);
  };
  return (
    <nav className="gk-tabs" role="tablist">
      {tabs.map((t, i) => {
        const ids = tabIds(prefix, t.id);
        return (
          <button
            key={t.id}
            id={ids.tab}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            aria-controls={ids.panel}
            tabIndex={t.id === active ? 0 : -1}
            className={`gk-tab${t.id === active ? ' gk-active' : ''}`}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              const next = move(i, e.key);
              if (next !== null) {
                e.preventDefault();
                onChange(next);
                document.getElementById(tabIds(prefix, next).tab)?.focus();
              }
            }}
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="gk-empty">{children}</div>;
}

/** An address or value as hex, in the monospace face. */
export function Hex({ value, digits = 8 }: { value: number; digits?: number }) {
  return <span className="gk-mono">{`0x${(value >>> 0).toString(16).padStart(digits, '0')}`}</span>;
}

/** Parse what a user typed as a number: `0x...`, decimal, or `-` prefixed. */
export function parseNumber(text: string): number | null {
  const t = text.trim();
  if (/^-?0x[0-9a-f]+$/i.test(t)) {
    const v = parseInt(t.replace('-', ''), 16);
    return t.startsWith('-') ? -v : v;
  }
  if (/^-?\d+$/.test(t)) {
    return Number(t);
  }
  return null;
}

/**
 * Run a click's request without awaiting it, routing its failure into the
 * panel's error line (and clearing the line when it succeeds) instead of
 * leaving an unhandled rejection the user never sees.
 */
export function attempt(setError: (message: string | null) => void, action: Promise<unknown>): void {
  action.then(
    () => setError(null),
    (err: Error) => setError(err.message),
  );
}

/**
 * A screen painted from base64 RGBA. The screens a recording and a save state carry
 * are already reduced, so `width` and `height` come with them rather than being
 * assumed. `scale` fixes how large it is drawn, in screen pixels per stored pixel;
 * without one it takes the width it is given and keeps its shape.
 */
export function Screenshot({
  rgba,
  width,
  height,
  scale,
  label,
}: {
  rgba: string;
  width: number;
  height: number;
  scale?: number;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixels = useMemo(() => ({ width, height, rgba: base64ToBytes(rgba) }), [rgba, width, height]);
  usePixels(canvasRef, pixels);
  return (
    <canvas
      ref={canvasRef}
      className="gk-pixels"
      style={scale === undefined ? undefined : { width: width * scale, height: height * scale }}
      aria-label={label}
    />
  );
}

/** How many rows a log view mounts at most; older entries are counted, not rendered. */
export const MAX_ROWS = 1000;

/** The newest `MAX_ROWS` of a log, and how many older ones are left out. */
export function newest<T>(entries: T[]): { shown: T[]; omitted: number } {
  const omitted = Math.max(0, entries.length - MAX_ROWS);
  return { shown: omitted ? entries.slice(omitted) : entries, omitted };
}
