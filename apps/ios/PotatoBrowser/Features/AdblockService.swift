import CryptoKit
import Foundation
import WebKit

/// The built-in ad and tracker blocker on iOS: WebKit rule lists block the requests (one list
/// per list group, compiled once on the device), the Ghostery engine in JavaScriptCore gives each
/// page its cosmetics and scriptlets and tells which resources were blocked, for the counts.
@MainActor
final class AdblockService: ObservableObject {
  static let groupOrder = ["ads", "trackers", "cookies", "annoyances"]

  @Published private(set) var lists: [String: WKContentRuleList] = [:]
  @Published private(set) var compiling: Set<String> = []
  @Published private(set) var engines: Set<String> = []
  @Published private(set) var updating = false
  @Published private(set) var lastCheck: Date?
  @Published private(set) var lastError: String?
  @Published private(set) var customErrors: [String] = []

  let engine = EngineHost()
  private let settings: SettingsStore
  private let store: Store
  private let apiBase: URL
  private let dir: URL
  private let ruleStore: WKContentRuleListStore
  private var state = UserState()
  private var pendingStats = 0
  private var timer: Timer?
  /// The daily check also carries the AI Shield's rule version; AppModel hands it on.
  var onShieldInfo: (([String: Any]?) async -> Void)?
  /// Whether the AI Shield wants its daily rule check (Settings > AI Shield).
  var shieldWantsUpdates: () -> Bool = { false }

  struct UserState: Codable {
    /// Lists downloaded by an update: id -> revision and when.
    var lists: [String: Downloaded] = [:]
    var lastCheck: Double?
    var lastError: String?
    /// UTC day of the last scheduled check, the one that counts the install as used that day.
    var countedDay: String?
    struct Downloaded: Codable {
      var rev: String
      var fetchedAt: Double
    }
  }

  init(settings: SettingsStore, store: Store, apiBase: URL, directory: URL) {
    self.settings = settings
    self.store = store
    self.apiBase = apiBase
    dir = directory.appendingPathComponent("Filters", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir.appendingPathComponent("lists"), withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(at: dir.appendingPathComponent("rules"), withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(at: dir.appendingPathComponent("engines"), withIntermediateDirectories: true)
    let ruleDir = directory.appendingPathComponent("RuleLists", isDirectory: true)
    try? FileManager.default.createDirectory(at: ruleDir, withIntermediateDirectories: true)
    ruleStore = WKContentRuleListStore(url: ruleDir)
    if let data = try? Data(contentsOf: dir.appendingPathComponent("state.json")), let s = try? JSONDecoder().decode(UserState.self, from: data) {
      state = s
    }
    lastCheck = state.lastCheck.map { Date(timeIntervalSince1970: $0) }
    lastError = state.lastError
  }

  private var a: Settings.Adblock { settings.value.adblock }

  /// The list groups the settings turn on.
  var activeGroups: [String] {
    var g = ["ads"]
    if a.trackers { g.append("trackers") }
    if a.cookieNotices { g.append("cookies") }
    if a.annoyances { g.append("annoyances") }
    return g
  }

  private var activeIds: [String] {
    activeGroups + (a.customFilters.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : ["custom"])
  }

  // MARK: Start

  func start() async {
    await engine.start()
    await prepare()
    timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.flushStats() }
    }
    scheduleUpdates()
  }

  /// Loads (or compiles) what the current settings need: rule lists and engines.
  func prepare() async {
    let want = activeIds
    for id in want where !engines.contains(id) {
      if let data = engineData(id) {
        let n = await engine.load(id: id, data: data)
        if n > 0 { engines.insert(id) }
      }
    }
    for id in engines where !want.contains(id) {
      await engine.unload(id: id)
      engines.remove(id)
    }
    for id in want { await ensureList(id) }
  }

  private func engineData(_ id: String) -> Data? {
    if id == "custom" { return nil }
    let updated = dir.appendingPathComponent("engines/\(id).bin")
    if groupIsUpdated(id), let d = try? Data(contentsOf: updated) { return d }
    return try? Data(contentsOf: WebResources.url("engines/\(id).bin"))
  }

