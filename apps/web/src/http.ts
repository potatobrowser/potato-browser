import { rateLimitKey } from './lib';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

export const error = (status: number, message: string) => json({ error: message }, status);

export const MAX_BODY = 16_384;

/** The body as bytes, or null past `max` bytes (checked while reading, not after). */
export async function readBytes(req: Request, max: number, body: ReadableStream<Uint8Array> | null = req.body): Promise<Uint8Array | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max && body === req.body) return null;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return buf;
}

export async function readCapped(req: Request): Promise<string | null> {
  const bytes = await readBytes(req, MAX_BODY);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  // Exactly application/json: a web page can send text/plain (even "text/plain; x=application/json")
  // cross-site without a CORS preflight, which would let any site act as its visitors.
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return null;
  const text = await readCapped(req);
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'local';
}

export async function limited(limiter: RateLimit | undefined, ip: string): Promise<boolean> {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key: rateLimitKey(ip) });
  return !success;
}

export const isTor = (req: Request) => (req.cf as { country?: string } | undefined)?.country === 'T1';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Now, to the hour: enough for caps and triage, too coarse to line up with other logs. */
export const hourNow = () => Date.now() - (Date.now() % HOUR_MS);

export const today = () => new Date().toISOString().slice(0, 10);
