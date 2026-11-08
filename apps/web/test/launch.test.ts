import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { hashContentKey, hashPrefix, SHIELD_RULES_FORMAT } from '@potato/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CRASHES_PER_DAY, pruneCrashes } from '../src/crashes';
import generated from '../src/generated/shield-rules.json';
import worker from '../src/index';
import { MAX_REPORTS_PER_DAY } from '../src/reports';

const BASE = 'https://potatobrowser.test';
const app = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.fetch(
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

const client = (n: number) => n.toString(16).padStart(32, '0');
const vote = (h: string, c: number, kind: 'ai' | 'human', ip: string) =>
  call('POST', '/api/v1/flags', { h, platform: 'reddit', client: client(c), vote: kind, app: 'ios' }, { 'cf-connecting-ip': ip });

describe('Not AI votes', () => {
  it('counts AI flags and Not AI votes per network and weighs them for older apps', async () => {
    const h = await hashContentKey('reddit:t3_disputed');
    expect((await vote(h, 1, 'ai', '198.18.1.1')).json).toEqual({ h, n: 1, d: 0, flagged: true, vote: 'ai' });
    await vote(h, 2, 'ai', '198.18.2.1');
    await vote(h, 3, 'ai', '198.18.3.1');
    expect((await vote(h, 4, 'human', '198.18.4.1')).json).toEqual({ h, n: 3, d: 1, flagged: false, vote: 'human' });
    // Same network again: still one Not AI vote.
    expect((await vote(h, 5, 'human', '198.18.4.9')).json.d).toBe(1);

    const v2 = await call('POST', '/api/v1/lookup', { prefixes: [hashPrefix(h)], v: 2 });
    expect(v2.json.items.find((i: { h: string }) => i.h === h)).toEqual({ h, n: 3, d: 1 });
    // Apps before 0.8.0 see AI flags minus Not AI votes.
    const v1 = await call('POST', '/api/v1/lookup', { prefixes: [hashPrefix(h)] });
    expect(v1.json.items.find((i: { h: string }) => i.h === h)).toEqual({ h, n: 2 });
    const legacy = await call('POST', '/api/v1/flags', { h, platform: 'reddit', client: client(6) }, { 'cf-connecting-ip': '198.18.6.1' });
    expect(legacy.json).toEqual({ h, n: 3, flagged: true });
  });

  it('lets an install change its mind and take its vote back', async () => {
    const h = await hashContentKey('reddit:t3_changed');
    await vote(h, 10, 'ai', '198.18.10.1');
    await vote(h, 11, 'ai', '198.18.11.1');
    expect((await vote(h, 10, 'human', '198.18.10.1')).json).toMatchObject({ n: 1, d: 1, vote: 'human' });
    const rows = await env.DB.prepare('SELECT kind FROM votes WHERE h = ?').bind(h).all<{ kind: string }>();
    expect(rows.results.map((r) => r.kind).sort()).toEqual(['ai', 'human']);
    const undo = await call('DELETE', '/api/v1/flags', { h, platform: 'reddit', client: client(10), vote: 'human' });
    expect(undo.json).toEqual({ h, n: 1, d: 0, flagged: false, vote: null });
  });

  it('hides posts whose disputes cancel their flags from older apps', async () => {
    const h = await hashContentKey('reddit:t3_cancelled');
    await vote(h, 20, 'ai', '198.18.20.1');
    await vote(h, 21, 'human', '198.18.21.1');
    const v1 = await call('POST', '/api/v1/lookup', { prefixes: [hashPrefix(h)] });
    expect(v1.json.items.find((i: { h: string }) => i.h === h)).toBeUndefined();
  });

  it('rejects unknown vote kinds', async () => {
    const h = await hashContentKey('reddit:t3_weird');
    const r = await call('POST', '/api/v1/flags', { h, platform: 'reddit', client: client(30), vote: 'robot' });
    expect(r.status).toBe(400);
  });

  it('counts votes that added a network and votes a shared network swallowed', async () => {
    const h = await hashContentKey('reddit:t3_cgnat');
    const before = await env.DB.prepare("SELECT COALESCE(SUM(counted), 0) AS c, COALESCE(SUM(collapsed), 0) AS x FROM vote_stats WHERE app = 'ios' AND family = 'v6'").first<{
      c: number;
      x: number;
    }>();
    await vote(h, 40, 'ai', '2001:db8:77:1::1');
    await vote(h, 41, 'ai', '2001:db8:77:2::1'); // same /48: collapsed
    await vote(h, 40, 'ai', '2001:db8:77:1::1'); // the same install again: not counted twice
    await new Promise((r) => setTimeout(r, 50));
    const after = await env.DB.prepare("SELECT SUM(counted) AS c, SUM(collapsed) AS x FROM vote_stats WHERE app = 'ios' AND family = 'v6'").first<{ c: number; x: number }>();
    expect((after?.c ?? 0) - (before?.c ?? 0)).toBe(1);
    expect((after?.x ?? 0) - (before?.x ?? 0)).toBe(1);
  });
});

describe('daily check', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = input instanceof Request ? input.url : String(input);
      if (u.endsWith('/metadata.json')) return Response.json({ revisions: ['a'.repeat(64)] });
      return new Response('nope', { status: 404 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const installs = async (app: string, version: string) =>
    (await env.DB.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM installs WHERE app = ? AND version = ?').bind(app, version).first<{ n: number }>())?.n ?? 0;

  it('answers lists and the shield rules, and counts the install by app and version', async () => {
    const before = await installs('mac', '0.8.0');
    const r = await call('GET', '/api/v1/filters?lists=easylist&app=mac&v=0.8.0');
    expect(r.status).toBe(200);
    expect(r.json.lists).toEqual({ easylist: 'a'.repeat(64) });
    expect(r.json.shield).toEqual({ version: generated.version, hash: generated.hash });
    await new Promise((res) => setTimeout(res, 50));
    expect(await installs('mac', '0.8.0')).toBe(before + 1);
  });

  it('takes a shield-only check, and counts older apps by their HTTP client', async () => {
    const ios = await installs('ios', '0.6.0');
    expect((await call('GET', '/api/v1/filters?app=ios&v=0.6.0')).json.lists).toEqual({});
    const legacyIos = await installs('ios', 'legacy');
    const legacyMac = await installs('mac', 'legacy');
    await call('GET', '/api/v1/filters?lists=easylist', undefined, { 'user-agent': 'PotatoBrowser/120 CFNetwork/3826.400.110 Darwin/25.0.0' });
    await call('GET', '/api/v1/filters?lists=easylist', undefined, { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/156.0.0.0' });
    await new Promise((res) => setTimeout(res, 50));
    expect(await installs('ios', '0.6.0')).toBe(ios + 1);
    expect(await installs('ios', 'legacy')).toBe(legacyIos + 1);
    expect(await installs('mac', 'legacy')).toBe(legacyMac + 1);
    // Without lists an app has to say what it is; a version must look like one.
    expect((await call('GET', '/api/v1/filters')).status).toBe(400);
    expect((await call('GET', '/api/v1/filters?app=mac&v=x')).status).toBe(400);
    const rows = await env.DB.prepare('SELECT * FROM installs LIMIT 1').first<Record<string, unknown>>();
    expect(Object.keys(rows!).sort()).toEqual(['app', 'day', 'n', 'version']);
  });
});

describe('AI Shield rules', () => {
  it('serves the rules signed, with the version and hash the daily check names', async () => {
    const r = await call('GET', '/api/v1/shield/rules');
    expect(r.status).toBe(200);
    const { payload, signature } = r.json as { payload: string; signature: string };
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(generated.testKey!), (c) => c.charCodeAt(0)), { name: 'Ed25519' }, false, ['verify']);
    const sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(payload))).toBe(true);
    const tampered = new TextEncoder().encode(payload.replace('display', 'Display'));
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, tampered)).toBe(false);
    const p = JSON.parse(payload);
    expect(p.format).toBe(SHIELD_RULES_FORMAT);
    expect(p.version).toBe(generated.version);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(p.rules)));
    expect(Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')).toBe(p.hash);
    expect(p.rules.some((rule: { id: string }) => rule.id === 'google-search')).toBe(true);
  });
});

