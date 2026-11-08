import CryptoKit
import Foundation
import WebKit

/// AI Shield rule summaries the build exports from apps/browser/src/content/shield/rules.ts.
struct ShieldRule: Decodable, Identifiable {
  struct Feature: Decodable, Identifiable {
    let id: String
    let name: String
    let block: [String]

    enum CodingKeys: String, CodingKey { case id, name, block }

    // Rule updates carry the full catalog, where most features block nothing.
    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      name = try c.decode(String.self, forKey: .name)
      block = try c.decodeIfPresent([String].self, forKey: .block) ?? []
    }
  }
  let id: String
  let site: String
  let hosts: [String]
  let paths: [String]?
  let features: [Feature]
}

/// Main-app side of the AI Shield: per-site state, the AI Mode redirect, the chatbot block and
/// the rule list that blocks requests which only fetch AI answers. Hiding runs in the pages.
@MainActor
final class ShieldService {
  private(set) var rules: [ShieldRule]
  /// Where the rules in use come from: the app, or a signed update from potatobrowser.com.
  private(set) var source = "app"
  private(set) var version: Int
  private(set) var lastCheck: Date?
  /// Downloaded rules for the pages (content world), checked again there; nil while the app's own apply.
  private(set) var rulesScript: WKUserScript?
  private var hash: String
  private let settings: SettingsStore
  private let world: WKContentWorld
  private let file: URL
  private let keys: [String]
  private var regexes: [String: NSRegularExpression] = [:]
  private(set) var blockList: WKContentRuleList?
  private var blockListKey = ""
  private var fetching = false

