import type { ImportResult, ImportSource } from '../../shared/types';
import { ctx } from '../context';
import { BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID } from '../db';
import { findChromiumProfiles, readChromiumBookmarks, readChromiumHistory } from './chromium';
import type { ImportedBookmark, ImportedBookmarks, ImportedHistoryItem } from './common';
import { findFirefoxProfiles, readFirefoxBookmarks, readFirefoxHistory } from './firefox';
import { readSafariBookmarks, readSafariHistory, safariDir, safariState } from './safari';
import path from 'node:path';
import fs from 'node:fs';

interface SourceImpl extends ImportSource {
  readBookmarks: () => ImportedBookmarks;
  readHistory: () => ImportedHistoryItem[];
}

function sources(): SourceImpl[] {
  const out: SourceImpl[] = [];
  for (const p of findChromiumProfiles()) {
    out.push({
      id: `chromium:${p.browser.key}:${p.profileDir}`,
      browser: p.browser.name,
      profile: p.profileName,
      path: p.path,
      kind: 'chromium',
      hasBookmarks: fs.existsSync(path.join(p.path, 'Bookmarks')) || p.browser.key === 'arc',
      hasHistory: fs.existsSync(path.join(p.path, 'History')),
      blocked: null,
      readBookmarks: () => readChromiumBookmarks(p),
      readHistory: () => readChromiumHistory(p),
    });
  }
  for (const p of findFirefoxProfiles()) {
    out.push({
      id: `firefox:${path.basename(p.path)}`,
      browser: 'Firefox',
      profile: p.name,
      path: p.path,
      kind: 'firefox',
      hasBookmarks: true,
      hasHistory: true,
      blocked: null,
      readBookmarks: () => readFirefoxBookmarks(p),
      readHistory: () => readFirefoxHistory(p),
    });
  }
  const safari = safariState();
  if (safari.bookmarks !== 'missing' || safari.history !== 'missing') {
    const blocked = safari.bookmarks === 'blocked' || safari.history === 'blocked';
    out.push({
      id: 'safari',
      browser: 'Safari',
      profile: 'Default',
      path: safariDir(),
      kind: 'safari',
      hasBookmarks: safari.bookmarks !== 'missing',
      hasHistory: safari.history !== 'missing',
      blocked: blocked ? 'macOS protects Safari data. Allow Full Disk Access for No-AI Browser, then try again.' : null,
      readBookmarks: readSafariBookmarks,
      readHistory: readSafariHistory,
    });
  }
  return out;
}

export function detectSources(): ImportSource[] {
  return sources().map(({ readBookmarks: _b, readHistory: _h, ...s }) => s);
}

function count(nodes: ImportedBookmark[]): number {
  return nodes.reduce((n, b) => n + (b.url ? 1 : 0) + count(b.children ?? []), 0);
}

/** Inserts a bookmark tree, skipping URLs the user already has. Returns how many were added. */
function insertTree(parentId: number, nodes: ImportedBookmark[], existing: Set<string>): number {
  let added = 0;
  for (const n of nodes) {
    if (n.url) {
      if (existing.has(n.url)) continue;
      existing.add(n.url);
      ctx.db.addBookmark({ parentId, title: n.title, url: n.url, createdAt: n.addedAt });
      added++;
    } else if (n.children) {
      if (!count(n.children)) continue;
      const folder = ctx.db.findFolder(parentId, n.title) ?? ctx.db.addBookmark({ parentId, type: 'folder', title: n.title, createdAt: n.addedAt });
      added += insertTree(folder, n.children, existing);
    }
  }
  return added;
}

function allBookmarkUrls(): Set<string> {
  const urls = new Set<string>();
  const walk = (nodes: { url: string | null; children?: unknown[] }[]) => {
    for (const n of nodes) {
      if (n.url) urls.add(n.url);
      if (n.children) walk(n.children as typeof nodes);
    }
  };
  walk(ctx.db.bookmarkTree());
  return urls;
}

export async function runImport(sourceId: string, what: { bookmarks: boolean; history: boolean }): Promise<ImportResult> {
  const src = sources().find((s) => s.id === sourceId);
  const result: ImportResult = { sourceId, bookmarks: 0, history: 0, errors: [] };
  if (!src) {
    result.errors.push('That browser profile is no longer available.');
    return result;
  }
  const label = src.profile && src.profile !== 'Default' && src.profile !== 'Person 1' ? `${src.browser} (${src.profile})` : src.browser;
  if (what.bookmarks && src.hasBookmarks) {
    try {
      const tree = src.readBookmarks();
      const existing = allBookmarkUrls();
      ctx.db.tx(() => {
        if (tree.bar.length) {
          // An empty bar takes the other browser's bar as is; otherwise keep it in a folder.
          const target = ctx.db.bookmarkCount(BOOKMARKS_BAR_ID) === 0
            ? BOOKMARKS_BAR_ID
            : ctx.db.findFolder(BOOKMARKS_BAR_ID, `Imported from ${label}`) ??
              ctx.db.addBookmark({ parentId: BOOKMARKS_BAR_ID, type: 'folder', title: `Imported from ${label}` });
          result.bookmarks += insertTree(target, tree.bar, existing);
        }
        if (tree.other.length && count(tree.other)) {
          const folder = ctx.db.findFolder(OTHER_BOOKMARKS_ID, `Imported from ${label}`) ??
            ctx.db.addBookmark({ parentId: OTHER_BOOKMARKS_ID, type: 'folder', title: `Imported from ${label}` });
          result.bookmarks += insertTree(folder, tree.other, existing);
        }
      });
    } catch (err) {
      result.errors.push(`Bookmarks: ${describe(err)}`);
    }
  }
  if (what.history && src.hasHistory) {
    try {
      const items = src.readHistory();
      ctx.db.tx(() => {
        for (const h of items) if (ctx.db.importUrl(h.url, h.title, h.visitCount, h.typedCount, h.lastVisit)) result.history++;
      });
    } catch (err) {
      result.errors.push(`History: ${describe(err)}`);
    }
  }
  return result;
}

function describe(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'EPERM' || e?.code === 'EACCES') return 'macOS blocked access. Allow Full Disk Access for No-AI Browser in System Settings.';
  if (e?.code === 'ENOENT') return 'file not found';
  return e?.message || String(err);
}