describe('site reports', () => {
  const report = (body: Record<string, unknown>, ip = '198.18.50.1') =>
    call('POST', '/api/v1/reports', { url: 'https://www.google.com/search?q=spuds#top', feature: 'shield', problem: 'showing', app: 'mac', version: '0.8.0', ...body }, { 'cf-connecting-ip': ip });

  it('stores the address without its fragment, the choice, app and version', async () => {
    expect((await report({})).json).toEqual({ ok: true });
    const row = await env.DB.prepare("SELECT * FROM reports WHERE url LIKE '%spuds%' ORDER BY id DESC").first<Record<string, unknown>>();
    expect(row).toMatchObject({ url: 'https://www.google.com/search?q=spuds', host: 'google.com', feature: 'shield', problem: 'showing', app: 'mac', version: '0.8.0', status: 'new' });
    expect(Object.keys(row!).sort()).toEqual(['app', 'created_at', 'feature', 'host', 'id', 'problem', 'status', 'updated_at', 'url', 'version']);
    expect((row!.created_at as number) % 3_600_000).toBe(0);
  });

  it('rejects anything else', async () => {
    for (const bad of [{ url: 'javascript:alert(1)' }, { url: 'potato://settings' }, { feature: 'flags' }, { problem: 'ugly' }, { app: 'linux' }, { version: '1' }]) {
      expect((await report(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const plain = await app.fetch(new Request(BASE + '/api/v1/reports', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ url: 'https://a.example/' }) }));
    expect(plain.status).toBe(400);
  });

  it('takes at most so many reports a day', async () => {
    const now = Date.now();
    const stmts = Array.from({ length: MAX_REPORTS_PER_DAY }, () =>
      env.DB.prepare("INSERT INTO reports (created_at, url, host, feature, problem, app, version, updated_at) VALUES (?1, 'https://flood.example/', 'flood.example', 'adblock', 'broken', 'ios', '0.6.0', ?1)").bind(now),
    );
    await env.DB.batch(stmts);
    expect((await report({}, '198.18.51.1')).status).toBe(429);
    await env.DB.prepare("DELETE FROM reports WHERE host = 'flood.example'").run();
  });
});

function minidump(): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x4d, 0x44, 0x4d, 0x50]);
  return b;
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

