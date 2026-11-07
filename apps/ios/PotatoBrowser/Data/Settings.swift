import Combine
import Foundation

enum FlagMode: String, Codable, CaseIterable, Identifiable {
  case hide, label, ignore
  var id: String { rawValue }
}

enum StartupMode: String, Codable, CaseIterable, Identifiable {
  case restore, newtab
  var id: String { rawValue }
}

enum Theme: String, Codable, CaseIterable, Identifiable {
  case system, light, dark
  var id: String { rawValue }
}

/// The Mac app's settings (apps/browser/src/main/settings.ts), minus what iOS decides itself.
struct Settings: Codable, Equatable {
  struct Shield: Codable, Equatable {
    var enabled = true
    /// Hostnames (registrable or full) where AI features are shown.
    var disabledSites: [String] = []
    /// Rule ids (`rule` or `rule:feature`) the user turned off everywhere.
    var disabledRules: [String] = []
  }

  struct Flags: Codable, Equatable {
    var mode: FlagMode = .label
    var threshold = 3
    var showButtons = true
    var disabledPlatforms: [String] = []
  }

  struct Privacy: Codable, Equatable {
    var globalPrivacyControl = true
    var blockAiChatbots = false
  }

  struct Adblock: Codable, Equatable {
    var enabled = true
    var disabledSites: [String] = []
    var trackers = true
    var cookieNotices = false
    var annoyances = false
    var customFilters = ""
    var autoUpdate = true
  }

  var searchEngine = "duckduckgo"
  var searchSuggestions = true
  var startup: StartupMode = .restore
  var theme: Theme = .system
  var shield = Shield()
  var flags = Flags()
  var privacy = Privacy()
  var adblock = Adblock()
  /// Sites the user asked to see in their desktop layout.
  var desktopSites: [String] = []
  var installId = Settings.randomId()
  var firstRunDone = false

  static func randomId() -> String {
    (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
  }

  /// Clamps and dedupes, like the Mac app's sanitizeSettings.
  mutating func sanitize() {
    if !SearchEngine.all.contains(where: { $0.id == searchEngine }) { searchEngine = SearchEngine.all[0].id }
    flags.threshold = min(100, max(1, flags.threshold))
    flags.disabledPlatforms = flags.disabledPlatforms.filter { FlagPlatform.ids.contains($0) }
    shield.disabledSites = Self.uniqueLowercased(shield.disabledSites)
    shield.disabledRules = Array(NSOrderedSet(array: shield.disabledRules)) as? [String] ?? []
    adblock.disabledSites = Self.uniqueLowercased(adblock.disabledSites)
    adblock.customFilters = String(adblock.customFilters.prefix(200_000))
    desktopSites = Self.uniqueLowercased(desktopSites)
    if installId.range(of: "^[0-9a-f]{32}$", options: .regularExpression) == nil { installId = Self.randomId() }
  }

  private static func uniqueLowercased(_ list: [String]) -> [String] {
    var seen = Set<String>()
    return list.map { $0.lowercased() }.filter { !$0.isEmpty && seen.insert($0).inserted }
  }
}

// Missing keys fall back to defaults, so older settings files keep working.
extension Settings {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let d = Settings()
    searchEngine = (try? c.decodeIfPresent(String.self, forKey: .searchEngine)) ?? d.searchEngine
    searchSuggestions = (try? c.decodeIfPresent(Bool.self, forKey: .searchSuggestions)) ?? d.searchSuggestions
    startup = (try? c.decodeIfPresent(StartupMode.self, forKey: .startup)) ?? d.startup
    theme = (try? c.decodeIfPresent(Theme.self, forKey: .theme)) ?? d.theme
    shield = (try? c.decodeIfPresent(Shield.self, forKey: .shield)) ?? d.shield
    flags = (try? c.decodeIfPresent(Flags.self, forKey: .flags)) ?? d.flags
    privacy = (try? c.decodeIfPresent(Privacy.self, forKey: .privacy)) ?? d.privacy
    adblock = (try? c.decodeIfPresent(Adblock.self, forKey: .adblock)) ?? d.adblock
    desktopSites = (try? c.decodeIfPresent([String].self, forKey: .desktopSites)) ?? d.desktopSites
    installId = (try? c.decodeIfPresent(String.self, forKey: .installId)) ?? d.installId
    firstRunDone = (try? c.decodeIfPresent(Bool.self, forKey: .firstRunDone)) ?? d.firstRunDone
  }
}

extension Settings.Shield {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true
    disabledSites = (try? c.decodeIfPresent([String].self, forKey: .disabledSites)) ?? []
    disabledRules = (try? c.decodeIfPresent([String].self, forKey: .disabledRules)) ?? []
  }
}

extension Settings.Flags {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    mode = (try? c.decodeIfPresent(FlagMode.self, forKey: .mode)) ?? .label
    threshold = (try? c.decodeIfPresent(Int.self, forKey: .threshold)) ?? 3
    showButtons = (try? c.decodeIfPresent(Bool.self, forKey: .showButtons)) ?? true
    disabledPlatforms = (try? c.decodeIfPresent([String].self, forKey: .disabledPlatforms)) ?? []
  }
}

extension Settings.Privacy {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    globalPrivacyControl = (try? c.decodeIfPresent(Bool.self, forKey: .globalPrivacyControl)) ?? true
    blockAiChatbots = (try? c.decodeIfPresent(Bool.self, forKey: .blockAiChatbots)) ?? false
  }
}

extension Settings.Adblock {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true
    disabledSites = (try? c.decodeIfPresent([String].self, forKey: .disabledSites)) ?? []
    trackers = (try? c.decodeIfPresent(Bool.self, forKey: .trackers)) ?? true
    cookieNotices = (try? c.decodeIfPresent(Bool.self, forKey: .cookieNotices)) ?? false
    annoyances = (try? c.decodeIfPresent(Bool.self, forKey: .annoyances)) ?? false
    customFilters = (try? c.decodeIfPresent(String.self, forKey: .customFilters)) ?? ""
    autoUpdate = (try? c.decodeIfPresent(Bool.self, forKey: .autoUpdate)) ?? true
  }
}

@MainActor
final class SettingsStore: ObservableObject {
  @Published private(set) var value: Settings
  /// (new, previous) after every change.
  let changes = PassthroughSubject<(Settings, Settings), Never>()
  private let url: URL

  init(directory: URL) {
    url = directory.appendingPathComponent("settings.json")
    var s = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(Settings.self, from: $0) } ?? Settings()
    s.sanitize()
    value = s
    save()
  }

  func update(_ change: (inout Settings) -> Void) {
    var next = value
    change(&next)
    next.installId = value.installId
    next.sanitize()
    guard next != value else { return }
    let prev = value
    value = next
    save()
    changes.send((next, prev))
  }

  private func save() {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? enc.encode(value) { try? data.write(to: url, options: .atomic) }
  }
}