  private func groupIsUpdated(_ id: String) -> Bool {
    let lists = WebResources.manifest.groups.first { $0.id == id }?.lists ?? []
    return lists.contains { state.lists[$0] != nil }
  }

  /// One generation for all group lists: they share exceptions, so any list update renews all.
  private var generation: String {
    let revs = WebResources.manifest.lists.keys.sorted().map { "\($0)=\(revision($0))" }.joined(separator: ",")
    return Self.hash("\(WebResources.manifest.builtAt)|\(revs)")
  }

  private func revision(_ id: String) -> String {
    state.lists[id]?.rev ?? WebResources.manifest.lists[id]?.rev ?? ""
  }

  private func identifier(_ id: String) -> String {
    id == "custom" ? "custom-\(Self.hash(WebResources.manifest.builtAt + a.customFilters))" : "\(id)-\(generation)"
  }

  static func hash(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
  }

  private func ruleJSON(_ id: String) async -> String? {
    if id == "custom" {
      let r = await engine.ruleLists(groups: [], custom: a.customFilters)
      return r["custom"]?.json
    }
    if !state.lists.isEmpty, let s = try? String(contentsOf: dir.appendingPathComponent("rules/\(id).json"), encoding: .utf8) { return s }
    return WebResources.inflatedText("rules/\(id).json.z")
  }

  private func ensureList(_ id: String) async {
    let ident = identifier(id)
    if lists[id]?.identifier == ident || compiling.contains(id) { return }
    if let found = try? await ruleStore.contentRuleList(forIdentifier: ident) {
      lists[id] = found
      return
    }
    compiling.insert(id)
    defer { compiling.remove(id) }
    guard let json = await ruleJSON(id) else { return }
    do {
      let list = try await ruleStore.compileContentRuleList(forIdentifier: ident, encodedContentRuleList: json)
      lists[id] = list
      if id == "custom" {
        await compileCustomEngine()
        customErrors = []
      }
      await removeStale()
    } catch {
      if id == "custom" { customErrors = [error.localizedDescription] }
      print("adblock: compile \(id) failed: \(error)")
    }
  }

  private func compileCustomEngine() async {
    let resources = WebResources.inflatedText("resources.json.z") ?? "{}"
    if let data = await engine.compile(lists: [], resources: resources, custom: a.customFilters) {
      if await engine.load(id: "custom", data: data) > 0 { engines.insert("custom") }
    }
  }

  private func removeStale() async {
    let keep = Set(lists.values.compactMap(\.identifier))
    let all = await ruleStore.availableIdentifiers() ?? []
    for ident in all where !keep.contains(ident) && (ident.hasPrefix("custom-") || Self.groupOrder.contains { ident.hasPrefix("\($0)-") }) {
      try? await ruleStore.removeContentRuleList(forIdentifier: ident)
    }
  }

  func onSettingsChanged(_ next: Settings, _ prev: Settings) {
    let n = next.adblock
    let p = prev.adblock
    if n.trackers != p.trackers || n.cookieNotices != p.cookieNotices || n.annoyances != p.annoyances || n.customFilters != p.customFilters || n.enabled != p.enabled {
      if n.customFilters != p.customFilters {
        lists["custom"] = nil
        engines.remove("custom")
        Task { await engine.unload(id: "custom") }
      }
      Task { await prepare() }
    }
  }

  // MARK: Per page

  func isSiteDisabled(_ url: URL?) -> Bool {
    guard let host = url?.host else { return false }
    return a.disabledSites.contains { URLInput.hostMatches(host, $0) }
  }

  func isEnabled(for url: URL?) -> Bool {
    a.enabled && URLInput.isWeb(url) && !isSiteDisabled(url)
  }

  func setSite(_ url: URL, enabled: Bool) {
    guard let host = url.host else { return }
    settings.update { s in
      s.adblock.disabledSites.removeAll { URLInput.hostMatches(host, $0) }
      if !enabled { s.adblock.disabledSites.append(URLInput.siteKey(url)) }
    }
  }

