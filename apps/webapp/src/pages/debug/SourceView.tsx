import type { DebugInfo } from '@gba-kit/debug-info';
import type { EmulatorBridge } from '@gba-kit/gba-browser';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Panel } from '../../components/Panel';
import { loadDebugInfoFromFile, loadDebugInfoFromServer } from './elf-loader';
import { type SourceRow, buildSourceRows, matchSegmentsIndex, toRenderItems } from './source-model';

interface SourceViewProps {
  emulator: EmulatorBridge;
  pc: number;
}

/** A picked source file, with its path split into segments for suffix matching. */
interface PickedFile {
  segments: string[];
  file: File;
}

export function SourceView({ emulator, pc }: SourceViewProps) {
  const [di, setDi] = useState<DebugInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const elfInputRef = useRef<HTMLInputElement>(null);
  const sourcesInputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const autoLoadTried = useRef(false);

  // Picked source files + lazily-read file contents (DWARF path -> lines | null).
  const [sourceFiles, setSourceFiles] = useState<PickedFile[] | null>(null);
  const [sourceText, setSourceText] = useState<Map<string, string[] | null>>(new Map());

  // The directory picker needs non-standard attributes set imperatively.
  useEffect(() => {
    const el = sourcesInputRef.current;
    if (el) {
      el.setAttribute('webkitdirectory', '');
      el.setAttribute('directory', '');
    }
  }, [di]);

  const handleElfLoad = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    setError(null);
    try {
      const loaded = await loadDebugInfoFromFile(file);
      if (!loaded.hasLineInfo) {
        setError('That ELF has no DWARF line info. Build with -g and load the sidecar ELF.');
        return;
      }
      setDi(loaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ELF');
    } finally {
      e.target.value = '';
    }
  }, []);

  const handleSourcesLoad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) {
      return;
    }
    const picked: PickedFile[] = [];
    for (const file of Array.from(list)) {
      const rel = file.webkitRelativePath || file.name;
      picked.push({ segments: rel.split('/').filter(Boolean), file });
    }
    setSourceFiles(picked);
    setSourceText(new Map()); // reset cache for the new tree
    e.target.value = '';
  }, []);

  // Auto-load the sidecar ELF the dev server serves (zero-click), if one is
  // configured and nothing is loaded yet. Falls back to the manual picker.
  useEffect(() => {
    if (di || autoLoadTried.current || !window.__GBAKIT_CONFIG__?.hasElf) {
      return;
    }
    autoLoadTried.current = true;
    let cancelled = false;
    void loadDebugInfoFromServer()
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        if (!loaded.hasLineInfo) {
          setError('The server ELF has no DWARF line info. Build with -g.');
          return;
        }
        setDi(loaded);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to auto-load ELF');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [di]);

  const fn = useMemo(() => di?.pcToFunction(pc) ?? null, [di, pc]);
  const rows: SourceRow[] = useMemo(
    () => (di && fn ? buildSourceRows((a, c) => emulator.disassembleAt(a, c), di, fn.address, fn.end) : []),
    [di, fn, emulator],
  );
  const current = useMemo(() => (di ? di.lines.pcToSource(pc) : null), [di, pc]);

  const items = useMemo(
    () => toRenderItems(rows, (file, line) => sourceText.get(file)?.[line - 1] ?? null, current, pc),
    [rows, sourceText, current, pc],
  );

  // Lazily read the source files referenced by the current function.
  useEffect(() => {
    if (!sourceFiles) {
      return;
    }
    const needed = [...new Set(rows.map((r) => r.src?.file).filter((f): f is string => !!f))];
    const missing = needed.filter((f) => !sourceText.has(f));
    if (missing.length === 0) {
      return;
    }

    let cancelled = false;
    void Promise.all(
      missing.map(async (path) => {
        const idx = matchSegmentsIndex(path, sourceFiles);
        const lines = idx >= 0 ? (await sourceFiles[idx]!.file.text()).split('\n') : null;
        return [path, lines] as const;
      }),
    ).then((entries) => {
      if (cancelled) {
        return;
      }
      setSourceText((prev) => {
        const next = new Map(prev);
        for (const [path, lines] of entries) {
          next.set(path, lines);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rows, sourceFiles, sourceText]);

  // Keep the current instruction in view as the PC moves.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [pc, items]);

  const elfInput = (
    <input
      ref={elfInputRef}
      type="file"
      accept=".elf,application/octet-stream"
      className="hidden"
      onChange={handleElfLoad}
    />
  );

  if (!di) {
    return (
      <Panel title="Source" className="h-full">
        <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400 text-xs px-4 text-center">
          <p>
            Load a <code className="text-slate-300">-g</code> ELF (e.g.{' '}
            <code className="text-slate-300">klonoa-eod.elf</code>) to follow execution in source.
          </p>
          <p className="text-slate-500 text-[10px]">
            The ELF carries DWARF; the shipped <code>.gba</code> doesn&apos;t. Its loadable bytes match the ROM.
          </p>
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-slate-700 text-slate-200 hover:bg-slate-600 transition-colors text-xs"
            onClick={() => elfInputRef.current?.click()}
          >
            Load ELF
          </button>
          {error && <span className="text-red-400">{error}</span>}
          {elfInput}
        </div>
      </Panel>
    );
  }

  const headerRight = (
    <div className="flex gap-3">
      <button
        type="button"
        className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
        onClick={() => sourcesInputRef.current?.click()}
        title="Pick the project source folder to show C alongside the disassembly"
      >
        {sourceFiles ? 'sources ✓' : 'load sources'}
      </button>
      <button
        type="button"
        className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
        onClick={() => elfInputRef.current?.click()}
        title="Load a different ELF"
      >
        change ELF
      </button>
    </div>
  );

  return (
    <Panel
      title={fn ? `Source — ${fn.name}` : 'Source'}
      className="h-full"
      headerRight={headerRight}
      contentClassName="font-mono text-[11px] leading-[1.5]"
    >
      {elfInput}
      <input ref={sourcesInputRef} type="file" multiple className="hidden" onChange={handleSourcesLoad} />
      {!fn ? (
        <div className="flex items-center justify-center h-full text-slate-500 text-xs px-4 text-center">
          PC 0x{pc.toString(16).padStart(8, '0')} is not in a known function (BIOS, or a different ELF?).
        </div>
      ) : (
        <div className="py-1">
          {items.map((item, i) => {
            if (item.kind === 'file') {
              return (
                <div key={`f${i}`} className="px-3 pt-2 pb-0.5 text-[10px] text-slate-600 select-none">
                  ── {item.file} ──
                </div>
              );
            }
            if (item.kind === 'cline') {
              return (
                <div key={`c${i}`} className={clsx('px-3 flex gap-2', item.active && 'bg-sky-500/10')}>
                  <span className="text-slate-600 w-8 text-right shrink-0 select-none">{item.line}</span>
                  <span className="text-emerald-300/90 whitespace-pre">{item.text ?? ''}</span>
                </div>
              );
            }
            return (
              <div
                key={`a${item.address}`}
                ref={item.current ? activeRef : undefined}
                className={clsx(
                  'flex items-center pl-8 pr-3 whitespace-pre',
                  item.current ? 'bg-sky-500/20 border-l-2 border-l-sky-500' : 'border-l-2 border-l-transparent',
                )}
              >
                <span className="w-4 shrink-0 text-sky-400">{item.current ? '>' : ''}</span>
                <span className="text-slate-600 w-20 shrink-0">0x{item.address.toString(16)}</span>
                <span className="text-slate-400">{item.mnemonic}</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
