import XCTest
@testable import PotatoBrowser

/// The Mac app's address bar cases (apps/browser/test/unit/urls.test.ts).
final class URLInputTests: XCTestCase {
  func testURLs() {
    let cases: [(String, String)] = [
      ("example.com", "https://example.com/"),
      ("example.com/path?q=1#x", "https://example.com/path?q=1#x"),
      ("https://example.com", "https://example.com/"),
      ("http://example.com/a", "http://example.com/a"),
      ("localhost:3000", "http://localhost:3000/"),
      ("localhost", "http://localhost/"),
      ("192.168.1.10", "http://192.168.1.10/"),
      ("192.168.1.10:8080/admin", "http://192.168.1.10:8080/admin"),
      ("myhost:8080", "http://myhost:8080/"),
      ("xn--bcher-kva.example", "https://xn--bcher-kva.example/"),
      ("about:blank", "about:blank"),
      ("file:///Users/me/a.html", "file:///Users/me/a.html"),
    ]
    for (input, url) in cases {
      XCTAssertEqual(URLInput.classify(input), .url(URL(string: url)!), input)
    }
  }

  func testKeepsEscapesWhileEncodingInvalidCharacters() {
    XCTAssertEqual(URLInput.classify("data:text/html,<b>a%20b</b>"), .url(URL(string: "data:text/html,%3Cb%3Ea%20b%3C/b%3E")!))
    XCTAssertEqual(URLInput.classify("https://example.com/a%20b?q=\"x\""), .url(URL(string: "https://example.com/a%20b?q=%22x%22")!))
  }

  func testSearches() {
    for input in ["cats", "how do magnets work", "example", "foo.bar baz", "999.1.1.1", "node.js tutorial", "c++", "a..b"] {
      guard case .search = URLInput.classify(input) else { return XCTFail("\(input) should be a search") }
    }
  }

  func testForcedSearchAndEmpty() {
    XCTAssertEqual(URLInput.classify("?example.com"), .search("example.com"))
    XCTAssertNil(URLInput.classify("   "))
    XCTAssertNil(URLInput.classify("?"))
  }

  func testSearchURLs() {
    XCTAssertEqual(SearchEngine.get("duckduckgo").url(for: "a&b c")?.absoluteString, "https://noai.duckduckgo.com/?q=a%26b%20c")
    XCTAssertEqual(SearchEngine.get("google-web").url(for: "x")?.absoluteString, "https://www.google.com/search?q=x&udm=14")
    XCTAssertEqual(URLInput.resolve("cats", engine: "bing")?.absoluteString, "https://www.bing.com/search?q=cats")
    XCTAssertEqual(SearchEngine.get("nope").id, "duckduckgo")
  }

  func testQueryShownForSearchResults() {
    XCTAssertEqual(SearchEngine.get("google").query(in: URL(string: "https://www.google.com/search?q=boiled+potatoes&hl=en")!), "boiled potatoes")
    XCTAssertEqual(SearchEngine.get("duckduckgo").query(in: URL(string: "https://noai.duckduckgo.com/?q=mash")!), "mash")
    XCTAssertNil(SearchEngine.get("duckduckgo").query(in: URL(string: "https://example.com/?q=mash")!))
  }

  func testSites() {
    XCTAssertEqual(URLInput.siteKey(URL(string: "https://www.google.com/search?q=1")), "google.com")
    XCTAssertTrue(URLInput.hostMatches("mail.google.com", "google.com"))
    XCTAssertFalse(URLInput.hostMatches("notgoogle.com", "google.com"))
    XCTAssertTrue(URLInput.hostMatches("www.reddit.com", "reddit.com"))
    XCTAssertEqual(URLInput.displayHost(URL(string: "https://www.example.com/a")), "example.com")
  }
}
