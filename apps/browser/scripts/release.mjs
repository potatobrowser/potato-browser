// Builds the DMGs, uploads them to R2 and publishes latest.json for the download site.
// Usage: node scripts/release.mjs [--skip-build] [--notes "..."]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const web = path.resolve(root, '../web');
const site = process.env.POTATO_SITE || 'https://potatobrowser.com';
const bucket = 'noaibrowser-releases';
const args = process.argv.slice(2);
const notesIdx = args.indexOf('--notes');
const notes = notesIdx >= 0 ? args[notesIdx + 1] : 'AI Shield for major sites, no AI in the engine, and anonymous community flags for AI-generated posts.';
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!args.includes('--skip-build')) {
  execFileSync(process.execPath, ['scripts/dist.mjs'], { cwd: root, stdio: 'inherit' });
}

const wrangler = (...a) =>
  execFileSync(path.join(web, 'node_modules/.bin/wrangler'), a, { cwd: web, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CI: '1' } });

const files = {};
const sizes = {};
const sha256 = {};
for (const arch of ['arm64', 'x64']) {
  const name = `Potato-Browser-${version}-${arch}.dmg`;
  const file = path.join(root, 'release', name);
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  const buf = fs.readFileSync(file);
  sizes[arch] = buf.length;
  sha256[arch] = crypto.createHash('sha256').update(buf).digest('hex');
  files[arch] = `releases/${version}/${name}`;
  console.log(`uploading ${name} (${(buf.length / 1048576).toFixed(1)} MB)`);
  wrangler('r2', 'object', 'put', `${bucket}/${files[arch]}`, '--file', file, '--content-type', 'application/x-apple-diskimage', '--remote');
}

const manifest = { version, date: new Date().toISOString().slice(0, 10), notes, files, sizes, sha256 };
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'potato-release-')), 'latest.json');
fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
wrangler('r2', 'object', 'put', `${bucket}/latest.json`, '--file', tmp, '--content-type', 'application/json', '--cache-control', 'no-cache', '--remote');

const latest = await (await fetch(`${site}/api/v1/releases/latest`, { cache: 'no-store' })).json();
if (latest.version !== version) throw new Error(`site reports ${latest.version}, expected ${version}`);
for (const arch of ['arm64', 'x64']) {
  const res = await fetch(`${site}/download/mac-${arch}`, { method: 'HEAD' });
  if (!res.ok || Number(res.headers.get('content-length')) !== sizes[arch]) throw new Error(`download check failed for ${arch}: ${res.status}`);
}
console.log(`released ${version}:`, JSON.stringify({ sizes, sha256 }, null, 2));
