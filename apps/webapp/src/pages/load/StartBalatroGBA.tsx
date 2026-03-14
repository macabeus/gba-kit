import clsx from 'clsx';
import { useCallback, useState } from 'react';

const CORS_PROXY = 'https://api.codetabs.com/v1/proxy?quest=';
const RELEASES_API = 'https://api.github.com/repos/GBALATRO/balatro-gba/releases';
const ASSET_NAME = 'balatro-gba.gba';

interface StartBalatroGBAProps {
  onRomLoad: (data: ArrayBuffer) => void;
}

async function fetchLatestRom(): Promise<ArrayBuffer> {
  // Fetch releases to find the download URL (GitHub API supports CORS)
  const res = await fetch(RELEASES_API);
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }

  const releases = await res.json();
  let downloadUrl: string | null = null;
  for (const release of releases) {
    const asset = release.assets?.find((a: { name: string }) => a.name === ASSET_NAME);
    if (asset) {
      downloadUrl = asset.browser_download_url;
      break;
    }
  }
  if (!downloadUrl) {
    throw new Error('No .gba ROM found in releases');
  }

  // Download the ROM through a CORS proxy (GitHub release downloads lack CORS headers)
  const romRes = await fetch(`${CORS_PROXY}${downloadUrl}`);
  if (!romRes.ok) {
    throw new Error(`Download failed: ${romRes.status}`);
  }

  return romRes.arrayBuffer();
}

export function StartBalatroGBA({ onRomLoad }: StartBalatroGBAProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLatestRom();
      onRomLoad(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
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
