import { env, exports } from 'cloudflare:workers';
import { hashContentKey, hashPrefix } from '@potato/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAILY_FLAG_CAP, MAX_VOTES_PER_NETWORK, networkPrefix, rateLimitKey, voterId } from '../src/lib';
import { resetManifestCache } from '../src/releases';

const BASE = 'https://potatobrowser.test';
const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;

function client(n: number): string {
  return n.toString(16).padStart(32, '0');
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await worker.fetch(
    new Request(BASE + path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, headers: res.headers, text };
}

// By default every install flags from its own network, like real users do.
const netOf = (c: string) => `10.${parseInt(c.slice(-4), 16) % 250}.${parseInt(c.slice(-8, -4), 16) % 250}.7`;
const flag = (h: string, c: string, platform = 'reddit', ip = netOf(c)) =>
  call('POST', '/api/v1/flags', { h, platform, client: c }, { 'cf-connecting-ip': ip });
const unflag = (h: string, c: string, platform = 'reddit') => call('DELETE', '/api/v1/flags', { h, platform, client: c });
const lookup = (prefixes: string[]) => call('POST', '/api/v1/lookup', { prefixes });

describe('flags API', () => {
  it('reports health', async () => {
    const r = await call('GET', '/api/v1/health');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });

  it('counts each install once per post and supports undo', async () => {
    const h = await hashContentKey('reddit:t3_once');
    expect((await flag(h, client(1))).json).toEqual({ h, n: 1, flagged: true });
    expect((await flag(h, client(1))).json.n).toBe(1); // same install again: no double count
    expect((await flag(h, client(2))).json.n).toBe(2);
    expect((await unflag(h, client(1))).json).toEqual({ h, n: 1, flagged: false });
    expect((await unflag(h, client(1))).json.n).toBe(1); // undo is idempotent
  });

  it('counts one network once per post, whatever install ids it sends', async () => {
    const h = await hashContentKey('reddit:t3_stuffed');
    for (let i = 0; i < 5; i++) {
      const r = await flag(h, client(700 + i), 'reddit', `203.0.113.${10 + i}`); // same /24
      expect(r.json.n).toBe(1);
    }
    expect((await flag(h, client(800), 'reddit', '2001:db8:aa:1::5')).json.n).toBe(2);
    expect((await flag(h, client(801), 'reddit', '2001:db8:aa:ffff::9')).json.n).toBe(2); // same /48
    expect((await flag(h, client(802), 'reddit', '198.51.100.20')).json.n).toBe(3);
    // Undo removes that network's contribution only when its last vote goes.
    expect((await unflag(h, client(802))).json.n).toBe(2);
    const rows = await env.DB.prepare('SELECT DISTINCT src FROM votes WHERE h = ?').bind(h).all<{ src: string }>();
    for (const r of rows.results) expect(r.src).toMatch(/^[0-9a-f]{4}$/);
  });

  it('derives networks from IPv4, IPv6 and mapped addresses', () => {
    expect(networkPrefix('203.0.113.77')).toBe('203.0.113');
    expect(networkPrefix('::ffff:203.0.113.77')).toBe('203.0.113');
    expect(networkPrefix('2001:db8:aa:1::5')).toBe('2001:db8:aa');
    expect(networkPrefix('2001:0db8:00aa:ffff:1:2:3:4')).toBe('2001:db8:aa');
    expect(networkPrefix('2001:db8::1')).toBe('2001:db8:0');
    expect(networkPrefix('::1')).toBe('0:0:0');
    expect(networkPrefix('local')).toBe('local');
  });

  it('answers lookups by prefix and never lists unflagged posts', async () => {
    const a = await hashContentKey('x:1790000000000000000');
    const b = await hashContentKey('x:1790000000000000001');
    await flag(a, client(10), 'x');
    await flag(a, client(11), 'x');
    await flag(b, client(12), 'x');
    await unflag(b, client(12), 'x');
    const r = await lookup([hashPrefix(a), hashPrefix(b)]);
    expect(r.status).toBe(200);
    const items = r.json.items as { h: string; n: number }[];
    expect(items.find((i) => i.h === a)?.n).toBe(2);
    expect(items.find((i) => i.h === b)).toBeUndefined();
  });

  it('stores voters only as HMACs of the install id', async () => {
    const h = await hashContentKey('instagram:C9xYzAbCdEf');
    await flag(h, client(77), 'instagram');
    const rows = await env.DB.prepare('SELECT voter FROM votes WHERE h = ?').bind(h).all<{ voter: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.voter).not.toContain(client(77));
    expect(rows.results[0]!.voter).toBe(await voterId('test-salt-for-voter-ids', client(77)));
    const item = await env.DB.prepare('SELECT * FROM items WHERE h = ?').bind(h).first<Record<string, unknown>>();
    expect(Object.keys(item!).sort()).toEqual(['created_at', 'h', 'n', 'platform', 'prefix', 'updated_at']);
    const vote = await env.DB.prepare('SELECT * FROM votes WHERE h = ?').bind(h).first<Record<string, unknown>>();
    expect(Object.keys(vote!).sort()).toEqual(['created_at', 'h', 'src', 'voter']);
  });

  it('rejects malformed input', async () => {
    const h = await hashContentKey('reddit:t3_bad');
    expect((await flag('not-a-hash', client(1))).status).toBe(400);
    expect((await flag(h, 'short')).status).toBe(400);
    expect((await flag(h, client(1), 'myspace')).status).toBe(400);
    expect((await lookup([])).status).toBe(400);
    expect((await lookup(['ABCDE'])).status).toBe(400);
    expect((await lookup(Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(5, '0')))).status).toBe(400);
    const notJson = await worker.fetch(new Request(BASE + '/api/v1/lookup', { method: 'POST', body: '{"prefixes":["abcde"]}' }));
    expect(notJson.status).toBe(400);
    expect((await call('GET', '/api/v1/nope')).status).toBe(405);
  });

  it('caps flags per install per day', async () => {
    const voter = await voterId('test-salt-for-voter-ids', client(500));
    const now = Date.now();
    const stmts = Array.from({ length: DAILY_FLAG_CAP }, (_, i) =>
      env.DB.prepare('INSERT INTO votes (h, voter, created_at) VALUES (?, ?, ?)').bind(i.toString(16).padStart(64, '0'), voter, now),
    );
    await env.DB.batch(stmts);
    const h = await hashContentKey('reddit:t3_overcap');
    const r = await flag(h, client(500));
    expect(r.status).toBe(429);
    // Another install is unaffected.
    expect((await flag(h, client(501))).status).toBe(200);
  });

  it('returns aggregate stats', async () => {
    const h = await hashContentKey('youtube:dQw4w9WgXcQ');
    await flag(h, client(900), 'youtube');
    const r = await call('GET', '/api/v1/stats');
    expect(r.status).toBe(200);
    expect(r.json.flaggedPosts).toBeGreaterThanOrEqual(1);
    expect(r.json.flags).toBeGreaterThanOrEqual(1);
  });
});

