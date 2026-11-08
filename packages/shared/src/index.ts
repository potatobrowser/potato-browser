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
/** Keeps the project's former name: every stored flag is keyed by it. */
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

/** The apps that talk to the service. */
export const APPS = ['mac', 'ios'] as const;
export type AppPlatform = (typeof APPS)[number];

export function isAppPlatform(value: unknown): value is AppPlatform {
  return typeof value === 'string' && (APPS as readonly string[]).includes(value);
}

/** Dotted app versions as the apps send them (0.8.0). */
export function isAppVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
}

// ---- API contract ----------------------------------------------------------------------------

/** A vote on a post: flagged as AI-generated, or disputed as made by a person. */
export type VoteKind = 'ai' | 'human';

export function isVoteKind(value: unknown): value is VoteKind {
  return value === 'ai' || value === 'human';
}

/**
 * The count a post is judged by: AI flags minus Not AI votes. A post counts as AI-generated when
 * this reaches the user's threshold.
 */
export function netFlags(n: number, d: number): number {
  return n - d;
}

export interface LookupRequest {
  prefixes: string[];
  /** 2 asks for AI flags and Not AI votes separately; without it `n` is the net count. */
  v?: 2;
}

export interface LookupItem {
  /** Full content hash. */
  h: string;
  /** Distinct networks that flagged it as AI (net of Not AI votes for v1 lookups). */
  n: number;
  /** Distinct networks that voted Not AI (v2 lookups only). */
  d?: number;
}

export interface LookupResponse {
  items: LookupItem[];
}

export interface FlagRequest {
  h: string;
  platform: Platform;
  client: string;
  /** Without it (apps before 0.8.0) the vote is an AI flag and counts come back net. */
  vote?: VoteKind;
  app?: AppPlatform;
}

export interface FlagResponse {
  h: string;
  n: number;
  /** Present when the request named a vote kind. */
  d?: number;
  flagged: boolean;
  vote?: VoteKind | null;
}

// ---- Site reports ----------------------------------------------------------------------------

export const REPORT_FEATURES = ['shield', 'adblock'] as const;
export type ReportFeature = (typeof REPORT_FEATURES)[number];
/** `showing`: AI (shield) or ads (ad blocker) still show. `broken`: the feature broke the page. */
export const REPORT_PROBLEMS = ['showing', 'broken'] as const;
export type ReportProblem = (typeof REPORT_PROBLEMS)[number];

export interface SiteReport {
  url: string;
  feature: ReportFeature;
  problem: ReportProblem;
  app: AppPlatform;
  version: string;
}

/** What a report sends as the page address: http(s) only, no fragment, at most 2048 characters. */
export function reportUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    u.username = '';
    u.password = '';
    const s = u.toString();
    return s.length <= 2048 ? s : null;
  } catch {
    return null;
  }
}

// ---- AI Shield rule updates ------------------------------------------------------------------

/** Bumped when downloaded rules stop being readable by older apps. */
export const SHIELD_RULES_FORMAT = 1;

/**
 * Ed25519 keys (raw, base64) that sign downloaded AI Shield rules. The private key never reaches
 * the Worker: rules are signed when the site is deployed, so the server alone cannot inject CSS.
 */
export const SHIELD_RULES_KEYS = ['Jhe5kgTZOhggkysLPjSEBKKm9sQtlxzF3jbOOo30OCo='];

/** What is signed: the rules catalog of apps/browser/src/content/shield/rules.ts. */
export interface ShieldRulesPayload {
  format: number;
  /** Seconds since 1970 of the commit the rules come from; newer wins. */
  version: number;
  /** sha256 (hex) of JSON.stringify(rules). */
  hash: string;
  rules: unknown[];
}

/** GET /api/v1/shield/rules. `payload` is the signed JSON text, `signature` base64. */
export interface ShieldRulesEnvelope {
  payload: string;
  signature: string;
}

/** The daily check (GET /api/v1/filters): filter list revisions and the current shield rules. */
export interface UpdateCheckResponse {
  lists: Record<string, string | null>;
  shield?: { version: number; hash: string };
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
