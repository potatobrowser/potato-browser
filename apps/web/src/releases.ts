import type { ReleaseInfo } from '@potato/shared';

/** The repository whose GitHub Releases hold the builds; forks set SOURCE_REPO in wrangler.jsonc. */
export const DEFAULT_REPO = 'potatobrowser/potato-browser';

export type Arch = 'arm64' | 'x64';
export const ARCHS: readonly Arch[] = ['arm64', 'x64'];

/** latest.json as the release workflow attaches it to every GitHub Release. */
export interface Manifest {
  version: string;
  date: string;
  notes: string;
  commit: string;
  files: Record<Arch, string>;
  sizes: Record<Arch, number>;
  sha256: Record<Arch, string>;
  /** The zips in-app updates install; null for releases before 0.7.0. */
  zips: Record<Arch, ZipAsset> | null;
}

export interface ZipAsset {
  file: string;
  size: number;
  /** base64, as electron-updater checks it. */
  sha512: string;
}

export interface LatestRelease extends ReleaseInfo {
  sizes: Record<Arch, number>;
  sha256: Record<Arch, string>;
  source: { repo: string; tag: string; commit: string; release: string };
}

const TTL_MS = 5 * 60_000;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const FILE = /^[A-Za-z0-9._-]{1,100}\.dmg$/;
const ZIP = /^[A-Za-z0-9._-]{1,100}\.zip$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function repoOf(env: { SOURCE_REPO?: string }): string {
  const repo = env.SOURCE_REPO?.trim();
  return repo && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) ? repo : DEFAULT_REPO;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isSize = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

function parseZips(v: unknown, version: string): Record<Arch, ZipAsset> | null {
  if (!isRecord(v)) return null;
  const out: Partial<Record<Arch, ZipAsset>> = {};
  for (const a of ARCHS) {
    const z = v[a];
    if (!isRecord(z)) return null;
    const { file, size, sha512 } = z;
    // electron-updater picks the asset for this Mac by "arm64" in its name.
    if (typeof file !== 'string' || !ZIP.test(file) || !file.includes(version) || file.includes('arm64') !== (a === 'arm64')) return null;
    if (!isSize(size) || typeof sha512 !== 'string' || !SHA512_B64.test(sha512)) return null;
    out[a] = { file, size, sha512 };
  }
  return out as Record<Arch, ZipAsset>;
}

/** Strict check, since the fields end up in redirect URLs and on the download page. */
export function parseManifest(v: unknown): Manifest | null {
  if (!isRecord(v) || !isRecord(v.files) || !isRecord(v.sizes) || !isRecord(v.sha256)) return null;
  const { version, date, notes, commit, files, sizes, sha256 } = v;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  if (typeof date !== 'string' || !DATE.test(date)) return null;
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return null;
  for (const a of ARCHS) {
    const f = files[a];
    const n = sizes[a];
    const s = sha256[a];
    if (typeof f !== 'string' || !FILE.test(f) || !f.includes(version)) return null;
    if (!isSize(n)) return null;
    if (typeof s !== 'string' || !SHA256.test(s)) return null;
  }
  return {
    version,
    date,
    notes: typeof notes === 'string' ? notes.slice(0, 2000) : '',
    commit,
    files: { arm64: files.arm64 as string, x64: files.x64 as string },
    sizes: { arm64: sizes.arm64 as number, x64: sizes.x64 as number },
    sha256: { arm64: sha256.arm64 as string, x64: sha256.x64 as string },
    zips: parseZips(v.zips, version),
  };
}

// Per-isolate copy; also the fallback while GitHub is unreachable.
let memo: { repo: string; manifest: Manifest; expires: number } | null = null;

/** For tests. */
export function resetManifestCache(): void {
  memo = null;
}

async function fetchManifest(repo: string): Promise<Manifest | null> {
  const res = await fetch(`https://github.com/${repo}/releases/latest/download/latest.json`, {
    headers: { 'user-agent': 'potatobrowser-site', accept: 'application/json, application/octet-stream' },
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length > 16_384) return null;
  try {
    return parseManifest(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The latest published release, cached for five minutes; null when none can be found. */
export async function latestManifest(env: { SOURCE_REPO?: string }): Promise<Manifest | null> {
  const repo = repoOf(env);
  const now = Date.now();
  if (memo?.repo === repo && memo.expires > now) return memo.manifest;
  const cacheKey = new Request(`https://release-cache.potatobrowser.invalid/${repo}/latest.json`);
  const cache = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches?.default;
  try {
    const hit = await cache?.match(cacheKey);
    const cached = hit ? parseManifest(await hit.json()) : null;
    if (cached) {
      memo = { repo, manifest: cached, expires: now + TTL_MS };
      return cached;
    }
  } catch {}
  let fresh: Manifest | null = null;
  try {
    fresh = await fetchManifest(repo);
  } catch {}
  if (!fresh) return memo?.repo === repo ? memo.manifest : null;
  memo = { repo, manifest: fresh, expires: now + TTL_MS };
  try {
    await cache?.put(cacheKey, new Response(JSON.stringify(fresh), { headers: { 'cache-control': `max-age=${TTL_MS / 1000}` } }));
  } catch {}
  return fresh;
}

export function assetUrl(repo: string, m: Manifest, arch: Arch, file = m.files[arch]): string {
  return `https://github.com/${repo}/releases/download/v${m.version}/${encodeURIComponent(file)}`;
}

/**
 * latest-mac.yml for electron-updater's generic provider, as JSON (which is YAML too), listing
 * only the zip for the Mac's architecture: electron-updater's own pick between several can be
 * fooled by the host name. The zip downloads straight from the GitHub Release; Squirrel.Mac
 * installs it only when it is signed like the running app.
 */
export function updateFeed(repo: string, m: Manifest, arch: Arch): object | null {
  const zip = m.zips?.[arch];
  if (!zip) return null;
  return {
    version: m.version,
    files: [{ url: assetUrl(repo, m, arch, zip.file), sha512: zip.sha512, size: zip.size }],
    releaseDate: `${m.date}T00:00:00.000Z`,
  };
}

export function releaseInfo(repo: string, m: Manifest, origin: string): LatestRelease {
  const tag = `v${m.version}`;
  return {
    version: m.version,
    date: m.date,
    notes: m.notes,
    downloads: { arm64: `${origin}/download/mac-arm64`, x64: `${origin}/download/mac-x64` },
    sizes: m.sizes,
    sha256: m.sha256,
    source: {
      repo: `https://github.com/${repo}`,
      tag,
      commit: m.commit,
      release: `https://github.com/${repo}/releases/tag/${tag}`,
    },
  };
}
