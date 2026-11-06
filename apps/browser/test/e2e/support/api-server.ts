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

export interface ApiServer {
  url: string;
  stop(): Promise<void>;
}

/** Runs the real flags Worker under `wrangler dev` with a throwaway local D1. */
export async function startApiServer(): Promise<ApiServer> {
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-d1-'));
  const wrangler = path.join(WEB, 'node_modules', '.bin', 'wrangler');
  const migrate = spawnSync(wrangler, ['d1', 'migrations', 'apply', 'noaibrowser', '--local', '--persist-to', persist], {
    cwd: WEB,
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    encoding: 'utf8',
  });
  if (migrate.status !== 0) throw new Error(`D1 migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);
  const port = await freePort();
  const child: ChildProcess = spawn(
    wrangler,
    ['dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', 'VOTER_SALT:e2e-salt', '--show-interactive-dev-session=false'],
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
