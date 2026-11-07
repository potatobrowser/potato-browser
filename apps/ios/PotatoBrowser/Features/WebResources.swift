import Foundation

/// What scripts/build-web.mjs puts into the app bundle (WebResources/).
enum WebResources {
  static let base = Bundle.main.url(forResource: "WebResources", withExtension: nil)!

  static func url(_ path: String) -> URL { base.appendingPathComponent(path) }

  static func text(_ path: String) -> String {
    (try? String(contentsOf: url(path), encoding: .utf8)) ?? ""
  }

  /// Files the build stored as raw DEFLATE (`.z`).
  static func inflate(_ url: URL) -> Data? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? (data as NSData).decompressed(using: .zlib) as Data
  }

  static func inflatedText(_ path: String) -> String? {
    inflate(url(path)).map { String(decoding: $0, as: UTF8.self) }
  }

  static let contentScript = text("js/content.js")
  static let pageScriptTemplate = text("js/page.js")
  static let engineScript = text("js/engine.js")

  struct Manifest: Decodable {
    struct List: Decodable {
      let rev: String
      let name: String
      let homepage: String
    }
    struct Group: Decodable {
      let id: String
      let lists: [String]
      let rules: Int
    }
    let version: String
    let builtAt: String
    let listsFetchedAt: String
    let lists: [String: List]
    let resources: String
    let groups: [Group]
    let aiGlobals: [String]
  }

  static let manifest: Manifest = {
    let data = (try? Data(contentsOf: url("manifest.json"))) ?? Data()
    return (try? JSONDecoder().decode(Manifest.self, from: data))
      ?? Manifest(version: "0", builtAt: "", listsFetchedAt: "", lists: [:], resources: "", groups: [], aiGlobals: [])
  }()

  /// The page world script with its options written in.
  static func pageScript(gpc: Bool, facebook: Bool) -> String {
    pageScriptTemplate.replacingOccurrences(of: "__POTATO_OPTS__", with: "{gpc:\(gpc),facebook:\(facebook)}")
  }
}
