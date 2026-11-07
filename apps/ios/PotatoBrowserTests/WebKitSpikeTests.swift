import JavaScriptCore
import WebKit
import XCTest

/// Answers the WebKit questions the iOS design depends on. Needs test/support/spike-server.mjs
/// on 127.0.0.1:8791 for the network tests (skipped when it is not running).
@MainActor
final class WebKitSpikeTests: XCTestCase {
  static let base = "http://127.0.0.1:8791"

  var resources: URL { Bundle.main.url(forResource: "WebResources", withExtension: nil)! }

  func inflate(_ url: URL) throws -> String {
    let data = try (Data(contentsOf: url) as NSData).decompressed(using: .zlib) as Data
    return String(decoding: data, as: UTF8.self)
  }

  func compile(_ id: String, _ json: String) async throws -> WKContentRuleList {
    try await withCheckedThrowingContinuation { cont in
      WKContentRuleListStore.default().compileContentRuleList(forIdentifier: id, encodedContentRuleList: json) { list, error in
        if let list { cont.resume(returning: list) } else { cont.resume(throwing: error ?? NSError(domain: "compile", code: 1)) }
      }
    }
  }

  func serverUp() async -> Bool {
    guard let url = URL(string: Self.base + "/plain.html") else { return false }
    return (try? await URLSession.shared.data(from: url)) != nil
  }

  func testShippedRuleListsCompile() async throws {
    for id in ["ads", "trackers", "cookies", "annoyances"] {
      let json = try inflate(resources.appendingPathComponent("rules/\(id).json.z"))
      let start = Date()
      _ = try await compile("spike-\(id)", json)
      print("SPIKE compile \(id): \(String(format: "%.2f", Date().timeIntervalSince(start))) s, \(json.count) bytes")
    }
  }

