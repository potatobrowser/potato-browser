import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  accessState,
  HISTORY_LIMIT,
  homeDir,
  isImportableUrl,
  withDbCopy,
  type ImportedBookmark,
  type ImportedBookmarks,
  type ImportedHistoryItem,
} from './common';

export function safariDir(): string {
  return path.join(homeDir(), 'Library', 'Safari');
}

type PlistValue = string | number | boolean | Date | PlistValue[] | { [k: string]: PlistValue } | null;

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!;
  });

/** Minimal XML property list parser (dict, array, string, numbers, booleans, date, data). */
export function parseXmlPlist(xml: string): PlistValue {
  const tokens: { tag?: string; close?: boolean; self?: boolean; text?: string }[] = [];
  const re = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[2]) tokens.push({ tag: m[2], close: m[1] === '/', self: m[3] === '/' });
    else if (m[4] !== undefined) tokens.push({ text: m[4] });
  }
  let i = 0;
  const textUntil = (tag: string): string => {
    let out = '';
    while (i < tokens.length && !(tokens[i]!.tag === tag && tokens[i]!.close)) {
      if (tokens[i]!.text !== undefined) out += tokens[i]!.text;
      i++;
    }
    i++;
    return decode(out);
  };
  const skipText = () => {
    while (i < tokens.length && tokens[i]!.text !== undefined) i++;
  };
  const value = (): PlistValue => {
    skipText();
    const t = tokens[i++];
    if (!t?.tag) return null;
    if (t.self) {
      if (t.tag === 'true') return true;
      if (t.tag === 'false') return false;
      if (t.tag === 'dict') return {};
      if (t.tag === 'array') return [];
      return t.tag === 'string' ? '' : null;
    }
    switch (t.tag) {
      case 'plist': {
        const v = value();
        skipText();
        i++;
        return v;
      }
      case 'dict': {
        const obj: Record<string, PlistValue> = {};
        for (;;) {
          skipText();
          const k = tokens[i];
          if (!k || (k.tag === 'dict' && k.close)) {
            i++;
            return obj;
          }
          if (k.tag === 'key' && !k.close) {
            i++;
            const key = textUntil('key');
            obj[key] = value();
          } else i++;
        }
      }
      case 'array': {
        const arr: PlistValue[] = [];
        for (;;) {
          skipText();
          const k = tokens[i];
          if (!k || (k.tag === 'array' && k.close)) {
            i++;
            return arr;
          }
          arr.push(value());
        }
      }
      case 'string':
        return textUntil('string');
      case 'integer':
      case 'real':
        return Number(textUntil(t.tag));
      case 'date':
        return new Date(textUntil('date'));
      case 'data':
        textUntil('data');
        return null;
      case 'true':
        textUntil('true');
        return true;
      case 'false':
        textUntil('false');
        return false;
      default:
        textUntil(t.tag);
        return null;
    }
  };
  return value();
}

function readPlist(file: string): PlistValue {
  const raw = fs.readFileSync(file);
  // Binary plists start with "bplist"; let plutil convert them to XML.
  const xml = raw.subarray(0, 6).toString() === 'bplist'
    ? execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', file], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
    : raw.toString('utf8');
  return parseXmlPlist(xml);
}

type Dict = { [k: string]: PlistValue };

function convert(children: PlistValue): ImportedBookmark[] {
  if (!Array.isArray(children)) return [];
  const out: ImportedBookmark[] = [];
  for (const c of children) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || c instanceof Date) continue;
    const d = c as Dict;
    if (d.WebBookmarkType === 'WebBookmarkTypeLeaf' && isImportableUrl(d.URLString)) {
      const title = ((d.URIDictionary as Dict | undefined)?.title as string) || (d.URLString as string);
      out.push({ title, url: d.URLString as string });
    } else if (d.WebBookmarkType === 'WebBookmarkTypeList') {
      out.push({ title: (d.Title as string) || 'Folder', children: convert(d.Children) });
    }
  }
  return out;
}

export function safariState(): { bookmarks: 'ok' | 'missing' | 'blocked'; history: 'ok' | 'missing' | 'blocked' } {
  return {
    bookmarks: accessState(path.join(safariDir(), 'Bookmarks.plist')),
    history: accessState(path.join(safariDir(), 'History.db')),
  };
}

export function readSafariBookmarks(): ImportedBookmarks {
  const root = readPlist(path.join(safariDir(), 'Bookmarks.plist')) as Dict;
  const result: ImportedBookmarks = { bar: [], other: [] };
  for (const c of (root?.Children as PlistValue[]) ?? []) {
    const d = c as Dict;
    if (!d || d.WebBookmarkType !== 'WebBookmarkTypeList') continue;
    if (d.Title === 'BookmarksBar') result.bar = convert(d.Children);
    else if (d.Title === 'BookmarksMenu') result.other.push(...convert(d.Children));
    else if (d.Title === 'com.apple.ReadingList') {
      const items = convert(d.Children);
      if (items.length) result.other.push({ title: 'Reading List', children: items });
    } else {
      result.other.push({ title: (d.Title as string) || 'Folder', children: convert(d.Children) });
    }
  }
  return result;
}

export function readSafariHistory(): ImportedHistoryItem[] {
  return withDbCopy(path.join(safariDir(), 'History.db'), (db) => {
    const rows = db
      .prepare(
        `SELECT i.url AS url, i.visit_count AS visit_count, MAX(v.visit_time) AS t,
           (SELECT title FROM history_visits v2 WHERE v2.history_item = i.id AND v2.title IS NOT NULL ORDER BY v2.visit_time DESC LIMIT 1) AS title
         FROM history_items i JOIN history_visits v ON v.history_item = i.id
         GROUP BY i.id ORDER BY t DESC LIMIT ?`,
      )
      .all(HISTORY_LIMIT) as { url: string; visit_count: number; t: number; title: string | null }[];
    return rows
      .map((r) => ({
        url: r.url,
        title: r.title ?? '',
        visitCount: Number(r.visit_count) || 1,
        typedCount: 0,
        lastVisit: Math.round((Number(r.t) + 978_307_200) * 1000),
      }))
      .filter((r) => r.lastVisit > 0 && isImportableUrl(r.url));
  });
}
