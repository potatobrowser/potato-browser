import fs from 'node:fs';
import path from 'node:path';
import {
  appSupport,
  exists,
  HISTORY_LIMIT,
  isImportableUrl,
  withDbCopy,
  type ImportedBookmark,
  type ImportedBookmarks,
  type ImportedHistoryItem,
} from './common';

export interface FirefoxProfile {
  name: string;
  path: string;
}

/** Parses profiles.ini (Name/Path/IsRelative per [ProfileN] section). */
export function parseProfilesIni(text: string, root: string): FirefoxProfile[] {
  const out: FirefoxProfile[] = [];
  let cur: Record<string, string> | null = null;
  const flush = () => {
    if (cur?.Path) {
      const p = cur.IsRelative === '0' ? cur.Path : path.join(root, cur.Path);
      out.push({ name: cur.Name || path.basename(p), path: p });
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      flush();
      cur = sec[1]!.startsWith('Profile') ? {} : null;
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (kv && cur) cur[kv[1]!.trim()] = kv[2]!.trim();
  }
  flush();
  return out;
}

export function findFirefoxProfiles(): FirefoxProfile[] {
  const root = appSupport('Firefox');
  const ini = path.join(root, 'profiles.ini');
  if (!exists(ini)) return [];
  try {
    return parseProfilesIni(fs.readFileSync(ini, 'utf8'), root).filter((p) => exists(path.join(p.path, 'places.sqlite')));
  } catch {
    return [];
  }
}

interface Row {
  id: number;
  type: number;
  parent: number;
  position: number;
  title: string | null;
  url: string | null;
  dateAdded: number | null;
  guid: string;
}

export function readFirefoxBookmarks(profile: FirefoxProfile): ImportedBookmarks {
  return withDbCopy(path.join(profile.path, 'places.sqlite'), (db) => {
    const rows = db
      .prepare(
        `SELECT b.id, b.type, b.parent, b.position, b.title, p.url, b.dateAdded, b.guid
         FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position`,
      )
      .all() as unknown as Row[];
    const byParent = new Map<number, Row[]>();
    for (const r of rows) {
      const list = byParent.get(r.parent) ?? [];
      list.push(r);
      byParent.set(r.parent, list);
    }
    const build = (parentId: number, depth = 0): ImportedBookmark[] =>
      depth > 20
        ? []
        : (byParent.get(parentId) ?? []).flatMap((r): ImportedBookmark[] => {
            if (r.type === 1 && isImportableUrl(r.url)) {
              return [{ title: r.title || r.url, url: r.url, addedAt: r.dateAdded ? Math.round(Number(r.dateAdded) / 1000) : undefined }];
            }
            if (r.type === 2) return [{ title: r.title || 'Folder', children: build(r.id, depth + 1) }];
            return [];
          });
    const root = (guid: string) => rows.find((r) => r.guid === guid);
    const toolbar = root('toolbar_____');
    const menu = root('menu________');
    const unfiled = root('unfiled_____');
    const mobile = root('mobile______');
    const other: ImportedBookmark[] = [];
    if (menu) {
      const items = build(menu.id);
      if (items.length) other.push({ title: 'Bookmarks Menu', children: items });
    }
    if (unfiled) other.push(...build(unfiled.id));
    if (mobile) {
      const items = build(mobile.id);
      if (items.length) other.push({ title: 'Mobile Bookmarks', children: items });
    }
    return { bar: toolbar ? build(toolbar.id) : [], other };
  });
}

export function readFirefoxHistory(profile: FirefoxProfile): ImportedHistoryItem[] {
  return withDbCopy(path.join(profile.path, 'places.sqlite'), (db) => {
    const rows = db
      .prepare(
        `SELECT url, title, visit_count, typed, last_visit_date FROM moz_places
         WHERE hidden = 0 AND last_visit_date IS NOT NULL AND (url LIKE 'http:%' OR url LIKE 'https:%')
         ORDER BY last_visit_date DESC LIMIT ?`,
      )
      .all(HISTORY_LIMIT) as { url: string; title: string | null; visit_count: number; typed: number; last_visit_date: number }[];
    return rows
      .map((r) => ({
        url: r.url,
        title: r.title ?? '',
        visitCount: Number(r.visit_count) || 1,
        typedCount: Number(r.typed) || 0,
        lastVisit: Math.round(Number(r.last_visit_date) / 1000),
      }))
      .filter((r) => r.lastVisit > 0 && isImportableUrl(r.url));
  });
}
