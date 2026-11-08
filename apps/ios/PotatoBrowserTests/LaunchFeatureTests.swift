import CryptoKit
import XCTest
@testable import PotatoBrowser

@MainActor
final class LaunchFeatureTests: XCTestCase {
  private func envelope(_ payload: [String: Any], key: Curve25519.Signing.PrivateKey) throws -> [String: Any] {
    let data = try JSONSerialization.data(withJSONObject: payload)
    return ["payload": String(decoding: data, as: UTF8.self), "signature": try key.signature(for: data).base64EncodedString()]
  }

  private let rules: [[String: Any]] = [
    ["id": "e2e", "site": "Test", "hosts": ["site.test"], "features": [["id": "widget", "name": "Widget", "css": ["#ai"]], ["id": "req", "name": "Requests", "block": ["/ai/answer"]]]],
  ]

  func testShieldRuleUpdatesNeedOurSignature() throws {
    let key = Curve25519.Signing.PrivateKey()
    let pub = key.publicKey.rawRepresentation.base64EncodedString()
    let payload: [String: Any] = ["format": 1, "version": 4_000_000_000, "hash": String(repeating: "a", count: 64), "rules": rules]
    let env = try envelope(payload, key: key)
    let opened = ShieldService.open(env, keys: [pub])
    XCTAssertEqual(opened?.version, 4_000_000_000)
    XCTAssertEqual(opened?.rules.map(\.id), ["e2e"])
    XCTAssertEqual(opened?.rules.first?.features.last?.block, ["/ai/answer"])
    XCTAssertTrue(opened?.json.contains("#ai") == true, "the full rules go to the pages")

    XCTAssertNil(ShieldService.open(env, keys: [Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString()]), "another key")
    var tampered = env
    tampered["payload"] = (env["payload"] as! String).replacingOccurrences(of: "Widget", with: "Gadget")
    XCTAssertNil(ShieldService.open(tampered, keys: [pub]), "a changed byte")
    XCTAssertNil(ShieldService.open(try envelope(payload.merging(["format": 2]) { $1 }, key: key), keys: [pub]), "a future format")
    let siteWide: [[String: Any]] = [["id": "x", "site": "X", "hosts": ["*"], "features": [["id": "y", "name": "Y", "block": ["google"]]]]]
    XCTAssertNil(ShieldService.open(try envelope(payload.merging(["rules": siteWide]) { $1 }, key: key), keys: [pub]), "a block without a path")
  }

  func testShieldKeepsTheAppsRulesUntilAnUpdateIsNewer() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir.appendingPathComponent("Shield"), withIntermediateDirectories: true)
    let settings = SettingsStore(directory: dir)
    let key = Curve25519.Signing.PrivateKey()
    let pub = key.publicKey.rawRepresentation.base64EncodedString()
    let fresh = ShieldService(settings: settings, directory: dir, testKeys: [pub])
    XCTAssertEqual(fresh.source, "app")
    XCTAssertNil(fresh.rulesScript)

    // A saved update newer than the app's rules is used at the next launch.
    let env = try envelope(["format": 1, "version": 4_000_000_000, "hash": String(repeating: "b", count: 64), "rules": rules], key: key)
    try JSONSerialization.data(withJSONObject: env).write(to: dir.appendingPathComponent("Shield/rules.json"))
    let updated = ShieldService(settings: settings, directory: dir, testKeys: [pub])
    XCTAssertEqual(updated.source, "update")
    XCTAssertEqual(updated.rules.map(\.id), ["e2e"])
    XCTAssertTrue(updated.rulesScript?.source.hasPrefix("window.__potatoShieldRules = [") == true)

    // An older one is not.
    let old = try envelope(["format": 1, "version": 1, "hash": String(repeating: "c", count: 64), "rules": rules], key: key)
    try JSONSerialization.data(withJSONObject: old).write(to: dir.appendingPathComponent("Shield/rules.json"))
    XCTAssertEqual(ShieldService(settings: settings, directory: dir, testKeys: [pub]).source, "app")
  }

  func testCrashReportsLeaveOutWhatCouldSingleSomeoneOut() throws {
    let payload: [String: Any] = [
      "timeStampBegin": "2026-11-08 10:00:00",
      "crashDiagnostics": [["callStackTree": ["callStacks": []], "diagnosticMetaData": ["regionFormat": "HU", "pid": 4242, "osVersion": "iPhone OS 27.0", "exceptionType": 1]]],
      "cpuExceptionDiagnostics": [["x": 1]],
    ]
    let out = try XCTUnwrap(CrashReporter.sanitized(try JSONSerialization.data(withJSONObject: payload)))
    XCTAssertEqual(out.kind, "crash")
    XCTAssertNil(out.payload["cpuExceptionDiagnostics"])
    let meta = (out.payload["crashDiagnostics"] as? [[String: Any]])?.first?["diagnosticMetaData"] as? [String: Any]
    XCTAssertNil(meta?["regionFormat"])
    XCTAssertNil(meta?["pid"])
    XCTAssertEqual(meta?["osVersion"] as? String, "iPhone OS 27.0")
    let hang = try JSONSerialization.data(withJSONObject: ["hangDiagnostics": [["callStackTree": [:]]]])
    XCTAssertEqual(CrashReporter.sanitized(hang)?.kind, "hang")
    XCTAssertNil(CrashReporter.sanitized(try JSONSerialization.data(withJSONObject: ["diskWriteExceptionDiagnostics": [["x": 1]]])))
  }

  func testSiteReportsSendOnlyTheAddress() {
    XCTAssertEqual(SiteReports.address(URL(string: "https://user:pw@www.google.com/search?q=spuds#top")!), "https://www.google.com/search?q=spuds")
    XCTAssertNil(SiteReports.address(URL(string: "file:///etc/hosts")!))
    XCTAssertNil(SiteReports.address(URL(string: "https://example.com/" + String(repeating: "a", count: 3000))!))
  }

  func testDailyCheckRunsOncePerUtcDay() {
    XCTAssertEqual(AdblockService.utcDay(0), "1970-01-01")
    XCTAssertEqual(AdblockService.utcDay(86_399), "1970-01-01")
    XCTAssertEqual(AdblockService.utcDay(86_400), "1970-01-02")
    XCTAssertEqual(AdblockService.utcDay(nil), "")
  }
}
