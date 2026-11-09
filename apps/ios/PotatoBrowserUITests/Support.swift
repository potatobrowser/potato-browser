import Network
import XCTest

/// Pages for the UI tests from a small HTTP server on 127.0.0.1 in the test runner (the simulator
/// shares the Mac's loopback, so the app and Safari reach it): no test needs the internet.
/// Every path answers with a page named after it that says how often it was loaded (`Load 2`).
final class LocalServer {
  static let shared = LocalServer()

  private let queue = DispatchQueue(label: "potato.local-server")
  private var listener: NWListener?
  private var loads: [String: Int] = [:]
  private(set) var port: UInt16 = 0

  /// `http://127.0.0.1:<port><path>`, starting the server on first use.
  func url(_ path: String) -> URL {
    if listener == nil { start() }
    return URL(string: "http://127.0.0.1:\(port)\(path)")!
  }

  private func start() {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    let listener = try! NWListener(using: params)
    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.signal() }
    }
    listener.newConnectionHandler = { [weak self] c in
      guard let self else { return }
      c.start(queue: self.queue)
      self.receive(c, buffer: Data())
    }
    listener.start(queue: queue)
    _ = ready.wait(timeout: .now() + 10)
    self.listener = listener
    port = listener.port?.rawValue ?? 0
  }

  private func receive(_ c: NWConnection, buffer: Data) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
      guard let self else { return }
      let buffer = buffer + (data ?? Data())
      guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
        if done || error != nil { c.cancel() } else { self.receive(c, buffer: buffer) }
        return
      }
      let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
      let path = head.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
      self.respond(c, path: path)
    }
  }

  private func respond(_ c: NWConnection, path: String) {
    let name = String(path.split(separator: "?").first ?? "/")
    loads[name, default: 0] += 1
    let body = name == "/favicon.ico" ? "" : Self.page(name: name, loads: loads[name]!)
    let head = "HTTP/1.1 \(body.isEmpty ? "404 Not Found" : "200 OK")\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    c.send(content: Data((head + body).utf8), completion: .contentProcessed { _ in c.cancel() })
  }

  /// A page with links to `/next`-style neighbours and a text field, tall enough to scroll.
  private static func page(name: String, loads: Int) -> String {
    """
    <!doctype html><meta name=viewport content="width=device-width"><title>\(name)</title>
    <style>body{font:22px -apple-system;margin:24px}a,input{font-size:22px;display:block;margin:20px 0}</style>
    <h1>Load \(loads)</h1><p>Page \(name)</p>
    <a href="\(name)/next">Next page</a><input id=field placeholder="Type here">
    <div style="height:1400px"></div>
    """
  }
}

extension XCTestCase {
  /// The app on a fresh profile in test mode (no first-run setup), after `steps` (TestRunner).
  func launchApp(steps: String? = nil) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-potato-fresh", "-potato-test"]
    if let steps { app.launchEnvironment["POTATO_TEST_STEPS"] = steps }
    app.launch()
    return app
  }

  /// TestRunner steps that open `paths` from the local server, each in its own tab.
  func tabSteps(_ paths: [String]) -> String {
    let steps = paths.enumerated().map { i, p in
      #"{"action":"\#(i == 0 ? "open" : "newTab")","url":"\#(LocalServer.shared.url(p))","wait":0.5}"#
    }
    return "[" + steps.joined(separator: ",") + "]"
  }

  func addressShows(_ app: XCUIApplication, containing text: String, timeout: TimeInterval = 20) -> Bool {
    waitFor(timeout) { (app.buttons["address-bar"].value as? String)?.contains(text) == true }
  }

  func waitForTabs(_ app: XCUIApplication, _ count: Int, timeout: TimeInterval = 10) -> Bool {
    // On iPad the button hides while the address field is open.
    waitFor(timeout) { app.buttons["tabs-button"].exists && app.buttons["tabs-button"].label == "Tabs, \(count) open" }
  }

  func waitFor(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return true }
      Thread.sleep(forTimeInterval: 0.25)
    }
    return condition()
  }

  /// Opens a link as another app would. iOS may ask whether to open the app; the test agrees.
  func openFromOutside(_ url: URL) {
    XCUIDevice.shared.system.open(url)
    let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
    if open.waitForExistence(timeout: 1.5) { open.tap() }
  }
}
