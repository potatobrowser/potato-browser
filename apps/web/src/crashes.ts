import { isAppVersion } from '@potato/shared';
import { clientIp, DAY_MS, error, limited, readBytes } from './http';
import type { Env } from './index';

/** Compressed upload, and what it may grow to: minidumps are a few hundred KB. */
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_DUMP = 24 * 1024 * 1024;
const MAX_IOS = 1024 * 1024;
/** Bounds storage if a crash loop or a script floods the endpoint. */
export const MAX_CRASHES_PER_DAY = 3000;

const PROCESS = /^[a-z][a-z-]{0,31}$/;
const ARCH = /^(arm64|x64)$/;
const CRASHPAD_INFO_STREAM = 0x43500001;

/**
 * Crashpad writes a report id and its per-install client id into the minidump's own info stream
 * (MinidumpCrashpadInfo: version, report_id, client_id, ...). Both are zeroed, and so is any copy
 * of the client id the upload named, so reports from one install cannot be linked.
 * Returns false for a dump whose layout does not hold together.
 */
export function scrubMinidump(data: Uint8Array, guid = ''): boolean {
  if (data.byteLength < 32) return false;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = v.getUint32(8, true);
  const dir = v.getUint32(12, true);
  if (count > 4096 || dir + count * 12 > data.byteLength) return false;
  for (let i = 0; i < count; i++) {
    const at = dir + i * 12;
    if (v.getUint32(at, true) !== CRASHPAD_INFO_STREAM) continue;
    const size = v.getUint32(at + 4, true);
    const rva = v.getUint32(at + 8, true);
    if (size < 36 || rva + 36 > data.byteLength) return false;
    data.fill(0, rva + 4, rva + 36);
  }
  if (/^[0-9a-fA-F-]{32,36}$/.test(guid)) {
    for (const variant of new Set([guid, guid.toLowerCase(), guid.toUpperCase(), guid.replaceAll('-', '')])) {
      const needle = new TextEncoder().encode(variant);
      for (let at = indexOf(data, needle, 0); at >= 0; at = indexOf(data, needle, at + needle.length)) data.fill(0x30, at, at + needle.length);
    }
  }
  return true;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Crashpad and the iOS app send no Origin or fetch metadata; a web page's form post always does. */
function fromBrowser(req: Request): boolean {
  return req.headers.has('origin') || req.headers.has('sec-fetch-site') || req.headers.has('sec-fetch-mode');
}

function body(req: Request): ReadableStream<Uint8Array> | null {
  if (!req.body) return null;
  return (req.headers.get('content-encoding') ?? '').toLowerCase() === 'gzip' ? req.body.pipeThrough(new DecompressionStream('gzip')) : req.body;
}

async function store(env: Env, app: 'mac' | 'ios', version: string, process: string, data: Uint8Array, meta: Record<string, string>, ext: string): Promise<string> {
  const id = crypto.randomUUID();
  const day = new Date().toISOString().slice(0, 10);
  const key = `${app}/${version}/${day}/${id}.${ext}`;
  await env.CRASHES!.put(key, data, { customMetadata: { app, version, process, ...meta } });
  await env.DB.prepare('INSERT INTO crashes (id, created_at, app, version, process, size, key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id, Date.now(), app, version, process, data.byteLength, key)
    .run();
  return id;
}

async function admitted(req: Request, env: Env): Promise<Response | null> {
  if (!env.CRASHES) return error(503, 'crash reports are not configured');
  // Multipart posts need no CORS preflight: without this any site could fill the daily quota.
  if (fromBrowser(req)) return error(403, 'crash reports come from the apps only');
  if (await limited(env.CRASH_LIMIT, clientIp(req))) return error(429, 'slow down');
  const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM crashes WHERE created_at > ?1')
    .bind(Date.now() - DAY_MS)
    .first<{ c: number }>();
  return (recent?.c ?? 0) >= MAX_CRASHES_PER_DAY ? error(429, 'too many crash reports today') : null;
}

/**
 * POST /api/v1/crashes: what Electron's crashReporter (Crashpad) uploads from the Mac app, a
 * multipart form with the minidump, gzipped. Only the dump and what is needed to read it (version,
 * process, Electron version, architecture) are kept; Crashpad's per-install id (the `guid` field
 * and its copy inside the dump) and the address are dropped.
 */
export async function macCrash(req: Request, env: Env): Promise<Response> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('multipart/form-data')) return error(400, 'expected a minidump upload');
  if (Number(req.headers.get('content-length') ?? 0) > MAX_UPLOAD) return error(413, 'too large');
  const denied = await admitted(req, env);
  if (denied) return denied;
  const bytes = await readBytes(req, MAX_DUMP, body(req)).catch(() => null);
  if (!bytes) return error(413, 'too large or not readable');
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'content-type': type } }).formData();
  } catch {
    return error(400, 'malformed upload');
  }
  const dump = form.get('upload_file_minidump');
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : '';
  };
  const version = field('_version');
  const proc = field('process_type') || 'browser';
  if (!dump || typeof dump === 'string' || !isAppVersion(version) || field('_productName') !== 'Potato Browser' || !PROCESS.test(proc)) {
    return error(400, 'not a Potato Browser crash report');
  }
  const data = new Uint8Array(await dump.arrayBuffer());
  // Minidumps start with "MDMP".
  if (data.byteLength < 32 || data[0] !== 0x4d || data[1] !== 0x44 || data[2] !== 0x4d || data[3] !== 0x50) return error(400, 'not a minidump');
  if (!scrubMinidump(data, field('guid'))) return error(400, 'malformed minidump');
  const electron = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(field('ver')) ? field('ver') : '';
  const arch = ARCH.test(field('arch')) ? field('arch') : '';
  const id = await store(env, 'mac', version, proc, data, { electron, arch }, 'dmp');
  // Crashpad records this as the report id.
  return new Response(id, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/** POST /api/v1/crashes/ios: one MetricKit diagnostic payload (JSON) from the iOS app. */
export async function iosCrash(req: Request, env: Env): Promise<Response> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return error(400, 'expected JSON');
  const denied = await admitted(req, env);
  if (denied) return denied;
  const bytes = await readBytes(req, MAX_IOS, body(req)).catch(() => null);
  if (!bytes) return error(413, 'too large or not readable');
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, 'malformed JSON');
  }
  const version = doc.version;
  const payload = doc.payload as Record<string, unknown> | undefined;
  const kind = typeof doc.kind === 'string' && PROCESS.test(doc.kind) ? doc.kind : 'crash';
  if (doc.app !== 'ios' || !isAppVersion(version) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return error(400, 'not a Potato Browser diagnostic');
  }
  const id = await store(env, 'ios', version, kind, new TextEncoder().encode(JSON.stringify(payload)), {}, 'json');
  return new Response(id, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Daily cleanup: crash reports older than 90 days, in R2 and the index. */
export async function pruneCrashes(env: Env): Promise<void> {
  const cutoff = Date.now() - 90 * DAY_MS;
  for (;;) {
    const old = await env.DB.prepare('SELECT id, key FROM crashes WHERE created_at < ?1 LIMIT 500')
      .bind(cutoff)
      .all<{ id: string; key: string }>();
    const rows = old.results ?? [];
    if (!rows.length) return;
    if (env.CRASHES) await env.CRASHES.delete(rows.map((r) => r.key));
    await env.DB.batch(rows.map((r) => env.DB.prepare('DELETE FROM crashes WHERE id = ?1').bind(r.id)));
    if (rows.length < 500) return;
  }
}