describe('abuse limits', () => {
  it('only takes exact application/json, so web pages cannot flag cross-site', async () => {
    const h = await hashContentKey('reddit:t3_csrf');
    for (const type of ['text/plain; x=application/json', 'text/plain', 'application/x-www-form-urlencoded']) {
      const res = await worker.fetch(
        new Request(BASE + '/api/v1/flags', {
          method: 'POST',
          headers: { 'content-type': type, 'cf-connecting-ip': '198.18.0.1' },
          body: JSON.stringify({ h, platform: 'reddit', client: client(4000) }),
        }),
      );
      expect(res.status).toBe(400);
    }
    const ok = await call('POST', '/api/v1/flags', { h, platform: 'reddit', client: client(4000) }, { 'content-type': 'application/json; charset=utf-8' });
    expect(ok.json.n).toBe(1);
  });

  it('rejects oversized bodies, declared or streamed', async () => {
    const big = JSON.stringify({ prefixes: ['00000'], pad: 'x'.repeat(20_000) });
    expect((await call('POST', '/api/v1/lookup', JSON.parse(big))).status).toBe(400);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const res = await worker.fetch(new Request(BASE + '/api/v1/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit));
    expect(res.status).toBe(400);
  });

  it('keys rate limits on the IPv6 /64, not the address', () => {
    expect(rateLimitKey('2001:db8:aa:1::5')).toBe('2001:db8:aa:1::/64');
    expect(rateLimitKey('2001:db8:aa:1:ffff:1:2:3')).toBe('2001:db8:aa:1::/64');
    expect(rateLimitKey('203.0.113.77')).toBe('203.0.113.77');
    expect(rateLimitKey('::ffff:203.0.113.77')).toBe('203.0.113.77');
  });

  it('stores only a few votes per post and network, still counting it once', async () => {
    const h = await hashContentKey('reddit:t3_pileup');
    for (let i = 0; i < MAX_VOTES_PER_NETWORK + 4; i++) expect((await flag(h, client(5000 + i), 'reddit', '192.0.2.44')).json.n).toBe(1);
    const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM votes WHERE h = ?').bind(h).first<{ c: number }>();
    expect(row?.c).toBe(MAX_VOTES_PER_NETWORK);
  });

  it('stores vote times to the hour', async () => {
    const h = await hashContentKey('reddit:t3_hour');
    await flag(h, client(6000));
    const row = await env.DB.prepare('SELECT created_at FROM votes WHERE h = ?').bind(h).first<{ created_at: number }>();
    expect((row?.created_at ?? 1) % 3_600_000).toBe(0);
  });
});

describe('canonical host', () => {
  const get = (url: string) => worker.fetch(new Request(url, { redirect: 'manual' }));

  it('sends www to the apex', async () => {
    const r = await get('https://www.potatobrowser.com/download/mac-arm64?x=1');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://potatobrowser.com/download/mac-arm64?x=1');
  });

  it('sends workers.dev pages to the apex but keeps its API and downloads', async () => {
    const page = await get('https://noaibrowser.example.workers.dev/');
    expect(page.status).toBe(301);
    expect(page.headers.get('location')).toBe('https://potatobrowser.com/');
    const api = await get('https://noaibrowser.example.workers.dev/api/v1/health');
    expect(api.status).toBe(200);
  });

  it('serves the landing page on the apex', async () => {
    const r = await get('https://potatobrowser.com/');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Grown,');
  });
});

describe('releases and downloads', () => {
  const sha = (c: string) => c.repeat(64);
  const manifest = {
    version: '9.9.9',
    date: '2026-11-05',
    notes: 'Test',
    commit: 'a'.repeat(40),
    files: { arm64: 'Potato-Browser-9.9.9-arm64.dmg', x64: 'Potato-Browser-9.9.9-x64.dmg' },
    sizes: { arm64: 1000, x64: 2000 },
    sha256: { arm64: sha('1'), x64: sha('2') },
  };
  const repo = 'https://github.com/potatobrowser/potato-browser';
  let served: { status: number; body: unknown } = { status: 404, body: 'Not Found' };
  const requested: string[] = [];

  beforeEach(() => {
    resetManifestCache();
    requested.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = input instanceof Request ? input.url : String(input);
      requested.push(u);
      const body = typeof served.body === 'string' ? served.body : JSON.stringify(served.body);
      return new Response(body, { status: served.status });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const get = (path: string, init: RequestInit = {}) => worker.fetch(new Request(BASE + path, { redirect: 'manual', ...init }));

  it('404s before the first release and sends downloads to the releases page', async () => {
    served = { status: 404, body: 'Not Found' };
    expect((await call('GET', '/api/v1/releases/latest')).status).toBe(404);
    const r = await get('/download/mac-arm64');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`${repo}/releases/latest`);
    expect(requested[0]).toBe(`${repo}/releases/latest/download/latest.json`);
  });

  it('rejects a manifest whose fields could point elsewhere', async () => {
    served = { status: 200, body: { ...manifest, files: { ...manifest.files, arm64: '../../evil/x.dmg' } } };
    expect((await call('GET', '/api/v1/releases/latest')).status).toBe(404);
    served = { status: 200, body: { ...manifest, version: '9.9.9/../../x' } };
    expect((await call('GET', '/api/v1/releases/latest')).status).toBe(404);
    served = { status: 200, body: '{not json' };
    expect((await call('GET', '/api/v1/releases/latest')).status).toBe(404);
  });

  it('describes the latest GitHub release and redirects downloads to its assets', async () => {
    served = { status: 200, body: manifest };
    const latest = await call('GET', '/api/v1/releases/latest');
    expect(latest.status).toBe(200);
    expect(latest.json).toMatchObject({
      version: '9.9.9',
      downloads: { arm64: `${BASE}/download/mac-arm64`, x64: `${BASE}/download/mac-x64` },
      sizes: manifest.sizes,
      sha256: manifest.sha256,
      source: { repo, tag: 'v9.9.9', commit: manifest.commit, release: `${repo}/releases/tag/v9.9.9` },
    });

    const arm = await get('/download/mac-arm64');
    expect(arm.status).toBe(302);
    expect(arm.headers.get('location')).toBe(`${repo}/releases/download/v9.9.9/Potato-Browser-9.9.9-arm64.dmg`);
    expect((await get('/download/mac')).headers.get('location')).toContain('-arm64.dmg');
    expect((await get('/download/mac-x64')).headers.get('location')).toBe(`${repo}/releases/download/v9.9.9/Potato-Browser-9.9.9-x64.dmg`);
    expect((await get('/download/mac-arm64', { method: 'HEAD' })).status).toBe(302);
    expect((await get('/download/linux')).status).toBe(404);
    expect((await get('/download/mac-arm64', { method: 'POST' })).status).toBe(405);
  });

  it('keeps serving the last good release while GitHub is down', async () => {
    served = { status: 200, body: manifest };
    expect((await call('GET', '/api/v1/releases/latest')).status).toBe(200);
    // Expire the per-isolate copy but keep it as the fallback.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
    served = { status: 503, body: 'unavailable' };
    await caches.default.delete(new Request('https://release-cache.potatobrowser.invalid/potatobrowser/potato-browser/latest.json'));
    expect((await call('GET', '/api/v1/releases/latest')).json.version).toBe('9.9.9');
  });
});
