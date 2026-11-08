// Builds everything the iOS app loads from its bundle into WebResources/:
//   js/content.js   content world script (shield, flags, ad blocker cosmetics)
//   js/page.js      page world script (AI APIs removed, GPC, Facebook helper)
//   js/engine.js    the ad blocker engine for JavaScriptCore
//   rules/<group>.json.z   WebKit rule lists per list group (raw DEFLATE)
//   engines/<group>.bin    Ghostery engines per list group (cosmetics, scriptlets, counts)
//   lists/<id>.txt.z       the pinned filter lists (for updates on the device)
//   resources.json.z       uBlock Origin's scriptlets and redirect resources
//   shield.json            AI Shield rule summaries (names, hosts, blocked AI requests)
//   manifest.json          versions, revisions and counts
// The filter lists are the Mac app's pinned ones (apps/browser/filters/lock.json).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { catalog, ensureLists, readLock } from '../../browser/scripts/filters.mjs';
import { loadShieldRules } from '../../browser/scripts/shield-rules.mjs';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'WebResources');
const tmp = path.join(root, 'build', 'web');
const dev = process.argv.includes('--dev');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const started = Date.now();

fs.rmSync(out, { recursive: true, force: true });
for (const d of ['js', 'rules', 'engines', 'lists']) fs.mkdirSync(path.join(out, d), { recursive: true });
fs.mkdirSync(tmp, { recursive: true });

const common = { bundle: true, minify: !dev, legalComments: 'none', logLevel: 'warning', absWorkingDir: root, charset: 'utf8' };
await Promise.all([
  build({ ...common, entryPoints: ['web/content.ts'], outfile: path.join(out, 'js/content.js'), format: 'iife', platform: 'browser', target: 'safari18' }),
  build({ ...common, entryPoints: ['web/page.ts'], outfile: path.join(out, 'js/page.js'), format: 'iife', platform: 'browser', target: 'safari18' }),
  build({ ...common, entryPoints: ['web/engine.ts'], outfile: path.join(out, 'js/engine.js'), format: 'iife', platform: 'neutral', target: 'es2022', mainFields: ['module', 'main'] }),
  build({ ...common, minify: false, entryPoints: ['web/buildlib.ts'], outfile: path.join(tmp, 'buildlib.mjs'), format: 'esm', platform: 'node', target: 'node22' }),
]);
for (const f of ['content.js', 'page.js']) {
  const code = fs.readFileSync(path.join(out, 'js', f), 'utf8');
  if (f === 'page.js' && !code.includes('__POTATO_OPTS__')) throw new Error('page.js lost its __POTATO_OPTS__ placeholder');
}

const lib = await import(path.join(tmp, 'buildlib.mjs') + `?t=${Date.now()}`);

// Filter lists, pinned.
const lock = readLock();
const files = await ensureLists(lock);
const text = (id) => fs.readFileSync(files[id], 'utf8');
const deflate = (s) => zlib.deflateRawSync(Buffer.from(s, 'utf8'), { level: 9 });
const resourcesJson = text(catalog.resources);
fs.writeFileSync(path.join(out, 'resources.json.z'), deflate(resourcesJson));
for (const g of catalog.groups) for (const id of g.lists) fs.writeFileSync(path.join(out, 'lists', `${id}.txt.z`), deflate(text(id)));

// WebKit rule lists.
const engineApi = lib.createEngineApi();
const lists = engineApi.ruleLists(catalog.groups.map((g) => ({ id: g.id, lists: g.lists.map(text) })));
const groups = [];
for (const g of catalog.groups) {
  const r = lists[g.id];
  fs.writeFileSync(path.join(out, 'rules', `${g.id}.json.z`), deflate(r.json));
  // Ghostery engines per group: cosmetics, scriptlets and the URL checks for counts.
  const bytes = engineApi.compile(g.lists.map((id) => ({ id, text: text(id) })), resourcesJson);
  fs.writeFileSync(path.join(out, 'engines', `${g.id}.bin`), bytes);
  groups.push({ id: g.id, lists: g.lists, rules: r.rules, ruleBytes: r.json.length, engineBytes: bytes.length });
}

// AI Shield rule summaries for the app (settings, the shield panel, blocked AI requests).
const shield = lib.RULES.map((r) => ({
  id: r.id,
  site: r.site,
  hosts: r.hosts,
  paths: r.paths ?? null,
  features: r.features.map((f) => ({ id: f.id, name: f.name, block: f.block ?? [] })),
}));
fs.writeFileSync(path.join(out, 'shield.json'), JSON.stringify(shield));
// Their git version and hash: a downloaded rule update replaces them only when newer.
const shieldRules = await loadShieldRules(build, root);

const manifest = {
  version: pkg.version,
  builtAt: new Date().toISOString(),
  listsFetchedAt: lock.fetchedAt,
  lists: Object.fromEntries(Object.keys(files).map((id) => [id, { rev: lock.lists[id].rev, name: catalog.lists[id]?.name ?? id, homepage: catalog.lists[id]?.homepage ?? '' }])),
  resources: catalog.resources,
  groups,
  flagPlatforms: lib.ADAPTERS.map((a) => ({ platform: a.platform, hosts: a.hosts })),
  aiGlobals: lib.AI_GLOBALS,
  shieldRules: { version: shieldRules.version, hash: shieldRules.hash, keys: lib.SHIELD_RULES_KEYS },
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

const size = (p) => {
  const s = fs.statSync(p);
  return s.isDirectory() ? fs.readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0) : s.size;
};
console.log(
  `WebResources: ${(size(out) / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s; ` +
    groups.map((g) => `${g.id} ${g.rules} rules`).join(', '),
);
