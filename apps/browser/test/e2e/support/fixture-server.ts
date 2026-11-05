import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const SITES = path.resolve(__dirname, '../../fixtures/sites');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveFile(host: string, pathname: string): string | null {
  const base = path.join(SITES, host);
  const clean = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const candidates = [
    path.join(base, clean),
    path.join(base, clean + '.html'),
    path.join(base, clean, 'index.html'),
  ];
  for (const c of candidates) {
    if (c.startsWith(base) && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  // Fallback page per host (SPA-style routes like /r/test/comments/abc/...).
  const fallback = path.join(base, '_fallback.html');
  return fs.existsSync(fallback) ? fallback : null;
}

/** Dynamic routes used by shell tests (downloads, cookies, permissions, popups...). */
function dynamic(host: string, url: URL, res: http.ServerResponse): boolean {
  if (host !== 'site.test') return false;
  const p = url.pathname;
  if (p === '/download.bin') {
    const body = Buffer.alloc(256 * 1024, 7);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="report.bin"',
      'content-length': String(body.length),
    });
    res.end(body);
    return true;
  }
  if (p === '/title') {
    const t = url.searchParams.get('t') ?? 'Untitled';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${t.replace(/[<>&]/g, '')}</title><h1>${t.replace(/[<>&]/g, '')}</h1><p>Generated page.</p>`);
    return true;
  }
  if (p === '/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Slow</title><p>done</p>');
    }, 3000);
    return true;
  }
  if (p === '/async/folsrch' || p === '/api/ai-endpoint') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('AI content');
    return true;
  }
  return false;
}

export interface FixtureServer {
  url: string;
  port: number;
  requests: string[];
  close(): Promise<void>;
}

/**
 * Serves fixtures for any host. The browser's test-mode proxy sends
 * `https://www.reddit.com/r/test/` here as `/www.reddit.com/r/test/`.
 */
export function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [, host = '', ...rest] = url.pathname.split('/');
    const pathname = '/' + rest.join('/');
    requests.push(`${req.method} ${host}${pathname}${url.search}`);
    const inner = new URL(pathname + url.search, `https://${host}`);
    if (dynamic(host, inner, res)) return;
    // Every Google host serves the same search fixture (any ccTLD).
    const siteHost = /^(www\.)?google\.[a-z.]+$/.test(host) ? 'www.google.com' : host;
    const file = resolveFile(siteHost, pathname === '/' ? '/index.html' : pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Not found</title><p>No fixture for ${host}${pathname}</p>`);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
