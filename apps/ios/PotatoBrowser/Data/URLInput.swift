import Foundation

struct SearchEngine: Identifiable, Hashable {
  let id: String
  let name: String
  /// `%s` is replaced with the encoded query.
  let search: String
  /// OpenSearch suggestions (`[query, [suggestions...]]`), or nil.
  let suggest: String?
  var note: String? = nil

  /// The Mac app's list (apps/browser/src/shared/urls.ts).
  static let all: [SearchEngine] = [
    SearchEngine(id: "duckduckgo", name: "DuckDuckGo (no AI)", search: "https://noai.duckduckgo.com/?q=%s", suggest: "https://duckduckgo.com/ac/?q=%s&type=list", note: "DuckDuckGo with its AI features turned off. A plain baked potato of a search engine."),
    SearchEngine(id: "google", name: "Google", search: "https://www.google.com/search?q=%s", suggest: "https://suggestqueries.google.com/complete/search?client=firefox&q=%s", note: "AI Overviews and AI Mode get peeled off by the AI Shield."),
    SearchEngine(id: "google-web", name: "Google (Web results only)", search: "https://www.google.com/search?q=%s&udm=14", suggest: "https://suggestqueries.google.com/complete/search?client=firefox&q=%s", note: "Plain links, no AI Overviews, no widgets. Meat and potatoes."),
    SearchEngine(id: "bing", name: "Bing", search: "https://www.bing.com/search?q=%s", suggest: "https://api.bing.com/osjson.aspx?query=%s"),
    SearchEngine(id: "brave", name: "Brave Search", search: "https://search.brave.com/search?q=%s&summary=0", suggest: "https://search.brave.com/api/suggest?q=%s"),
    SearchEngine(id: "startpage", name: "Startpage", search: "https://www.startpage.com/do/search?q=%s", suggest: nil),
    SearchEngine(id: "ecosia", name: "Ecosia", search: "https://www.ecosia.org/search?q=%s", suggest: "https://ac.ecosia.org/autocomplete?q=%s&type=list"),
    SearchEngine(id: "kagi", name: "Kagi", search: "https://kagi.com/search?q=%s", suggest: nil),
  ]

  static func get(_ id: String) -> SearchEngine { all.first { $0.id == id } ?? all[0] }

  func url(for query: String) -> URL? {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines).addingPercentEncoding(withAllowedCharacters: .urlQueryValueAllowed) ?? ""
    return URL(string: search.replacingOccurrences(of: "%s", with: q))
  }

  /// Search results pages of this engine (the address bar shows the query, not the URL).
  func query(in url: URL) -> String? {
    guard let template = URLComponents(string: search), let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
      c.host == template.host, c.path == template.path
    else { return nil }
    let key = template.queryItems?.first { $0.value == "%s" }?.name ?? "q"
    return c.queryItems?.first { $0.name == key }?.value
  }
}

extension CharacterSet {
  static let urlQueryValueAllowed: CharacterSet = {
    var s = CharacterSet.urlQueryAllowed
    s.remove(charactersIn: "&=+?#/")
    return s
  }()
}

struct FlagPlatform: Identifiable, Hashable {
  let id: String
  let label: String
  static let all: [FlagPlatform] = [
    .init(id: "reddit", label: "Reddit"), .init(id: "x", label: "X"), .init(id: "instagram", label: "Instagram"),
    .init(id: "facebook", label: "Facebook"), .init(id: "threads", label: "Threads"), .init(id: "linkedin", label: "LinkedIn"),
    .init(id: "youtube", label: "YouTube"), .init(id: "bluesky", label: "Bluesky"), .init(id: "tiktok", label: "TikTok"),
  ]
  static let ids = Set(all.map(\.id))
}

enum OmniboxTarget: Equatable {
  case url(URL)
  case search(String)
}

/// Address bar input: URL or search. A port of the Mac app's classifyInput.
enum URLInput {
  static let knownSchemes: Set<String> = ["http", "https", "file", "about", "data", "mailto", "tel", "blob", "ftp", "sms", "facetime"]

