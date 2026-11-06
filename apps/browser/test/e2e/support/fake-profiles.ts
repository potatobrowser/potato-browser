import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;
/** Chrome stores microseconds since 1601-01-01. */
const webkit = (ms: number) => String(BigInt(ms + 11_644_473_600_000) * 1000n);

function chromeProfile(dir: string, bookmarks: { bar: [string, string][]; other: [string, string][] }, history: [string, string][]): void {
  fs.mkdirSync(dir, { recursive: true });
  const node = ([name, url]: [string, string]) => ({ type: 'url', name, url, date_added: webkit(Date.now() - 30 * DAY) });
  fs.writeFileSync(
    path.join(dir, 'Bookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [...bookmarks.bar.map(node), { type: 'folder', name: 'Recipes', children: [node(['Soup', 'https://soup.test/'])] }] },
        other: { type: 'folder', name: 'Other bookmarks', children: bookmarks.other.map(node) },
        synced: { type: 'folder', name: 'Mobile bookmarks', children: [] },
      },
    }),
  );
  const db = new DatabaseSync(path.join(dir, 'History'));
  db.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)`);
  const ins = db.prepare('INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, 0)');
  history.forEach(([url, title], i) => ins.run(url, title, 5 - i, 1, webkit(Date.now() - (i + 1) * DAY)));
  ins.run('chrome://settings/', 'Settings', 1, 0, webkit(Date.now()));
  db.close();
}

function firefoxProfile(root: string): void {
  const profDir = path.join(root, 'Profiles', 'abcd1234.default-release');
  fs.mkdirSync(profDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'profiles.ini'),
    '[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abcd1234.default-release\nDefault=1\n',
  );
  const db = new DatabaseSync(path.join(profDir, 'places.sqlite'));
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed INTEGER, hidden INTEGER DEFAULT 0, last_visit_date INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, dateAdded INTEGER, guid TEXT);
  `);
  const now = Date.now() * 1000;
  db.exec(`
    INSERT INTO moz_places VALUES (1, 'https://mdn.test/', 'MDN Web Docs', 9, 1, 0, ${now - 2 * DAY * 1000});
    INSERT INTO moz_places VALUES (2, 'https://firefox-only.test/', 'Firefox Only', 3, 0, 0, ${now - 3 * DAY * 1000});
    INSERT INTO moz_bookmarks VALUES (1, 2, NULL, 0, 0, '', ${now}, 'root________');
    INSERT INTO moz_bookmarks VALUES (2, 2, NULL, 1, 0, 'menu', ${now}, 'menu________');
    INSERT INTO moz_bookmarks VALUES (3, 2, NULL, 1, 1, 'toolbar', ${now}, 'toolbar_____');
    INSERT INTO moz_bookmarks VALUES (4, 2, NULL, 1, 2, 'unfiled', ${now}, 'unfiled_____');
    INSERT INTO moz_bookmarks VALUES (10, 1, 1, 3, 0, 'MDN', ${now}, 'bm-mdn-00001');
    INSERT INTO moz_bookmarks VALUES (11, 1, 2, 2, 0, 'Firefox Only', ${now}, 'bm-ffo-00001');
  `);
  db.close();
}

function safariProfile(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const leaf = (title: string, url: string) =>
    `<dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string><key>URLString</key><string>${url}</string><key>URIDictionary</key><dict><key>title</key><string>${title}</string></dict></dict>`;
  fs.writeFileSync(
    path.join(dir, 'Bookmarks.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Children</key><array>
<dict><key>Title</key><string>BookmarksBar</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Children</key><array>${leaf('Apple &amp; Co', 'https://apple.test/')}</array></dict>
<dict><key>Title</key><string>BookmarksMenu</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Children</key><array>${leaf('Safari Menu Item', 'https://safari-menu.test/')}</array></dict>
<dict><key>Title</key><string>com.apple.ReadingList</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Children</key><array>${leaf('Long read', 'https://longread.test/')}</array></dict>
</array><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict></plist>`,
  );
  const db = new DatabaseSync(path.join(dir, 'History.db'));
  db.exec(`
    CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER);
    CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);
  `);
  const t = Date.now() / 1000 - 978_307_200 - 86400;
  db.exec(`INSERT INTO history_items VALUES (1, 'https://safari-history.test/', 4); INSERT INTO history_visits VALUES (1, 1, ${t}, 'Safari History Page');`);
  db.close();
}

/** Builds a fake home directory with Chrome (two profiles), Firefox and Safari data. */
export function makeFakeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-home-'));
  const chrome = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  fs.mkdirSync(chrome, { recursive: true });
  fs.writeFileSync(
    path.join(chrome, 'Local State'),
    JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' }, 'Profile 1': { name: 'Work' } } } }),
  );
  chromeProfile(
    path.join(chrome, 'Default'),
    { bar: [['Hacker News', 'https://news.test/'], ['Wikipedia', 'https://wiki.test/']], other: [['Old Blog', 'https://blog.test/']] },
    [['https://news.test/', 'Hacker News'], ['https://chrome-history.test/page', 'Chrome History Page']],
  );
  chromeProfile(path.join(chrome, 'Profile 1'), { bar: [['Work Wiki', 'https://work.test/']], other: [] }, []);
  firefoxProfile(path.join(home, 'Library', 'Application Support', 'Firefox'));
  safariProfile(path.join(home, 'Library', 'Safari'));
  return home;
}
