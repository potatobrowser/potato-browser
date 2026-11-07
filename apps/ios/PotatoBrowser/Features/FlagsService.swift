import CryptoKit
import Foundation

/// Anonymous AI flags (apps/browser/src/main/flags.ts). Content keys stay on the phone: lookups
/// send 5-character prefixes of `sha256("noai-flag:v1:" + key)` and match full hashes here.
@MainActor
final class FlagsService {
  static let hashDomain = "noai-flag:v1:"
  static let prefixLength = 5
  static let maxPrefixes = 100

  private let apiBase: URL
  private let store: Store
  private let settings: SettingsStore
  private let session: URLSession
  private var prefixCache: [String: (at: Date, counts: [String: Int])] = [:]
  private var hashes: [String: String] = [:]
  private var inflight: [String: Task<Void, Never>] = [:]
  /// Private tabs flag under a throwaway id and remember their flags only in memory.
  private var privateMine = Set<String>()
  private var privateClient: String?

  init(apiBase: URL, store: Store, settings: SettingsStore) {
    self.apiBase = apiBase
    self.store = store
    self.settings = settings
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 6
    c.httpCookieStorage = nil
    c.urlCache = nil
    session = URLSession(configuration: c)
  }

  static func hash(_ key: String) -> String {
    SHA256.hash(data: Data((hashDomain + key).utf8)).map { String(format: "%02x", $0) }.joined()
  }

  static func platform(of key: String) -> String? {
    guard let i = key.firstIndex(of: ":") else { return nil }
    let platform = String(key[..<i])
    let id = key[key.index(after: i)...]
    return FlagPlatform.ids.contains(platform) && !id.isEmpty && id.count <= 256 ? platform : nil
  }

  private func hash(_ key: String) -> String {
    if let h = hashes[key] { return h }
    let h = Self.hash(key)
    if hashes.count > 20_000 { hashes.removeAll() }
    hashes[key] = h
    return h
  }

  private func fresh(_ prefix: String) -> Bool {
    if let e = prefixCache[prefix] { return Date().timeIntervalSince(e.at) < 120 }
    return false
  }

  private func post(_ path: String, _ body: [String: Any], method: String = "POST") async throws -> [String: Any] {
    var req = URLRequest(url: apiBase.appendingPathComponent(path))
    req.httpMethod = method
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, res) = try await session.data(for: req)
    guard let http = res as? HTTPURLResponse, http.statusCode == 200 else {
      throw URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "\(path) \((res as? HTTPURLResponse)?.statusCode ?? 0)"])
    }
    return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
  }

  private func fetch(_ prefixes: [String]) async {
    let todo = prefixes.filter { !fresh($0) && inflight[$0] == nil }
    var waits = prefixes.compactMap { inflight[$0] }
    for start in stride(from: 0, to: todo.count, by: Self.maxPrefixes) {
      let batch = Array(todo[start..<min(start + Self.maxPrefixes, todo.count)])
      let task = Task { @MainActor in
        defer { batch.forEach { self.inflight[$0] = nil } }
        guard let res = try? await self.post("api/v1/lookup", ["prefixes": batch]) else { return }
        var grouped = Dictionary(uniqueKeysWithValues: batch.map { ($0, [String: Int]()) })
        for item in res["items"] as? [[String: Any]] ?? [] {
          guard let h = item["h"] as? String, let n = item["n"] as? Int else { continue }
          grouped[String(h.prefix(Self.prefixLength))]?[h] = n
        }
        for (p, counts) in grouped { self.prefixCache[p] = (Date(), counts) }
      }
      batch.forEach { inflight[$0] = task }
      waits.append(task)
    }
    for w in waits { await w.value }
  }

  func lookup(keys: [String], isPrivate: Bool, localOnly: Bool) async -> [String: [String: Any]] {
    let valid = Array(Set(keys)).filter { Self.platform(of: $0) != nil }.prefix(500).map { $0 }
    var out: [String: [String: Any]] = [:]
    if !localOnly {
      let hs = valid.map(hash)
      await fetch(Array(Set(hs.map { String($0.prefix(Self.prefixLength)) })))
    }
    // The user's own flags are read only now: one may have been set while the lookup ran.
    let mine = isPrivate ? privateMine : store.myFlags(valid)
    for k in valid {
      let h = hash(k)
      let n = localOnly ? 0 : prefixCache[String(h.prefix(Self.prefixLength))]?.counts[h] ?? 0
      out[k] = ["n": n, "mine": mine.contains(k)]
    }
    return out
  }

  /// Flags (or un-flags) every key of one post and returns their new status.
  func set(keys: [String], flag: Bool, isPrivate: Bool) async throws -> [String: [String: Any]] {
    let valid = Array(Set(keys)).filter { Self.platform(of: $0) != nil }.prefix(10)
    guard !valid.isEmpty else { throw URLError(.badURL) }
    let client: String
    if isPrivate {
      if privateClient == nil { privateClient = Settings.randomId() }
      client = privateClient!
    } else {
      client = settings.value.installId
    }
    var out: [String: [String: Any]] = [:]
    for key in valid {
      let platform = Self.platform(of: key)!
      let h = hash(key)
      let res = try await post("api/v1/flags", ["h": h, "platform": platform, "client": client], method: flag ? "POST" : "DELETE")
      let n = res["n"] as? Int ?? 0
      if isPrivate {
        if flag { privateMine.insert(key) } else { privateMine.remove(key) }
      } else {
        store.setMyFlag(key: key, hash: h, platform: platform, on: flag)
      }
      let p = String(h.prefix(Self.prefixLength))
      var entry = prefixCache[p] ?? (Date(), [:])
      entry.counts[h] = n
      prefixCache[p] = entry
      out[key] = ["n": n, "mine": flag]
    }
    return out
  }

  func forgetPrivate() {
    privateMine.removeAll()
    privateClient = nil
  }

  func clearCache() {
    prefixCache.removeAll()
  }
}
