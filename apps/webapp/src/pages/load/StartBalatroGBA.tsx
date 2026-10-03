import clsx from 'clsx';
import { useCallback, useState } from 'react';

import { BalatroDownloadError, type BalatroRelease, fetchBalatroRom } from './balatro-rom';

interface StartBalatroGBAProps {
  onRomLoad: (data: ArrayBuffer) => void;
}

export function StartBalatroGBA({ onRomLoad }: StartBalatroGBAProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallback, setFallback] = useState<BalatroRelease | null>(null);

  const handleClick = useCallback(async () => {
    setLoading(true);
    setError(null);
    setFallback(null);
    try {
      const { data } = await fetchBalatroRom();
      onRomLoad(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
      setFallback(err instanceof BalatroDownloadError ? err.release : null);
    } finally {
      setLoading(false);
    }
  }, [onRomLoad]);

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-2 text-slate-600 text-xs uppercase tracking-wider">
        <div className="w-8 h-px bg-slate-700" />
        <span>or try a homebrew</span>
        <div className="w-8 h-px bg-slate-700" />
      </div>

      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className={clsx(
          'group relative px-6 py-3 rounded-xl font-medium text-sm transition-all',
          'bg-linear-to-r from-blue-600 to-blue-500',
          'hover:from-blue-500 hover:to-blue-400',
          'active:scale-[0.98]',
          'disabled:opacity-60 disabled:cursor-wait',
        )}
      >
        <div className="absolute inset-0 rounded-xl bg-linear-to-r from-blue-500/20 to-amber-500/20 blur-xl opacity-0 group-hover:opacity-100 transition-opacity" />

        <div className="relative flex items-center gap-3">
          {loading ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              <span className="text-white">Downloading...</span>
            </>
          ) : (
            <>
              <span className="text-lg leading-none">&#9824;</span>
              <span className="text-white">Play Balatro GBA</span>
            </>
          )}
        </div>
      </button>

      {error && <p className="text-blue-400 text-xs">{error}</p>}
      {fallback && (
        <p className="text-slate-400 text-xs text-center max-w-sm">
          Download{' '}
          <a href={fallback.url} className="text-sky-400 hover:text-sky-300 underline underline-offset-2">
            {fallback.fileName}
          </a>{' '}
          ({fallback.tag}) from GitHub, then drop it onto the loader above.
        </p>
      )}

      <p className="text-slate-600 text-[10px]">
        Open-source homebrew by{' '}
        <a
          href="https://github.com/GBALATRO/balatro-gba"
          target="_blank"
          rel="noopener noreferrer"
          className="text-slate-500 hover:text-slate-400 underline underline-offset-2"
        >
          GBALATRO
        </a>
      </p>
    </div>
  );
}
