// Builds main + preloads with esbuild and the React renderer with Vite into dist/.
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { catalog, ensureLists, readLock } from './filters.mjs';

const root = path.resolve(import.meta.dirname, '..');
const prod = process.argv.includes('--prod');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

const define = {
  'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'),
  __APP_VERSION__: JSON.stringify(pkg.version),
  __API_BASE__: JSON.stringify(process.env.POTATO_API_BASE_BUILD || 'https://potatobrowser.com'),
  // Squirrel.Mac only installs updates signed like the running app, so only Developer ID release
  // builds download them; others just say a new version is out.
  __AUTO_UPDATE__: JSON.stringify(process.env.POTATO_AUTO_UPDATE === '1'),
};

const common = {
  bundle: true,
  sourcemap: prod ? false : 'inline',
  minify: prod,
  legalComments: 'none',
  define,
  logLevel: 'warning',
  absWorkingDir: root,
};

await Promise.all([
  build({
    ...common,
    entryPoints: { 'main/index': 'src/main/index.ts', 'main/filters-compiler': 'src/main/adblock/compiler.ts' },
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
  }),
  // Sandboxed preloads can only require('electron'); everything else is bundled.
  build({
    ...common,
    entryPoints: { 'preload/ui': 'src/preload/ui.ts', 'preload/web': 'src/preload/web.ts' },
    outdir: 'dist',
    platform: 'browser',
    format: 'cjs',
    target: 'chrome150',
    external: ['electron'],
  }),
  viteBuild({ configFile: path.join(root, 'vite.config.mts'), logLevel: 'warn', define }),
]);

// Ad blocker: the pinned lists (gzipped, for other list choices) and the default engine compiled.
const lock = readLock();
const cached = await ensureLists(lock);
const out = path.join(root, 'dist', 'filters');
fs.mkdirSync(path.join(out, 'lists'), { recursive: true });
for (const [id, file] of Object.entries(cached)) {
  fs.writeFileSync(path.join(out, 'lists', `${id}.txt.gz`), zlib.gzipSync(fs.readFileSync(file), { level: 9 }));
}
const defaults = catalog.groups.filter((g) => ['ads', 'trackers'].includes(g.id)).flatMap((g) => g.lists);
const job = path.join(out, 'job.json');
fs.writeFileSync(job, JSON.stringify({ lists: defaults.map((id) => cached[id]), resources: cached[catalog.resources], custom: '', out: path.join(out, 'engine.bin') }));
execFileSync(process.execPath, [path.join(root, 'dist', 'main', 'filters-compiler.js'), job], { stdio: 'inherit' });
fs.rmSync(job);
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ fetchedAt: lock.fetchedAt, groups: ['ads', 'trackers'], lists: lock.lists }));

console.log(`built ${pkg.productName} ${pkg.version}${prod ? ' (prod)' : ''}`);
