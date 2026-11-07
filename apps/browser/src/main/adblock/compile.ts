import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ENGINE_VERSION, FiltersEngine, parseFilters } from '@ghostery/adblocker';
import catalog from '../../../filters/lists.json';

/** Pure Node (no Electron): used by the build, the compiler utility process and the main process. */

export type GroupId = 'ads' | 'trackers' | 'cookies' | 'annoyances';
export const CATALOG = catalog as {
  source: string;
  resources: string;
  groups: { id: GroupId; lists: string[] }[];
  lists: Record<string, { name: string; homepage: string; license: string }>;
};
export const ALL_LIST_IDS = [...new Set([...CATALOG.groups.flatMap((g) => g.lists), CATALOG.resources])];
export const DEFAULT_GROUPS: GroupId[] = ['ads', 'trackers'];

/** The list choices of the ad blocker settings. */
export interface AdblockChoice {
  trackers: boolean;
  cookieNotices: boolean;
  annoyances: boolean;
}

export const ENGINE_OPTIONS = {
  loadPreprocessors: true,
  loadExtendedSelectors: true,
  loadCSPFilters: true,
  enableHtmlFiltering: false,
  enableMutationObserver: true,
} as const;

/** `!#if` bindings the lists see: a Chromium browser that injects user stylesheets. */
export function engineEnv(): Map<string, boolean> {
  return new Map([
    ['env_chromium', true],
    ['ext_ghostery', true],
    ['cap_user_stylesheet', true],
  ]);
}

export function listsForGroups(groups: GroupId[]): string[] {
  return CATALOG.groups.filter((g) => groups.includes(g.id)).flatMap((g) => g.lists);
}

export function groupsFor(s: AdblockChoice): GroupId[] {
  return [...DEFAULT_GROUPS.filter((g) => g === 'ads' || s.trackers), ...(s.cookieNotices ? (['cookies'] as const) : []), ...(s.annoyances ? (['annoyances'] as const) : [])];
}

/** A list download is plausible: text of a sane size, and valid JSON for the resources file. */
export function isPlausibleList(id: string, text: string): boolean {
  if (text.length < 200 || text.length > 20_000_000) return false;
  if (id !== CATALOG.resources) return text.includes('\n') && !text.trimStart().startsWith('<');
  try {
    const r = JSON.parse(text);
    return Array.isArray(r?.scriptlets) && Array.isArray(r?.redirects);
  } catch {
    return false;
  }
}

/** Lines of the user's own filters the engine could not read. */
export function customFilterErrors(text: string): string[] {
  if (!text.trim()) return [];
  try {
    return parseFilters(text, { loadExtendedSelectors: true, loadPreprocessors: true }).notSupportedFilters.slice(0, 20).map((f) => f.filter.slice(0, 200));
  } catch {
    return [];
  }
}

export interface EngineSpec {
  /** List ids in catalog order, each with the revision compiled. */
  lists: [string, string][];
  resources: string;
  custom: string;
}

/** Identifies a compiled engine: library version, list revisions and the user's own filters. */
export function specKey(spec: EngineSpec): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ v: ENGINE_VERSION, lists: spec.lists, resources: spec.resources, custom: spec.custom.trim() }))
    .digest('hex');
}

export function readListFile(file: string): string {
  const buf = fs.readFileSync(file);
  return (file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
}

/** Names (and aliases) of scriptlets uBlock Origin marks `requiresTrust`, with and without `.js`. */
export function trustedScriptletNames(resourcesJson: string): Set<string> {
  const names = new Set<string>();
  try {
    for (const s of JSON.parse(resourcesJson).scriptlets ?? []) {
      if (s?.requiresTrust !== true) continue;
      for (const n of [s.name, ...(s.aliases ?? [])]) {
        if (typeof n !== 'string') continue;
        names.add(n);
        names.add(n.replace(/\.js$/, ''));
      }
    }
  } catch {}
  return names;
}

const SCRIPTLET_NAME = /#@?#\+js\(\s*([^,)\s]+)|#@?%#\/\/scriptlet\(\s*['"]([^'"]+)/;

/**
 * Drops filters that call trusted scriptlets (which can run arbitrary code in pages). Ghostery's
 * engine does not enforce uBlock's trust flag, so, as in uBlock Origin, only uBlock's own lists
 * and the user's filters may use them.
 */
export function dropTrustedScriptlets(text: string, trusted: Set<string>): string {
  if (!trusted.size || !text.includes('+js(') && !text.includes('//scriptlet(')) return text;
  return text
    .split('\n')
    .filter((line) => {
      const m = SCRIPTLET_NAME.exec(line);
      const name = m && (m[1] ?? m[2]);
      return !name || !trusted.has(name.replace(/^['"]|['"]$/g, ''));
    })
    .join('\n');
}

/** uBlock Origin's own lists, trusted for trusted scriptlets like in uBlock itself. */
export const isUblockList = (file: string) => path.basename(file).startsWith('ublock-');

export interface CompileJob {
  lists: string[];
  resources: string;
  custom: string;
  out: string;
}

/** Writes the engine to `job.out` and its filter count to `job.out + '.json'`. */
export function compileEngine(job: CompileJob): { bytes: number; ms: number; filters: number } {
  const started = Date.now();
  const resources = readListFile(job.resources);
  const trusted = trustedScriptletNames(resources);
  const lists = job.lists.map((f) => (isUblockList(f) ? readListFile(f) : dropTrustedScriptlets(readListFile(f), trusted)));
  const engine = FiltersEngine.parse([...lists, job.custom].join('\n'), ENGINE_OPTIONS);
  engine.updateResources(resources, crypto.createHash('sha256').update(resources).digest('hex').slice(0, 16));
  const buf = engine.serialize();
  const f = engine.getFilters();
  const filters = f.networkFilters.length + f.cosmeticFilters.length;
  const tmp = `${job.out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, job.out);
  fs.writeFileSync(`${job.out}.json`, JSON.stringify({ filters }));
  return { bytes: buf.length, ms: Date.now() - started, filters };
}

export function loadEngine(file: string): FiltersEngine {
  const engine = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(file)));
  engine.updateEnv(engineEnv() as Parameters<FiltersEngine['updateEnv']>[0]);
  return engine;
}
