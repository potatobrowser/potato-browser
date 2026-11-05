import {
  hashPrefix,
  isClientId,
  isFullHash,
  isHashPrefix,
  isPlatform,
  MAX_LOOKUP_PREFIXES,
  type FlagResponse,
  type LookupItem,
  type ReleaseInfo,
} from '@noai/shared';
import { DAILY_FLAG_CAP, voterId } from './lib';

export interface Env {
  DB: D1Database;
  RELEASES: R2Bucket;
  ASSETS: Fetcher;
  LOOKUP_LIMIT: RateLimit;
  FLAG_LIMIT: RateLimit;
  /** HMAC key that turns install ids into voter ids (secret). */
  VOTER_SALT?: string;
}

const DAY_MS = 86_400_000;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

const error = (status: number, message: string) => json({ error: message }, status);

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return null;
  const text = await req.text();
  if (text.length > 16_384) return null;
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

async function limited(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key });
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
  if (await limited(env.FLAG_LIMIT, clientIp(req))) return error(429, 'slow down');
  const voter = await voterId(env.VOTER_SALT, client);
  const now = Date.now();

  if (flag) {
    const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM votes WHERE voter = ?1 AND created_at > ?2')
      .bind(voter, now - DAY_MS)
      .first<{ c: number }>();
    if ((recent?.c ?? 0) >= DAILY_FLAG_CAP) return error(429, 'daily flag limit reached');
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO votes (h, voter, created_at) VALUES (?1, ?2, ?3)').bind(h, voter, now),
      env.DB.prepare(
        `INSERT INTO items (h, prefix, platform, n, created_at, updated_at)
         VALUES (?1, ?2, ?3, (SELECT COUNT(*) FROM votes WHERE h = ?1), ?4, ?4)
         ON CONFLICT (h) DO UPDATE SET n = (SELECT COUNT(*) FROM votes WHERE h = ?1), updated_at = ?4`,
      ).bind(h, hashPrefix(h), platform, now),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM votes WHERE h = ?1 AND voter = ?2').bind(h, voter),
      env.DB.prepare('UPDATE items SET n = (SELECT COUNT(*) FROM votes WHERE h = ?1), updated_at = ?2 WHERE h = ?1').bind(h, now),
    ]);
  }
  const row = await env.DB.prepare('SELECT n FROM items WHERE h = ?1').bind(h).first<{ n: number }>();
  const res: FlagResponse = { h, n: row?.n ?? 0, flagged: flag };
  return json(res);
}

async function stats(env: Env): Promise<Response> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS posts, COALESCE(SUM(n), 0) AS flags FROM items WHERE n > 0').first<{
    posts: number;
    flags: number;
  }>();
  return json({ flaggedPosts: row?.posts ?? 0, flags: row?.flags ?? 0 }, 200, { 'cache-control': 'public, max-age=60' });
}

interface LatestManifest extends ReleaseInfo {
  files: { arm64: string; x64: string };
  sizes?: { arm64?: number; x64?: number };
  sha256?: { arm64?: string; x64?: string };
}

async function latestManifest(env: Env): Promise<LatestManifest | null> {
  const obj = await env.RELEASES.get('latest.json');
  if (!obj) return null;
  try {
    return (await obj.json()) as LatestManifest;
  } catch {
    return null;
  }
}

async function latestRelease(req: Request, env: Env): Promise<Response> {
  const m = await latestManifest(env);
  if (!m) return error(404, 'no release yet');
  const origin = new URL(req.url).origin;
  const info: ReleaseInfo & Pick<LatestManifest, 'sizes' | 'sha256'> = {
    version: m.version,
    date: m.date,
    notes: m.notes,
    downloads: { arm64: `${origin}/download/mac-arm64`, x64: `${origin}/download/mac-x64` },
    sizes: m.sizes,
    sha256: m.sha256,
  };
  return json(info, 200, { 'cache-control': 'public, max-age=300' });
}

async function download(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return error(405, 'method not allowed');
  const arch = url.pathname === '/download/mac-x64' ? 'x64' : url.pathname === '/download/mac-arm64' || url.pathname === '/download/mac' ? 'arm64' : null;
  if (!arch) return error(404, 'not found');
  const m = await latestManifest(env);
  const key = m?.files[arch];
  if (!m || !key) return error(404, 'no release yet');
  const filename = key.split('/').pop()!;
  const headers = new Headers({
    'content-type': 'application/x-apple-diskimage',
    'content-disposition': `attachment; filename="${filename}"`,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    const head = await env.RELEASES.head(key);
    if (!head) return error(404, 'file missing');
    head.writeHttpMetadata(headers);
    headers.set('content-type', 'application/x-apple-diskimage');
    headers.set('content-length', String(head.size));
    headers.set('etag', head.httpEtag);
    return new Response(null, { headers });
  }
  const obj = await env.RELEASES.get(key, { range: req.headers, onlyIf: req.headers });
  if (!obj) return error(404, 'file missing');
  headers.set('etag', obj.httpEtag);
  if (!('body' in obj)) return new Response(null, { status: 304, headers });
  const body = obj as R2ObjectBody;
  const range = body.range as { offset?: number; length?: number } | undefined;
  if (range && req.headers.has('range')) {
    const offset = range.offset ?? 0;
    const length = range.length ?? body.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${body.size}`);
    headers.set('content-length', String(length));
    return new Response(body.body, { status: 206, headers });
  }
  headers.set('content-length', String(body.size));
  const day = new Date().toISOString().slice(0, 10);
  ctx.waitUntil(
    env.DB.prepare('INSERT INTO downloads (day, arch, n) VALUES (?1, ?2, 1) ON CONFLICT (day, arch) DO UPDATE SET n = n + 1')
      .bind(day, arch)
      .run()
      .catch(() => {}),
  );
  return new Response(body.body, { headers });
}

async function api(req: Request, env: Env, url: URL): Promise<Response> {
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
      return stats(env);
    case 'GET /api/v1/releases/latest':
      return latestRelease(req, env);
    default:
      return error(url.pathname.startsWith('/api/v1/') ? 405 : 404, 'not found');
  }
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      if (url.pathname.startsWith('/download/')) return await download(req, env, url, ctx);
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error('request failed', url.pathname, err);
      return error(500, 'internal error');
    }
  },
} satisfies ExportedHandler<Env>;
