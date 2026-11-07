// Ad blocker filter lists, pinned in filters/lock.json.
//   node scripts/filters.mjs update   pin the latest revision of every list (Ghostery's CDN)
//   node scripts/filters.mjs fetch    download the pinned files into .cache/filters
// The build calls ensureLists() and fails if a file does not match its pinned SHA-256.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export const catalog = JSON.parse(fs.readFileSync(path.join(root, 'filters', 'lists.json'), 'utf8'));
const lockFile = path.join(root, 'filters', 'lock.json');
const cacheDir = path.join(root, '.cache', 'filters');

export const listIds = () => [...new Set([...catalog.groups.flatMap((g) => g.lists), catalog.resources])];
export const readLock = () => JSON.parse(fs.readFileSync(lockFile, 'utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function get(url) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error(`GET ${url} failed: ${lastErr?.message ?? lastErr}`);
}

const cachePath = (id, rev) => path.join(cacheDir, `${id}-${rev}.txt`);

/** Returns the cached path of every pinned list, downloading missing ones. */
export async function ensureLists(lock = readLock()) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = {};
  for (const id of listIds()) {
    const pin = lock.lists[id];
    if (!pin) throw new Error(`filters/lock.json has no entry for ${id}; run: node scripts/filters.mjs update`);
    const file = cachePath(id, pin.rev);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== pin.sha256) {
      const buf = await get(`${catalog.source}/${id}/${pin.rev}/list.txt`);
      if (sha256(buf) !== pin.sha256) throw new Error(`${id} ${pin.rev}: SHA-256 does not match filters/lock.json`);
      fs.writeFileSync(file, buf);
    }
    out[id] = file;
  }
  return out;
}

async function update() {
  const old = fs.existsSync(lockFile) ? readLock() : { lists: {} };
  const lists = {};
  let changed = 0;
  for (const id of listIds()) {
    const meta = JSON.parse((await get(`${catalog.source}/${id}/metadata.json`)).toString('utf8'));
    const rev = meta.revisions?.at(-1);
    if (typeof rev !== 'string' || !/^[0-9a-f]{64}$/.test(rev)) throw new Error(`${id}: no revision in metadata`);
    if (old.lists[id]?.rev === rev) {
      lists[id] = old.lists[id];
      continue;
    }
    const buf = await get(`${catalog.source}/${id}/${rev}/list.txt`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath(id, rev), buf);
    lists[id] = { rev, sha256: sha256(buf), bytes: buf.length };
    changed++;
    console.log(`${id}: ${rev.slice(0, 12)} (${buf.length} bytes)`);
  }
  const lock = { fetchedAt: changed ? new Date().toISOString().replace(/\.\d+Z$/, 'Z') : old.fetchedAt, lists };
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  console.log(changed ? `${changed} lists updated` : 'all lists up to date');
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const cmd = process.argv[2];
  if (cmd === 'update') await update();
  else if (cmd === 'fetch') console.log(Object.keys(await ensureLists()).length, 'lists ready in .cache/filters');
  else {
    console.error('usage: node scripts/filters.mjs update|fetch');
    process.exit(1);
  }
}
