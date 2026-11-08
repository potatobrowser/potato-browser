import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { VoteKind } from '@potato/shared';
import type { BookmarkNode, DownloadItemState, HistoryEntry, TopSite } from '../shared/types';

export const BOOKMARKS_BAR_ID = 1;
export const OTHER_BOOKMARKS_ID = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS urls (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  visit_count INTEGER NOT NULL DEFAULT 0,
  typed_count INTEGER NOT NULL DEFAULT 0,
  last_visit INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS urls_last_visit ON urls(last_visit);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  url_id INTEGER NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
  visit_time INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_time ON visits(visit_time);
CREATE INDEX IF NOT EXISTS visits_url ON visits(url_id);
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES bookmarks(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('folder', 'url')),
  title TEXT NOT NULL DEFAULT '',
  url TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookmarks_parent ON bookmarks(parent_id, position);
CREATE INDEX IF NOT EXISTS bookmarks_url ON bookmarks(url);
CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  state TEXT NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  mime TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS site_settings (
  site TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (site, key)
);
CREATE TABLE IF NOT EXISTS favicons (
  host TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS my_flags (
  key TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  vote TEXT NOT NULL DEFAULT 'ai'
);
CREATE TABLE IF NOT EXISTS stats (
  day TEXT PRIMARY KEY,
  shield_hidden INTEGER NOT NULL DEFAULT 0,
  ads_blocked INTEGER NOT NULL DEFAULT 0
);
`;

type Row = Record<string, any>;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export class ProfileDb {
  readonly db: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    // Profiles from before the ad blocker (0.5.0) lack the column.
    const cols = this.db.prepare('PRAGMA table_info(stats)').all() as Row[];
    if (!cols.some((c) => c.name === 'ads_blocked')) this.db.exec('ALTER TABLE stats ADD COLUMN ads_blocked INTEGER NOT NULL DEFAULT 0');
    // Not AI votes (0.8.0): before them every row was an AI flag.
    const flagCols = this.db.prepare('PRAGMA table_info(my_flags)').all() as Row[];
    if (!flagCols.some((c) => c.name === 'vote')) this.db.exec("ALTER TABLE my_flags ADD COLUMN vote TEXT NOT NULL DEFAULT 'ai'");
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO bookmarks (id, parent_id, type, title, position, created_at)
         VALUES (?, NULL, 'folder', 'Bookmarks Bar', 0, ?), (?, NULL, 'folder', 'Other Bookmarks', 1, ?)`,
      )
      .run(BOOKMARKS_BAR_ID, now, OTHER_BOOKMARKS_ID, now);
  }

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- history ------------------------------------------------------------------------------

  addVisit(url: string, title: string, opts: { typed?: boolean; time?: number; countVisit?: boolean } = {}): void {
    const time = opts.time ?? Date.now();
    const count = opts.countVisit === false ? 0 : 1;
    this.stmt(
      `INSERT INTO urls (url, title, visit_count, typed_count, last_visit) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title = CASE WHEN excluded.title != '' THEN excluded.title ELSE urls.title END,
         visit_count = urls.visit_count + excluded.visit_count,
         typed_count = urls.typed_count + excluded.typed_count,
         last_visit = MAX(urls.last_visit, excluded.last_visit)`,
    ).run(url, title, count, opts.typed ? 1 : 0, time);
    if (count) {
      const row = this.stmt('SELECT id FROM urls WHERE url = ?').get(url) as Row;
      this.stmt('INSERT INTO visits (url_id, visit_time) VALUES (?, ?)').run(row.id, time);
    }
  }

  updateTitle(url: string, title: string): void {
    if (!title) return;
    this.stmt('UPDATE urls SET title = ? WHERE url = ?').run(title, url);
  }

  queryHistory(text: string, limit = 100, before = Number.MAX_SAFE_INTEGER): HistoryEntry[] {
    const like = `%${escapeLike(text.trim())}%`;
    const rows = this.stmt(
      `SELECT v.id, u.url, u.title, v.visit_time FROM visits v JOIN urls u ON u.id = v.url_id
       WHERE v.visit_time < ? AND (? = '%%' OR u.url LIKE ? ESCAPE '\\' OR u.title LIKE ? ESCAPE '\\')
       ORDER BY v.visit_time DESC LIMIT ?`,
    ).all(before, like, like, like, limit) as Row[];
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      visitTime: r.visit_time,
      favicon: this.favicon(hostOf(r.url)),
    }));
  }

  deleteVisits(ids: number[]): void {
    this.tx(() => {
      for (const id of ids) this.stmt('DELETE FROM visits WHERE id = ?').run(id);
      this.pruneUrls();
    });
  }

  deleteUrl(url: string): void {
    this.stmt('DELETE FROM urls WHERE url = ?').run(url);
  }

  clearHistory(since: number): void {
    this.tx(() => {
      this.stmt('DELETE FROM visits WHERE visit_time >= ?').run(since);
      this.stmt('DELETE FROM urls WHERE last_visit >= ? AND id NOT IN (SELECT url_id FROM visits)').run(since);
      this.pruneUrls();
    });
  }

  private pruneUrls(): void {
    this.stmt('DELETE FROM urls WHERE id NOT IN (SELECT url_id FROM visits)').run();
  }

  /** Imported history: keeps the source's counts and records one visit at its last visit time. */
  importUrl(url: string, title: string, visitCount: number, typedCount: number, lastVisit: number): boolean {
    const existing = this.stmt('SELECT id, last_visit FROM urls WHERE url = ?').get(url) as Row | undefined;
    if (existing && existing.last_visit >= lastVisit) return false;
    this.stmt(
      `INSERT INTO urls (url, title, visit_count, typed_count, last_visit) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title = CASE WHEN urls.title = '' THEN excluded.title ELSE urls.title END,
         visit_count = urls.visit_count + excluded.visit_count,
         typed_count = urls.typed_count + excluded.typed_count,
         last_visit = MAX(urls.last_visit, excluded.last_visit)`,
    ).run(url, title, Math.max(1, visitCount), Math.max(0, typedCount), lastVisit);
    const row = this.stmt('SELECT id FROM urls WHERE url = ?').get(url) as Row;
    this.stmt('INSERT INTO visits (url_id, visit_time) VALUES (?, ?)').run(row.id, lastVisit);
    return true;
  }

  historyCount(): number {
    return (this.stmt('SELECT COUNT(*) AS c FROM urls').get() as Row).c;
  }

  /** Candidates for omnibox suggestions, scored by frecency in JS. */
  suggestUrls(text: string, limit: number): { url: string; title: string; score: number; bookmarked: boolean }[] {
    const t = text.trim().toLowerCase();
    if (!t) return [];
    const like = `%${escapeLike(t)}%`;
    const rows = this.stmt(
      `SELECT url, title, visit_count, typed_count, last_visit FROM urls
       WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
       ORDER BY typed_count DESC, visit_count DESC, last_visit DESC LIMIT 60`,
    ).all(like, like) as Row[];
    const marks = this.stmt(
      `SELECT url, title FROM bookmarks WHERE type = 'url' AND (url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') LIMIT 30`,
    ).all(like, like) as Row[];
    const now = Date.now();
    const out = new Map<string, { url: string; title: string; score: number; bookmarked: boolean }>();
    const score = (r: Row) => {
      const ageDays = Math.max(0, (now - (r.last_visit || 0)) / 86_400_000);
      const recency = ageDays < 4 ? 1 : ageDays < 14 ? 0.7 : ageDays < 31 ? 0.5 : ageDays < 90 ? 0.3 : 0.1;
      const host = hostOf(r.url).replace(/^www\./, '');
      const prefix = host.startsWith(t) ? 3 : 1;
      return (1 + r.visit_count + 2 * r.typed_count) * recency * prefix;
    };
    for (const r of rows) out.set(r.url, { url: r.url, title: r.title, score: score(r), bookmarked: false });
    for (const m of marks) {
      const prev = out.get(m.url);
      if (prev) {
        prev.bookmarked = true;
        prev.score *= 2;
      } else {
        out.set(m.url, { url: m.url, title: m.title, score: 5, bookmarked: true });
      }
    }
    return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Host completion for inline autocomplete ("git" -> "github.com"). */
  inlineHost(text: string): string | null {
    const t = text.trim().toLowerCase();
    if (!t || /[\s/]/.test(t)) return null;
    const rows = this.stmt(
      `SELECT url FROM urls WHERE (url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')
       ORDER BY typed_count DESC, visit_count DESC LIMIT 20`,
    ).all(
      `https://${escapeLike(t)}%`,
      `https://www.${escapeLike(t)}%`,
      `http://${escapeLike(t)}%`,
      `http://www.${escapeLike(t)}%`,
    ) as Row[];
    for (const r of rows) {
      const host = hostOf(r.url).replace(/^www\./, '');
      if (host.startsWith(t) && host.length > t.length) return host;
    }
    return null;
  }

  topSites(limit: number): TopSite[] {
    const rows = this.stmt(
      `SELECT url, title, visit_count FROM urls WHERE url LIKE 'http%' AND visit_count > 0
       ORDER BY visit_count DESC, last_visit DESC LIMIT 200`,
    ).all() as Row[];
    const seen = new Set<string>();
    const out: TopSite[] = [];
    for (const r of rows) {
      const host = hostOf(r.url);
      if (!host || seen.has(host)) continue;
      seen.add(host);
      out.push({ url: r.url, title: r.title || host, favicon: this.favicon(host) });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- bookmarks ----------------------------------------------------------------------------

  private toNode(r: Row): BookmarkNode {
    return {
      id: r.id,
      parentId: r.parent_id,
      type: r.type,
      title: r.title,
      url: r.url,
      position: r.position,
      createdAt: r.created_at,
    };
  }

  bookmarkChildren(parentId: number, deep = false): BookmarkNode[] {
    const rows = this.stmt('SELECT * FROM bookmarks WHERE parent_id = ? ORDER BY position, id').all(parentId) as Row[];
    return rows.map((r) => {
      const n = this.toNode(r);
      if (deep && n.type === 'folder') n.children = this.bookmarkChildren(n.id, true);
      return n;
    });
  }

  bookmarkTree(): BookmarkNode[] {
    return [BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID].map((id) => {
      const n = this.toNode(this.stmt('SELECT * FROM bookmarks WHERE id = ?').get(id) as Row);
      n.children = this.bookmarkChildren(id, true);
      return n;
    });
  }

  getBookmark(id: number): BookmarkNode | null {
    const r = this.stmt('SELECT * FROM bookmarks WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toNode(r) : null;
  }

  isBookmarked(url: string): boolean {
    return !!this.stmt("SELECT 1 FROM bookmarks WHERE type = 'url' AND url = ? LIMIT 1").get(url);
  }

  addBookmark(b: { parentId?: number; type?: 'folder' | 'url'; title: string; url?: string | null; index?: number; createdAt?: number }): number {
    const parentId = b.parentId ?? BOOKMARKS_BAR_ID;
    const type = b.type ?? 'url';
    const max = (this.stmt('SELECT COALESCE(MAX(position), -1) AS m FROM bookmarks WHERE parent_id = ?').get(parentId) as Row).m as number;
    let position = max + 1;
    if (b.index !== undefined && b.index <= max) {
      position = Math.max(0, b.index);
      this.stmt('UPDATE bookmarks SET position = position + 1 WHERE parent_id = ? AND position >= ?').run(parentId, position);
    }
    const r = this.stmt(
      'INSERT INTO bookmarks (parent_id, type, title, url, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(parentId, type, b.title, type === 'url' ? (b.url ?? '') : null, position, b.createdAt ?? Date.now());
    return Number(r.lastInsertRowid);
  }

  updateBookmark(id: number, patch: { title?: string; url?: string }): void {
    if (id === BOOKMARKS_BAR_ID || id === OTHER_BOOKMARKS_ID) return;
    if (patch.title !== undefined) this.stmt('UPDATE bookmarks SET title = ? WHERE id = ?').run(patch.title, id);
    if (patch.url !== undefined) this.stmt("UPDATE bookmarks SET url = ? WHERE id = ? AND type = 'url'").run(patch.url, id);
  }

  removeBookmark(id: number): void {
    if (id === BOOKMARKS_BAR_ID || id === OTHER_BOOKMARKS_ID) return;
    const n = this.getBookmark(id);
    if (!n) return;
    this.tx(() => {
      this.stmt('DELETE FROM bookmarks WHERE id = ?').run(id);
      this.stmt('UPDATE bookmarks SET position = position - 1 WHERE parent_id = ? AND position > ?').run(n.parentId, n.position);
    });
  }

  removeBookmarksByUrl(url: string): void {
    const rows = this.stmt("SELECT id FROM bookmarks WHERE type = 'url' AND url = ?").all(url) as Row[];
    for (const r of rows) this.removeBookmark(r.id);
  }

  moveBookmark(id: number, parentId: number, index: number): void {
    const n = this.getBookmark(id);
    if (!n || n.parentId === null) return;
    // Refuse to move a folder into itself or its descendants.
    for (let p: number | null = parentId; p !== null; p = this.getBookmark(p)?.parentId ?? null) {
      if (p === id) return;
    }
    this.tx(() => {
      this.stmt('UPDATE bookmarks SET position = position - 1 WHERE parent_id = ? AND position > ?').run(n.parentId, n.position);
      const count = (this.stmt('SELECT COUNT(*) AS c FROM bookmarks WHERE parent_id = ?').get(parentId) as Row).c as number;
      const pos = Math.max(0, Math.min(index, count));
      this.stmt('UPDATE bookmarks SET position = position + 1 WHERE parent_id = ? AND position >= ?').run(parentId, pos);
      this.stmt('UPDATE bookmarks SET parent_id = ?, position = ? WHERE id = ?').run(parentId, pos, id);
    });
  }

  findFolder(parentId: number, title: string): number | null {
    const r = this.stmt("SELECT id FROM bookmarks WHERE parent_id = ? AND type = 'folder' AND title = ?").get(parentId, title) as Row | undefined;
    return r ? r.id : null;
  }

  bookmarkCount(parentId: number): number {
    return (this.stmt('SELECT COUNT(*) AS c FROM bookmarks WHERE parent_id = ?').get(parentId) as Row).c;
  }

  // ---- downloads ----------------------------------------------------------------------------

  saveDownload(d: DownloadItemState): void {
    this.stmt(
      `INSERT INTO downloads (id, url, filename, path, state, received, total, started_at, ended_at, mime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, path = excluded.path, state = excluded.state,
         received = excluded.received, total = excluded.total, ended_at = excluded.ended_at`,
    ).run(d.id, d.url, d.filename, d.path, d.state, d.received, d.total, d.startedAt, d.endedAt, d.mime);
  }

  listDownloads(limit = 200): DownloadItemState[] {
    const rows = this.stmt('SELECT * FROM downloads ORDER BY started_at DESC LIMIT ?').all(limit) as Row[];
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      filename: r.filename,
      path: r.path,
      state: r.state,
      paused: false,
      received: r.received,
      total: r.total,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      mime: r.mime,
    }));
  }

  removeDownload(id: string): void {
    this.stmt('DELETE FROM downloads WHERE id = ?').run(id);
  }

  clearDownloads(since = 0): void {
    this.stmt("DELETE FROM downloads WHERE started_at >= ? AND state != 'progressing'").run(since);
  }

  // ---- site settings, favicons, flags, stats ------------------------------------------------

  getSiteSetting(site: string, key: string): string | null {
    const r = this.stmt('SELECT value FROM site_settings WHERE site = ? AND key = ?').get(site, key) as Row | undefined;
    return r ? r.value : null;
  }

  setSiteSetting(site: string, key: string, value: string | null): void {
    if (value === null) this.stmt('DELETE FROM site_settings WHERE site = ? AND key = ?').run(site, key);
    else this.stmt('INSERT OR REPLACE INTO site_settings (site, key, value) VALUES (?, ?, ?)').run(site, key, value);
  }

  siteSettingsByKey(key: string): { site: string; value: string }[] {
    return this.stmt('SELECT site, value FROM site_settings WHERE key = ? ORDER BY site').all(key) as { site: string; value: string }[];
  }

  siteSettingsByKeyPrefix(prefix: string): { site: string; key: string; value: string }[] {
    return this.stmt("SELECT site, key, value FROM site_settings WHERE key LIKE ? ESCAPE '\\' ORDER BY site, key").all(escapeLike(prefix) + '%') as {
      site: string;
      key: string;
      value: string;
    }[];
  }

  clearSiteSettings(keyPrefix: string): void {
    this.stmt("DELETE FROM site_settings WHERE key LIKE ? ESCAPE '\\'").run(escapeLike(keyPrefix) + '%');
  }

  favicon(host: string): string | null {
    if (!host) return null;
    const r = this.stmt('SELECT data FROM favicons WHERE host = ?').get(host) as Row | undefined;
    return r ? r.data : null;
  }

  setFavicon(host: string, data: string): void {
    this.stmt('INSERT OR REPLACE INTO favicons (host, data, updated_at) VALUES (?, ?, ?)').run(host, data, Date.now());
  }

  /** The user's votes on these keys: an AI flag or Not AI. */
  myFlags(keys: string[]): Map<string, VoteKind> {
    const out = new Map<string, VoteKind>();
    for (const k of keys) {
      const r = this.stmt('SELECT vote FROM my_flags WHERE key = ?').get(k) as Row | undefined;
      if (r) out.set(k, r.vote === 'human' ? 'human' : 'ai');
    }
    return out;
  }

  setMyFlag(key: string, hash: string, platform: string, vote: VoteKind | null): void {
    if (vote) this.stmt('INSERT OR REPLACE INTO my_flags (key, hash, platform, created_at, vote) VALUES (?, ?, ?, ?, ?)').run(key, hash, platform, Date.now(), vote);
    else this.stmt('DELETE FROM my_flags WHERE key = ?').run(key);
  }

  myFlagCount(): { ai: number; human: number } {
    const r = this.stmt("SELECT COALESCE(SUM(vote = 'ai'), 0) AS ai, COALESCE(SUM(vote = 'human'), 0) AS human FROM my_flags").get() as Row;
    return { ai: Number(r.ai), human: Number(r.human) };
  }

  addShieldHidden(n: number): void {
    if (n <= 0) return;
    const day = new Date().toISOString().slice(0, 10);
    this.stmt(
      'INSERT INTO stats (day, shield_hidden) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET shield_hidden = shield_hidden + excluded.shield_hidden',
    ).run(day, n);
  }

  addAdsBlocked(n: number): void {
    if (n <= 0) return;
    const day = new Date().toISOString().slice(0, 10);
    this.stmt(
      'INSERT INTO stats (day, ads_blocked) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET ads_blocked = ads_blocked + excluded.ads_blocked',
    ).run(day, n);
  }

  shieldStats(): { hiddenTotal: number; hiddenToday: number; blockedTotal: number; blockedToday: number } {
    const day = new Date().toISOString().slice(0, 10);
    const total = this.stmt('SELECT COALESCE(SUM(shield_hidden), 0) AS s, COALESCE(SUM(ads_blocked), 0) AS a FROM stats').get() as Row;
    const today = this.stmt('SELECT shield_hidden AS s, ads_blocked AS a FROM stats WHERE day = ?').get(day) as Row | undefined;
    return { hiddenTotal: total.s, hiddenToday: today?.s ?? 0, blockedTotal: total.a, blockedToday: today?.a ?? 0 };
  }
}
