import { DAY_MS, error, json, readJson } from './http';
import type { Env } from './index';

/**
 * /admin: the maintainer's page for triaging site reports and reading the counters (active
 * installs, downloads, votes, crash reports). HTTP Basic auth with the ADMIN_TOKEN secret as the
 * password; without the secret the page does not exist.
 */

const enc = new TextEncoder();

async function authorized(req: Request, env: Env): Promise<boolean> {
  const token = env.ADMIN_TOKEN;
  const header = req.headers.get('authorization') ?? '';
  if (!token || !header.startsWith('Basic ')) return false;
  let pass = '';
  try {
    const decoded = atob(header.slice(6));
    pass = decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    return false;
  }
  const a = enc.encode(pass);
  const b = enc.encode(token);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

const challenge = () =>
  new Response('Sign in to see this page.', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="Potato Browser admin", charset="UTF-8"', 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
  });

const STATUSES = ['new', 'done', 'ignored'];

async function summary(env: Env): Promise<Response> {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
  const [installs, downloads, votes, flags, reports, crashDays, crashes] = await env.DB.batch([
    env.DB.prepare('SELECT day, app, version, n FROM installs WHERE day >= ?1 ORDER BY day').bind(since),
    env.DB.prepare('SELECT day, arch, n FROM downloads WHERE day >= ?1 ORDER BY day').bind(since),
    env.DB.prepare('SELECT day, app, family, counted, collapsed FROM vote_stats WHERE day >= ?1 ORDER BY day').bind(since),
    env.DB.prepare('SELECT COUNT(*) AS posts, COALESCE(SUM(n), 0) AS ai, COALESCE(SUM(d), 0) AS human FROM items WHERE n > 0 OR d > 0'),
    env.DB.prepare(
      `SELECT id, created_at, url, host, feature, problem, app, version, status FROM reports
       WHERE status = 'new' OR updated_at > ?1 ORDER BY created_at DESC LIMIT 1000`,
    ).bind(Date.now() - 7 * DAY_MS),
    env.DB.prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS day, app, version, process, COUNT(*) AS n FROM crashes
       WHERE created_at > ?1 GROUP BY day, app, version, process ORDER BY day`,
    ).bind(Date.now() - 30 * DAY_MS),
    env.DB.prepare('SELECT id, created_at, app, version, process, size, key FROM crashes ORDER BY created_at DESC LIMIT 50'),
  ]);
  return json({
    installs: installs!.results,
    downloads: downloads!.results,
    votes: votes!.results,
    flags: flags!.results[0],
    reports: reports!.results,
    crashDays: crashDays!.results,
    crashes: crashes!.results,
  });
}

async function setStatus(req: Request, env: Env, target: { id?: number; host?: string }): Promise<Response> {
  // Basic credentials ride along on cross-site requests too: a custom header forces a preflight,
  // which this origin never grants, and the Origin must be this site.
  if (req.headers.get('x-potato-admin') !== '1' || req.headers.get('origin') !== new URL(req.url).origin) return error(403, 'forbidden');
  const body = await readJson(req);
  const status = body?.status;
  if (typeof status !== 'string' || !STATUSES.includes(status)) return error(400, 'invalid status');
  const now = Date.now();
  const stmt = target.id
    ? env.DB.prepare('UPDATE reports SET status = ?1, updated_at = ?2 WHERE id = ?3').bind(status, now, target.id)
    : env.DB.prepare("UPDATE reports SET status = ?1, updated_at = ?2 WHERE host = ?3 AND status = 'new'").bind(status, now, target.host);
  const r = await stmt.run();
  return json({ ok: true, changed: r.meta.changes ?? 0 });
}

export async function admin(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ADMIN_TOKEN) return error(404, 'not found');
  if (!(await authorized(req, env))) return challenge();
  const path = url.pathname.replace(/\/+$/, '') || '/admin';
  if (req.method === 'GET' && path === '/admin') return page();
  if (req.method === 'GET' && path === '/admin/api/summary') return summary(env);
  const one = /^\/admin\/api\/reports\/(\d{1,12})$/.exec(path);
  if (req.method === 'POST' && one) return setStatus(req, env, { id: Number(one[1]) });
  const host = /^\/admin\/api\/reports\/host\/([a-z0-9.-]{1,253})$/.exec(path);
  if (req.method === 'POST' && host) return setStatus(req, env, { host: host[1] });
  return error(404, 'not found');
}

function page(): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return new Response(PAGE.replaceAll('__NONCE__', nonce), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    },
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Potato admin</title>
<style nonce="__NONCE__">
:root { --bg: #faf8f5; --card: #fff; --ink: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #9a5b2b; --warn: #b45309; }
@media (prefers-color-scheme: dark) { :root { --bg: #171412; --card: #221e1b; --ink: #f5f5f4; --muted: #a8a29e; --line: #3a3430; --accent: #e3a66e; --warn: #f59e0b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 60px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0 0 10px; }
.sub { color: var(--muted); margin: 0 0 18px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 18px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; overflow-x: auto; }
.stat b { display: block; font-size: 26px; font-variant-numeric: tabular-nums; }
.stat span { color: var(--muted); font-size: 13px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.url { word-break: break-all; }
.url a { color: var(--accent); }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; white-space: nowrap; }
.pill.showing { color: var(--warn); border-color: var(--warn); }
button { font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
button:hover { border-color: var(--accent); }
.host { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 16px 0 6px; }
.host h3 { margin: 0; font-size: 15px; }
.muted { color: var(--muted); }
.tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.tabs button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
</style>
</head>
<body>
<main>
<h1>Potato Browser</h1>
<p class="sub" id="when">Loading...</p>
<div class="grid" id="stats"></div>
<div class="card"><h2>Active installs per day</h2><div id="installs"></div></div>
<div class="card"><h2>Versions today</h2><div id="versions"></div></div>
<div class="card"><h2>Site reports</h2><div class="tabs" id="tabs"></div><div id="reports"></div></div>
<div class="card"><h2>Votes per day</h2><p class="muted">Collapsed: a vote from a network that already counted for that post. A high share on phones means shared carrier networks swallow real votes.</p><div id="votes"></div></div>
<div class="card"><h2>Downloads per day</h2><div id="downloads"></div></div>
<div class="card"><h2>Crash reports</h2><p class="muted">Get one with: npx wrangler r2 object get potatobrowser-crashes/&lt;key&gt; --remote --file crash.dmp</p><div id="crashes"></div></div>
</main>
<script nonce="__NONCE__">
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
const table = (head, rows, nums = []) => {
  if (!rows.length) return el('p', { class: 'muted' }, 'Nothing yet.');
  return el('table', {}, el('thead', {}, el('tr', {}, ...head.map((h, i) => el('th', nums.includes(i) ? { class: 'num' } : {}, h)))),
    el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c, i) => el('td', nums.includes(i) ? { class: 'num' } : {}, c))))));
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const fmt = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
let data = null;
let filter = 'new';

async function load() {
  const res = await fetch('/admin/api/summary', { headers: { accept: 'application/json' } });
  data = await res.json();
  render();
}

async function setStatus(path, status) {
  await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-potato-admin': '1' }, body: JSON.stringify({ status }) });
  await load();
}

function render() {
  $('when').textContent = 'Updated ' + new Date().toLocaleTimeString();
  const days = [...new Set(data.installs.map((r) => r.day))].sort();
  const last = days.at(-1);
  const on = (day, app) => sum(data.installs.filter((r) => r.day === day && r.app === app).map((r) => r.n));
  const newReports = data.reports.filter((r) => r.status === 'new');
  $('stats').replaceChildren(
    ...[
      ['Mac installs today', last ? on(last, 'mac') : 0],
      ['iPhone and iPad today', last ? on(last, 'ios') : 0],
      ['New site reports', newReports.length],
      ['Flagged posts', data.flags?.posts ?? 0],
      ['Not AI votes', data.flags?.human ?? 0],
      ['Crash reports, 30 days', sum(data.crashDays.map((r) => r.n))],
    ].map(([label, n]) => el('div', { class: 'card stat' }, el('b', {}, Number(n).toLocaleString()), el('span', {}, label))),
  );
  $('installs').replaceChildren(table(['Day', 'Mac', 'iOS', 'Older apps'], days.slice().reverse().map((d) => [d, on(d, 'mac'), on(d, 'ios'), sum(data.installs.filter((r) => r.day === d && r.version === 'legacy').map((r) => r.n))]), [1, 2, 3]));
  $('versions').replaceChildren(table(['App', 'Version', 'Checks'], data.installs.filter((r) => r.day === last).sort((a, b) => b.n - a.n).map((r) => [r.app, r.version, r.n]), [2]));

  const counts = { new: newReports.length, done: data.reports.filter((r) => r.status === 'done').length, ignored: data.reports.filter((r) => r.status === 'ignored').length };
  $('tabs').replaceChildren(...['new', 'done', 'ignored'].map((s) => el('button', { 'aria-pressed': String(filter === s), onclick: () => { filter = s; render(); } }, s + ' (' + counts[s] + ')')));
  const shown = data.reports.filter((r) => r.status === filter);
  const byHost = new Map();
  for (const r of shown) byHost.set(r.host, [...(byHost.get(r.host) ?? []), r]);
  const groups = [...byHost].sort((a, b) => b[1].length - a[1].length);
  $('reports').replaceChildren(...(groups.length ? groups.flatMap(([host, rows]) => [
    el('div', { class: 'host' }, el('h3', {}, host), el('span', { class: 'muted' }, rows.length + (rows.length === 1 ? ' report' : ' reports')),
      ...(filter === 'new' ? [el('button', { onclick: () => setStatus('/admin/api/reports/host/' + host, 'done') }, 'All done')] : [])),
    table(['When', 'Problem', 'Page', 'App', ''], rows.map((r) => [
      fmt(r.created_at),
      el('span', { class: 'pill ' + r.problem }, (r.feature === 'shield' ? (r.problem === 'showing' ? 'AI still showing' : 'Shield broke it') : (r.problem === 'showing' ? 'Ads still showing' : 'Ad blocker broke it'))),
      el('span', { class: 'url' }, /^https?:\/\//.test(r.url) ? el('a', { href: r.url, rel: 'noreferrer noopener', target: '_blank' }, r.url) : r.url),
      r.app + ' ' + r.version,
      filter === 'new'
        ? el('span', {}, el('button', { onclick: () => setStatus('/admin/api/reports/' + r.id, 'done') }, 'Done'), ' ', el('button', { onclick: () => setStatus('/admin/api/reports/' + r.id, 'ignored') }, 'Ignore'))
        : el('button', { onclick: () => setStatus('/admin/api/reports/' + r.id, 'new') }, 'Reopen'),
    ])),
  ]) : [el('p', { class: 'muted' }, 'No ' + filter + ' reports.')]));

  const vdays = [...new Set(data.votes.map((r) => r.day))].sort().reverse();
  $('votes').replaceChildren(table(['Day', 'App', 'IP', 'Counted', 'Collapsed'], vdays.flatMap((d) => data.votes.filter((r) => r.day === d).map((r) => [d, r.app, r.family, r.counted, r.collapsed])), [3, 4]));
  const ddays = [...new Set(data.downloads.map((r) => r.day))].sort().reverse();
  const dl = (d, a) => sum(data.downloads.filter((r) => r.day === d && r.arch === a).map((r) => r.n));
  $('downloads').replaceChildren(table(['Day', 'Apple silicon', 'Intel'], ddays.map((d) => [d, dl(d, 'arm64'), dl(d, 'x64')]), [1, 2]));
  $('crashes').replaceChildren(
    table(['Day', 'App', 'Version', 'Process', 'Reports'], data.crashDays.slice().reverse().map((r) => [r.day, r.app, r.version, r.process, r.n]), [4]),
    el('h2', {}, 'Latest'),
    table(['When', 'App', 'Process', 'Size', 'Key'], data.crashes.map((r) => [fmt(r.created_at), r.app + ' ' + r.version, r.process, Math.round(r.size / 1024) + ' KB', el('span', { class: 'url' }, r.key)]), [3]),
  );
}

load().catch((e) => { $('when').textContent = 'Could not load: ' + e.message; });
</script>
</body>
</html>`;