  /// Rule lists a page at `url` loads with.
  func ruleLists(for url: URL?) -> [WKContentRuleList] {
    guard isEnabled(for: url) else { return [] }
    return activeIds.compactMap { lists[$0] }
  }

  var isReady: Bool { activeGroups.allSatisfy { lists[$0] != nil } }

  var engineIds: [String] { activeIds.filter { engines.contains($0) } }

  /// Cosmetics JSON for a page's main frame, or nil when the blocker is off there.
  func cosmeticsJSON(for url: URL) async -> String? {
    guard isEnabled(for: url), !engineIds.isEmpty else { return nil }
    return await engine.cosmeticsJSON(ids: engineIds, url: url.absoluteString)
  }

  func domRules(url: URL, dom: [String: [String]]) async -> String {
    guard isEnabled(for: url) else { return "" }
    return await engine.domRules(ids: engineIds, url: url.absoluteString, dom: dom)
  }

  /// Counts the resources of a page the filters block; returns their hosts.
  func blocked(site: URL, source: URL, items: [[String: String]], isPrivate: Bool) async -> [String] {
    guard isEnabled(for: site), !engineIds.isEmpty else { return [] }
    let hosts = await engine.blocked(ids: engineIds, source: source.absoluteString, items: items)
    if !isPrivate { pendingStats += hosts.count }
    return hosts
  }

  func flushStats() {
    guard pendingStats > 0 else { return }
    store.addAdsBlocked(pendingStats)
    pendingStats = 0
  }

  // MARK: Updates (once a day, through potatobrowser.com, like the Mac app)

  private var wantsLists: Bool { a.enabled && a.autoUpdate }

