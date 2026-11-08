// The real flags Worker under `wrangler dev` with a throwaway local D1 (as in the Mac suite),
// plus helpers that seed flags as other people and read counts.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const WEB = path.resolve(import.meta.dirname, '../../../web');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

const ADMIN_TOKEN = 'e2e-admin';

/** What the test Worker stored (its /admin summary): installs, reports, crash reports. */
export async function apiSummary(base) {
  const res = await fetch(`${base}/admin/api/summary`, { headers: { authorization: 'Basic ' + Buffer.from(`admin:${ADMIN_TOKEN}`).toString('base64') } });
  if (!res.ok) throw new Error(`admin summary: ${res.status}`);
  return res.json();
}

export async function startApiServer() {
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-ios-d1-'));
  const wrangler = path.join(WEB, 'node_modules', '.bin', 'wrangler');
  const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };
  // The Worker serves the AI Shield rules signed with a throwaway key (apps/web/scripts/shield-rules.mjs).
  const rules = spawnSync(process.execPath, [path.join(WEB, 'scripts', 'shield-rules.mjs')], { cwd: WEB, env, encoding: 'utf8' });
  if (rules.status !== 0) throw new Error(`shield rules failed:\n${rules.stdout}\n${rules.stderr}`);
  const migrate = spawnSync(wrangler, ['d1', 'migrations', 'apply', 'noaibrowser', '--local', '--persist-to', persist], { cwd: WEB, env, encoding: 'utf8' });
  if (migrate.status !== 0) throw new Error(`D1 migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);
  const port = await freePort();
  const child = spawn(wrangler, ['dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', 'VOTER_SALT:e2e-salt', '--var', `ADMIN_TOKEN:${ADMIN_TOKEN}`, '--show-interactive-dev-session=false'], {
    cwd: WEB,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`);
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error(`wrangler dev did not start:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    url,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(persist, { recursive: true, force: true });
    },
  };
}

/** AI flags (n) and Not AI votes (d) of a key, as the server counts them. */
export async function voteCounts(api, key) {
  const h = hashKey(key);
  const res = await fetch(`${api}/api/v1/lookup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [h.slice(0, 5)], v: 2 }) });
  const item = (await res.json()).items.find((i) => i.h === h);
  return { n: item?.n ?? 0, d: item?.d ?? 0 };
}

export const hashKey = (key) => createHash('sha256').update(`noai-flag:v1:${key}`).digest('hex');

let seq = 0;
/** Flags a content key as `count` other people, each from another network. */
export async function flagAsOthers(api, key, count) {
  const h = hashKey(key);
  const platform = key.slice(0, key.indexOf(':'));
  for (let i = 0; i < count; i++) {
    const client = (Date.now().toString(16) + (seq++).toString(16).padStart(8, '0') + Math.random().toString(16).slice(2)).slice(0, 32).padEnd(32, '0');
    const res = await fetch(`${api}/api/v1/flags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.${process.pid % 200}.${seq % 250}.9` },
      body: JSON.stringify({ h, platform, client }),
    });
    if (!res.ok) throw new Error(`seeding flag failed: ${res.status} ${await res.text()}`);
  }
}

export async function flagCount(api, key) {
  const h = hashKey(key);
  const res = await fetch(`${api}/api/v1/lookup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [h.slice(0, 5)] }) });
  const items = (await res.json()).items ?? [];
  return items.find((i) => i.h === h)?.n ?? 0;
}
