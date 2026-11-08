import XCTest

/// Links from other apps: the URL scheme and "Open in Potato" in the share sheet.
final class LinkTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  private func link(_ page: String) -> URL {
    URL(string: "potatobrowser://open?url=" + page.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)!
  }

  func testURLSchemeOpensWebPagesInANewTab() {
    let server = LocalServer.shared
    let app = launchApp(steps: tabSteps(["/first"]))
    XCTAssertTrue(addressShows(app, containing: "/first"))
    // An open panel goes away for the link.
    app.buttons["tabs-button"].tap()
    XCTAssertTrue(app.buttons["tabs-done"].waitForExistence(timeout: 5))

    openFromOutside(link(server.url("/linked").absoluteString))
    XCTAssertTrue(addressShows(app, containing: "/linked"), "the page opens")
    XCTAssertTrue(waitForTabs(app, 2), "in a new tab")
    XCTAssertFalse(app.buttons["tabs-done"].exists, "the tab switcher closed")

    // Never another scheme, and nothing malformed.
    for bad in ["javascript:alert(1)", "data:text/html,<h1>hi</h1>", "file:///etc/hosts", "not a link"] {
      openFromOutside(link(bad))
    }
    openFromOutside(URL(string: "potatobrowser://open")!)
    sleep(2)
    XCTAssertTrue(addressShows(app, containing: "/linked", timeout: 2))
    XCTAssertTrue(waitForTabs(app, 2, timeout: 2), "nothing else opened")

    // potato-http(s):// stands for the page itself, and opens it in a normal tab even from a
    // private one.
    app.buttons["menu"].tap()
    app.buttons["menu-private-tab"].tap()
    XCTAssertTrue(app.staticTexts["Private tab"].waitForExistence(timeout: 5))
    let mapped = server.url("/mapped?q=1").absoluteString.replacingOccurrences(of: "http://", with: "potato-http://")
    openFromOutside(URL(string: mapped)!)
    XCTAssertTrue(addressShows(app, containing: "/mapped?q=1"))
    XCTAssertTrue(waitForTabs(app, 3), "a third normal tab")
  }

  func testShareExtensionOpensThePageFromSafari() {
    let page = LocalServer.shared.url("/shared")
    let app = launchApp()
    XCTAssertTrue(app.buttons["address-bar"].waitForExistence(timeout: 10))

    let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    XCUIDevice.shared.system.open(page)
    XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 15), "Safari opens the page")
    XCTAssertTrue(safari.webViews.staticTexts["Page /shared"].waitForExistence(timeout: 15))
    safari.buttons["MoreMenuButton"].tap()
    safari.buttons["ShareButton"].tap()
    let potato = safari.collectionViews["activityCollectionView"].cells["Potato"]
    XCTAssertTrue(potato.waitForExistence(timeout: 10), "Potato is in the share sheet")
    potato.tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15), "the share opens Potato")
    XCTAssertTrue(addressShows(app, containing: "/shared"), "with the shared page")
    XCTAssertTrue(waitForTabs(app, 1), "in the blank tab it had")
  }
}
