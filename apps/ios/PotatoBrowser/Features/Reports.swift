import Foundation
import MetricKit

/// "Report this site" in the protections panel: the page address and the choice, with the app's
/// version, sent to potatobrowser.com. Nothing else.
enum SiteReports {
  static let features = ["shield", "adblock"]
  static let problems = ["showing", "broken"]

  /// What is sent as the address: http(s) only, without fragment or credentials.
  static func address(_ url: URL) -> String? {
    guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false), ["http", "https"].contains(c.scheme?.lowercased() ?? "") else { return nil }
    c.fragment = nil
    c.user = nil
    c.password = nil
    guard let s = c.url?.absoluteString, s.count <= 2048 else { return nil }
    return s
  }

  static func send(_ url: URL, feature: String, problem: String, apiBase: URL) async -> Bool {
    guard let address = address(url), features.contains(feature), problems.contains(problem) else { return false }
    var req = URLRequest(url: apiBase.appendingPathComponent("api/v1/reports"))
    req.httpMethod = "POST"
    req.timeoutInterval = 15
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["url": address, "feature": feature, "problem": problem, "app": "ios", "version": Bundle.main.marketingVersion])
    guard let (_, res) = try? await URLSession(configuration: .ephemeral).data(for: req) else { return false }
    return (res as? HTTPURLResponse)?.statusCode == 200
  }
}

/// Opt-in crash reports: MetricKit hands the app its crash and hang diagnostics (on the launch after a
/// crash), and while the user has opted in each payload goes to potatobrowser.com, kept 90 days.
final class CrashReporter: NSObject, MXMetricManagerSubscriber {
  private let enabled: @MainActor () -> Bool
  private let apiBase: URL

  init(apiBase: URL, enabled: @escaping @MainActor () -> Bool) {
    self.apiBase = apiBase
    self.enabled = enabled
    super.init()
    MXMetricManager.shared.add(self)
  }

  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    let docs = payloads.map { $0.jsonRepresentation() }
    Task { @MainActor in
      guard enabled() else { return }
      for d in docs { _ = await upload(d) }
    }
  }

  /// Crash and hang diagnostics only, at most a few of each, without the region format and pid.
  static func sanitized(_ json: Data) -> (kind: String, payload: [String: Any])? {
    guard let doc = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return nil }
    var out: [String: Any] = [:]
    for key in ["timeStampBegin", "timeStampEnd"] { out[key] = doc[key] }
    for key in ["crashDiagnostics", "hangDiagnostics"] {
      guard let list = doc[key] as? [[String: Any]], !list.isEmpty else { continue }
      out[key] = list.prefix(10).map(scrub)
    }
    let kind = out["crashDiagnostics"] != nil ? "crash" : out["hangDiagnostics"] != nil ? "hang" : nil
    return kind.map { ($0, out) }
  }

  private static func scrub(_ d: [String: Any]) -> [String: Any] {
    var d = d
    if var meta = d["diagnosticMetaData"] as? [String: Any] {
      meta["regionFormat"] = nil
      meta["pid"] = nil
      d["diagnosticMetaData"] = meta
    }
    return d
  }

  /// Sends one MetricKit payload (its JSON); true when the service took it.
  @discardableResult
  func upload(_ json: Data) async -> Bool {
    guard let (kind, payload) = Self.sanitized(json),
      let body = try? JSONSerialization.data(withJSONObject: ["app": "ios", "version": Bundle.main.marketingVersion, "kind": kind, "payload": payload]),
      body.count < 1_000_000
    else { return false }
    var req = URLRequest(url: apiBase.appendingPathComponent("api/v1/crashes/ios"))
    req.httpMethod = "POST"
    req.timeoutInterval = 30
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.httpBody = body
    guard let (_, res) = try? await URLSession(configuration: .ephemeral).data(for: req) else { return false }
    return (res as? HTTPURLResponse)?.statusCode == 200
  }
}
