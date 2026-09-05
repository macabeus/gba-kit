/** Small building blocks the panels share. */
import type { ReactNode } from 'react';

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

export function Button({
  children,
  onClick,
  disabled,
  kind,
  active,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'danger';
  active?: boolean;
  title?: string;
}) {
  const classes = [
    'gk-button',
    kind === 'primary' && 'gk-primary',
    kind === 'danger' && 'gk-danger',
    active && 'gk-active',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} onClick={onClick} disabled={disabled} title={title}>
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

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <nav className="gk-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          className={`gk-tab${t.id === active ? ' gk-active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
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
