import { env, exports } from 'cloudflare:workers';
import { hashContentKey, hashPrefix } from '@noai/shared';
import { describe, expect, it } from 'vitest';
import { DAILY_FLAG_CAP, networkPrefix, voterId } from '../src/lib';

const BASE = 'https://noaibrowser.test';
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

describe('releases and downloads', () => {
  it('404s before the first release', async () => {
    expect((await call('GET', '/api/v1/releases/latest')).status).toBe(404);
    expect((await call('GET', '/download/mac-arm64')).status).toBe(404);
  });

  it('serves the latest DMG with ranges and counts downloads', async () => {
    const dmg = new Uint8Array(1000).map((_, i) => i % 251);
    await env.RELEASES.put('releases/9.9.9/No-AI-Browser-9.9.9-arm64.dmg', dmg);
    await env.RELEASES.put(
      'latest.json',
      JSON.stringify({
        version: '9.9.9',
        date: '2026-11-05',
        notes: 'Test',
        files: { arm64: 'releases/9.9.9/No-AI-Browser-9.9.9-arm64.dmg', x64: 'releases/9.9.9/No-AI-Browser-9.9.9-x64.dmg' },
      }),
    );
    const latest = await call('GET', '/api/v1/releases/latest');
    expect(latest.json.version).toBe('9.9.9');
    expect(latest.json.downloads.arm64).toBe(`${BASE}/download/mac-arm64`);

    const full = await worker.fetch(new Request(BASE + '/download/mac-arm64'));
    expect(full.status).toBe(200);
    expect(full.headers.get('content-disposition')).toBe('attachment; filename="No-AI-Browser-9.9.9-arm64.dmg"');
    expect(full.headers.get('content-length')).toBe('1000');
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(dmg);

    const part = await worker.fetch(new Request(BASE + '/download/mac', { headers: { range: 'bytes=10-19' } }));
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(dmg.slice(10, 20));

    const head = await worker.fetch(new Request(BASE + '/download/mac-arm64', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('1000');

    // The x64 file was never uploaded.
    expect((await call('GET', '/download/mac-x64')).status).toBe(404);
    expect((await call('GET', '/download/linux')).status).toBe(404);
  });
});
