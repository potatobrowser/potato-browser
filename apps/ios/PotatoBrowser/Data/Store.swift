import Combine
import Foundation

struct HistoryEntry: Identifiable, Hashable {
  let id: Int64
  let url: String
  let title: String
  let time: Date
}

struct Bookmark: Identifiable, Hashable {
  let id: Int64
  let parentId: Int64?
  let isFolder: Bool
  var title: String
  var url: String?
}

struct DownloadRecord: Identifiable, Hashable {
  let id: String
  let url: String
  var filename: String
  var path: String
  var state: String
  var received: Int64
  var total: Int64
  let startedAt: Date
}

struct SuggestedPage: Hashable {
  let url: String
  let title: String
  var score: Double
  var bookmarked: Bool
}

/// History, bookmarks, downloads, the user's own flags and daily counts, in one SQLite file.
/// The schema follows the Mac app's (apps/browser/src/main/db.ts).
@MainActor
final class Store: ObservableObject {
  let db: SQLite
  /// Bumped when bookmarks change, so views showing them refresh.
  @Published private(set) var bookmarksVersion = 0
  @Published private(set) var historyVersion = 0
  @Published private(set) var statsVersion = 0

  nonisolated static let bookmarksRoot: Int64 = 1

  init(path: String) throws {
    db = try SQLite(path: path)
    try db.exec("""
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
      CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        filename TEXT NOT NULL,
        path TEXT NOT NULL,
        state TEXT NOT NULL,
        received INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL
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
      """)
    // Not AI votes (0.6.0): before them every row was an AI flag.
    if !db.query("PRAGMA table_info(my_flags)").contains(where: { $0.string("name") == "vote" }) {
      try db.exec("ALTER TABLE my_flags ADD COLUMN vote TEXT NOT NULL DEFAULT 'ai'")
    }
    if db.query("SELECT id FROM bookmarks WHERE id = 1").isEmpty {
      try db.runOrThrow("INSERT INTO bookmarks (id, parent_id, type, title, position, created_at) VALUES (1, NULL, 'folder', 'Bookmarks', 0, ?)", [Self.now()])
    }
  }

  static func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
  private static func date(_ ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }

  // MARK: History

  func addVisit(url: String, title: String, typed: Bool) {
    guard url.hasPrefix("http://") || url.hasPrefix("https://") else { return }
    let now = Self.now()
    db.run(
      """
      INSERT INTO urls (url, title, visit_count, typed_count, last_visit) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(url) DO UPDATE SET visit_count = visit_count + 1, typed_count = typed_count + excluded.typed_count,
        last_visit = excluded.last_visit, title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END
      """, url, title, typed ? 1 : 0, now)
    if let id = db.query("SELECT id FROM urls WHERE url = ?", url).first?.int("id") {
      db.run("INSERT INTO visits (url_id, visit_time) VALUES (?, ?)", id, now)
    }
    historyVersion += 1
  }

  func updateTitle(url: String, title: String) {
    guard !title.isEmpty else { return }
    if db.run("UPDATE urls SET title = ? WHERE url = ? AND title != ?", title, url, title) > 0 { historyVersion += 1 }
  }

