import { isAppPlatform, isAppVersion, type UpdateCheckResponse } from '@potato/shared';
import { filterRevisions, listIds, MAX_FILTER_LISTS } from './filters';
import { error, json, today } from './http';
import type { Env } from './index';
import { shieldInfo } from './shield';

/** Apps before 0.8.0 do not say which app they are, but their HTTP clients do. */
function legacyApp(req: Request): string {
  const ua = req.headers.get('user-agent') ?? '';
  if (/CFNetwork|Darwin\//.test(ua)) return 'ios';
  if (/Macintosh/.test(ua)) return 'mac';
  return 'unknown';
}

/**
 * GET /api/v1/filters?lists=a,b&app=mac&v=0.8.0, the daily check of every install: the latest
 * filter list revisions and AI Shield rules. It adds one to today's count for that app and
 * version; nothing else about the request is kept.
 */
export async function updateCheck(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const ids = listIds(url);
  const app = url.searchParams.get('app');
  const version = url.searchParams.get('v');
  const known = isAppPlatform(app) && isAppVersion(version);
  // Apps before 0.8.0 always name lists; newer ones may only want the shield rules.
  if (!ids || (!ids.length && !known)) return error(400, `lists must be 1-${MAX_FILTER_LISTS} list ids`);
  const lists = await filterRevisions(ids);
  ctx.waitUntil(
    env.DB.prepare('INSERT INTO installs (day, app, version, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT (day, app, version) DO UPDATE SET n = n + 1')
      .bind(today(), known ? app : legacyApp(req), known ? version : 'legacy')
      .run()
      .catch(() => {}),
  );
  const body: UpdateCheckResponse = { lists, shield: shieldInfo() };
  return json(body, 200, { 'cache-control': 'private, max-age=900' });
}
