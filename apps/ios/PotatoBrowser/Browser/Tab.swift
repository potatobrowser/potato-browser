import Combine
import UIKit
import WebKit

enum Interstitial: Equatable {
  /// An AI chatbot site the user blocked in settings.
  case chatbot(URL)
  /// A page that could not load.
  case failed(URL?, title: String, message: String)
  /// A certificate error; `trust` lets the user continue for this session.
  case insecure(URL, host: String)
  /// The web content process quit.
  case crashed(URL?)
}

struct ShieldPageState: Equatable {
  var count = 0
  var features: [String] = []
}

struct AdblockPageState: Equatable {
  var blocked = 0
  var hosts: [String: Int] = [:]
  var topHosts: [(host: String, count: Int)] {
    hosts.sorted { $0.value > $1.value }.prefix(5).map { ($0.key, $0.value) }
  }
  static func == (a: Self, b: Self) -> Bool { a.blocked == b.blocked && a.hosts == b.hosts }
}

struct FlagsPageState: Equatable {
  var platform: String?
  var hidden = 0
  var labeled = 0
}

/// A tab's web view. Keys a focused page leaves alone go to the keyboard's text commands before
/// the app's commands, and Cmd+W and Cmd+F end there, so it claims those two first.
final class BrowserWebView: WKWebView {
  weak var app: AppModel?

