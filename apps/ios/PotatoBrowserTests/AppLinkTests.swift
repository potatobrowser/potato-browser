import UniformTypeIdentifiers
import XCTest
@testable import PotatoBrowser

/// Links from other apps (Shared/AppLink.swift): the URL scheme and what the share extension reads.
final class AppLinkTests: XCTestCase {
  private func page(_ link: String) -> String? {
    AppLink.page(for: URL(string: link)!)?.absoluteString
  }

  func testOpenLinks() {
    XCTAssertEqual(page("potatobrowser://open?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2%23top"), "https://example.com/a?b=1&c=2#top")
    XCTAssertEqual(page("potatobrowser://open?url=http%3A%2F%2Flocalhost%3A8080%2F"), "http://localhost:8080/")
    XCTAssertEqual(page("potatobrowser://open/?url=https%3A%2F%2Fexample.com"), "https://example.com")
    XCTAssertEqual(page("POTATOBROWSER://Open?url=HTTPS%3A%2F%2FExample.com%2FPath"), "https://Example.com/Path", "schemes and the command in any case")
    XCTAssertEqual(page("potatobrowser://open?x=1&url=https%3A%2F%2Fexample.com%2F&url=https%3A%2F%2Fother.example%2F"), "https://example.com/", "the first url")
  }

  func testPageSchemes() {
    XCTAssertEqual(page("potato-https://example.com/fries?salt=1#crispy"), "https://example.com/fries?salt=1#crispy")
    XCTAssertEqual(page("potato-http://192.168.1.10:8080/admin"), "http://192.168.1.10:8080/admin")
    XCTAssertEqual(page("Potato-HTTPS://example.com/"), "https://example.com/")
    XCTAssertEqual(page("https://example.com/"), "https://example.com/", "web links, for when the app may be the default browser")
  }

  func testOnlyWebPagesOpen() {
    let refused = [
      "potatobrowser://open?url=javascript%3Aalert(1)",
      "potatobrowser://open?url=JavaScript%3Aalert(document.cookie)",
      "potatobrowser://open?url=data%3Atext%2Fhtml%2C%3Ch1%3Ehi%3C%2Fh1%3E",
      "potatobrowser://open?url=file%3A%2F%2F%2Fetc%2Fhosts",
      "potatobrowser://open?url=about%3Ablank",
      "potatobrowser://open?url=mailto%3Aspud%40example.com",
      "potatobrowser://open?url=potato-https%3A%2F%2Fexample.com%2F",
      "potatobrowser://open?url=potatobrowser%3A%2F%2Fopen%3Furl%3Dhttps%253A%252F%252Fexample.com",
      "potatobrowser://open?url=https%3A%2F%2F",
      "potatobrowser://open?url=https%3A%2F%2F%2Fpath",
      "potatobrowser://open?url=example.com",
      "potatobrowser://open?url=",
      "potatobrowser://open",
      "potatobrowser://settings?url=https%3A%2F%2Fexample.com",
      "potatobrowser://open/elsewhere?url=https%3A%2F%2Fexample.com",
      "potato-https:example.com",
      "potato-https:///nohost",
      "potato-ftp://example.com/",
      "ftp://example.com/",
      "javascript:alert(1)",
      "file:///etc/hosts",
    ]
    for link in refused {
      XCTAssertNil(page(link), link)
    }
  }

  func testLinkForTheShareExtension() throws {
    let pages = ["https://example.com/", "https://example.com/a%20b?q=1&r=a+b#x", "http://localhost:3000/path?x=%26", "https://xn--bcher-kva.example/"]
    for p in pages {
      let link = try XCTUnwrap(AppLink.link(opening: URL(string: p)!))
      XCTAssertEqual(link.scheme, "potatobrowser")
      XCTAssertEqual(AppLink.page(for: link)?.absoluteString, p, "\(p) survives the trip")
    }
    XCTAssertEqual(AppLink.link(opening: URL(string: "https://example.com/?a=1&b=2")!)?.absoluteString, "potatobrowser://open?url=https%3A%2F%2Fexample%2Ecom%2F%3Fa%3D1%26b%3D2")
    XCTAssertNil(AppLink.link(opening: URL(string: "javascript:alert(1)")!))
    XCTAssertNil(AppLink.link(opening: URL(string: "file:///tmp/a.html")!))
  }

