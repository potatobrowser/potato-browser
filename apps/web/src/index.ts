import { admin } from './admin';
import { updateCheck } from './checks';
import { iosCrash, macCrash, pruneCrashes } from './crashes';
import { filterList } from './filters';
import { lookup, setVote, stats } from './flags';
import { DAY_MS, error, json } from './http';
import { addReport } from './reports';
import { assetUrl, latestManifest, releaseInfo, repoOf, updateFeed, type Arch } from './releases';
import { shieldRules } from './shield';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Opt-in crash reports (minidumps from the Mac app, MetricKit payloads from iOS). */
  CRASHES?: R2Bucket;
  LOOKUP_LIMIT: RateLimit;
  FLAG_LIMIT: RateLimit;
  REPORT_LIMIT?: RateLimit;
  CRASH_LIMIT?: RateLimit;
  /** HMAC key that turns install ids into voter ids (secret). */
  VOTER_SALT?: string;
  /** Password of the /admin page (secret); without it the page does not exist. */
  ADMIN_TOKEN?: string;
  /** owner/name of the public repository whose GitHub Releases hold the builds. */
  SOURCE_REPO?: string;
}

async function latestRelease(req: Request, env: Env): Promise<Response> {
  const m = await latestManifest(env);
  if (!m) return error(404, 'no release yet');
  const info = releaseInfo(repoOf(env), m, new URL(req.url).origin);
  return json(info, 200, { 'cache-control': 'public, max-age=300' });
}

/** The in-app update feed; the browser asks for it every few hours and sends nothing about the user. */
async function updateFeedMac(env: Env, arch: Arch): Promise<Response> {
  const m = await latestManifest(env);
  const feed = m ? updateFeed(repoOf(env), m, arch) : null;
  if (!feed) return error(404, 'no update yet');
  return new Response(JSON.stringify(feed), {
    headers: { 'content-type': 'text/yaml; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
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
      return setVote(req, env, ctx, false);
    case 'DELETE /api/v1/flags':
      return setVote(req, env, ctx, true);
    case 'GET /api/v1/stats':
      return stats(env, ctx);
    case 'GET /api/v1/releases/latest':
      return latestRelease(req, env);
    case 'GET /api/v1/filters':
      return updateCheck(req, env, url, ctx);
    case 'GET /api/v1/shield/rules':
      return shieldRules();
    case 'POST /api/v1/reports':
      return addReport(req, env);
    case 'POST /api/v1/crashes':
      return macCrash(req, env);
    case 'POST /api/v1/crashes/ios':
      return iosCrash(req, env);
    default: {
      const m = /^GET \/api\/v1\/filters\/([^/]+)\/([^/]+)$/.exec(route);
      if (m) return filterList(m[1]!, m[2]!);
      const u = /^GET \/api\/v1\/update\/mac\/(arm64|x64)\/latest-mac\.yml$/.exec(route);
      if (u) return updateFeedMac(env, u[1] as Arch);
      return error(url.pathname.startsWith('/api/v1/') ? 405 : 404, 'not found');
    }
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

/** Daily: site reports and crash reports are kept 90 days at most, triaged reports 30. */
async function cleanup(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM reports WHERE created_at < ?1').bind(now - 90 * DAY_MS),
    env.DB.prepare("DELETE FROM reports WHERE status != 'new' AND updated_at < ?1").bind(now - 30 * DAY_MS),
  ]);
  await pruneCrashes(env);
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    try {
      const redirect = canonicalRedirect(url);
      if (redirect) return redirect;
      if (url.pathname.startsWith('/api/')) return await api(req, env, url, ctx);
      if (url.pathname.startsWith('/download/')) return await download(req, env, url, ctx);
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await admin(req, env, url);
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error('request failed', url.pathname, err);
      return error(500, 'internal error');
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(cleanup(env).catch((err) => console.error('cleanup failed', err)));
  },
} satisfies ExportedHandler<Env>;