  override var keyCommands: [UIKeyCommand]? {
    let commands = [
      UIKeyCommand(input: "w", modifierFlags: .command, action: #selector(closeTab)),
      UIKeyCommand(input: "f", modifierFlags: .command, action: #selector(findOnPage)),
    ]
    for c in commands { c.wantsPriorityOverSystemBehavior = true }
    return (super.keyCommands ?? []) + commands
  }

  @objc private func closeTab() { app?.closeTabShortcut() }
  @objc private func findOnPage() { app?.findShortcut() }
}

@MainActor
final class Tab: NSObject, ObservableObject, Identifiable {
  let id = UUID()
  let isPrivate: Bool
  unowned let app: AppModel

  @Published var title = ""
  @Published var url: URL?
  @Published var isLoading = false
  @Published var progress: Double = 0
  @Published var canGoBack = false
  @Published var canGoForward = false
  @Published var hasOnlySecureContent = true
  @Published var interstitial: Interstitial?
  @Published var shield = ShieldPageState()
  @Published var adblock = AdblockPageState()
  @Published var flags = FlagsPageState()
  @Published var snapshot: UIImage?
  @Published var themeColor: UIColor?

  /// Restored tabs keep their state until first shown.
  private var pendingState: Data?
  private var pendingURL: URL?
  private var savedTitle = ""
  private(set) var lastActive = Date()

  private let controller = WKUserContentController()
  private var web: WKWebView?
  private var observations: [NSKeyValueObservation] = []
  private var shieldFrames: [String: ShieldPageState] = [:]
  private var appliedLists: [String] = []
  private var decisionSeq = 0
  private var typed = false
  private var allowedChatbots = Set<String>()
  private var trustedCertificates: [String: Data] = [:]
  private var configuredFor: URL?

  init(app: AppModel, isPrivate: Bool, url: URL? = nil, state: Data? = nil, title: String = "") {
    self.app = app
    self.isPrivate = isPrivate
    super.init()
    pendingURL = url
    pendingState = state
    savedTitle = title
    self.title = title
    self.url = url
    controller.addScriptMessageHandler(ScriptHandler(tab: self), contentWorld: app.world, name: "potato")
  }

  /// Creates the web view on first use (restored tabs stay cheap until shown).
  var webView: WKWebView {
    if let web { return web }
    let config = WKWebViewConfiguration()
    config.websiteDataStore = isPrivate ? app.privateDataStore : .default()
    config.userContentController = controller
    Self.configure(config, test: app.isTest)
    let w = BrowserWebView(frame: .zero, configuration: config)
    setUp(w)
    return w
  }

  private func setUp(_ w: BrowserWebView) {
    web = w
    w.app = app
    w.navigationDelegate = self
    w.uiDelegate = self
    w.allowsBackForwardNavigationGestures = true
    w.allowsLinkPreview = true
    w.isFindInteractionEnabled = true
    #if DEBUG
      w.isInspectable = true
    #endif
    if app.isTest { w.isInspectable = true }
    if isPrivate { w.backgroundColor = .systemBackground }
    let refresh = UIRefreshControl()
    refresh.tintColor = UIColor(named: "AccentColor")
    refresh.addTarget(self, action: #selector(pulledToRefresh), for: .valueChanged)
    w.scrollView.refreshControl = refresh
    observe(w)
    installBaseScripts(for: nil)
    if let state = pendingState {
      pendingState = nil
      w.interactionState = state
    } else if let url = pendingURL {
      pendingURL = nil
      w.load(URLRequest(url: url))
    }
  }

  /// No AI in the engine: what WebKit lets an app turn off.
  static func configure(_ config: WKWebViewConfiguration, test: Bool) {
    config.allowsInlineMediaPlayback = true
    config.allowsPictureInPictureMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = .audio
    config.writingToolsBehavior = .none
    config.allowsInlinePredictions = false
    config.supportsAdaptiveImageGlyph = false
    config.upgradeKnownHostsToHTTPS = true
    config.preferences.isElementFullscreenEnabled = true
    config.preferences.isFraudulentWebsiteWarningEnabled = true
    config.applicationNameForUserAgent = Self.userAgentSuffix
  }

  /// Safari's tokens, so sites (Google sign-in among them) treat the app as the browser it is.
  static let userAgentSuffix: String = {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "Version/\(v.majorVersion).\(v.minorVersion) Mobile/15E148 Safari/604.1"
  }()

  private func observe(_ w: WKWebView) {
    observations = [
      w.observe(\.title, options: [.new]) { [weak self] w, _ in
        Task { @MainActor in
          guard let self else { return }
          self.title = w.title ?? ""
          if !self.isPrivate, let url = w.url, !self.title.isEmpty { self.app.store.updateTitle(url: url.absoluteString, title: self.title) }
        }
      },
      w.observe(\.url, options: [.new]) { [weak self] w, _ in Task { @MainActor in self?.url = w.url ?? self?.url } },
      w.observe(\.isLoading, options: [.new]) { [weak self] w, _ in
        Task { @MainActor in
          self?.isLoading = w.isLoading
          if !w.isLoading { w.scrollView.refreshControl?.endRefreshing() }
        }
      },
      w.observe(\.estimatedProgress, options: [.new]) { [weak self] w, _ in Task { @MainActor in self?.progress = w.estimatedProgress } },
      w.observe(\.canGoBack, options: [.new]) { [weak self] w, _ in Task { @MainActor in self?.canGoBack = w.canGoBack } },
      w.observe(\.canGoForward, options: [.new]) { [weak self] w, _ in Task { @MainActor in self?.canGoForward = w.canGoForward } },
      w.observe(\.hasOnlySecureContent, options: [.new]) { [weak self] w, _ in Task { @MainActor in self?.hasOnlySecureContent = w.hasOnlySecureContent } },
      w.observe(\.themeColor, options: [.new]) { [weak self] w, _ in Task { @MainActor in self?.themeColor = w.themeColor } },
    ]
  }

  var isBlank: Bool { url == nil && interstitial == nil && pendingState == nil }
  /// A page is showing (not the new tab page or an error).
  var hasPage: Bool { url != nil && interstitial == nil }

  /// The address the user sees: a blocked or failed page's own, not the one before it.
  var displayURL: URL? {
    switch interstitial {
    case .chatbot(let u), .insecure(let u, _): u
    case .failed(let u, _, _), .crashed(let u): u ?? url
    case nil: url
    }
  }
  var hasWebView: Bool { web != nil }
  var displayTitle: String {
    if !title.isEmpty { return title }
    if let url { return URLInput.displayHost(url) }
    return "New Tab"
  }

  /// The web view itself is made when the tab is first shown or loads a page: one made before the
  /// app has a window (at launch) gets its touch handling wrong and crashes on the first tap.
  func activate() {
    lastActive = Date()
  }

  // MARK: Navigation

  func load(_ url: URL, typed: Bool = false) {
    interstitial = nil
    self.typed = typed
    webView.load(URLRequest(url: url))
  }

  func submit(_ text: String) {
    guard let url = URLInput.resolve(text, engine: app.settings.value.searchEngine) else { return }
    load(url, typed: true)
  }

  /// From an error page: back to the page underneath (or the new tab page when there is none).
  func goBack() {
    if interstitial != nil {
      interstitial = nil
      return
    }
    web?.goBack()
  }

  func goForward() { web?.goForward() }

  func reload() {
    if case .crashed(let u) = interstitial, let u {
      load(u)
      return
    }
    if case .failed(let u, _, _) = interstitial, let u {
      load(u)
      return
    }
    interstitial = nil
    if web?.url == nil, let url { load(url) } else { web?.reload() }
  }

  func stop() { web?.stopLoading() }

  /// Pull to refresh. The spinner goes when the load finishes or fails, or now if nothing loads.
  @objc private func pulledToRefresh() {
    reload()
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 500_000_000)
      if web?.isLoading != true { web?.scrollView.refreshControl?.endRefreshing() }
    }
  }

  func takeSnapshot() {
    guard let web, web.window != nil, web.bounds.width > 0 else { return }
    let c = WKSnapshotConfiguration()
    c.snapshotWidth = 400
    web.takeSnapshot(with: c) { [weak self] image, _ in
      if let image { self?.snapshot = image }
    }
  }

  var interactionState: Data? {
    if let pendingState { return pendingState }
    return web?.interactionState as? Data
  }

  var isDesktopSite: Bool {
    guard let host = url?.host else { return false }
    return app.settings.value.desktopSites.contains { URLInput.hostMatches(host, $0) }
  }

  func toggleDesktopSite() {
    guard let url, let host = url.host else { return }
    let on = !isDesktopSite
    app.settings.update { s in
      s.desktopSites.removeAll { URLInput.hostMatches(host, $0) }
      if on { s.desktopSites.append(URLInput.siteKey(url)) }
    }
    web?.reload()
  }

  func allowChatbotOnce(_ url: URL) {
    if let h = url.host { allowedChatbots.insert(h.lowercased()) }
    load(url)
  }

  func trustCertificateAndContinue(_ url: URL) {
    if let host = url.host, let data = pendingCertificate[host] { trustedCertificates[host] = data }
    load(url)
  }

  private var pendingCertificate: [String: Data] = [:]

  // MARK: Page config (what the Mac preload asks for with sendSync)

  func pageConfig(for url: URL, cosmetics: String?) -> String {
    let s = app.settings.value
    let web = URLInput.isWeb(url)
    let config: [String: Any] = [
      "isPrivate": isPrivate,
      "testHooks": app.isTest,
      "shield": ["enabled": web && app.shield.isEnabled(for: url), "disabledRules": s.shield.disabledRules],
      "adblock": ["enabled": web && app.adblock.isEnabled(for: url)],
      "flags": [
        "enabled": web && (s.flags.mode != .ignore || s.flags.showButtons),
        "mode": s.flags.mode.rawValue,
        "threshold": s.flags.threshold,
        "showButtons": s.flags.showButtons,
        "disabledPlatforms": s.flags.disabledPlatforms,
      ],
      "host": url.host ?? "",
    ]
    let data = (try? JSONSerialization.data(withJSONObject: config)) ?? Data("{}".utf8)
    var json = String(decoding: data, as: UTF8.self)
    json.removeLast()
    return json + ",\"cosmetics\":" + (cosmetics ?? "null") + "}"
  }

  func pageConfigObject(for url: URL) -> Any? {
    let json = pageConfig(for: url, cosmetics: nil)
    return try? JSONSerialization.jsonObject(with: Data(json.utf8))
  }

  /// Scripts and rule lists for the document about to load at `url`.
  private func prepare(for url: URL, cosmetics: String?) {
    var scriptlets: [String] = []
    var cosmeticsForConfig = cosmetics
    if let cosmetics, let obj = try? JSONSerialization.jsonObject(with: Data(cosmetics.utf8)) as? [String: Any] {
      scriptlets = obj["scripts"] as? [String] ?? []
      var rest = obj
      rest["scripts"] = []
      cosmeticsForConfig = (try? JSONSerialization.data(withJSONObject: rest)).map { String(decoding: $0, as: UTF8.self) }
    }
    controller.removeAllUserScripts()
    controller.addUserScript(app.pageScript)
    controller.addUserScript(WKUserScript(source: "window.__potatoConfig = \(pageConfig(for: url, cosmetics: cosmeticsForConfig));", injectionTime: .atDocumentStart, forMainFrameOnly: false, in: app.world))
    if let rules = app.shield.rulesScript { controller.addUserScript(rules) }
    controller.addUserScript(app.contentScript)
    if !scriptlets.isEmpty, let host = url.host {
      let hostJSON = (try? JSONSerialization.data(withJSONObject: [host])).map { String(decoding: $0, as: UTF8.self) } ?? "[]"
      let source = "(function(){if(location.hostname!==\(hostJSON)[0])return;\n\(scriptlets.joined(separator: "\n"))\n})();"
      controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
    }
    applyRuleLists(for: url)
    configuredFor = url
  }

  /// Base scripts before the first navigation decision (about:blank popups).
  private func installBaseScripts(for url: URL?) {
    controller.removeAllUserScripts()
    controller.addUserScript(app.pageScript)
    if let rules = app.shield.rulesScript { controller.addUserScript(rules) }
    controller.addUserScript(app.contentScript)
  }

  func applyRuleLists(for url: URL?) {
    let lists = app.ruleLists(for: url)
    let ids = lists.map { $0.identifier ?? "" }
    guard ids != appliedLists else { return }
    controller.removeAllContentRuleLists()
    for l in lists { controller.add(l) }
    appliedLists = ids
  }

  /// Settings changed: new rule lists now, and the open page updates in place.
  func settingsChanged() {
    guard let web, let url = web.url, URLInput.isWeb(url) else { return }
    applyRuleLists(for: url)
    let config = pageConfig(for: url, cosmetics: nil)
    web.evaluateJavaScript("window.__potatoApply && window.__potatoApply(\(config))", in: nil, in: app.world) { _ in }
    // Later documents (and iframes) of this page get the new config too.
    prepare(for: url, cosmetics: nil)
  }

  // MARK: Reports from pages

  func shieldReport(frame: String, count: Int, features: [String], delta: Int) {
    shieldFrames[frame] = ShieldPageState(count: count, features: features)
    var total = ShieldPageState()
    for s in shieldFrames.values {
      total.count += s.count
      for f in s.features where !total.features.contains(f) { total.features.append(f) }
    }
    if total != shield { shield = total }
    if !isPrivate, delta > 0 { app.store.addShieldHidden(min(delta, 1000)) }
  }

  func addBlocked(_ hosts: [String]) {
    guard !hosts.isEmpty else { return }
    var s = adblock
    for h in hosts {
      s.blocked += 1
      let host = h.replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
      if s.hosts[host] != nil || s.hosts.count < 200 { s.hosts[host, default: 0] += 1 }
    }
    adblock = s
  }

  private func resetPageState() {
    shieldFrames = [:]
    shield = ShieldPageState()
    adblock = AdblockPageState()
    flags = FlagsPageState()
  }

  fileprivate func handleExternal(_ url: URL) {
    let scheme = url.scheme?.lowercased() ?? ""
    let safe = ["mailto", "tel", "sms", "facetime", "facetime-audio", "maps", "itms-apps", "itms-appss"]
    if safe.contains(scheme) {
      UIApplication.shared.open(url)
      return
    }
    Presenter.confirm(title: "Open in another app?", message: "This page wants to open \(url.scheme ?? "an app") link.", action: "Open") { ok in
      if ok { UIApplication.shared.open(url) }
    }
  }
}

// MARK: - WKNavigationDelegate

extension Tab: WKNavigationDelegate {
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
    guard let url = action.request.url else {
      decisionHandler(.cancel, preferences)
      return
    }
    let scheme = url.scheme?.lowercased() ?? ""
    if !["http", "https", "about", "data", "blob", "file", "javascript"].contains(scheme) {
      decisionHandler(.cancel, preferences)
      if action.navigationType == .linkActivated || action.targetFrame?.isMainFrame != false { handleExternal(url) }
      return
    }
    if action.targetFrame == nil {
      // target=_blank without a window: a new tab.
      decisionHandler(.cancel, preferences)
      app.tabs.open(url, after: self, isPrivate: isPrivate)
      return
    }
    if action.shouldPerformDownload {
      decisionHandler(.download, preferences)
      return
    }
    guard action.targetFrame?.isMainFrame == true else {
      decisionHandler(.allow, preferences)
      return
    }
    if app.settings.value.privacy.blockAiChatbots, Chatbots.isChatbot(url), !allowedChatbots.contains(url.host?.lowercased() ?? "") {
      decisionHandler(.cancel, preferences)
      interstitial = .chatbot(url)
      return
    }
    if let target = app.shield.redirect(for: url), target != url {
      decisionHandler(.cancel, preferences)
      webView.load(URLRequest(url: target))
      return
    }
    if let host = url.host {
      preferences.preferredContentMode = app.settings.value.desktopSites.contains { URLInput.hostMatches(host, $0) } ? .desktop : .recommended
    }
    decisionSeq += 1
    let seq = decisionSeq
    let adblock = app.adblock
    Task { @MainActor in
      // The page's cosmetics, but never more than a moment's wait.
      let cosmetics = await withTaskGroup(of: String?.self) { group -> String? in
        group.addTask { await adblock.cosmeticsJSON(for: url) }
        group.addTask {
          try? await Task.sleep(nanoseconds: 400_000_000)
          return nil
        }
        let first = await group.next() ?? nil
        group.cancelAll()
        return first
      }
      guard seq == self.decisionSeq else {
        decisionHandler(.cancel, preferences)
        return
      }
      self.prepare(for: url, cosmetics: cosmetics)
      decisionHandler(.allow, preferences)
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
    if response.isForMainFrame {
      let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
      if !response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") {
        decisionHandler(.download)
        return
      }
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    app.downloads.track(download)
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    app.downloads.track(download)
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    if case .chatbot = interstitial { return }
    interstitial = nil
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    resetPageState()
    interstitial = nil
    url = webView.url
    if !isPrivate, let u = webView.url { app.store.addVisit(url: u.absoluteString, title: webView.title ?? "", typed: typed) }
    typed = false
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if !isPrivate, let u = webView.url, let t = webView.title, !t.isEmpty { app.store.updateTitle(url: u.absoluteString, title: t) }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    fail(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    fail(error, committed: true)
  }

  private func fail(_ error: Error, committed: Bool = false) {
    let e = error as NSError
    // Cancelled loads, downloads and policy cancels are not failures.
    if e.code == NSURLErrorCancelled || (e.domain == "WebKitErrorDomain" && (e.code == 102 || e.code == 204)) { return }
    if committed { return }
    let failed = (e.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? url
    let host = failed?.host ?? "This site"
    switch e.code {
    case NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid, NSURLErrorSecureConnectionFailed:
      if let failed { interstitial = .insecure(failed, host: host) }
    case NSURLErrorNotConnectedToInternet:
      interstitial = .failed(failed, title: "You're offline", message: "Check your Wi-Fi or mobile data, then try again. Until then, enjoy being a couch potato.")
    case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed:
      interstitial = .failed(failed, title: "This site can't be reached", message: "We dug around, but couldn't find the server for \(host). Check the address for typos.")
    case NSURLErrorTimedOut:
      interstitial = .failed(failed, title: "This site can't be reached", message: "\(host) took too long to respond. Slower than a potato in a cold oven.")
    case NSURLErrorCannotConnectToHost:
      interstitial = .failed(failed, title: "This site can't be reached", message: "\(host) refused to connect. Hot potato.")
    case NSURLErrorNetworkConnectionLost:
      interstitial = .failed(failed, title: "This site can't be reached", message: "The connection to \(host) was interrupted.")
    case NSURLErrorHTTPTooManyRedirects:
      interstitial = .failed(failed, title: "This page isn't working", message: "\(host) redirected you too many times.")
    default:
      interstitial = .failed(failed, title: "This page isn't working", message: "\(host) could not be loaded. \(e.localizedDescription)")
    }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    interstitial = .crashed(webView.url ?? url)
  }

  func webView(_ webView: WKWebView, respondTo challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
    let space = challenge.protectionSpace
    if space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust {
      let host = space.host
      if let trusted = trustedCertificates[host], let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
        SecCertificateCopyData(leaf) as Data == trusted
      {
        return (.useCredential, URLCredential(trust: trust))
      }
      if !SecTrustEvaluateWithError(trust, nil), let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first {
        pendingCertificate[host] = SecCertificateCopyData(leaf) as Data
      }
      return (.performDefaultHandling, nil)
    }
    if [NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodHTTPDigest, NSURLAuthenticationMethodNTLM].contains(space.authenticationMethod) {
      guard let (user, password) = await Presenter.login(host: space.host) else { return (.cancelAuthenticationChallenge, nil) }
      return (.useCredential, URLCredential(user: user, password: password, persistence: isPrivate ? .none : .forSession))
    }
    return (.performDefaultHandling, nil)
  }
}

// MARK: - WKUIDelegate

extension Tab: WKUIDelegate {
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    // Popups and OAuth windows: a new tab that keeps its opener.
    let tab = Tab(app: app, isPrivate: isPrivate)
    configuration.userContentController = tab.controller
    let w = BrowserWebView(frame: .zero, configuration: configuration)
    tab.setUp(w)
    app.tabs.insert(tab, after: self)
    return w
  }

  func webViewDidClose(_ webView: WKWebView) {
    app.tabs.close(self)
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
    Presenter.alert(title: frame.securityOrigin.host, message: message) { completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
    Presenter.confirm(title: frame.securityOrigin.host, message: message, action: "OK") { completionHandler($0) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
    Presenter.prompt(title: frame.securityOrigin.host, message: prompt, text: defaultText) { completionHandler($0) }
  }

  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
    decisionHandler(.prompt)
  }

  func webView(_ webView: WKWebView, contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo, completionHandler: @escaping @MainActor (UIContextMenuConfiguration?) -> Void) {
    guard let link = elementInfo.linkURL, URLInput.isWeb(link) else {
      completionHandler(UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { UIMenu(children: $0) })
      return
    }
    completionHandler(UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] suggested in
      guard let self else { return UIMenu(children: suggested) }
      var actions: [UIMenuElement] = [
        UIAction(title: "Open in New Tab", image: UIImage(systemName: "plus.square.on.square")) { _ in self.app.tabs.open(link, after: self, isPrivate: self.isPrivate, background: true) },
      ]
      if !self.isPrivate {
        actions.append(UIAction(title: "Open in Private Tab", image: UIImage(systemName: "eye.slash")) { _ in self.app.tabs.open(link, after: nil, isPrivate: true) })
      }
      actions.append(UIAction(title: "Copy Link", image: UIImage(systemName: "doc.on.doc")) { _ in UIPasteboard.general.url = link })
      actions.append(UIAction(title: "Share Link", image: UIImage(systemName: "square.and.arrow.up")) { _ in Presenter.share([link]) })
      let rest = suggested.filter { el in
        guard let a = el as? UIAction else { return true }
        return !["Copy Link", "Share…", "Share...", "Open in New Tab"].contains(a.title)
      }
      return UIMenu(children: [UIMenu(options: .displayInline, children: actions)] + rest)
    })
  }
}

/// Messages from the content world (`window.webkit.messageHandlers.potato`). Page scripts cannot
/// reach this handler: it only exists in the "potato" content world.
final class ScriptHandler: NSObject, WKScriptMessageHandlerWithReply {
  weak var tab: Tab?
  init(tab: Tab) { self.tab = tab }

