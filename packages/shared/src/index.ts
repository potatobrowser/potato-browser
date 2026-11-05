/**
 * Protocol shared by the browser (flags client) and the Cloudflare Worker (flags API).
 *
 * A post is identified by a canonical key such as `reddit:t3_abc123`. The key never leaves the
 * device in clear text: the client hashes it (`hashContentKey`) and only sends
 *  - a short prefix of the hash for lookups (k-anonymity, like Safe Browsing), and
 *  - the full hash when the user flags a post.
 */

export const PLATFORMS = [
  'reddit',
  'x',
  'instagram',
  'facebook',
  'threads',
  'linkedin',
  'youtube',
  'bluesky',
  'tiktok',
] as const;

export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  reddit: 'Reddit',
  x: 'X',
  instagram: 'Instagram',
  facebook: 'Facebook',
  threads: 'Threads',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  bluesky: 'Bluesky',
  tiktok: 'TikTok',
};

/** Hex characters of the hash sent for lookups: 20 bits, about a million buckets. */
export const PREFIX_HEX_LENGTH = 5;
/** Max prefixes per lookup request (D1 binds at most 100 parameters per statement). */
export const MAX_LOOKUP_PREFIXES = 100;
export const HASH_DOMAIN = 'noai-flag:v1:';

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

/** Canonical content key. Ids are trimmed; platform ids are case-sensitive (Instagram shortcodes). */
export function contentKey(platform: Platform, id: string): string {
  return `${platform}:${id.trim()}`;
}

export function parseContentKey(key: string): { platform: Platform; id: string } | null {
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const platform = key.slice(0, i);
  const id = key.slice(i + 1);
  if (!isPlatform(platform) || !id || id.length > 256) return null;
  return { platform, id };
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hashContentKey(key: string): Promise<string> {
  return sha256Hex(HASH_DOMAIN + key);
}

export function hashPrefix(hash: string): string {
  return hash.slice(0, PREFIX_HEX_LENGTH);
}

export function isFullHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isHashPrefix(value: unknown): value is string {
  return typeof value === 'string' && value.length === PREFIX_HEX_LENGTH && /^[0-9a-f]+$/.test(value);
}

/** Random install ids are 32 hex chars (128 bits); the server only stores an HMAC of them. */
export function isClientId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

// ---- API contract ----------------------------------------------------------------------------

export interface LookupRequest {
  prefixes: string[];
}

export interface LookupItem {
  /** Full content hash. */
  h: string;
  /** Number of distinct people who flagged it. */
  n: number;
}

export interface LookupResponse {
  items: LookupItem[];
}

export interface FlagRequest {
  h: string;
  platform: Platform;
  client: string;
}

export interface FlagResponse {
  h: string;
  n: number;
  flagged: boolean;
}

export interface ReleaseInfo {
  version: string;
  date: string;
  notes: string;
  downloads: { arm64: string; x64: string };
}

export interface ApiError {
  error: string;
}

/** Compares dotted numeric versions; returns >0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