  final class Loader: NSObject, WKNavigationDelegate {
    var done: CheckedContinuation<Void, Never>?
    var onDecide: ((WKWebView, WKNavigationAction) -> Void)?
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
      if action.targetFrame?.isMainFrame ?? true { onDecide?(webView, action) }
      decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done?.resume(); done = nil }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { done?.resume(); done = nil }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { done?.resume(); done = nil }
  }

  func load(_ web: WKWebView, _ loader: Loader, _ url: String) async {
    await withCheckedContinuation { cont in
      loader.done = cont
      web.load(URLRequest(url: URL(string: url)!))
    }
  }

  func waitFor(_ web: WKWebView, _ js: String, world: WKContentWorld = .page, timeout: TimeInterval = 5) async -> Any? {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if let v = try? await web.evaluateJavaScript(js, in: nil, contentWorld: world), !(v is NSNull) { return v }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    return nil
  }

  /// Redirect to a data: stand-in, modify-headers on requests and responses, in an app's rule list.
  func testRedirectAndHeaders() async throws {
    guard await serverUp() else { throw XCTSkip("spike server not running") }
    let standIn = "data:application/javascript;base64," + Data("window.standInRan = true;".utf8).base64EncodedString()
    let rules = """
    [
      {"trigger":{"url-filter":"/blocked\\\\.js"},"action":{"type":"block"}},
      {"trigger":{"url-filter":"/redirected\\\\.js","resource-type":["script"]},"action":{"type":"redirect","redirect":{"url":"\(standIn)"}}},
      {"trigger":{"url-filter":".*"},"action":{"type":"modify-headers","priority":1,"request-headers":[{"operation":"set","header":"Sec-GPC","value":"1"}]}},
      {"trigger":{"url-filter":"/csp\\\\.html","resource-type":["document"]},"action":{"type":"modify-headers","priority":1,"response-headers":[{"operation":"append","header":"Content-Security-Policy","value":"script-src 'none'"}]}}
    ]
    """
    let list = try await compile("spike-actions", rules)
    let config = WKWebViewConfiguration()
    config.userContentController.add(list)
    let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 600), configuration: config)
    let loader = Loader()
    web.navigationDelegate = loader
    await load(web, loader, Self.base + "/spike.html")
    let results = await waitFor(web, "window.results && window.results.done ? JSON.stringify(window.results) : null")
    print("SPIKE actions: \(results ?? "timeout")")
    await load(web, loader, Self.base + "/csp.html")
    let inline = try? await web.evaluateJavaScript("String(!!window.inlineRan)")
    print("SPIKE csp response header applied: \((inline as? String) == "false")")
  }

  /// Redirect targets: an http URL, a query transform, a custom scheme.
  func testRedirectVariants() async throws {
    guard await serverUp() else { throw XCTSkip("spike server not running") }
    for (name, action) in [
      ("http", "{\"type\":\"redirect\",\"redirect\":{\"url\":\"\(Self.base)/blocked.js\"}}"),
      ("transform", "{\"type\":\"redirect\",\"redirect\":{\"transform\":{\"path\":\"/blocked.js\"}}}"),
      ("regex", "{\"type\":\"redirect\",\"redirect\":{\"regex-substitution\":\"\\\\1blocked.js\"}}"),
    ] {
      let rules = "[{\"trigger\":{\"url-filter\":\"^(.*)redirected\\\\.js\"},\"action\":\(action)}]"
      do {
        let list = try await compile("spike-redirect-\(name)", rules)
        let config = WKWebViewConfiguration()
        config.userContentController.add(list)
        let web = WKWebView(frame: .zero, configuration: config)
        let loader = Loader()
        web.navigationDelegate = loader
        await load(web, loader, Self.base + "/spike.html")
        let results = await waitFor(web, "window.results && window.results.done ? JSON.stringify(window.results) : null")
        print("SPIKE redirect \(name): \(results ?? "timeout")")
      } catch {
        print("SPIKE redirect \(name): compile error \(error)")
      }
    }
  }

  /// User scripts added while a main-frame navigation waits for its policy apply to that page.
  func testUserScriptAddedInPolicyDecision() async throws {
    guard await serverUp() else { throw XCTSkip("spike server not running") }
    let config = WKWebViewConfiguration()
    let web = WKWebView(frame: .zero, configuration: config)
    let loader = Loader()
    var n = 0
    loader.onDecide = { web, action in
      n += 1
      let controller = web.configuration.userContentController
      controller.removeAllUserScripts()
      controller.addUserScript(WKUserScript(source: "window.navMark = \(n);", injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
    }
    web.navigationDelegate = loader
    await load(web, loader, Self.base + "/plain.html")
    let first = try? await web.evaluateJavaScript("String(window.navMark)")
    await load(web, loader, "http://localhost:8791/plain.html")
    let second = try? await web.evaluateJavaScript("String(window.navMark)")
    print("SPIKE per-navigation scripts: first=\(first ?? "nil") second=\(second ?? "nil") decisions=\(n)")
    XCTAssertEqual(first as? String, "1")
    XCTAssertEqual(second as? String, "2")
  }

  /// Which AI and speech globals iOS WebKit exposes, in a window and in a worker.
  func testAIGlobals() async throws {
    let names = ["LanguageModel", "Summarizer", "Writer", "Rewriter", "Proofreader", "Translator", "LanguageDetector", "Classifier", "ai", "SpeechRecognition", "webkitSpeechRecognition", "SpeechSynthesis", "speechSynthesis", "FaceDetector", "TextDetector", "BarcodeDetector"]
    let config = WKWebViewConfiguration()
    let web = WKWebView(frame: .zero, configuration: config)
    let loader = Loader()
    web.navigationDelegate = loader
    let html = "<!doctype html><title>t</title>"
    await withCheckedContinuation { cont in
      loader.done = cont
      web.loadHTMLString(html, baseURL: URL(string: "https://example.com/"))
    }
    let list = names.map { "'\($0)'" }.joined(separator: ",")
    let window = try await web.evaluateJavaScript("JSON.stringify([\(list)].filter(n => n in window).concat(('ml' in navigator) ? ['navigator.ml'] : []))")
    let worker = try await web.callAsyncJavaScript("""
      const src = 'postMessage([' + \(list.debugDescription) + '].filter(n => n in self))';
      const w = new Worker(URL.createObjectURL(new Blob([src], {type: 'text/javascript'})));
      return await new Promise(r => { w.onmessage = e => r(JSON.stringify(e.data)); w.onerror = e => r('error ' + e.message); setTimeout(() => r('timeout'), 3000); });
    """, contentWorld: .page)
    let speech = try await web.callAsyncJavaScript("""
      const C = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!C) return 'absent';
      const r = new C();
      return await new Promise(res => { r.onerror = e => res('error:' + e.error); r.onstart = () => res('started'); try { r.start(); } catch (e) { res('throw:' + e); } setTimeout(() => res('timeout'), 3000); });
    """, contentWorld: .page)
    print("SPIKE ai globals window=\(window ?? "nil") worker=\(worker ?? "nil") speech=\(speech ?? "nil")")
  }

  /// The ad blocker engine in JavaScriptCore: load time and query time.
  func testEngineInJavaScriptCore() throws {
    let ctx = JSContext()!
    var errors: [String] = []
    ctx.exceptionHandler = { _, e in errors.append(e?.toString() ?? "?") }
    let js = try String(contentsOf: resources.appendingPathComponent("js/engine.js"), encoding: .utf8)
    var t = Date()
    ctx.evaluateScript(js)
    print("SPIKE engine.js evaluated in \(String(format: "%.3f", Date().timeIntervalSince(t))) s, errors: \(errors)")
    let api = ctx.objectForKeyedSubscript("PotatoEngine")!
    for id in ["ads", "trackers"] {
      let data = try Data(contentsOf: resources.appendingPathComponent("engines/\(id).bin"))
      t = Date()
      let bytes = typedArray(ctx, data)
      let n = api.invokeMethod("load", withArguments: [id, bytes!])
      print("SPIKE load \(id): \(n?.toInt32() ?? -1) filters in \(String(format: "%.3f", Date().timeIntervalSince(t))) s, errors: \(errors)")
    }
    for url in ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.theguardian.com/world", "https://www.google.com/search?q=potato"] {
      t = Date()
      let r = api.invokeMethod("cosmetics", withArguments: [["ads", "trackers"], url])
      let obj = r?.toDictionary() ?? [:]
      let styles = (obj["styles"] as? String)?.count ?? 0
      let scripts = (obj["scripts"] as? [String])?.count ?? 0
      let extended = (obj["extended"] as? [Any])?.count ?? 0
      print("SPIKE cosmetics \(url): styles \(styles) chars, \(scripts) scriptlets, \(extended) procedural in \(String(format: "%.4f", Date().timeIntervalSince(t))) s")
    }
    t = Date()
    let items: [[String: String]] = [
      ["url": "https://securepubads.g.doubleclick.net/tag/js/gpt.js", "type": "script"],
      ["url": "https://www.google-analytics.com/analytics.js", "type": "script"],
      ["url": "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "type": "script"],
      ["url": "https://www.theguardian.com/static/main.js", "type": "script"],
    ]
    let blocked = api.invokeMethod("blocked", withArguments: [["ads", "trackers"], "https://www.theguardian.com/world", items])
    print("SPIKE blocked: \(blocked?.toArray() ?? []) in \(String(format: "%.4f", Date().timeIntervalSince(t))) s, errors: \(errors)")
    XCTAssertTrue(errors.isEmpty)
  }

  func typedArray(_ ctx: JSContext, _ data: Data) -> JSValue? {
    let count = data.count
    let ptr = UnsafeMutableRawPointer.allocate(byteCount: count, alignment: 8)
    data.copyBytes(to: ptr.assumingMemoryBound(to: UInt8.self), count: count)
    var exception: JSValueRef?
    let ref = JSObjectMakeTypedArrayWithBytesNoCopy(ctx.jsGlobalContextRef, kJSTypedArrayTypeUint8Array, ptr, count, { bytes, _ in bytes?.deallocate() }, nil, &exception)
    return ref.map { JSValue(jsValueRef: $0, in: ctx) }
  }
}