async function crashForm(fields: Record<string, string>, dump = minidump()): Promise<{ body: Uint8Array; type: string }> {
  const form = new FormData();
  for (const [k, v] of Object.entries({ _productName: 'Potato Browser', _version: '0.8.0', ver: '45.2.3', process_type: 'renderer', guid: 'f0a1-unique-install', arch: 'arm64', ...fields })) form.set(k, v);
  form.set('upload_file_minidump', new File([dump], 'crash.dmp'));
  const res = new Response(form);
  return { body: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type')! };
}

describe('crash reports', () => {
  it('stores a gzipped Crashpad upload in R2 without the install guid', async () => {
    const { body, type } = await crashForm({});
    const res = await app.fetch(new Request(BASE + '/api/v1/crashes', { method: 'POST', headers: { 'content-type': type, 'content-encoding': 'gzip' }, body: await gzip(body) }));
    expect(res.status).toBe(200);
    const id = await res.text();
    const row = await env.DB.prepare('SELECT * FROM crashes WHERE id = ?').bind(id).first<{ key: string; app: string; process: string; version: string }>();
    expect(row).toMatchObject({ app: 'mac', process: 'renderer', version: '0.8.0' });
    const obj = await env.CRASHES!.get(row!.key);
    expect(obj).not.toBeNull();
    expect(obj!.customMetadata).toEqual({ app: 'mac', version: '0.8.0', process: 'renderer', electron: '45.2.3', arch: 'arm64' });
    expect(JSON.stringify(obj!.customMetadata)).not.toContain('f0a1');
    expect(new Uint8Array(await obj!.arrayBuffer()).slice(0, 4)).toEqual(minidump().slice(0, 4));
  });

  it('refuses uploads that are not Potato Browser minidumps', async () => {
    for (const [fields, dump] of [
      [{ _productName: 'Other App' }, minidump()],
      [{ _version: 'banana' }, minidump()],
      [{}, new Uint8Array(64)],
    ] as const) {
      const { body, type } = await crashForm(fields, dump);
      const res = await app.fetch(new Request(BASE + '/api/v1/crashes', { method: 'POST', headers: { 'content-type': type }, body }));
      expect(res.status).toBe(400);
    }
    expect((await call('POST', '/api/v1/crashes', { a: 1 })).status).toBe(400);
  });

  it('stores MetricKit payloads from the iOS app', async () => {
    const r = await call('POST', '/api/v1/crashes/ios', { app: 'ios', version: '0.6.0', kind: 'crash', payload: { crashDiagnostics: [{ callStackTree: {} }] } });
    expect(r.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM crashes WHERE id = ?').bind(r.text).first<{ key: string }>();
    expect(row!.key).toMatch(/^ios\/0\.6\.0\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.json$/);
    expect(JSON.parse(await (await env.CRASHES!.get(row!.key))!.text())).toEqual({ crashDiagnostics: [{ callStackTree: {} }] });
    expect((await call('POST', '/api/v1/crashes/ios', { app: 'mac', version: '0.6.0', payload: {} })).status).toBe(400);
    expect((await call('POST', '/api/v1/crashes/ios', { app: 'ios', version: '0.6.0', payload: [] })).status).toBe(400);
  });

  it('keeps crash reports 90 days', async () => {
    const old = Date.now() - 91 * 86_400_000;
    await env.CRASHES!.put('mac/0.1.0/2026-01-01/old.dmp', minidump());
    await env.DB.prepare("INSERT INTO crashes (id, created_at, app, version, process, size, key) VALUES ('old', ?1, 'mac', '0.1.0', 'browser', 64, 'mac/0.1.0/2026-01-01/old.dmp')").bind(old).run();
    await pruneCrashes(env);
    expect(await env.CRASHES!.get('mac/0.1.0/2026-01-01/old.dmp')).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM crashes WHERE id = 'old'").first()).toBeNull();
    expect(MAX_CRASHES_PER_DAY).toBeGreaterThan(100);
  });
});

describe('admin page', () => {
  const auth = { authorization: 'Basic ' + btoa('admin:test-admin-token') };

  it('asks for the password and shows the counters with it', async () => {
    const anon = await call('GET', '/admin');
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toContain('Basic');
    expect((await call('GET', '/admin', undefined, { authorization: 'Basic ' + btoa('admin:wrong') })).status).toBe(401);
    const page = await call('GET', '/admin', undefined, auth);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'nonce-");
    expect(page.headers.get('x-robots-tag')).toBe('noindex');
    const s = await call('GET', '/admin/api/summary', undefined, auth);
    expect(Object.keys(s.json).sort()).toEqual(['crashDays', 'crashes', 'downloads', 'flags', 'installs', 'reports', 'votes']);
  });

  it('triages reports only from its own page', async () => {
    await call('POST', '/api/v1/reports', { url: 'https://www.bing.com/search?q=x', feature: 'shield', problem: 'showing', app: 'mac', version: '0.8.0' }, { 'cf-connecting-ip': '198.18.60.1' });
    const { id } = (await env.DB.prepare("SELECT id FROM reports WHERE host = 'bing.com' ORDER BY id DESC").first<{ id: number }>())!;
    const post = (headers: Record<string, string>) => call('POST', `/admin/api/reports/${id}`, { status: 'done' }, { ...auth, ...headers });
    expect((await post({})).status).toBe(403);
    expect((await post({ 'x-potato-admin': '1', origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ 'x-potato-admin': '1', origin: BASE })).json).toEqual({ ok: true, changed: 1 });
    expect((await env.DB.prepare('SELECT status FROM reports WHERE id = ?').bind(id).first<{ status: string }>())!.status).toBe('done');
    const bulk = await call('POST', '/admin/api/reports/host/bing.com', { status: 'ignored' }, { ...auth, 'x-potato-admin': '1', origin: BASE });
    expect(bulk.status).toBe(200);
  });

  it('cleans up old and triaged reports every day', async () => {
    const old = Date.now() - 91 * 86_400_000;
    await env.DB.prepare("INSERT INTO reports (created_at, url, host, feature, problem, app, version, updated_at) VALUES (?1, 'https://old.example/', 'old.example', 'shield', 'broken', 'mac', '0.8.0', ?1)").bind(old).run();
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: Date.now(), cron: '17 3 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.DB.prepare("SELECT 1 FROM reports WHERE host = 'old.example'").first()).toBeNull();
  });
});