  static func looksLikeHost(_ host: String) -> Bool {
    if host == "localhost" { return true }
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    if parts.count == 4, parts.allSatisfy({ Int($0).map { (0...255).contains($0) && !$0.description.isEmpty } ?? false }) { return true }
    if host.hasPrefix("[") && host.hasSuffix("]") { return true }
    guard host.contains(".") else { return false }
    for l in parts {
      if l.isEmpty || l.first == "-" || l.last == "-" { return false }
      if l.range(of: "^[a-z0-9-]+$", options: [.regularExpression, .caseInsensitive]) == nil { return false }
    }
    let tld = String(parts.last!)
    return tld.range(of: "^[a-z]{2,24}$", options: [.regularExpression, .caseInsensitive]) != nil
      || tld.range(of: "^xn--[a-z0-9-]+$", options: [.regularExpression, .caseInsensitive]) != nil
  }

  static func classify(_ raw: String) -> OmniboxTarget? {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return nil }
    if text.hasPrefix("?") {
      let q = text.dropFirst().trimmingCharacters(in: .whitespaces)
      return q.isEmpty ? nil : .search(q)
    }
    if text.rangeOfCharacter(from: .whitespacesAndNewlines) != nil { return .search(text) }
    if let m = text.range(of: "^[a-z][a-z0-9+.-]*:", options: [.regularExpression, .caseInsensitive]) {
      let scheme = text[m].dropLast().lowercased()
      if knownSchemes.contains(scheme) {
        if scheme == "http" || scheme == "https" {
          if let u = URL(string: text), u.host != nil { return .url(u) }
          return .search(text)
        }
        if let u = URL(string: text) { return .url(u) }
        return .search(text)
      }
    }
    // host[:port][/path] without a scheme
    let pattern = "^([^/?#:]+|\\[[^\\]]+\\])(:\\d{1,5})?([/?#].*)?$"
    if let re = try? NSRegularExpression(pattern: pattern), let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) {
      let host = (Range(m.range(at: 1), in: text).map { String(text[$0]) } ?? "").lowercased()
      let port = Range(m.range(at: 2), in: text).map { String(text[$0]) } ?? ""
      let rest = Range(m.range(at: 3), in: text).map { String(text[$0]) } ?? ""
      if looksLikeHost(host) || (!port.isEmpty && host.range(of: "^[a-z0-9-]+$", options: [.regularExpression, .caseInsensitive]) != nil) {
        let isIP = host.split(separator: ".").count == 4 && host.split(separator: ".").allSatisfy { Int($0) != nil }
        let local = host == "localhost" || isIP || !host.contains(".") || host.hasSuffix(".local")
        if let u = URL(string: "\(local ? "http" : "https")://\(host)\(port)\(rest)") { return .url(u) }
        return .search(text)
      }
    }
    return .search(text)
  }

  static func resolve(_ raw: String, engine: String) -> URL? {
    switch classify(raw) {
    case .url(let u): u
    case .search(let q): SearchEngine.get(engine).url(for: q)
    case nil: nil
    }
  }

  static func host(of url: String) -> String {
    URL(string: url)?.host?.lowercased() ?? ""
  }

  /// Hostname without a leading www: the per-site key for exceptions.
  static func siteKey(_ url: URL?) -> String {
    (url?.host ?? "").lowercased().replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
  }

  /// `host` equals `site` or is a subdomain of it.
  static func hostMatches(_ host: String, _ site: String) -> Bool {
    let h = host.lowercased().replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
    let s = site.lowercased().replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
    return !s.isEmpty && (h == s || h.hasSuffix("." + s))
  }

  /// Host shown in the address bar while it is not being edited.
  static func displayHost(_ url: URL?) -> String {
    guard let url else { return "" }
    if let host = url.host, url.scheme == "http" || url.scheme == "https" {
      return host.replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
    }
    return url.absoluteString
  }

  static func isWeb(_ url: URL?) -> Bool {
    url?.scheme == "http" || url?.scheme == "https"
  }
}
