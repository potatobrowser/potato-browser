import fs from 'node:fs';
import path from 'node:path';
import {
  appSupport,
  exists,
  fromWebkitTime,
  HISTORY_LIMIT,
  isImportableUrl,
  withDbCopy,
  type ImportedBookmark,
  type ImportedBookmarks,
  type ImportedHistoryItem,
} from './common';

export interface ChromiumBrowser {
  key: string;
  name: string;
  /** Path segments under ~/Library/Application Support. */
  dir: string[];
  /** Opera keeps a single profile directly in its data directory. */
  flat?: boolean;
}

export const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  { key: 'chrome', name: 'Google Chrome', dir: ['Google', 'Chrome'] },
  { key: 'chrome-beta', name: 'Google Chrome Beta', dir: ['Google', 'Chrome Beta'] },
  { key: 'chrome-canary', name: 'Google Chrome Canary', dir: ['Google', 'Chrome Canary'] },
  { key: 'edge', name: 'Microsoft Edge', dir: ['Microsoft Edge'] },
  { key: 'brave', name: 'Brave', dir: ['BraveSoftware', 'Brave-Browser'] },
  { key: 'arc', name: 'Arc', dir: ['Arc', 'User Data'] },
  { key: 'vivaldi', name: 'Vivaldi', dir: ['Vivaldi'] },
  { key: 'chromium', name: 'Chromium', dir: ['Chromium'] },
  { key: 'opera', name: 'Opera', dir: ['com.operasoftware.Opera'], flat: true },
  { key: 'opera-gx', name: 'Opera GX', dir: ['com.operasoftware.OperaGX'], flat: true },
  { key: 'yandex', name: 'Yandex Browser', dir: ['Yandex', 'YandexBrowser'] },
];

export interface ChromiumProfile {
  browser: ChromiumBrowser;
  profileDir: string;
  profileName: string;
  path: string;
}

export function findChromiumProfiles(): ChromiumProfile[] {
  const out: ChromiumProfile[] = [];
  for (const b of CHROMIUM_BROWSERS) {
    const root = appSupport(...b.dir);
    if (!exists(root)) continue;
    if (b.flat) {
      if (exists(path.join(root, 'Bookmarks')) || exists(path.join(root, 'History'))) {
        out.push({ browser: b, profileDir: '.', profileName: 'Default', path: root });
      }
      continue;
    }
    let names: Record<string, string> = {};
    try {
      const state = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'));
      const cache = state?.profile?.info_cache ?? {};
      names = Object.fromEntries(Object.entries(cache).map(([dir, v]) => [dir, String((v as { name?: string })?.name ?? dir)]));
    } catch {}
    let dirs = Object.keys(names);
    if (!dirs.length) {
      try {
        dirs = fs.readdirSync(root).filter((d) => d === 'Default' || /^Profile \d+$/.test(d));
      } catch {}
    }
    for (const dir of dirs.sort()) {
      const p = path.join(root, dir);
      if (!exists(path.join(p, 'Bookmarks')) && !exists(path.join(p, 'History'))) continue;
      out.push({ browser: b, profileDir: dir, profileName: names[dir] ?? dir, path: p });
    }
  }
  return out;
}

interface ChromeNode {
  type?: string;
  name?: string;
  url?: string;
  date_added?: string;
  children?: ChromeNode[];
}

function convert(nodes: ChromeNode[] | undefined): ImportedBookmark[] {
  const out: ImportedBookmark[] = [];
  for (const n of nodes ?? []) {
    if (n.type === 'url' && isImportableUrl(n.url)) {
      out.push({ title: n.name || n.url, url: n.url, addedAt: fromWebkitTime(n.date_added) || undefined });
    } else if (n.type === 'folder') {
      out.push({ title: n.name || 'Folder', children: convert(n.children), addedAt: fromWebkitTime(n.date_added) || undefined });
    }
  }
  return out;
}

/** Arc keeps pinned tabs in StorableSidebar.json rather than the Bookmarks file. */
function arcSidebar(): ImportedBookmark[] {
  const file = appSupport('Arc', 'StorableSidebar.json');
  if (!exists(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out: ImportedBookmark[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const tab = (v as { data?: { tab?: { savedURL?: string; savedTitle?: string } } }).data?.tab;
        if (tab && isImportableUrl(tab.savedURL)) out.push({ title: tab.savedTitle || tab.savedURL!, url: tab.savedURL });
        Object.values(v).forEach(walk);
      }
    };
    walk(data?.sidebar?.containers ?? data);
    const seen = new Set<string>();
    return out.filter((b) => !seen.has(b.url!) && seen.add(b.url!));
  } catch {
    return [];
  }
}

export function readChromiumBookmarks(profile: ChromiumProfile): ImportedBookmarks {
  const result: ImportedBookmarks = { bar: [], other: [] };
  const file = path.join(profile.path, 'Bookmarks');
  if (exists(file)) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    result.bar = convert(json?.roots?.bookmark_bar?.children);
    result.other = [...convert(json?.roots?.other?.children), ...convert(json?.roots?.synced?.children)];
  }
  if (profile.browser.key === 'arc') {
    const pinned = arcSidebar();
    if (pinned.length) result.other.push({ title: 'Arc pinned tabs', children: pinned });
  }
  return result;
}

export function readChromiumHistory(profile: ChromiumProfile): ImportedHistoryItem[] {
  const file = path.join(profile.path, 'History');
  if (!exists(file)) return [];
  return withDbCopy(file, (db) => {
    const rows = db
      .prepare(
        `SELECT url, title, visit_count, typed_count, last_visit_time FROM urls
         WHERE hidden = 0 AND (url LIKE 'http:%' OR url LIKE 'https:%')
         ORDER BY last_visit_time DESC LIMIT ?`,
      )
      .all(HISTORY_LIMIT) as { url: string; title: string; visit_count: number; typed_count: number; last_visit_time: number | bigint }[];
    return rows
      .map((r) => ({
        url: r.url,
        title: r.title ?? '',
        visitCount: Number(r.visit_count) || 1,
        typedCount: Number(r.typed_count) || 0,
        lastVisit: fromWebkitTime(r.last_visit_time),
      }))
      .filter((r) => r.lastVisit > 0 && isImportableUrl(r.url));
  });
}
