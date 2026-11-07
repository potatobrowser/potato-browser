// The Mac app's fixture sites, served to the simulator under their real hostnames: an HTTP
// CONNECT proxy (WKWebsiteDataStore.proxyConfigurations in test runs) that terminates TLS with
// a certificate from a test CA the simulator trusts, and logs every request it gets.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import tls from 'node:tls';

export const SITES = path.resolve(import.meta.dirname, '../../../browser/test/fixtures/sites');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** Fixture hosts plus the extra names pages use (Google ccTLDs, unknown hosts for error pages). */
export function fixtureHosts() {
  const hosts = fs.readdirSync(SITES).filter((d) => fs.statSync(path.join(SITES, d)).isDirectory());
  return [...new Set([...hosts, 'google.com', 'www.google.de', 'www.google.co.uk', 'youtube.com', 'm.youtube.com', 'reddit.com', 'twitter.com', 'linkedin.com'])];
}

/** A CA and a server certificate for every fixture host (made once, kept in `dir`). */
export function ensureCerts(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  const run = (...args) => execFileSync('openssl', args, { stdio: 'pipe' });
  if (!fs.existsSync(f('ca.crt'))) {
    run('genrsa', '-out', f('ca.key'), '2048');
    run('req', '-x509', '-new', '-key', f('ca.key'), '-sha256', '-days', '3650', '-subj', '/CN=Potato Browser Test CA', '-out', f('ca.crt'));
  }
  const hosts = fixtureHosts();
  const marker = f('hosts.txt');
  if (!fs.existsSync(f('server.crt')) || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== hosts.join('\n')) {
    run('genrsa', '-out', f('server.key'), '2048');
    run('req', '-new', '-key', f('server.key'), '-subj', '/CN=potato-fixtures', '-out', f('server.csr'));
    fs.writeFileSync(
      f('ext.cnf'),
      `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${hosts.map((h) => `DNS:${h}`).join(',')}\n`,
    );
    run('x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('server.crt'), '-days', '365', '-sha256', '-extfile', f('ext.cnf'));
    fs.writeFileSync(marker, hosts.join('\n'));
  }
  return { ca: f('ca.crt'), key: f('server.key'), cert: f('server.crt') };
}

function resolveFile(host, pathname) {
  const base = path.join(SITES, host);
  const clean = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  for (const c of [path.join(base, clean), path.join(base, clean + '.html'), path.join(base, clean, 'index.html')]) {
    if (c.startsWith(base) && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  const fallback = path.join(base, '_fallback.html');
  return fs.existsSync(fallback) ? fallback : null;
}

/** Dynamic routes of the Mac suite's fixture server (downloads, slow pages, AI endpoints). */
function dynamic(host, url, res) {
  if (host !== 'site.test') {
    if ((host === 'www.google.com' && url.pathname === '/async/folsrch') || url.pathname === '/api/ai-endpoint') {
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      res.end('AI content');
      return true;
    }
    return false;
  }
  const p = url.pathname;
  if (p === '/download.bin') {
    const body = Buffer.alloc(256 * 1024, 7);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.bin"', 'content-length': String(body.length) });
    res.end(body);
    return true;
  }
  if (p === '/title') {
    const t = (url.searchParams.get('t') ?? 'Untitled').replace(/[<>&]/g, '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${t}</title><h1>${t}</h1><p>Generated page.</p>`);
    return true;
  }
  if (p === '/echo-headers') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({}));
    return true;
  }
  return false;
}

export async function startFixtureProxy({ certDir }) {
  const { key, cert } = ensureCerts(certDir);
  const secureContext = tls.createSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  const requests = [];
  const log = [];
  const site = http.createServer((req, res) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    const url = new URL(req.url ?? '/', `https://${host}`);
    requests.push(`${req.method} ${host}${url.pathname}${url.search}`);
    log.push({ at: Date.now(), host, path: url.pathname });
    if (dynamic(host, url, res)) return;
    const siteHost = /^(www\.)?google\.[a-z.]+$/.test(host) ? 'www.google.com' : host;
    const file = fs.existsSync(path.join(SITES, siteHost)) ? resolveFile(siteHost, url.pathname === '/' ? '/index.html' : url.pathname) : null;
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Not found</title><p>No fixture for ${host}${url.pathname}</p>`);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  const proxy = http.createServer((req, res) => site.emit('request', req, res));
  proxy.on('connect', (req, socket, head) => {
    const port = String(req.url).split(':')[1] ?? '443';
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) socket.unshift(head);
    if (port === '443') {
      const t = new tls.TLSSocket(socket, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
      t.on('error', () => {});
      site.emit('connection', t);
    } else {
      site.emit('connection', socket);
    }
    socket.on('error', () => {});
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  return {
    port: proxy.address().port,
    requests,
    log,
    /** Hosts requested between two times. */
    hostsBetween: (from, to) => log.filter((l) => l.at >= from && l.at <= to).map((l) => l.host),
    close: () => new Promise((r) => proxy.close(() => r())),
  };
}