  static func utcDay(_ t: Double?) -> String {
    guard let t else { return "" }
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: Date(timeIntervalSince1970: t))
  }

  /// Once per calendar day (UTC), so the check also tells how many installs ran that day.
  var isCheckDue: Bool {
    (wantsLists || shieldWantsUpdates()) && state.countedDay != Self.utcDay(Date().timeIntervalSince1970)
  }

  /// When the app comes to the foreground: suspended apps miss their hourly timer.
  func checkIfDue() {
    guard started, isCheckDue else { return }
    Task { await checkForUpdates(daily: true) }
  }

  private var started = false

  private func scheduleUpdates() {
    Task {
      try? await Task.sleep(nanoseconds: UInt64(ProcessInfo.processInfo.environment["POTATO_UPDATE_CHECK_DELAY_MS"].flatMap(Double.init) ?? 60_000) * 1_000_000)
      started = true
      while true {
        if isCheckDue { await checkForUpdates(daily: true) }
        try? await Task.sleep(nanoseconds: 3_600_000_000_000)
      }
    }
  }

  private func listText(_ id: String) -> String {
    if state.lists[id] != nil, let s = try? String(contentsOf: dir.appendingPathComponent("lists/\(id).txt"), encoding: .utf8) { return s }
    return WebResources.inflatedText("lists/\(id).txt.z") ?? ""
  }

  private static func plausible(_ text: String) -> Bool {
    text.count > 200 && text.count < 20_000_000 && text.contains("\n") && !text.trimmingCharacters(in: .whitespaces).hasPrefix("<")
  }

  /// `daily`: the scheduled check, which also counts the install as used today; "Update now" is not.
  func checkForUpdates(daily: Bool = false) async {
    guard !updating else { return }
    updating = true
    defer {
      updating = false
      saveState()
    }
    let ids = wantsLists ? WebResources.manifest.groups.filter { activeGroups.contains($0.id) }.flatMap(\.lists) : []
    var c = URLComponents(url: apiBase.appendingPathComponent("api/v1/filters"), resolvingAgainstBaseURL: false)!
    // The lists, the app and its version: nothing about the user.
    c.queryItems = [URLQueryItem(name: "lists", value: ids.joined(separator: ",")), URLQueryItem(name: "app", value: "ios"), URLQueryItem(name: "v", value: Bundle.main.marketingVersion)]
    if daily { c.queryItems?.append(URLQueryItem(name: "daily", value: "1")) }
    let session = URLSession(configuration: .ephemeral)
    do {
      let (data, res) = try await session.data(from: c.url!)
      guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
      if daily { state.countedDay = Self.utcDay(Date().timeIntervalSince1970) }
      let body = (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      let latest = body["lists"] as? [String: Any] ?? [:]
      if shieldWantsUpdates() { await onShieldInfo?(body["shield"] as? [String: Any]) }
      var changed: [String] = []
      var failed: [String] = []
      for id in ids {
        guard let rev = latest[id] as? String, rev.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil, rev != revision(id) else { continue }
        do {
          let (body, r) = try await session.data(from: apiBase.appendingPathComponent("api/v1/filters/\(id)/\(rev)"))
          let text = String(decoding: body, as: UTF8.self)
          guard (r as? HTTPURLResponse)?.statusCode == 200, Self.plausible(text) else { throw URLError(.cannotDecodeContentData) }
          try text.write(to: dir.appendingPathComponent("lists/\(id).txt"), atomically: true, encoding: .utf8)
          state.lists[id] = .init(rev: rev, fetchedAt: Date().timeIntervalSince1970)
          changed.append(id)
        } catch {
          failed.append(WebResources.manifest.lists[id]?.name ?? id)
        }
      }
      state.lastCheck = Date().timeIntervalSince1970
      state.lastError = failed.isEmpty ? nil : "could not download \(failed.joined(separator: ", "))"
      if !changed.isEmpty { await rebuildFromLists(changed: changed) }
    } catch {
      state.lastCheck = Date().timeIntervalSince1970
      state.lastError = error.localizedDescription
    }
    lastCheck = state.lastCheck.map { Date(timeIntervalSince1970: $0) }
    lastError = state.lastError
  }

  /// New engines for the groups whose lists changed, new rule lists for every group.
  private func rebuildFromLists(changed: [String]) async {
    let builder = EngineHost()
    await builder.start()
    let resources = WebResources.inflatedText("resources.json.z") ?? "{}"
    let groups = WebResources.manifest.groups
    for g in groups where g.lists.contains(where: changed.contains) {
      if let data = await builder.compile(lists: g.lists.map { ($0, listText($0)) }, resources: resources) {
        try? data.write(to: dir.appendingPathComponent("engines/\(g.id).bin"), options: .atomic)
        if engines.contains(g.id), await engine.load(id: g.id, data: data) == 0 { engines.remove(g.id) }
      }
    }
    let built = await builder.ruleLists(groups: groups.map { ($0.id, $0.lists.map(listText)) })
    for (id, r) in built { try? r.json.write(to: dir.appendingPathComponent("rules/\(id).json"), atomically: true, encoding: .utf8) }
    saveState()
    for id in activeGroups { await ensureList(id) }
  }

  private func saveState() {
    if let data = try? JSONEncoder().encode(state) { try? data.write(to: dir.appendingPathComponent("state.json"), options: .atomic) }
  }

  struct ListInfo: Identifiable {
    let id: String
    let name: String
    let group: String
    let homepage: String
    let updated: Date?
  }

  var listInfo: [ListInfo] {
    let m = WebResources.manifest
    let built = ISO8601DateFormatter().date(from: m.listsFetchedAt)
    return m.groups.filter { activeGroups.contains($0.id) }.flatMap { g in
      g.lists.map { id in
        ListInfo(id: id, name: m.lists[id]?.name ?? id, group: g.id, homepage: m.lists[id]?.homepage ?? "", updated: state.lists[id].map { Date(timeIntervalSince1970: $0.fetchedAt) } ?? built)
      }
    }
  }

  var ruleCount: Int {
    WebResources.manifest.groups.filter { activeGroups.contains($0.id) }.reduce(0) { $0 + $1.rules }
  }
}
