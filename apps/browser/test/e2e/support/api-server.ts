import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../../../web');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** The test Worker's /admin password, for reading what reached it. */
export const E2E_ADMIN_TOKEN = 'e2e-admin';

/** What the test Worker has stored: installs, reports, crash reports (its /admin summary). */
export async function apiSummary(): Promise<any> {
  const res = await fetch(`${process.env.POTATO_E2E_API}/admin/api/summary`, { headers: { authorization: 'Basic ' + Buffer.from(`admin:${E2E_ADMIN_TOKEN}`).toString('base64') } });
  if (!res.ok) throw new Error(`admin summary: ${res.status}`);
  return res.json();
}

export interface ApiServer {
  url: string;
  stop(): Promise<void>;
}

/** Runs the real flags Worker under `wrangler dev` with a throwaway local D1. */
export async function startApiServer(): Promise<ApiServer> {
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-d1-'));
  const wrangler = path.join(WEB, 'node_modules', '.bin', 'wrangler');
  // The Worker serves the AI Shield rules signed with a throwaway key (see scripts/shield-rules.mjs).
  const rules = spawnSync(process.execPath, [path.join(WEB, 'scripts', 'shield-rules.mjs')], { cwd: WEB, encoding: 'utf8' });
  if (rules.status !== 0) throw new Error(`shield rules failed:\n${rules.stdout}\n${rules.stderr}`);
  const migrate = spawnSync(wrangler, ['d1', 'migrations', 'apply', 'noaibrowser', '--local', '--persist-to', persist], {
    cwd: WEB,
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    encoding: 'utf8',
  });
  if (migrate.status !== 0) throw new Error(`D1 migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);
  const port = await freePort();
  const child: ChildProcess = spawn(
    wrangler,
    ['dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', 'VOTER_SALT:e2e-salt', '--var', `ADMIN_TOKEN:${E2E_ADMIN_TOKEN}`, '--show-interactive-dev-session=false'],
    { cwd: WEB, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/v1/health`);
      if (res.ok) break;
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
