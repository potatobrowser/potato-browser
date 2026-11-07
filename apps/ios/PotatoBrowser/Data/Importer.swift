import Compression
import Foundation

/// Bookmarks and history from other browsers: Netscape bookmark HTML (every browser exports it)
/// and Safari's export (Settings > Apps > Safari > Export, a ZIP with Bookmarks.html and
/// History.json).
enum Importer {
  struct Result {
    var bookmarks = 0
    var history = 0
    var errors: [String] = []
  }

  struct ParsedBookmark {
    var title: String
    var url: String?
    var children: [ParsedBookmark] = []
  }

  @MainActor
  static func importFile(_ url: URL, into store: Store) -> Result {
    var result = Result()
    let access = url.startAccessingSecurityScopedResource()
    defer { if access { url.stopAccessingSecurityScopedResource() } }
    guard let data = try? Data(contentsOf: url) else {
      result.errors.append("Could not read \(url.lastPathComponent).")
      return result
    }
    let ext = url.pathExtension.lowercased()
    if ext == "zip" || data.starts(with: [0x50, 0x4b, 0x03, 0x04]) {
      let files = unzip(data)
      if files.isEmpty { result.errors.append("Could not open the ZIP file.") }
      for (name, content) in files {
        let lower = name.lowercased()
        if lower.hasSuffix(".html") || lower.hasSuffix(".htm") {
          result.bookmarks += importBookmarks(String(decoding: content, as: UTF8.self), into: store, folderTitle: "Imported from Safari")
        } else if lower.hasSuffix(".json"), lower.contains("history") {
          result.history += importHistory(content, into: store)
        }
      }
    } else if ext == "json" {
      result.history += importHistory(data, into: store)
    } else {
      result.bookmarks += importBookmarks(String(decoding: data, as: UTF8.self), into: store, folderTitle: "Imported")
    }
    if result.bookmarks == 0 && result.history == 0 && result.errors.isEmpty {
      result.errors.append("No bookmarks or history found in \(url.lastPathComponent).")
    }
    return result
  }

  // MARK: Netscape bookmark HTML

