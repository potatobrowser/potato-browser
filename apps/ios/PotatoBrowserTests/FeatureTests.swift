import JavaScriptCore
import WebKit
import XCTest
@testable import PotatoBrowser

@MainActor
final class FeatureTests: XCTestCase {
  func store() -> SettingsStore {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return SettingsStore(directory: d)
  }

  func testShieldMatchesHostsLikeTheMacApp() {
    let shield = ShieldService(settings: store())
    XCTAssertFalse(shield.rules.isEmpty)
    XCTAssertTrue(shield.hostMatches("www.google.de", "google.*"))
    XCTAssertTrue(shield.hostMatches("google.co.uk", "google.*"))
    XCTAssertFalse(shield.hostMatches("google.evil.com", "google.*"))
    XCTAssertTrue(shield.hostMatches("old.reddit.com", "*.reddit.com"))
    XCTAssertTrue(shield.isSupported(URL(string: "https://www.google.com/search?q=1")))
    XCTAssertFalse(shield.isSupported(URL(string: "https://example.com/")))
  }

  func testAIModeRedirectAndPerSiteSwitch() {
    let settings = store()
    let shield = ShieldService(settings: settings)
    XCTAssertEqual(shield.redirect(for: URL(string: "https://www.google.com/search?q=cats&udm=50&aep=1")!)?.absoluteString, "https://www.google.com/search?q=cats")
    XCTAssertEqual(shield.redirect(for: URL(string: "https://www.google.com/ai")!)?.absoluteString, "https://www.google.com/")
    XCTAssertNil(shield.redirect(for: URL(string: "https://www.google.com/search?q=cats")!))
    shield.setSite(URL(string: "https://www.google.com/")!, enabled: false)
    XCTAssertEqual(settings.value.shield.disabledSites, ["google.com"])
    XCTAssertNil(shield.redirect(for: URL(string: "https://www.google.com/search?q=cats&udm=50")!))
    XCTAssertFalse(shield.isEnabled(for: URL(string: "https://mail.google.com/")))
    shield.setSite(URL(string: "https://www.google.com/")!, enabled: true)
    XCTAssertTrue(settings.value.shield.disabledSites.isEmpty)
  }

  func testChatbots() {
    XCTAssertTrue(Chatbots.isChatbot(URL(string: "https://chatgpt.com/c/1")!))
    XCTAssertTrue(Chatbots.isChatbot(URL(string: "https://huggingface.co/chat/")!))
    XCTAssertFalse(Chatbots.isChatbot(URL(string: "https://huggingface.co/models")!))
    XCTAssertFalse(Chatbots.isChatbot(URL(string: "https://notclaude.ai.example.com/")!))
  }

  func testImportsBookmarkHTMLAndSafariHistory() throws {
    let html = """
      <!DOCTYPE NETSCAPE-Bookmark-file-1>
      <TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
      <DL><p>
        <DT><H3>Favourites</H3>
        <DL><p>
          <DT><A HREF="https://potatoes.org/" ADD_DATE="1">Potatoes &amp; more</A>
          <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
        </DL><p>
        <DT><A HREF="https://example.com/">Example</A>
      </DL><p>
      """
    let parsed = Importer.parseBookmarks(html)
    XCTAssertEqual(parsed.count, 2)
    XCTAssertEqual(parsed[0].title, "Favourites")
    XCTAssertEqual(parsed[0].children.map(\.title), ["Potatoes & more"], "only web links are imported")
    XCTAssertEqual(parsed[1].url, "https://example.com/")

    let d = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    let db = try Store(path: d.appendingPathComponent("p.sqlite").path)
    XCTAssertEqual(Importer.importBookmarks(html, into: db, folderTitle: "Imported"), 2)
    let history = #"{"metadata":{"browser_name":"Safari"},"history":[{"url":"https://potatoes.org/mash","title":"Mash","time_usec":1700000000000000,"visit_count":3}]}"#
    XCTAssertEqual(Importer.importHistory(Data(history.utf8), into: db), 1)
    XCTAssertEqual(db.history(matching: "mash").first?.title, "Mash")
  }

  func testUnzipsStoredAndDeflatedEntries() throws {
    // A ZIP made by `zip` with one stored and one deflated file.
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let zipPath = Bundle(for: Self.self).url(forResource: "sample", withExtension: "zip")
    guard let zipPath else { throw XCTSkip("no sample.zip in the test bundle") }
    let files = Importer.unzip(try Data(contentsOf: zipPath))
    XCTAssertEqual(Set(files.map(\.0)), ["Bookmarks.html", "History.json"])
    XCTAssertTrue(String(decoding: files.first { $0.0 == "History.json" }!.1, as: UTF8.self).contains("potatoes.org"))
  }

  /// Every rule list the app ships compiles in this device's WebKit.
  func testShippedRuleListsCompile() async throws {
    let store = WKContentRuleListStore(url: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true))!
    for g in WebResources.manifest.groups {
      let json = try XCTUnwrap(WebResources.inflatedText("rules/\(g.id).json.z"))
      let list = try await store.compileContentRuleList(forIdentifier: g.id, encodedContentRuleList: json)
      XCTAssertEqual(list?.identifier, g.id)
    }
  }

  /// The ad blocker engine in JavaScriptCore: cosmetics, scriptlets and the blocked check.
  func testEngine() async throws {
    let engine = EngineHost()
    await engine.start()
    for id in ["ads", "trackers"] {
      let n = await engine.load(id: id, data: try Data(contentsOf: WebResources.url("engines/\(id).bin")))
      XCTAssertGreaterThan(n, 10_000, id)
    }
    let yt = await engine.cosmeticsJSON(ids: ["ads", "trackers"], url: "https://www.youtube.com/watch?v=1")
    let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(yt.utf8)) as? [String: Any])
    XCTAssertGreaterThan((obj["scripts"] as? [String])?.count ?? 0, 5, "YouTube gets uBlock's scriptlets")
    let blocked = await engine.blocked(ids: ["ads", "trackers"], source: "https://news.example/", items: [
      ["url": "https://securepubads.g.doubleclick.net/tag/js/gpt.js", "type": "script"],
      ["url": "https://news.example/app.js", "type": "script"],
    ])
    XCTAssertEqual(blocked, ["securepubads.g.doubleclick.net"])
    let custom = await engine.ruleLists(groups: [], custom: "||ads.example^\n@@||ads.example/ok.js")
    XCTAssertEqual(custom["custom"]?.rules, 3, "the block, its exception and the top document allow")
  }
}
