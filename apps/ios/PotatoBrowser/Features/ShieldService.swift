import Foundation
import WebKit

/// AI Shield rule summaries the build exports from apps/browser/src/content/shield/rules.ts.
struct ShieldRule: Decodable, Identifiable {
  struct Feature: Decodable, Identifiable {
    let id: String
    let name: String
    let block: [String]
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
  let rules: [ShieldRule]
  private let settings: SettingsStore
  private var regexes: [String: NSRegularExpression] = [:]
  private(set) var blockList: WKContentRuleList?
  private var blockListKey = ""

  init(settings: SettingsStore) {
    self.settings = settings
    let data = (try? Data(contentsOf: WebResources.url("shield.json"))) ?? Data()
    rules = (try? JSONDecoder().decode([ShieldRule].self, from: data)) ?? []
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