  @MainActor
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
    guard let tab, let body = message.body as? [String: Any], let type = body["type"] as? String else {
      replyHandler(nil, "bad message")
      return
    }
    let frame = message.frameInfo
    let frameURL = frame.request.url
    let topURL = message.webView?.url ?? tab.url
    let strings = { (v: Any?) -> [String] in ((v as? [Any]) ?? []).compactMap { $0 as? String }.filter { $0.count < 1000 } }
    switch type {
    case "config":
      replyHandler(topURL.flatMap { tab.pageConfigObject(for: $0) }, nil)
    case "shield":
      let count = min(10_000, max(0, body["count"] as? Int ?? 0))
      let features = strings(body["features"]).prefix(30).map { $0 }
      let delta = max(0, body["delta"] as? Int ?? 0)
      tab.shieldReport(frame: frame.isMainFrame ? "main" : (frameURL?.absoluteString ?? "frame"), count: count, features: features, delta: delta)
      replyHandler(nil, nil)
    case "flagsLookup":
      let keys = strings(body["keys"]).filter { $0.count < 300 }
      let localOnly = body["localOnly"] as? Bool ?? false
      Task { @MainActor in replyHandler(await tab.app.flags.lookup(keys: keys, isPrivate: tab.isPrivate, localOnly: localOnly), nil) }
    case "flagsSet":
      let keys = strings(body["keys"]).filter { $0.count < 300 }
      // "ai", "human", or null to take the vote back; `flag` is how 0.5 scripts asked.
      let vote = (body["vote"] as? String).flatMap { ["ai", "human"].contains($0) ? $0 : nil } ?? ((body["flag"] as? Bool) == true ? "ai" : nil)
      Task { @MainActor in
        do {
          replyHandler(try await tab.app.flags.set(keys: keys, vote: vote, isPrivate: tab.isPrivate), nil)
        } catch {
          replyHandler(nil, error.localizedDescription)
        }
      }
    case "flagsReport":
      guard frame.isMainFrame else { return replyHandler(nil, nil) }
      let platform = body["platform"] as? String
      tab.flags = FlagsPageState(platform: platform.flatMap { FlagPlatform.ids.contains($0) ? $0 : nil }, hidden: max(0, body["hidden"] as? Int ?? 0), labeled: max(0, body["labeled"] as? Int ?? 0))
      replyHandler(nil, nil)
    case "adblockFrame":
      guard let url = frameURL, URLInput.isWeb(url), tab.app.adblock.isEnabled(for: topURL) else { return replyHandler(NSNull(), nil) }
      Task { @MainActor in
        let json = await tab.app.adblock.engine.cosmeticsJSON(ids: tab.app.adblock.engineIds, url: url.absoluteString)
        replyHandler(try? JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed]), nil)
      }
    case "adblockDom":
      guard let url = frameURL, URLInput.isWeb(url), tab.app.adblock.isEnabled(for: topURL) else { return replyHandler("", nil) }
      let dom = body["dom"] as? [String: Any] ?? [:]
      let parsed = ["classes": strings(dom["classes"]), "ids": strings(dom["ids"]), "hrefs": strings(dom["hrefs"])]
      Task { @MainActor in replyHandler(await tab.app.adblock.domRules(url: url, dom: parsed), nil) }
    case "resources":
      guard let top = topURL else { return replyHandler(nil, nil) }
      let items = ((body["items"] as? [Any]) ?? []).prefix(500).compactMap { $0 as? [String: String] }
      let source = frameURL.flatMap { URLInput.isWeb($0) ? $0 : nil } ?? top
      Task { @MainActor in
        guard tab.app.adblock.isEnabled(for: top) else { return replyHandler(nil, nil) }
        let hosts = await tab.app.adblock.blocked(site: top, source: source, items: items, isPrivate: tab.isPrivate)
        if tab.url?.host == top.host { tab.addBlocked(hosts) }
        replyHandler(nil, nil)
      }
    default:
      replyHandler(nil, "unknown message")
    }
  }
}
