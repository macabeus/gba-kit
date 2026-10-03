/**
 * The "Play Balatro GBA" download: which release it picks, what it accepts as a ROM, and
 * which release it offers by hand when the download proxy fails. The release list mirrors
 * GBALATRO's: versioned file names on full releases, the old unversioned name on prereleases.
 */
import { describe, expect, it } from 'vitest';

import { BalatroDownloadError, fetchBalatroRom, isGbaRom, latestRomRelease } from '../pages/load/balatro-rom';

const download = (tag: string, name: string): string =>
  `https://github.com/GBALATRO/balatro-gba/releases/download/${tag}/${name}`;

const RELEASES = [
  {
    tag_name: 'v0.2.2',
    draft: false,
    prerelease: false,
    assets: [{ name: 'balatro-gba-0.2.2.gba', browser_download_url: download('v0.2.2', 'balatro-gba-0.2.2.gba') }],
  },
  {
    tag_name: 'v0.2.1',
    draft: false,
    prerelease: false,
    assets: [{ name: 'balatro-gba-v0.2.1.gba', browser_download_url: download('v0.2.1', 'balatro-gba-v0.2.1.gba') }],
  },
  {
    tag_name: 'jokers_stable_v1.1',
    draft: false,
    prerelease: true,
    assets: [{ name: 'balatro-gba.gba', browser_download_url: download('jokers_stable_v1.1', 'balatro-gba.gba') }],
  },
];

/** Bytes with a GBA header's fixed byte (0x96 at 0xB2). */
function rom(): ArrayBuffer {
  const bytes = new Uint8Array(0x200);
  bytes[0xb2] = 0x96;
  return bytes.buffer;
}

/** A fetch that answers the release list, and answers the proxy with `romResponse`. */
function fakeFetch(romResponse: () => Response, requested: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify(RELEASES), { status: 200 });
    }
    return romResponse();
  }) as typeof fetch;
}

describe('latestRomRelease', () => {
  it('picks the newest full release and its versioned .gba file', () => {
    expect(latestRomRelease(RELEASES)).toEqual({
      tag: 'v0.2.2',
      fileName: 'balatro-gba-0.2.2.gba',
      url: download('v0.2.2', 'balatro-gba-0.2.2.gba'),
    });
  });

  it('falls back to a prerelease when no full release carries a ROM', () => {
    expect(latestRomRelease(RELEASES.slice(2))?.tag).toBe('jokers_stable_v1.1');
    expect(latestRomRelease([])).toBeNull();
  });
});

describe('isGbaRom', () => {
  it('accepts a cartridge header and refuses an error page', () => {
    expect(isGbaRom(rom())).toBe(true);
    expect(isGbaRom(new TextEncoder().encode('{"error":"Invalid or inactive API key"}').buffer)).toBe(false);
  });
});

describe('fetchBalatroRom', () => {
  it('downloads the release file through the proxy', async () => {
    const requested: string[] = [];
    const { release, data } = await fetchBalatroRom(fakeFetch(() => new Response(rom(), { status: 200 }), requested));
    expect(release.tag).toBe('v0.2.2');
    expect(isGbaRom(data)).toBe(true);
    expect(requested[1]).toContain(encodeURIComponent(download('v0.2.2', 'balatro-gba-0.2.2.gba')));
  });

  it('offers the release by hand when the proxy refuses or returns something else', async () => {
    for (const answer of [
      () => new Response('{"error":"Invalid or inactive API key"}', { status: 401 }),
      () => new Response('<html>error code: 522</html>', { status: 200 }),
      () => {
        throw new TypeError('Failed to fetch');
      },
    ]) {
      const failure = await fetchBalatroRom(fakeFetch(answer)).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(BalatroDownloadError);
      expect((failure as BalatroDownloadError).release?.fileName).toBe('balatro-gba-0.2.2.gba');
    }
  });
});
