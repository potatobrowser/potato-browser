import {
  hashPrefix,
  isClientId,
  isFullHash,
  isHashPrefix,
  isPlatform,
  MAX_LOOKUP_PREFIXES,
  type FlagResponse,
  type LookupItem,
} from '@potato/shared';
import { DAILY_FLAG_CAP, MAX_VOTES_PER_NETWORK, networkBucket, rateLimitKey, voterId } from './lib';
import { assetUrl, latestManifest, releaseInfo, repoOf } from './releases';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LOOKUP_LIMIT: RateLimit;
  FLAG_LIMIT: RateLimit;
  /** HMAC key that turns install ids into voter ids (secret). */
  VOTER_SALT?: string;
  /** owner/name of the public repository whose GitHub Releases hold the builds. */
  SOURCE_REPO?: string;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

const error = (status: number, message: string) => json({ error: message }, status);

const MAX_BODY = 16_384;

/** The body as text, or null past MAX_BODY bytes (checked while reading, not after). */
async function readCapped(req: Request): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  // Exactly application/json: a web page can send text/plain (even "text/plain; x=application/json")
  // cross-site without a CORS preflight, which would let any site cast flags as its visitors.
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return null;
  const text = await readCapped(req);
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'local';
}

async function limited(limiter: RateLimit | undefined, ip: string): Promise<boolean> {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key: rateLimitKey(ip) });
  return !success;
}


async function lookup(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const raw = body?.prefixes;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LOOKUP_PREFIXES || !raw.every(isHashPrefix)) {
    return error(400, `prefixes must be 1-${MAX_LOOKUP_PREFIXES} lowercase hex strings of the right length`);
  }
  if (await limited(env.LOOKUP_LIMIT, clientIp(req))) return error(429, 'slow down');
  const prefixes = [...new Set(raw as string[])];
  const marks = prefixes.map((_, i) => `?${i + 1}`).join(',');
  const rs = await env.DB.prepare(`SELECT h, n FROM items WHERE prefix IN (${marks}) AND n > 0`)
    .bind(...prefixes)
    .all<LookupItem>();
  return json({ items: rs.results ?? [] });
}

async function setFlag(req: Request, env: Env, flag: boolean): Promise<Response> {
  const body = await readJson(req);
  const { h, platform, client } = body ?? {};
  if (!isFullHash(h) || !isPlatform(platform) || !isClientId(client)) return error(400, 'invalid flag');
  if (!env.VOTER_SALT) return error(503, 'flag service is not configured');
  // Tor exits would each count as a separate network.
  if (flag && (req.cf as { country?: string } | undefined)?.country === 'T1') return error(403, 'flags cannot be sent over Tor');
  if (await limited(env.FLAG_LIMIT, clientIp(req))) return error(429, 'slow down');
  const voter = await voterId(env.VOTER_SALT, client);
  const src = await networkBucket(env.VOTER_SALT, clientIp(req));
  // Stored to the hour: enough for the daily cap, too coarse to line flags up with other logs.
  const now = Date.now() - (Date.now() % HOUR_MS);
  // Distinct network buckets, not distinct install ids: one network counts once per post.
  const count = '(SELECT COUNT(DISTINCT src) FROM votes WHERE h = ?1)';

  if (flag) {
    const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM votes WHERE voter = ?1 AND created_at > ?2')
      .bind(voter, now - DAY_MS)
      .first<{ c: number }>();
    if ((recent?.c ?? 0) >= DAILY_FLAG_CAP) return error(429, 'daily flag limit reached');
    await env.DB.batch([
      // A network already counted for this post stores only a few votes, so made-up install ids
      // cannot pile up rows that every recount has to read.
      env.DB.prepare(
        `INSERT OR IGNORE INTO votes (h, voter, created_at, src)
         SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM votes WHERE h = ?1 AND src = ?4) < ?5`,
      ).bind(h, voter, now, src, MAX_VOTES_PER_NETWORK),
      env.DB.prepare(
        `INSERT INTO items (h, prefix, platform, n, created_at, updated_at)
         VALUES (?1, ?2, ?3, ${count}, ?4, ?4)
         ON CONFLICT (h) DO UPDATE SET n = ${count}, updated_at = ?4`,
      ).bind(h, hashPrefix(h), platform, now),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM votes WHERE h = ?1 AND voter = ?2').bind(h, voter),
      env.DB.prepare(`UPDATE items SET n = ${count}, updated_at = ?2 WHERE h = ?1`).bind(h, now),
    ]);
  }
  const row = await env.DB.prepare('SELECT n FROM items WHERE h = ?1').bind(h).first<{ n: number }>();
  const res: FlagResponse = { h, n: row?.n ?? 0, flagged: flag };
  return json(res);
}

