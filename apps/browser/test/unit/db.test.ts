import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID, ProfileDb } from '../../src/main/db';

let db: ProfileDb;
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noai-db-'));
  db = new ProfileDb(path.join(dir, 'Profile.sqlite'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('history', () => {
  it('records visits and titles and supports search and deletion', () => {
    db.addVisit('https://a.test/', 'Alpha', { time: 1000 });
    db.addVisit('https://b.test/', '', { time: 2000 });
    db.updateTitle('https://b.test/', 'Bravo');
    const all = db.queryHistory('');
    expect(all.map((h) => h.title)).toEqual(['Bravo', 'Alpha']);
    expect(db.queryHistory('alp').map((h) => h.url)).toEqual(['https://a.test/']);
    // LIKE wildcards in user input are literal.
    expect(db.queryHistory('%')).toEqual([]);
    db.deleteVisits([all[0]!.id]);
    expect(db.queryHistory('').map((h) => h.url)).toEqual(['https://a.test/']);
    expect(db.historyCount()).toBe(1);
  });

  it('ranks suggestions by host prefix, typing and frequency', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) db.addVisit('https://docs.example.com/guide', 'Example guide', { time: now - i });
    db.addVisit('https://example.com/', 'Example', { time: now, typed: true });
    db.addVisit('https://other.test/example', 'Other example', { time: now });
    const s = db.suggestUrls('exa', 5);
    expect(s[0]!.url).toBe('https://example.com/');
    expect(db.inlineHost('exa')).toBe('example.com');
    expect(db.inlineHost('example.com')).toBeNull();
    expect(db.inlineHost('ex ample')).toBeNull();
  });

  it('lists distinct top sites and clears by time', () => {
    db.addVisit('https://a.test/1', 'A1', { time: 1000 });
    db.addVisit('https://a.test/2', 'A2', { time: 1001 });
    db.addVisit('https://b.test/', 'B', { time: 5000 });
    expect(db.topSites(10).map((s) => s.url)).toHaveLength(2);
    db.clearHistory(2000);
    expect(db.queryHistory('').map((h) => h.url).sort()).toEqual(['https://a.test/1', 'https://a.test/2']);
    db.clearHistory(0);
    expect(db.historyCount()).toBe(0);
  });

  it('imports history without duplicating newer local visits', () => {
    db.addVisit('https://a.test/', 'Local', { time: 5000 });
    expect(db.importUrl('https://a.test/', 'Imported', 10, 2, 4000)).toBe(false);
    expect(db.importUrl('https://b.test/', 'Imported B', 10, 2, 4000)).toBe(true);
    expect(db.queryHistory('b.test')[0]).toMatchObject({ title: 'Imported B', visitTime: 4000 });
  });
});

describe('bookmarks', () => {
  it('adds, orders, moves and removes bookmarks', () => {
    const a = db.addBookmark({ title: 'A', url: 'https://a.test/' });
    const b = db.addBookmark({ title: 'B', url: 'https://b.test/' });
    const c = db.addBookmark({ title: 'C', url: 'https://c.test/', index: 0 });
    expect(db.bookmarkChildren(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['C', 'A', 'B']);
    db.moveBookmark(c, BOOKMARKS_BAR_ID, 2);
    expect(db.bookmarkChildren(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['A', 'B', 'C']);
    db.removeBookmark(a);
    expect(db.bookmarkChildren(BOOKMARKS_BAR_ID).map((n) => [n.title, n.position])).toEqual([
      ['B', 0],
      ['C', 1],
    ]);
    expect(db.isBookmarked('https://b.test/')).toBe(true);
    db.removeBookmarksByUrl('https://b.test/');
    expect(db.isBookmarked('https://b.test/')).toBe(false);
    expect(b).toBeGreaterThan(0);
  });

  it('keeps folders acyclic and roots permanent', () => {
    const f1 = db.addBookmark({ type: 'folder', title: 'F1' });
    const f2 = db.addBookmark({ parentId: f1, type: 'folder', title: 'F2' });
    db.moveBookmark(f1, f2, 0); // would create a cycle
    expect(db.getBookmark(f1)!.parentId).toBe(BOOKMARKS_BAR_ID);
    db.removeBookmark(BOOKMARKS_BAR_ID);
    db.removeBookmark(OTHER_BOOKMARKS_ID);
    expect(db.bookmarkTree().map((r) => r.title)).toEqual(['Bookmarks Bar', 'Other Bookmarks']);
    db.removeBookmark(f1);
    expect(db.getBookmark(f2)).toBeNull(); // cascades
  });
});

describe('site settings, flags and stats', () => {
  it('stores and clears per-site values', () => {
    db.setSiteSetting('https://a.test', 'perm:geolocation', 'allow');
    expect(db.getSiteSetting('https://a.test', 'perm:geolocation')).toBe('allow');
    expect(db.siteSettingsByKey('perm:geolocation')).toEqual([{ site: 'https://a.test', value: 'allow' }]);
    db.setSiteSetting('https://a.test', 'perm:geolocation', null);
    expect(db.getSiteSetting('https://a.test', 'perm:geolocation')).toBeNull();
  });

  it('remembers the user flags and counts hidden AI features', () => {
    db.setMyFlag('reddit:t3_a', 'h', 'reddit', true);
    expect(db.myFlags(['reddit:t3_a', 'reddit:t3_b'])).toEqual(new Set(['reddit:t3_a']));
    db.setMyFlag('reddit:t3_a', 'h', 'reddit', false);
    expect(db.myFlagCount()).toBe(0);
    db.addShieldHidden(3);
    db.addShieldHidden(2);
    expect(db.shieldStats()).toEqual({ hiddenTotal: 5, hiddenToday: 5 });
  });
});