  func history(matching query: String = "", limit: Int = 300) -> [HistoryEntry] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    let rows: [SQLRow]
    if q.isEmpty {
      rows = db.query("SELECT v.id, u.url, u.title, v.visit_time FROM visits v JOIN urls u ON u.id = v.url_id ORDER BY v.visit_time DESC LIMIT ?", limit)
    } else {
      let like = "%\(Self.escapeLike(q))%"
      rows = db.query(
        "SELECT v.id, u.url, u.title, v.visit_time FROM visits v JOIN urls u ON u.id = v.url_id WHERE u.url LIKE ? ESCAPE '\\' OR u.title LIKE ? ESCAPE '\\' ORDER BY v.visit_time DESC LIMIT ?",
        like, like, limit)
    }
    return rows.map { HistoryEntry(id: $0.int("id"), url: $0.string("url"), title: $0.string("title"), time: Self.date($0.int("visit_time"))) }
  }

  func deleteVisit(_ id: Int64) {
    db.run("DELETE FROM visits WHERE id = ?", id)
    db.run("DELETE FROM urls WHERE id NOT IN (SELECT url_id FROM visits)")
    historyVersion += 1
  }

  /// Clears history since `since` (all of it when nil).
  func clearHistory(since: Date?) {
    if let since {
      db.run("DELETE FROM visits WHERE visit_time >= ?", Int64(since.timeIntervalSince1970 * 1000))
      db.run("DELETE FROM urls WHERE id NOT IN (SELECT url_id FROM visits)")
    } else {
      db.run("DELETE FROM visits")
      db.run("DELETE FROM urls")
    }
    historyVersion += 1
  }

  static func escapeLike(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "%", with: "\\%").replacingOccurrences(of: "_", with: "\\_")
  }

  /// History and bookmark matches for the address bar, scored like the Mac app.
  func suggestPages(_ text: String, limit: Int) -> [SuggestedPage] {
    let t = text.trimmingCharacters(in: .whitespaces).lowercased()
    guard !t.isEmpty else { return [] }
    let like = "%\(Self.escapeLike(t))%"
    let rows = db.query(
      "SELECT url, title, visit_count, typed_count, last_visit FROM urls WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' ORDER BY typed_count DESC, visit_count DESC, last_visit DESC LIMIT 60",
      like, like)
    let marks = db.query("SELECT url, title FROM bookmarks WHERE type = 'url' AND (url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') LIMIT 30", like, like)
    let now = Self.now()
    var out: [String: SuggestedPage] = [:]
    for r in rows {
      let ageDays = max(0, Double(now - r.int("last_visit")) / 86_400_000)
      let recency = ageDays < 4 ? 1 : ageDays < 14 ? 0.7 : ageDays < 31 ? 0.5 : ageDays < 90 ? 0.3 : 0.1
      let host = URLInput.host(of: r.string("url")).replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
      let prefix = host.hasPrefix(t) ? 3.0 : 1.0
      let score = Double(1 + r.int("visit_count") + 2 * r.int("typed_count")) * recency * prefix
      out[r.string("url")] = SuggestedPage(url: r.string("url"), title: r.string("title"), score: score, bookmarked: false)
    }
    for m in marks {
      let url = m.string("url")
      if var prev = out[url] {
        prev.bookmarked = true
        prev.score *= 2
        out[url] = prev
      } else {
        out[url] = SuggestedPage(url: url, title: m.string("title"), score: 5, bookmarked: true)
      }
    }
    return out.values.sorted { $0.score > $1.score }.prefix(limit).map { $0 }
  }

  /// The host the user most likely means when typing its start (inline completion).
  func inlineHost(_ text: String) -> String? {
    let t = text.trimmingCharacters(in: .whitespaces).lowercased()
    guard !t.isEmpty, t.rangeOfCharacter(from: CharacterSet(charactersIn: " /")) == nil else { return nil }
    let e = Self.escapeLike(t)
    let rows = db.query(
      "SELECT url FROM urls WHERE (url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\') ORDER BY typed_count DESC, visit_count DESC LIMIT 20",
      "https://\(e)%", "https://www.\(e)%", "http://\(e)%", "http://www.\(e)%")
    for r in rows {
      let host = URLInput.host(of: r.string("url")).replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
      if host.hasPrefix(t), host.count > t.count { return host }
    }
    return nil
  }

  func topSites(limit: Int) -> [SuggestedPage] {
    db.query("SELECT url, title, visit_count FROM urls WHERE last_visit > ? ORDER BY visit_count DESC LIMIT ?", Self.now() - 30 * 86_400_000, limit * 3)
      .map { SuggestedPage(url: $0.string("url"), title: $0.string("title"), score: Double($0.int("visit_count")), bookmarked: false) }
      .reduce(into: [SuggestedPage]()) { acc, p in
        let host = URLInput.host(of: p.url)
        if !acc.contains(where: { URLInput.host(of: $0.url) == host }) { acc.append(p) }
      }
      .prefix(limit).map { $0 }
  }

  // MARK: Bookmarks

  func bookmarks(in parent: Int64) -> [Bookmark] {
    db.query("SELECT id, parent_id, type, title, url FROM bookmarks WHERE parent_id = ? ORDER BY position, id", parent).map(Self.bookmark)
  }

  func bookmark(_ id: Int64) -> Bookmark? {
    db.query("SELECT id, parent_id, type, title, url FROM bookmarks WHERE id = ?", id).first.map(Self.bookmark)
  }

  private static func bookmark(_ r: SQLRow) -> Bookmark {
    Bookmark(id: r.int("id"), parentId: r.optionalInt("parent_id"), isFolder: r.string("type") == "folder", title: r.string("title"), url: r.optionalString("url"))
  }

  func bookmarkId(for url: String) -> Int64? {
    db.query("SELECT id FROM bookmarks WHERE type = 'url' AND url = ? LIMIT 1", url).first?.int("id")
  }

  func allFolders() -> [Bookmark] {
    db.query("SELECT id, parent_id, type, title, url FROM bookmarks WHERE type = 'folder' ORDER BY parent_id, position, id").map(Self.bookmark)
  }

  @discardableResult
  func addBookmark(url: String?, title: String, parent: Int64 = Store.bookmarksRoot) -> Int64 {
    let pos = db.query("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM bookmarks WHERE parent_id = ?", parent).first?.int("p") ?? 0
    db.run("INSERT INTO bookmarks (parent_id, type, title, url, position, created_at) VALUES (?, ?, ?, ?, ?, ?)", parent, url == nil ? "folder" : "url", title, url, pos, Self.now())
    bookmarksVersion += 1
    return db.lastInsertId
  }

  func updateBookmark(_ id: Int64, title: String, url: String?, parent: Int64?) {
    db.run("UPDATE bookmarks SET title = ?, url = COALESCE(?, url) WHERE id = ?", title, url, id)
    if let parent, parent != id {
      let pos = db.query("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM bookmarks WHERE parent_id = ?", parent).first?.int("p") ?? 0
      db.run("UPDATE bookmarks SET parent_id = ?, position = ? WHERE id = ? AND parent_id != ?", parent, pos, id, parent)
    }
    bookmarksVersion += 1
  }

  func moveBookmarks(in parent: Int64, from: IndexSet, to: Int) {
    var items = bookmarks(in: parent)
    items.move(fromOffsets: from, toOffset: to)
    db.transaction {
      for (i, b) in items.enumerated() { db.run("UPDATE bookmarks SET position = ? WHERE id = ?", i, b.id) }
    }
    bookmarksVersion += 1
  }

  func deleteBookmark(_ id: Int64) {
    guard id != Self.bookmarksRoot else { return }
    db.run("DELETE FROM bookmarks WHERE id = ?", id)
    bookmarksVersion += 1
  }

  /// Bookmarks of the top folder for the new tab page.
  func favorites(limit: Int) -> [Bookmark] {
    Array(bookmarks(in: Self.bookmarksRoot).filter { !$0.isFolder }.prefix(limit))
  }

  // MARK: Downloads

  func saveDownload(_ d: DownloadRecord) {
    db.run(
      """
      INSERT INTO downloads (id, url, filename, path, state, received, total, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, path = excluded.path, state = excluded.state,
        received = excluded.received, total = excluded.total
      """, d.id, d.url, d.filename, d.path, d.state, d.received, d.total, Int64(d.startedAt.timeIntervalSince1970 * 1000))
  }

  func downloads() -> [DownloadRecord] {
    db.query("SELECT * FROM downloads ORDER BY started_at DESC LIMIT 200").map {
      DownloadRecord(id: $0.string("id"), url: $0.string("url"), filename: $0.string("filename"), path: $0.string("path"), state: $0.string("state"), received: $0.int("received"), total: $0.int("total"), startedAt: Self.date($0.int("started_at")))
    }
  }

  func deleteDownload(_ id: String) {
    db.run("DELETE FROM downloads WHERE id = ?", id)
  }

  func clearDownloads() {
    db.run("DELETE FROM downloads WHERE state != 'progressing'")
  }

  // MARK: Flags

  /// The user's votes on these keys: "ai" (flagged) or "human" (Not AI).
  func myFlags(_ keys: [String]) -> [String: String] {
    var out: [String: String] = [:]
    for k in keys {
      if let row = db.query("SELECT vote FROM my_flags WHERE key = ?", k).first { out[k] = row.string("vote") == "human" ? "human" : "ai" }
    }
    return out
  }

  /// `vote` nil takes the user's vote back.
  func setMyFlag(key: String, hash: String, platform: String, vote: String?) {
    if let vote {
      db.run("INSERT OR REPLACE INTO my_flags (key, hash, platform, created_at, vote) VALUES (?, ?, ?, ?, ?)", key, hash, platform, Self.now(), vote)
    } else {
      db.run("DELETE FROM my_flags WHERE key = ?", key)
    }
  }

  /// Posts the user flagged as AI.
  func myFlagCount() -> Int {
    Int(db.query("SELECT COUNT(*) AS n FROM my_flags WHERE vote = 'ai'").first?.int("n") ?? 0)
  }

  /// Posts the user said are Not AI.
  func myDisputeCount() -> Int {
    Int(db.query("SELECT COUNT(*) AS n FROM my_flags WHERE vote = 'human'").first?.int("n") ?? 0)
  }

  // MARK: Stats

  static func today() -> String {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: Date())
  }

  func addShieldHidden(_ n: Int) {
    guard n > 0 else { return }
    db.run("INSERT INTO stats (day, shield_hidden) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET shield_hidden = shield_hidden + excluded.shield_hidden", Self.today(), n)
    statsVersion += 1
  }

  func addAdsBlocked(_ n: Int) {
    guard n > 0 else { return }
    db.run("INSERT INTO stats (day, ads_blocked) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET ads_blocked = ads_blocked + excluded.ads_blocked", Self.today(), n)
    statsVersion += 1
  }

  func todayStats() -> (shieldHidden: Int, adsBlocked: Int) {
    let r = db.query("SELECT shield_hidden, ads_blocked FROM stats WHERE day = ?", Self.today()).first
    return (Int(r?.int("shield_hidden") ?? 0), Int(r?.int("ads_blocked") ?? 0))
  }

  func totalStats() -> (shieldHidden: Int, adsBlocked: Int) {
    let r = db.query("SELECT COALESCE(SUM(shield_hidden), 0) AS s, COALESCE(SUM(ads_blocked), 0) AS a FROM stats").first
    return (Int(r?.int("s") ?? 0), Int(r?.int("a") ?? 0))
  }
}