const STATS_KEY = 'https://stats-cache.potatobrowser.invalid/v1';

/** Cached for a minute per location: the landing page asks on every view and the query scans items. */
async function stats(env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const hit = await cache?.match(STATS_KEY).catch(() => undefined);
  if (hit) return hit;
  const row = await env.DB.prepare('SELECT COUNT(*) AS posts, COALESCE(SUM(n), 0) AS flags FROM items WHERE n > 0').first<{
    posts: number;
    flags: number;
  }>();
  const res = json({ flaggedPosts: row?.posts ?? 0, flags: row?.flags ?? 0 }, 200, { 'cache-control': 'public, max-age=60' });
  if (cache) ctx.waitUntil(cache.put(STATS_KEY, res.clone()).catch(() => {}));
  return res;
}

async function latestRelease(req: Request, env: Env): Promise<Response> {
  const m = await latestManifest(env);
  if (!m) return error(404, 'no release yet');
  const info = releaseInfo(repoOf(env), m, new URL(req.url).origin);
  return json(info, 200, { 'cache-control': 'public, max-age=300' });
}

/** Downloads go to the GitHub Release the public workflow built; the site only counts them. */
async function download(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return error(405, 'method not allowed');
  const arch = url.pathname === '/download/mac-x64' ? 'x64' : url.pathname === '/download/mac-arm64' || url.pathname === '/download/mac' ? 'arm64' : null;
  if (!arch) return error(404, 'not found');
  const repo = repoOf(env);
  const m = await latestManifest(env);
  const location = m ? assetUrl(repo, m, arch) : `https://github.com/${repo}/releases/latest`;
  if (m && req.method === 'GET') {
    const day = new Date().toISOString().slice(0, 10);
    ctx.waitUntil(
      env.DB.prepare('INSERT INTO downloads (day, arch, n) VALUES (?1, ?2, 1) ON CONFLICT (day, arch) DO UPDATE SET n = n + 1')
        .bind(day, arch)
        .run()
        .catch(() => {}),
    );
  }
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

async function api(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const route = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;
  switch (route) {
    case 'GET /api/v1/health':
      return json({ ok: true });
    case 'POST /api/v1/lookup':
      return lookup(req, env);
    case 'POST /api/v1/flags':
      return setFlag(req, env, true);
    case 'DELETE /api/v1/flags':
      return setFlag(req, env, false);
    case 'GET /api/v1/stats':
      return stats(env, ctx);
    case 'GET /api/v1/releases/latest':
      return latestRelease(req, env);
    default:
      return error(url.pathname.startsWith('/api/v1/') ? 405 : 404, 'not found');
  }
}

const SITE = 'https://potatobrowser.com';

/** www and the old workers.dev pages move to the apex; the API and downloads still answer everywhere. */
function canonicalRedirect(url: URL): Response | null {
  const host = url.hostname;
  const legacy = host.endsWith('.workers.dev') && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/download/');
  if (host !== 'www.potatobrowser.com' && !legacy) return null;
  return Response.redirect(SITE + url.pathname + url.search, 301);
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    try {
      const redirect = canonicalRedirect(url);
      if (redirect) return redirect;
      if (url.pathname.startsWith('/api/')) return await api(req, env, url, ctx);
      if (url.pathname.startsWith('/download/')) return await download(req, env, url, ctx);
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error('request failed', url.pathname, err);
      return error(500, 'internal error');
    }
  },
} satisfies ExportedHandler<Env>;