  func testFirstPageInText() {
    XCTAssertEqual(AppLink.firstPage(in: "Look at https://example.com/a?b=1 and weep")?.absoluteString, "https://example.com/a?b=1")
    XCTAssertEqual(AppLink.firstPage(in: "Fries at example.com/potatoes.")?.absoluteString, "https://example.com/potatoes", "bare hosts get https")
    XCTAssertEqual(AppLink.firstPage(in: "Old school: http://example.com/")?.absoluteString, "http://example.com/", "an explicit http stays")
    XCTAssertEqual(AppLink.firstPage(in: "Mail spud@example.com or see https://b.example/")?.absoluteString, "https://b.example/", "not the email address")
    XCTAssertNil(AppLink.firstPage(in: "spud@example.com"))
    XCTAssertNil(AppLink.firstPage(in: "No links in this sack"))
    XCTAssertNil(AppLink.firstPage(in: ""))
  }

  // MARK: Share extension input

  private func item(_ providers: [NSItemProvider], text: String? = nil) -> NSExtensionItem {
    let item = NSExtensionItem()
    item.attachments = providers
    if let text { item.attributedContentText = NSAttributedString(string: text) }
    return item
  }

  private func provider(_ value: NSSecureCoding, _ type: UTType) -> NSItemProvider {
    NSItemProvider(item: value, typeIdentifier: type.identifier)
  }

  func testSharedURLsAndWebPages() async {
    // Safari shares the page as a URL, next to its title.
    let safari = item([provider(URL(string: "https://example.com/story")! as NSURL, .url), provider("A story" as NSString, .plainText)])
    let page = await SharedLink.page(in: [safari])
    XCTAssertEqual(page?.absoluteString, "https://example.com/story")
    // Some apps register the URL as a string, or as data.
    let asString = await SharedLink.page(in: [item([provider(" https://example.com/s " as NSString, .url)])])
    XCTAssertEqual(asString?.absoluteString, "https://example.com/s")
    let asData = await SharedLink.page(in: [item([provider(Data("https://example.com/d".utf8) as NSData, .url)])])
    XCTAssertEqual(asData?.absoluteString, "https://example.com/d")
  }

  func testSharedTextWithALink() async {
    let text = await SharedLink.page(in: [item([provider("Try this: example.com/mash, so good" as NSString, .plainText)])])
    XCTAssertEqual(text?.absoluteString, "https://example.com/mash")
    let caption = await SharedLink.page(in: [item([], text: "Caption with https://example.com/c")])
    XCTAssertEqual(caption?.absoluteString, "https://example.com/c")
  }

  func testSharesWithoutAWebPage() async {
    let file = await SharedLink.page(in: [item([provider(URL(fileURLWithPath: "/tmp/fries.html") as NSURL, .fileURL)])])
    XCTAssertNil(file)
    let mail = await SharedLink.page(in: [item([provider(URL(string: "mailto:spud@example.com")! as NSURL, .url)])])
    XCTAssertNil(mail)
    let words = await SharedLink.page(in: [item([provider("just words" as NSString, .plainText)])])
    XCTAssertNil(words)
    let nothing = await SharedLink.page(in: [])
    XCTAssertNil(nothing)
    // A file URL first does not hide a web page in the text after it.
    let both = await SharedLink.page(in: [item([provider(URL(fileURLWithPath: "/tmp/a") as NSURL, .fileURL), provider("see https://example.com/b" as NSString, .plainText)])])
    XCTAssertEqual(both?.absoluteString, "https://example.com/b")
  }
}
