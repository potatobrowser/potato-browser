import Foundation
import Network
import WebKit

/// Drives the app for the end-to-end and live checks (scripts/e2e.mjs, scripts/live-check.mjs).
/// Only with `-potato-test`: steps come from POTATO_TEST_STEPS (JSON), results go to stdout as
/// `POTATO_TEST {json}` lines, and `POTATO_SHOT <name>` asks the runner for a screenshot.
@MainActor
enum TestRunner {
  struct Step: Decodable {
    let action: String
    var url: String?
    var js: String?
    var world: String?
    var wait: Double?
    var name: String?
    var settings: [String: JSONValue]?
    var text: String?
  }

  enum JSONValue: Decodable {
    case bool(Bool), int(Int), string(String), array([String])
    init(from d: Decoder) throws {
      let c = try d.singleValueContainer()
      if let b = try? c.decode(Bool.self) { self = .bool(b) }
      else if let i = try? c.decode(Int.self) { self = .int(i) }
      else if let s = try? c.decode(String.self) { self = .string(s) }
      else { self = .array(try c.decode([String].self)) }
    }
  }

  static func configure(app: AppModel) {
    let env = ProcessInfo.processInfo.environment
    if let proxy = env["POTATO_TEST_PROXY"], let port = proxy.split(separator: ":").last.flatMap({ NWEndpoint.Port(String($0)) }) {
      let config = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: port))
      WKWebsiteDataStore.default().proxyConfigurations = [config]
      app.privateDataStore.proxyConfigurations = [config]
    }
  }

  static func emit(_ obj: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .fragmentsAllowed])) ?? Data()
    print("POTATO_TEST " + String(decoding: data, as: UTF8.self))
    fflush(stdout)
  }

  static func run(app: AppModel) async {
    guard app.isTest, let raw = ProcessInfo.processInfo.environment["POTATO_TEST_STEPS"], let data = raw.data(using: .utf8),
      let steps = try? JSONDecoder().decode([Step].self, from: data)
    else { return }
    emit(["event": "start", "steps": steps.count])
    for (i, step) in steps.enumerated() {
      var out: [String: Any] = ["step": i, "action": step.action]
      if let n = step.name { out["name"] = n }
      do {
        try await perform(step, app: app, out: &out)
      } catch {
        out["error"] = "\(error)"
      }
      emit(out)
    }
    emit(["event": "done"])
  }

  private static func perform(_ step: Step, app: AppModel, out: inout [String: Any]) async throws {
    let tabs = app.tabs!
    switch step.action {
    case "ready":
      // Waits until the ad blocker's rule lists are compiled (first start).
      let start = Date()
      while !app.adblock.isReady, Date().timeIntervalSince(start) < (step.wait ?? 120) { try await Task.sleep(nanoseconds: 250_000_000) }
      out["ready"] = app.adblock.isReady
      out["seconds"] = Date().timeIntervalSince(start)
      out["engines"] = Array(app.adblock.engines).sorted()
    case "open":
      guard let s = step.url, let url = URL(string: s) else { return }
      let tab = tabs.selected ?? tabs.newTab()
      tab.load(url)
      try await waitForLoad(tab, extra: step.wait ?? 2)
      out["url"] = tab.url?.absoluteString ?? ""
      out["title"] = tab.title
    case "newTab":
      let tab = tabs.newTab(url: step.url.flatMap(URL.init(string:)), isPrivate: step.text == "private")
      if step.url != nil { try await waitForLoad(tab, extra: step.wait ?? 2) }
    case "submit":
      guard let tab = tabs.selected, let text = step.text else { return }
      tab.submit(text)
      try await waitForLoad(tab, extra: step.wait ?? 2)
      out["url"] = tab.url?.absoluteString ?? ""
    case "wait":
      try await Task.sleep(nanoseconds: UInt64((step.wait ?? 1) * 1e9))
    case "eval":
      guard let tab = tabs.selected, let js = step.js else { return }
      let world: WKContentWorld = step.world == "potato" ? app.world : .page
      let v = try await tab.webView.callAsyncJavaScript(js, contentWorld: world)
      out["value"] = v ?? NSNull()
    case "state":
      guard let tab = tabs.selected else { return }
      out["url"] = tab.url?.absoluteString ?? ""
      out["title"] = tab.title
      out["shield"] = ["count": tab.shield.count, "features": tab.shield.features]
      out["adblock"] = ["blocked": tab.adblock.blocked, "hosts": tab.adblock.topHosts.map { "\($0.host):\($0.count)" }]
      out["flags"] = ["platform": tab.flags.platform ?? "", "hidden": tab.flags.hidden, "labeled": tab.flags.labeled]
      out["interstitial"] = tab.interstitial.map { "\($0)" } ?? ""
      out["tabs"] = tabs.tabs.count
      out["privateTabs"] = tabs.privateTabs.count
      out["stats"] = ["shieldHidden": app.store.todayStats().shieldHidden, "adsBlocked": app.store.todayStats().adsBlocked]
    case "settings":
      for (k, v) in step.settings ?? [:] { apply(k, v, app.settings) }
      try await Task.sleep(nanoseconds: 300_000_000)
    case "shot":
      print("POTATO_SHOT \(step.name ?? "shot")")
      fflush(stdout)
      try await Task.sleep(nanoseconds: UInt64((step.wait ?? 1.5) * 1e9))
    case "panel":
      app.panel = step.text.flatMap { name in [Panel.tabs, .menu, .protections, .settings, .history, .bookmarks, .downloads].first { "\($0)" == name } }
      try await Task.sleep(nanoseconds: 800_000_000)
    case "back":
      tabs.selected?.goBack()
      try await Task.sleep(nanoseconds: UInt64((step.wait ?? 2) * 1e9))
    case "engineCheck":
      let check = EngineCheck()
      await check.run(app: app)
      if let r = check.result { out["window"] = r.window; out["worker"] = r.worker; out["frame"] = r.frame; out["speech"] = r.speech }
    default:
      out["error"] = "unknown action"
    }
  }

  private static func waitForLoad(_ tab: Tab, extra: Double) async throws {
    try await Task.sleep(nanoseconds: 500_000_000)
    let start = Date()
    while tab.isLoading, Date().timeIntervalSince(start) < 30 { try await Task.sleep(nanoseconds: 200_000_000) }
    try await Task.sleep(nanoseconds: UInt64(extra * 1e9))
  }

  private static func apply(_ key: String, _ value: JSONValue, _ settings: SettingsStore) {
    settings.update { s in
      switch (key, value) {
      case ("shield.enabled", .bool(let b)): s.shield.enabled = b
      case ("shield.disabledSites", .array(let a)): s.shield.disabledSites = a
      case ("adblock.enabled", .bool(let b)): s.adblock.enabled = b
      case ("adblock.disabledSites", .array(let a)): s.adblock.disabledSites = a
      case ("adblock.cookieNotices", .bool(let b)): s.adblock.cookieNotices = b
      case ("adblock.annoyances", .bool(let b)): s.adblock.annoyances = b
      case ("adblock.customFilters", .string(let t)): s.adblock.customFilters = t
      case ("flags.mode", .string(let m)): s.flags.mode = FlagMode(rawValue: m) ?? s.flags.mode
      case ("flags.threshold", .int(let n)): s.flags.threshold = n
      case ("flags.showButtons", .bool(let b)): s.flags.showButtons = b
      case ("privacy.blockAiChatbots", .bool(let b)): s.privacy.blockAiChatbots = b
      case ("privacy.globalPrivacyControl", .bool(let b)): s.privacy.globalPrivacyControl = b
      case ("searchEngine", .string(let e)): s.searchEngine = e
      case ("firstRunDone", .bool(let b)): s.firstRunDone = b
      default: print("POTATO_TEST unknown setting \(key)")
      }
    }
  }
}
