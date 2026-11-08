import { isAppPlatform, isAppVersion, REPORT_FEATURES, REPORT_PROBLEMS, reportUrl } from '@potato/shared';
import { clientIp, DAY_MS, error, hourNow, json, limited, readJson } from './http';
import type { Env } from './index';

/** A flood of reports must not fill the database: a rolling day takes at most this many. */
export const MAX_REPORTS_PER_DAY = 2000;

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/** POST /api/v1/reports: "Report this site" from the shield and ad blocker panels. */
export async function addReport(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const { url, feature, problem, app, version } = body ?? {};
  const clean = typeof url === 'string' ? reportUrl(url) : null;
  if (!clean || !oneOf(REPORT_FEATURES, feature) || !oneOf(REPORT_PROBLEMS, problem) || !isAppPlatform(app) || !isAppVersion(version)) {
    return error(400, 'invalid report');
  }
  if (await limited(env.REPORT_LIMIT, clientIp(req))) return error(429, 'slow down');
  const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM reports WHERE created_at > ?1')
    .bind(Date.now() - DAY_MS)
    .first<{ c: number }>();
  if ((recent?.c ?? 0) >= MAX_REPORTS_PER_DAY) return error(429, 'too many reports today');
  const now = hourNow();
  await env.DB.prepare(
    `INSERT INTO reports (created_at, url, host, feature, problem, app, version, status, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'new', ?1)`,
  )
    .bind(now, clean, new URL(clean).hostname.replace(/^www\./, ''), feature, problem, app, version)
    .run();
  return json({ ok: true });
}
