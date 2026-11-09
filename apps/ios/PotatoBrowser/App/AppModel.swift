import Combine
import SwiftUI
import WebKit

enum Panel: Identifiable, Equatable {
  case tabs, menu, protections, settings, history, bookmarks, downloads, addBookmark, welcome
  var id: String { "\(self)" }
}

/// Owns the services and the tabs. One per app.
@MainActor
final class AppModel: ObservableObject {
  let settings: SettingsStore
  let store: Store
  let shield: ShieldService
  let adblock: AdblockService
  let flags: FlagsService
  let downloads: DownloadManager
  private(set) var crashes: CrashReporter!
  private(set) var tabs: TabManager!
  let isTest: Bool
  let apiBase: URL
  let directory: URL
  let world = WKContentWorld.world(name: "potato")
  private(set) var privateDataStore = WKWebsiteDataStore.nonPersistent()

  @Published var panel: Panel?
  @Published var toast: String?
  @Published var editingAddress = false
  @Published var suggestionText = ""

  private(set) var pageScript: WKUserScript
  let contentScript: WKUserScript
  private var bag = Set<AnyCancellable>()

  init() {
    let args = ProcessInfo.processInfo.arguments
    let env = ProcessInfo.processInfo.environment
    isTest = args.contains("-potato-test")
    apiBase = URL(string: env["POTATO_API_BASE"] ?? "https://potatobrowser.com")!
    let fm = FileManager.default
    var dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Potato", isDirectory: true)
    if let profile = env["POTATO_PROFILE"] { dir = URL(fileURLWithPath: profile, isDirectory: true) }
    if args.contains("-potato-fresh") { try? fm.removeItem(at: dir) }
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    directory = dir

    let settings = SettingsStore(directory: dir)
    if isTest, let first = env["POTATO_FIRST_RUN_DONE"], first == "1" { settings.update { $0.firstRunDone = true } }
    self.settings = settings
    let store = (try? Store(path: dir.appendingPathComponent("profile.sqlite").path)) ?? (try! Store(path: ":memory:"))
    self.store = store
    let testKeys = isTest ? env["POTATO_SHIELD_KEYS"].map { $0.split(separator: ",").map(String.init) } : nil
    shield = ShieldService(settings: settings, directory: dir, world: world, testKeys: testKeys)
    adblock = AdblockService(settings: settings, store: store, apiBase: apiBase, directory: dir)
    flags = FlagsService(apiBase: apiBase, store: store, settings: settings)
    downloads = DownloadManager(store: store, directory: fm.urls(for: .documentDirectory, in: .userDomainMask)[0])
    let s = settings.value
    pageScript = WKUserScript(source: WebResources.pageScript(gpc: s.privacy.globalPrivacyControl, facebook: Self.facebookHelper(s)), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page)
    contentScript = WKUserScript(source: WebResources.contentScript, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: world)
    if isTest { TestRunner.configure(app: self) }
    tabs = TabManager(app: self)
    crashes = CrashReporter(apiBase: apiBase) { [weak settings] in settings?.value.privacy.crashReports ?? false }
    adblock.shieldWantsUpdates = { [weak settings] in settings?.value.shield.autoUpdate ?? false }
    adblock.onShieldInfo = { [weak self] info in
      guard let self, await self.shield.update(info, apiBase: self.apiBase) else { return }
      self.tabs.settingsChanged()
    }

    settings.changes.sink { [weak self] new, prev in self?.settingsChanged(new, prev) }.store(in: &bag)
    if !s.firstRunDone && !isTest { panel = .welcome }
    Task {
      await shield.prepareBlockList()
      await adblock.start()
      tabs.settingsChanged()
    }
    if isTest {
      Task {
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        await TestRunner.run(app: self)
      }
    }
    adblock.$lists.dropFirst().sink { [weak self] _ in
      Task { @MainActor in self?.tabs.applyRuleLists() }
    }.store(in: &bag)
  }

  private static func facebookHelper(_ s: Settings) -> Bool {
    (s.flags.mode != .ignore || s.flags.showButtons) && !s.flags.disabledPlatforms.contains("facebook")
  }

  private func settingsChanged(_ new: Settings, _ prev: Settings) {
    adblock.onSettingsChanged(new, prev)
    if new.privacy.globalPrivacyControl != prev.privacy.globalPrivacyControl || Self.facebookHelper(new) != Self.facebookHelper(prev) {
      pageScript = WKUserScript(source: WebResources.pageScript(gpc: new.privacy.globalPrivacyControl, facebook: Self.facebookHelper(new)), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page)
    }
    if new.shield.disabledRules != prev.shield.disabledRules {
      Task {
        await shield.prepareBlockList()
        tabs.settingsChanged()
      }
    }
    if new.shield != prev.shield || new.adblock != prev.adblock || new.flags != prev.flags || new.privacy != prev.privacy {
      tabs.settingsChanged()
    }
  }

  /// Rule lists a page at `url` loads with: the ad blocker's and the shield's AI request blocks.
  func ruleLists(for url: URL?) -> [WKContentRuleList] {
    var lists = adblock.ruleLists(for: url)
    if shield.isEnabled(for: url), let l = shield.blockList { lists.append(l) }
    return lists
  }

  /// Ends the private session: its cookies, storage and throwaway flag id go.
  func resetPrivateSession() {
    flags.forgetPrivate()
    privateDataStore = WKWebsiteDataStore.nonPersistent()
  }

  /// A link from another app (the URL scheme, the share extension, or a web link once the app may
  /// be the default browser): its page opens in a normal tab, in front of everything but the
  /// first-run setup. A blank selected tab is reused rather than left behind.
  func open(link: URL) {
    guard let page = AppLink.page(for: link) else { return }
    editingAddress = false
    if panel != .welcome { panel = nil }
    if let tab = tabs.selected, !tab.isPrivate, tab.isBlank, !tab.isLoading {
      tab.load(page)
    } else {
      tabs.newTab(url: page, isPrivate: false)
    }
  }

  func showToast(_ text: String) {
    toast = text
    Task {
      try? await Task.sleep(nanoseconds: 2_500_000_000)
      if toast == text { toast = nil }
    }
  }

  /// "Report this site" for the selected tab's page.
  func report(feature: String, problem: String) async -> Bool {
    guard let url = tabs.selected?.url else { return false }
    return await SiteReports.send(url, feature: feature, problem: problem, apiBase: apiBase)
  }

  /// Clears cookies, caches and site data (and history since `since`).
  func clearBrowsingData(since: Date?, history: Bool, siteData: Bool) async {
    if history { store.clearHistory(since: since) }
    if siteData {
      let types = WKWebsiteDataStore.allWebsiteDataTypes()
      await WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: since ?? .distantPast)
    }
  }
}
