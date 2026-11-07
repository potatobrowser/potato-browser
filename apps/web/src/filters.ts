/**
 * Ad blocker filter lists for the browser's daily update. The lists come from Ghostery's CDN,
 * which republishes EasyList, EasyPrivacy and uBlock Origin's lists under immutable revision
 * URLs; the edge cache here means each revision is fetched from there once per location, not
 * once per install.
 */
export const FILTERS_CDN = 'https://cdn.ghostery.com/adblocker/resources';

const LIST_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const REV = /^[0-9a-f]{64}$/;
const MAX_LISTS = 32;
const HOUR = 3600;
const YEAR = 31_536_000;

function textResponse(body: BodyInit | null, status: number, headers: Record<string, string>): Response {
  return new Response(body, { status, headers: { 'x-content-type-options': 'nosniff', ...headers } });
}

const fail = (status: number, message: string) =>
  textResponse(JSON.stringify({ error: message }), status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });

async function latestRevision(id: string): Promise<string | null> {
  try {
    const res = await fetch(`${FILTERS_CDN}/${id}/metadata.json`, { cf: { cacheTtl: HOUR, cacheEverything: true } } as RequestInit);
    if (!res.ok) return null;
    const rev = ((await res.json()) as { revisions?: unknown[] }).revisions?.at(-1);
    return typeof rev === 'string' && REV.test(rev) ? rev : null;
  } catch {
    return null;
  }
}

/** GET /api/v1/filters?lists=a,b,c -> { lists: { a: "<rev>" | null, ... } } */
export async function filterRevisions(url: URL): Promise<Response> {
  const ids = [...new Set((url.searchParams.get('lists') ?? '').split(',').filter(Boolean))];
  if (!ids.length || ids.length > MAX_LISTS || !ids.every((id) => LIST_ID.test(id))) return fail(400, `lists must be 1-${MAX_LISTS} list ids`);
  const revs = await Promise.all(ids.map(latestRevision));
  const lists = Object.fromEntries(ids.map((id, i) => [id, revs[i]]));
  return textResponse(JSON.stringify({ lists }), 200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=900',
  });
}

/** GET /api/v1/filters/<id>/<rev> -> the list text of that revision, cached for a year. */
export async function filterList(id: string, rev: string): Promise<Response> {
  if (!LIST_ID.test(id) || !REV.test(rev)) return fail(400, 'invalid list or revision');
  let res: Response;
  try {
    res = await fetch(`${FILTERS_CDN}/${id}/${rev}/list.txt`, { cf: { cacheTtl: YEAR, cacheEverything: true } } as RequestInit);
  } catch {
    return fail(502, 'filter source unreachable');
  }
  if (res.status === 404 || res.status === 403) return fail(404, 'no such list revision');
  if (!res.ok || !res.body) return fail(502, 'filter source failed');
  return textResponse(res.body, 200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': `public, max-age=${YEAR}, immutable`,
  });
}
