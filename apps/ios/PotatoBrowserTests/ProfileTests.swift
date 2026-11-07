import XCTest
@testable import PotatoBrowser

@MainActor
final class ProfileTests: XCTestCase {
  func tempDir() -> URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
  }

  func testSettingsDefaultsAndPartialFiles() throws {
    let dir = tempDir()
    try #"{"searchEngine":"google","flags":{"mode":"hide","threshold":500},"adblock":{"trackers":false}}"#.write(to: dir.appendingPathComponent("settings.json"), atomically: true, encoding: .utf8)
    let s = SettingsStore(directory: dir).value
    XCTAssertEqual(s.searchEngine, "google")
    XCTAssertEqual(s.flags.mode, .hide)
    XCTAssertEqual(s.flags.threshold, 100, "threshold is clamped")
    XCTAssertTrue(s.flags.showButtons, "missing keys fall back to defaults")
    XCTAssertFalse(s.adblock.trackers)
    XCTAssertTrue(s.adblock.enabled)
    XCTAssertTrue(s.shield.enabled)
    XCTAssertNotNil(s.installId.range(of: "^[0-9a-f]{32}$", options: .regularExpression))
  }

  func testSettingsKeepInstallIdAndDedupeSites() {
    let store = SettingsStore(directory: tempDir())
    let id = store.value.installId
    var seen: [(Settings, Settings)] = []
    let sub = store.changes.sink { seen.append($0) }
    store.update {
      $0.installId = "00000000000000000000000000000000"
      $0.shield.disabledSites = ["Google.com", "google.com", ""]
      $0.searchEngine = "nonsense"
    }
    XCTAssertEqual(store.value.installId, id)
    XCTAssertEqual(store.value.shield.disabledSites, ["google.com"])
    XCTAssertEqual(store.value.searchEngine, "duckduckgo")
    XCTAssertEqual(seen.count, 1)
    sub.cancel()
  }

  func testHistorySuggestionsAndInlineHosts() throws {
    let store = try Store(path: tempDir().appendingPathComponent("p.sqlite").path)
    store.addVisit(url: "https://www.potatoes.org/varieties", title: "Potato varieties", typed: true)
    store.addVisit(url: "https://www.potatoes.org/varieties", title: "", typed: false)
    store.addVisit(url: "https://example.com/", title: "Example", typed: false)
    XCTAssertEqual(store.history().count, 3)
    XCTAssertEqual(store.history(matching: "varieties").count, 2)
    XCTAssertEqual(store.suggestPages("pota", limit: 5).first?.url, "https://www.potatoes.org/varieties")
    XCTAssertEqual(store.suggestPages("pota", limit: 5).first?.title, "Potato varieties", "an empty title does not replace a known one")
    XCTAssertEqual(store.inlineHost("pot"), "potatoes.org")
    XCTAssertNil(store.inlineHost("potatoes.org"))
    store.clearHistory(since: nil)
    XCTAssertTrue(store.history().isEmpty)
  }

  func testBookmarksFoldersAndOrder() throws {
    let store = try Store(path: tempDir().appendingPathComponent("p.sqlite").path)
    let folder = store.addBookmark(url: nil, title: "Recipes")
    store.addBookmark(url: "https://a.example/", title: "A", parent: folder)
    store.addBookmark(url: "https://b.example/", title: "B", parent: folder)
    store.addBookmark(url: "https://top.example/", title: "Top")
    XCTAssertEqual(store.bookmarks(in: folder).map(\.title), ["A", "B"])
    store.moveBookmarks(in: folder, from: IndexSet(integer: 1), to: 0)
    XCTAssertEqual(store.bookmarks(in: folder).map(\.title), ["B", "A"])
    XCTAssertNotNil(store.bookmarkId(for: "https://top.example/"))
    XCTAssertEqual(store.favorites(limit: 10).map(\.title), ["Top"])
    store.deleteBookmark(folder)
    XCTAssertNil(store.bookmarkId(for: "https://a.example/"), "deleting a folder deletes what is in it")
  }

  func testOwnFlagsAndStats() throws {
    let store = try Store(path: tempDir().appendingPathComponent("p.sqlite").path)
    store.setMyFlag(key: "reddit:t3_abc", hash: FlagsService.hash("reddit:t3_abc"), platform: "reddit", on: true)
    XCTAssertEqual(store.myFlags(["reddit:t3_abc", "reddit:t3_other"]), ["reddit:t3_abc"])
    XCTAssertEqual(store.myFlagCount(), 1)
    store.setMyFlag(key: "reddit:t3_abc", hash: "", platform: "reddit", on: false)
    XCTAssertEqual(store.myFlagCount(), 0)
    store.addShieldHidden(3)
    store.addAdsBlocked(5)
    store.addAdsBlocked(2)
    XCTAssertEqual(store.todayStats().shieldHidden, 3)
    XCTAssertEqual(store.todayStats().adsBlocked, 7)
  }

  func testFlagHashesMatchTheServerProtocol() {
    // Reference values from @potato/shared (sha256 of "noai-flag:v1:" + key).
    XCTAssertEqual(FlagsService.hash("reddit:t3_abc"), "4a4567c6ca7d1e8eba1ac364364cd1a28f19d92a5b39c6d4bb9e394571aea610")
    XCTAssertEqual(FlagsService.hash("x:1790000000000000000"), "63ff412d7623b6ab0d8a543d93cb8f787c23e940f70979eabc005a48e1bc0666")
    XCTAssertEqual(FlagsService.platform(of: "bluesky:did:plc:z72i7hdynmk6r22z27h6tvur/3l6oveex3ii2l"), "bluesky")
    XCTAssertNil(FlagsService.platform(of: "myspace:1"))
    XCTAssertNil(FlagsService.platform(of: "x:"))
    XCTAssertNil(FlagsService.platform(of: "nocolon"))
  }
}
