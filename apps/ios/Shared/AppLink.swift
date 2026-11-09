import Foundation
import UniformTypeIdentifiers

/// Links from other apps: `potatobrowser://open?url=<percent-encoded page>` (what the share
/// extension sends), and `potato-https://host/path` or `potato-http://host/path` for the page
/// itself. Only http and https pages ever open this way.
enum AppLink {
  static let scheme = "potatobrowser"

  /// The page `link` opens, or nil.
  static func page(for link: URL) -> URL? {
    guard let scheme = link.scheme?.lowercased() else { return nil }
    switch scheme {
    case Self.scheme:
      guard let c = URLComponents(url: link, resolvingAgainstBaseURL: false), c.host?.lowercased() == "open", c.path.isEmpty || c.path == "/",
        let value = c.queryItems?.first(where: { $0.name == "url" })?.value, let url = URL(string: value)
      else { return nil }
      return web(url)
    case "potato-https", "potato-http":
      let rest = link.absoluteString.dropFirst(scheme.count)
      return URL(string: String(scheme.dropFirst("potato-".count)) + rest).flatMap(web)
    case "http", "https":
      return web(link)
    default:
      return nil
    }
  }

  /// `url` if it is an http or https address with a host (scheme in lowercase), else nil.
  static func web(_ url: URL) -> URL? {
    guard let raw = url.scheme, ["http", "https"].contains(raw.lowercased()), let host = url.host, !host.isEmpty else { return nil }
    if raw == raw.lowercased() { return url }
    return URL(string: raw.lowercased() + url.absoluteString.dropFirst(raw.count))
  }

  /// The link that opens `page` in the app.
  static func link(opening page: URL) -> URL? {
    guard let page = web(page), let value = page.absoluteString.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return nil }
    return URL(string: "\(scheme)://open?url=\(value)")
  }

  /// The first web address in `text`. Bare hosts (`example.com/fries`) get https, as typed ones do.
  static func firstPage(in text: String) -> URL? {
    guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
    let ns = text as NSString
    for match in detector.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
      guard var url = match.url else { continue }
      if url.scheme == "http", !ns.substring(with: match.range).lowercased().hasPrefix("http://") {
        url = URL(string: "https" + url.absoluteString.dropFirst(4)) ?? url
      }
      if let page = web(url) { return page }
    }
    return nil
  }
}

/// What "Open in Potato" finds in a share: a URL, a web page from Safari, or text with a link.
enum SharedLink {
  static func page(in items: [NSExtensionItem]) async -> URL? {
    let providers = items.flatMap { $0.attachments ?? [] }
    for p in providers where p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
      if let url = await url(from: p), let page = AppLink.web(url) { return page }
    }
    for p in providers where p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      if let text = await text(from: p), let page = AppLink.firstPage(in: text) { return page }
    }
    for item in items {
      for text in [item.attributedContentText?.string, item.attributedTitle?.string].compactMap({ $0 }) {
        if let page = AppLink.firstPage(in: text) { return page }
      }
    }
    return nil
  }

  /// Apps register URLs as URL objects, strings or data.
  private static func url(from provider: NSItemProvider) async -> URL? {
    switch try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) {
    case let url as URL: url
    case let s as String: URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines))
    case let d as Data: URL(dataRepresentation: d, relativeTo: nil)
    default: nil
    }
  }

  private static func text(from provider: NSItemProvider) async -> String? {
    switch try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) {
    case let s as String: s
    case let a as NSAttributedString: a.string
    case let d as Data: String(data: d, encoding: .utf8)
    default: nil
    }
  }
}