  init(settings: SettingsStore, directory: URL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString), world: WKContentWorld = .world(name: "potato"), testKeys: [String]? = nil) {
    self.settings = settings
    self.world = world
    let data = (try? Data(contentsOf: WebResources.url("shield.json"))) ?? Data()
    rules = (try? JSONDecoder().decode([ShieldRule].self, from: data)) ?? []
    let bundled = WebResources.manifest.shieldRules
    version = bundled?.version ?? 0
    hash = bundled?.hash ?? ""
    keys = testKeys ?? bundled?.keys ?? []
    file = directory.appendingPathComponent("Shield/rules.json")
    if let saved = try? Data(contentsOf: file), let env = try? JSONSerialization.jsonObject(with: saved) as? [String: Any] {
      lastCheck = (env["checkedAt"] as? Double).map { Date(timeIntervalSince1970: $0) }
      if let opened = Self.open(env, keys: keys), opened.version > version, opened.hash != hash { use(opened) }
    }
  }

  struct Opened {
    let rules: [ShieldRule]
    let json: String
    let version: Int
    let hash: String
  }

  /// A rule update whose Ed25519 signature checks out against `keys`, or nil.
  static func open(_ envelope: [String: Any], keys: [String]) -> Opened? {
    guard let payload = envelope["payload"] as? String, payload.utf8.count < 2_000_000,
      let sigText = envelope["signature"] as? String, let sig = Data(base64Encoded: sigText)
    else { return nil }
    let data = Data(payload.utf8)
    let signed = keys.contains { k in
      guard let raw = Data(base64Encoded: k), let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw) else { return false }
      return key.isValidSignature(sig, for: data)
    }
    guard signed, let p = try? JSONSerialization.jsonObject(with: data) as? [String: Any], p["format"] as? Int == 1,
      let version = p["version"] as? Int, let hash = p["hash"] as? String, let list = p["rules"] as? [Any], !list.isEmpty,
      let rulesData = try? JSONSerialization.data(withJSONObject: list),
      let rules = try? JSONDecoder().decode([ShieldRule].self, from: rulesData),
      rules.allSatisfy({ r in r.features.allSatisfy { f in f.block.allSatisfy { $0.contains("/") && $0.count >= 4 && $0.count <= 200 } } })
    else { return nil }
    return Opened(rules: rules, json: String(decoding: rulesData, as: UTF8.self), version: version, hash: hash)
  }

  private func use(_ o: Opened) {
    rules = o.rules
    version = o.version
    hash = o.hash
    source = "update"
    regexes = [:]
    rulesScript = WKUserScript(source: "window.__potatoShieldRules = \(o.json);", injectionTime: .atDocumentStart, forMainFrameOnly: false, in: world)
  }

  /// From the daily check: downloads newer rules, keeps them only if signed by us. True when they changed.
  func update(_ latest: [String: Any]?, apiBase: URL) async -> Bool {
    lastCheck = Date()
    guard let v = latest?["version"] as? Int, let h = latest?["hash"] as? String, h != hash, v > version, !fetching else { return false }
    fetching = true
    defer { fetching = false }
    let session = URLSession(configuration: .ephemeral)
    guard let (data, res) = try? await session.data(from: apiBase.appendingPathComponent("api/v1/shield/rules")),
      (res as? HTTPURLResponse)?.statusCode == 200,
      var env = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let opened = Self.open(env, keys: keys), opened.version > version
    else { return false }
    env["checkedAt"] = lastCheck?.timeIntervalSince1970
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let out = try? JSONSerialization.data(withJSONObject: env) { try? out.write(to: file, options: .atomic) }
    use(opened)
    await prepareBlockList()
    return true
  }

  // MARK: Matching (as apps/browser/src/content/shield/match.ts)

  private func hostRegex(_ pattern: String) -> NSRegularExpression? {
    if let r = regexes[pattern] { return r }
    var p = pattern.lowercased().replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
    var prefix = "^(?:www\\.)?"
    if p.hasPrefix("*.") {
      p = String(p.dropFirst(2))
      prefix = "^(?:[a-z0-9-]+\\.)*"
    }
    let tld = p.hasSuffix(".*")
    if tld { p = String(p.dropLast(2)) }
    let body = NSRegularExpression.escapedPattern(for: p)
    let suffix = tld ? "\\.(?:[a-z]{2,3}|co\\.[a-z]{2}|com\\.[a-z]{2})$" : "$"
    let r = try? NSRegularExpression(pattern: prefix + body + suffix)
    regexes[pattern] = r
    return r
  }

  func hostMatches(_ host: String, _ pattern: String) -> Bool {
    if pattern == "*" { return true }
    let h = host.lowercased()
    return hostRegex(pattern)?.firstMatch(in: h, range: NSRange(h.startIndex..., in: h)) != nil
  }

  func rules(for host: String) -> [ShieldRule] {
    rules.filter { r in r.hosts.contains { $0 != "*" && hostMatches(host, $0) } }
  }

  /// The site has dedicated rules in the catalog.
  func isSupported(_ url: URL?) -> Bool {
    guard let host = url?.host else { return false }
    return !rules(for: host).isEmpty
  }

  func isSiteDisabled(_ url: URL?) -> Bool {
    guard let host = url?.host else { return false }
    return settings.value.shield.disabledSites.contains { URLInput.hostMatches(host, $0) }
  }

  func isEnabled(for url: URL?) -> Bool {
    settings.value.shield.enabled && URLInput.isWeb(url) && !isSiteDisabled(url)
  }

  func setSite(_ url: URL, enabled: Bool) {
    guard let host = url.host else { return }
    settings.update { s in
      s.shield.disabledSites.removeAll { URLInput.hostMatches(host, $0) }
      if !enabled { s.shield.disabledSites.append(URLInput.siteKey(url)) }
    }
  }

  private func isRuleDisabled(_ rule: String, _ feature: String) -> Bool {
    let d = settings.value.shield.disabledRules
    return d.contains(rule) || d.contains("\(rule):\(feature)")
  }

  /// Google's AI Mode (`/ai`, `udm=50`) goes back to regular results, as on the Mac.
  func redirect(for url: URL) -> URL? {
    guard isEnabled(for: url), let host = url.host?.lowercased(),
      host.range(of: "^(www\\.)?google\\.[a-z.]+$", options: .regularExpression) != nil,
      !isRuleDisabled("google-search", "ai-mode"),
      var c = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return nil }
    if c.path == "/ai" || c.path == "/aimode" {
      return URL(string: "\(url.scheme ?? "https")://\(url.host ?? "")/")
    }
    if c.path == "/search", c.queryItems?.contains(where: { $0.name == "udm" && $0.value == "50" }) == true {
      c.queryItems = c.queryItems?.filter { !["udm", "aep", "ntc"].contains($0.name) }
      return c.url
    }
    return nil
  }

  // MARK: Requests that only fetch AI output

  /// WebKit regexes for a rule's pages (host patterns, optionally with its path patterns).
  private func topURLPatterns(_ rule: ShieldRule) -> [String] {
    var out: [String] = []
    for pattern in rule.hosts where pattern != "*" {
      var p = pattern.lowercased().replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
      var prefix = "^https?://(www\\.)?"
      if p.hasPrefix("*.") {
        p = String(p.dropFirst(2))
        prefix = "^https?://([^/]+\\.)?"
      }
      let tld = p.hasSuffix(".*")
      if tld { p = String(p.dropLast(2)) }
      let host = prefix + p.replacingOccurrences(of: ".", with: "\\.") + (tld ? "\\.[a-z.]+" : "")
      out.append(host + "[/:]")
    }
    return out
  }

  private static func escape(_ s: String) -> String {
    var out = ""
    for ch in s {
      if "\\^$.|?*+()[]{}".contains(ch) { out.append("\\") }
      out.append(ch)
    }
    return out
  }

  /// Rebuilds the AI request block list when the disabled rules change.
  func prepareBlockList() async {
    var rulesJSON: [[String: Any]] = []
    for rule in rules {
      let tops = topURLPatterns(rule)
      guard !tops.isEmpty else { continue }
      for f in rule.features where !f.block.isEmpty && !isRuleDisabled(rule.id, f.id) {
        for b in f.block {
          rulesJSON.append(["trigger": ["url-filter": Self.escape(b), "if-top-url": tops], "action": ["type": "block"]])
        }
      }
    }
    guard let data = try? JSONSerialization.data(withJSONObject: rulesJSON, options: [.sortedKeys]), let json = String(data: data, encoding: .utf8) else { return }
    guard json != blockListKey else { return }
    blockListKey = json
    if rulesJSON.isEmpty {
      blockList = nil
      return
    }
    blockList = try? await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "shield-requests", encodedContentRuleList: json)
  }
}

/// Main-frame hosts blocked when "Block AI chatbot sites" is on (apps/browser/src/main/sessions.ts).
enum Chatbots {
  static let hosts = [
    "chatgpt.com", "chat.openai.com", "gemini.google.com", "bard.google.com", "claude.ai", "copilot.microsoft.com",
    "perplexity.ai", "www.perplexity.ai", "chat.deepseek.com", "chat.mistral.ai", "grok.com", "meta.ai", "www.meta.ai",
    "poe.com", "character.ai", "pi.ai", "duck.ai", "you.com", "huggingface.co/chat",
  ]

  static func isChatbot(_ url: URL) -> Bool {
    guard let host = url.host?.lowercased() else { return false }
    return hosts.contains { entry in
      let parts = entry.split(separator: "/", maxSplits: 1).map(String.init)
      let h = parts[0]
      return (host == h || host.hasSuffix("." + h)) && (parts.count == 1 || url.path.hasPrefix("/" + parts[1]))
    }
  }
}