  static func parseBookmarks(_ html: String) -> [ParsedBookmark] {
    var stack: [ParsedBookmark] = [ParsedBookmark(title: "")]
    var pendingFolder: String?
    let pattern = "<DT><H3[^>]*>(.*?)</H3>|<DT><A\\s+[^>]*?HREF=\"([^\"]*)\"[^>]*>(.*?)</A>|<DL>|</DL>"
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) else { return [] }
    let ns = html as NSString
    for m in re.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
      let token = ns.substring(with: m.range).uppercased()
      if m.range(at: 1).location != NSNotFound {
        pendingFolder = decode(ns.substring(with: m.range(at: 1)))
      } else if m.range(at: 2).location != NSNotFound {
        let url = decode(ns.substring(with: m.range(at: 2)))
        let title = decode(ns.substring(with: m.range(at: 3)))
        if url.hasPrefix("http://") || url.hasPrefix("https://") {
          stack[stack.count - 1].children.append(ParsedBookmark(title: title, url: url))
        }
      } else if token.hasPrefix("<DL") {
        stack.append(ParsedBookmark(title: pendingFolder ?? ""))
        pendingFolder = nil
      } else if stack.count > 1 {
        let done = stack.removeLast()
        stack[stack.count - 1].children.append(done)
      }
    }
    while stack.count > 1 {
      let done = stack.removeLast()
      stack[stack.count - 1].children.append(done)
    }
    // The outermost <DL> is the file's root list.
    let root = stack[0].children
    if root.count == 1, root[0].url == nil, root[0].title.isEmpty { return root[0].children }
    return root
  }

  private static func decode(_ s: String) -> String {
    s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
      .replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
      .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&#39;", with: "'").replacingOccurrences(of: "&#x27;", with: "'")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  @MainActor
  static func importBookmarks(_ html: String, into store: Store, folderTitle: String) -> Int {
    let items = parseBookmarks(html)
    guard !items.isEmpty else { return 0 }
    let folder = store.addBookmark(url: nil, title: folderTitle)
    var n = 0
    func add(_ list: [ParsedBookmark], parent: Int64) {
      for b in list {
        if let url = b.url {
          store.addBookmark(url: url, title: b.title.isEmpty ? url : b.title, parent: parent)
          n += 1
        } else if !b.children.isEmpty {
          add(b.children, parent: store.addBookmark(url: nil, title: b.title.isEmpty ? "Folder" : b.title, parent: parent))
        }
      }
    }
    store.db.transaction { add(items, parent: folder) }
    return n
  }

  // MARK: History JSON (Safari's export: {"history": [{"url", "title", "time_usec", "visit_count"}]})

  @MainActor
  static func importHistory(_ data: Data, into store: Store) -> Int {
    guard let json = try? JSONSerialization.jsonObject(with: data) else { return 0 }
    let entries: [[String: Any]]
    if let obj = json as? [String: Any] {
      entries = (obj["history"] as? [[String: Any]]) ?? (obj["items"] as? [[String: Any]]) ?? []
    } else {
      entries = json as? [[String: Any]] ?? []
    }
    var n = 0
    store.db.transaction {
      for e in entries.prefix(100_000) {
        guard let url = e["url"] as? String ?? e["URL"] as? String, url.hasPrefix("http") else { continue }
        let title = e["title"] as? String ?? ""
        let micros = (e["time_usec"] as? Double) ?? (e["visit_time"] as? Double).map { $0 * 1000 } ?? Date().timeIntervalSince1970 * 1_000_000
        let ms = Int64(micros / 1000)
        let visits = max(1, e["visit_count"] as? Int ?? 1)
        store.db.run(
          """
          INSERT INTO urls (url, title, visit_count, typed_count, last_visit) VALUES (?, ?, ?, 0, ?)
          ON CONFLICT(url) DO UPDATE SET visit_count = visit_count + excluded.visit_count, last_visit = MAX(last_visit, excluded.last_visit),
            title = CASE WHEN title = '' THEN excluded.title ELSE title END
          """, url, title, visits, ms)
        if let id = store.db.query("SELECT id FROM urls WHERE url = ?", url).first?.int("id") {
          store.db.run("INSERT INTO visits (url_id, visit_time) VALUES (?, ?)", id, ms)
        }
        n += 1
      }
    }
    return n
  }

  // MARK: ZIP (stored and deflated entries)

  static func unzip(_ data: Data) -> [(String, Data)] {
    let bytes = [UInt8](data)
    func u16(_ o: Int) -> Int { o + 1 < bytes.count ? Int(bytes[o]) | Int(bytes[o + 1]) << 8 : 0 }
    func u32(_ o: Int) -> Int { o + 3 < bytes.count ? u16(o) | u16(o + 2) << 16 : 0 }
    // The central directory has the sizes even when local headers defer them.
    var eocd = -1
    var i = bytes.count - 22
    while i >= max(0, bytes.count - 65_557) {
      if u32(i) == 0x0605_4b50 {
        eocd = i
        break
      }
      i -= 1
    }
    guard eocd >= 0 else { return [] }
    let count = u16(eocd + 10)
    var p = u32(eocd + 16)
    var out: [(String, Data)] = []
    for _ in 0..<count {
      guard u32(p) == 0x0201_4b50 else { break }
      let method = u16(p + 10)
      let compressed = u32(p + 20)
      let size = u32(p + 24)
      let nameLen = u16(p + 28)
      let extraLen = u16(p + 30)
      let commentLen = u16(p + 32)
      let local = u32(p + 42)
      let name = String(decoding: bytes[min(p + 46, bytes.count)..<min(p + 46 + nameLen, bytes.count)], as: UTF8.self)
      p += 46 + nameLen + extraLen + commentLen
      guard u32(local) == 0x0403_4b50, !name.hasSuffix("/"), size < 200_000_000 else { continue }
      let start = local + 30 + u16(local + 26) + u16(local + 28)
      guard start + compressed <= bytes.count else { continue }
      let body = Data(bytes[start..<start + compressed])
      if method == 0 {
        out.append((name, body))
      } else if method == 8, let inflated = inflate(body, size: size) {
        out.append((name, inflated))
      }
    }
    return out
  }

  private static func inflate(_ data: Data, size: Int) -> Data? {
    guard size > 0 else { return Data() }
    var out = Data(count: size)
    let n = out.withUnsafeMutableBytes { dst in
      data.withUnsafeBytes { src in
        compression_decode_buffer(dst.bindMemory(to: UInt8.self).baseAddress!, size, src.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB)
      }
    }
    return n == size ? out : nil
  }
}
