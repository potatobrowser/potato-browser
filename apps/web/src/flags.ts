import {
  hashPrefix,
  isAppPlatform,
  isClientId,
  isFullHash,
  isHashPrefix,
  isPlatform,
  isVoteKind,
  MAX_LOOKUP_PREFIXES,
  type FlagResponse,
  type LookupItem,
  type VoteKind,
} from '@potato/shared';
import type { Env } from './index';
import { clientIp, DAY_MS, error, hourNow, isTor, json, limited, readJson, today } from './http';
import { DAILY_FLAG_CAP, MAX_VOTES_PER_NETWORK, networkBucket, voterId } from './lib';

export async function lookup(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const raw = body?.prefixes;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LOOKUP_PREFIXES || !raw.every(isHashPrefix)) {
    return error(400, `prefixes must be 1-${MAX_LOOKUP_PREFIXES} lowercase hex strings of the right length`);
  }
  if (await limited(env.LOOKUP_LIMIT, clientIp(req))) return error(429, 'slow down');
  const prefixes = [...new Set(raw as string[])];
  const marks = prefixes.map((_, i) => `?${i + 1}`).join(',');
  // Apps before 0.8.0 know only AI flags: they get the net count, so Not AI votes work for them too.
  const sql =
    body?.v === 2
      ? `SELECT h, n, d FROM items WHERE prefix IN (${marks}) AND n > 0`
      : `SELECT h, n - d AS n FROM items WHERE prefix IN (${marks}) AND n - d > 0`;
  const rs = await env.DB.prepare(sql)
    .bind(...prefixes)
    .all<LookupItem>();
  return json({ items: rs.results ?? [] });
}

const COUNT_AI = `(SELECT COUNT(DISTINCT src) FROM votes WHERE h = ?1 AND kind = 'ai')`;
const COUNT_HUMAN = `(SELECT COUNT(DISTINCT src) FROM votes WHERE h = ?1 AND kind = 'human')`;

/** POST casts (or changes) the install's vote on a post, DELETE takes it back. */
export async function setVote(req: Request, env: Env, ctx: ExecutionContext, remove: boolean): Promise<Response> {
  const body = await readJson(req);
  const { h, platform, client, vote, app } = body ?? {};
  if (!isFullHash(h) || !isPlatform(platform) || !isClientId(client)) return error(400, 'invalid flag');
  if (vote !== undefined && !isVoteKind(vote)) return error(400, 'invalid vote');
  if (!env.VOTER_SALT) return error(503, 'flag service is not configured');
  // Tor exits would each count as a separate network.
  if (!remove && isTor(req)) return error(403, 'flags cannot be sent over Tor');
  const ip = clientIp(req);
  if (await limited(env.FLAG_LIMIT, ip)) return error(429, 'slow down');
  const legacy = vote === undefined;
  const kind: VoteKind = legacy ? 'ai' : vote;
  const voter = await voterId(env.VOTER_SALT, client);
  const src = await networkBucket(env.VOTER_SALT, ip);
  const now = hourNow();

  if (!remove) {
    const prior = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM votes WHERE voter = ?2 AND created_at > ?5) AS recent,
              (SELECT kind FROM votes WHERE h = ?1 AND voter = ?2) AS mine,
              (SELECT COUNT(*) FROM votes WHERE h = ?1 AND src = ?3 AND kind = ?4 AND voter != ?2) AS shared`,
    )
      .bind(h, voter, src, kind, now - DAY_MS)
      .first<{ recent: number; mine: string | null; shared: number }>();
    if ((prior?.recent ?? 0) >= DAILY_FLAG_CAP) return error(429, 'daily flag limit reached');
    await env.DB.batch([
      // A changed mind keeps the network the vote was first cast from.
      env.DB.prepare('UPDATE votes SET kind = ?3, created_at = ?4 WHERE h = ?1 AND voter = ?2').bind(h, voter, kind, now),
      // Distinct networks count, not install ids, and a network that already counts for this post
      // stores only a few votes, so made-up ids cannot pile up rows that every recount reads.
      env.DB.prepare(
        `INSERT OR IGNORE INTO votes (h, voter, created_at, src, kind)
         SELECT ?1, ?2, ?3, ?4, ?6 WHERE NOT EXISTS (SELECT 1 FROM votes WHERE h = ?1 AND voter = ?2)
           AND (SELECT COUNT(*) FROM votes WHERE h = ?1 AND src = ?4) < ?5`,
      ).bind(h, voter, now, src, MAX_VOTES_PER_NETWORK, kind),
      env.DB.prepare(
        `INSERT INTO items (h, prefix, platform, n, d, created_at, updated_at)
         VALUES (?1, ?2, ?3, ${COUNT_AI}, ${COUNT_HUMAN}, ?4, ?4)
         ON CONFLICT (h) DO UPDATE SET n = ${COUNT_AI}, d = ${COUNT_HUMAN}, updated_at = ?4`,
      ).bind(h, hashPrefix(h), platform, now),
    ]);
    if (prior?.mine == null) {
      const family = ip.includes(':') && !/^::ffff:\d/i.test(ip) ? 'v6' : 'v4';
      const shared = (prior?.shared ?? 0) > 0;
      ctx.waitUntil(
        env.DB.prepare(
          `INSERT INTO vote_stats (day, app, family, counted, collapsed) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (day, app, family) DO UPDATE SET counted = counted + excluded.counted, collapsed = collapsed + excluded.collapsed`,
        )
          .bind(today(), isAppPlatform(app) ? app : 'legacy', family, shared ? 0 : 1, shared ? 1 : 0)
          .run()
          .catch(() => {}),
      );
    }
  } else {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM votes WHERE h = ?1 AND voter = ?2').bind(h, voter),
      env.DB.prepare(`UPDATE items SET n = ${COUNT_AI}, d = ${COUNT_HUMAN}, updated_at = ?2 WHERE h = ?1`).bind(h, now),
    ]);
  }
  const row = await env.DB.prepare('SELECT n, d FROM items WHERE h = ?1').bind(h).first<{ n: number; d: number }>();
  const n = row?.n ?? 0;
  const d = row?.d ?? 0;
  const res: FlagResponse = legacy
    ? { h, n: Math.max(0, n - d), flagged: !remove }
    : { h, n, d, flagged: !remove && kind === 'ai', vote: remove ? null : kind };
  return json(res);
}

const STATS_KEY = 'https://stats-cache.potatobrowser.invalid/v1';

/** Cached for a minute per location: the landing page asks on every view and the query scans items. */
export async function stats(env: Env, ctx: ExecutionContext): Promise<Response> {
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
