/**
 * The Balatro GBA homebrew ROM, from GBALATRO's latest GitHub release.
 *
 * The GitHub API answers cross-origin requests, so the release list comes straight from it.
 * The release file itself is served from a host that sends no CORS headers, so the download
 * goes through corsproxy.io. When that fails, the caller offers the file's own URL: the
 * browser downloads it as a normal link, and the player drops it onto the loader.
 */

const RELEASES_API = 'https://api.github.com/repos/GBALATRO/balatro-gba/releases';
const CORS_PROXY = 'https://corsproxy.io/';
/** corsproxy.io key for gba-kit's own pages; it is public by nature, since the browser sends it. */
const CORS_PROXY_KEY = '30b0ee0d';

/** GBATEK "GBA Cartridge Header": byte 0xB2 is the fixed value 0x96 in every cartridge. */
const HEADER_FIXED_OFFSET = 0xb2;
const HEADER_FIXED_VALUE = 0x96;

export interface BalatroRelease {
  /** The release's tag, e.g. `v0.2.2`. */
  tag: string;
  /** The ROM file's name, e.g. `balatro-gba-0.2.2.gba`. */
  fileName: string;
  /** The ROM's download URL on GitHub. */
  url: string;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

/** A download that failed, with the release the player can fetch by hand when one is known. */
export class BalatroDownloadError extends Error {
  constructor(
    message: string,
    readonly release: BalatroRelease | null,
  ) {
    super(message);
  }
}

/**
 * The newest published release that carries a `.gba` file. The API lists releases newest
 * first; drafts and prereleases come after every full release.
 */
export function latestRomRelease(releases: GitHubRelease[]): BalatroRelease | null {
  const published = releases.filter((r) => !r.draft && !r.prerelease);
  const prereleases = releases.filter((r) => !r.draft && r.prerelease);
  for (const release of [...published, ...prereleases]) {
    const asset = release.assets?.find((a) => a.name.toLowerCase().endsWith('.gba'));
    if (asset) {
      return { tag: release.tag_name, fileName: asset.name, url: asset.browser_download_url };
    }
  }
  return null;
}

/** Whether `data` carries a GBA cartridge header, which an error page or a cut-off download lacks. */
export function isGbaRom(data: ArrayBuffer): boolean {
  return data.byteLength > HEADER_FIXED_OFFSET && new Uint8Array(data)[HEADER_FIXED_OFFSET] === HEADER_FIXED_VALUE;
}

/** The latest Balatro GBA ROM's bytes, and the release they came from. */
export async function fetchBalatroRom(
  fetchFn: typeof fetch = fetch,
): Promise<{ release: BalatroRelease; data: ArrayBuffer }> {
  const res = await fetchFn(RELEASES_API);
  if (!res.ok) {
    throw new BalatroDownloadError(`GitHub API error: ${res.status}`, null);
  }
  const release = latestRomRelease((await res.json()) as GitHubRelease[]);
  if (!release) {
    throw new BalatroDownloadError('No .gba ROM found in the releases', null);
  }

  let romRes: Response;
  try {
    romRes = await fetchFn(`${CORS_PROXY}?key=${CORS_PROXY_KEY}&url=${encodeURIComponent(release.url)}`);
  } catch {
    throw new BalatroDownloadError('The download proxy could not be reached', release);
  }
  if (!romRes.ok) {
    throw new BalatroDownloadError(`The download proxy answered ${romRes.status}`, release);
  }
  const data = await romRes.arrayBuffer();
  if (!isGbaRom(data)) {
    throw new BalatroDownloadError('The download proxy returned something other than the ROM', release);
  }
  return { release, data };
}
