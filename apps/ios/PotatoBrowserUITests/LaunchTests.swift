import XCTest

/// The main flows by touch, as a person would use them.
final class BrowserUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  private func launch(_ args: [String] = ["-potato-fresh"]) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = args
    app.launch()
    return app
  }

  private func waitForAddress(_ app: XCUIApplication, containing text: String, timeout: TimeInterval = 20) -> Bool {
    let bar = app.buttons["address-bar"]
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if bar.exists, (bar.value as? String)?.contains(text) == true { return true }
      Thread.sleep(forTimeInterval: 0.3)
    }
    return false
  }

  func testFirstRunWelcomeThenBrowse() {
    let app = launch()
    let start = app.buttons["start-browsing"]
    XCTAssertTrue(start.waitForExistence(timeout: 10), "the welcome screen shows on first run")
    start.tap()

    XCTAssertTrue(app.otherElements["new-tab-page"].waitForExistence(timeout: 5) || app.buttons["ntp-search"].waitForExistence(timeout: 5))
    app.buttons["ntp-search"].tap()
    let field = app.textFields["address-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("example.com\n")
    XCTAssertTrue(waitForAddress(app, containing: "example.com"), "the page opens")

    // Page protections panel.
    app.buttons["protections"].tap()
    XCTAssertTrue(app.switches["shield-site-toggle"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.switches["adblock-site-toggle"].exists)
    app.buttons["Done"].tap()

    // Menu, then Settings.
    app.buttons["menu"].tap()
    XCTAssertTrue(app.buttons["menu-settings"].waitForExistence(timeout: 5))
    app.buttons["menu-settings"].tap()
    XCTAssertTrue(app.switches["shield-global"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.switches["adblock-global"].exists)
    app.buttons["Done"].tap()
  }

  func testTabsAndPrivateTabs() {
    let app = launch(["-potato-fresh", "-potato-test"])
    let tabsButton = app.buttons["tabs-button"]
    XCTAssertTrue(tabsButton.waitForExistence(timeout: 10))
    tabsButton.tap()
    XCTAssertTrue(app.buttons["new-tab"].waitForExistence(timeout: 5))
    app.buttons["new-tab"].tap()
    let field = app.textFields["address-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("example.org\n")
    XCTAssertTrue(waitForAddress(app, containing: "example.org"))

    tabsButton.tap()
    XCTAssertEqual(app.buttons.matching(identifier: "tab-card").count, 2)
    // Private tabs live apart from the normal ones.
    app.segmentedControls["tab-mode"].buttons["Private"].tap()
    app.buttons["new-tab"].tap()
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.typeText("example.net\n")
    XCTAssertTrue(waitForAddress(app, containing: "example.net"))
    tabsButton.tap()
    XCTAssertEqual(app.buttons.matching(identifier: "tab-card").count, 1)
    app.buttons["close-tab"].firstMatch.tap()
    // Closing the last private tab goes back to the normal tabs.
    XCTAssertTrue(app.segmentedControls["tab-mode"].buttons["2 Tabs"].waitForExistence(timeout: 5) || app.buttons["address-bar"].waitForExistence(timeout: 5))
  }

  func testPopupsLinksDialogsAndBookmarks() {
    let app = launch(["-potato-fresh", "-potato-test"])
    let bar = app.buttons["address-bar"]
    XCTAssertTrue(app.buttons["ntp-search"].waitForExistence(timeout: 10))
    app.buttons["ntp-search"].tap()
    let page = "data:text/html,<meta%20name=viewport%20content='width=device-width'><style>a,button{font-size:28px;display:block;margin:24px;padding:12px}</style><title>Controls</title><button%20onclick=\"window.open('https://example.com/')\">Popup</button><a%20href='https://example.org/'%20target='_blank'>Blank%20link</a><button%20onclick=\"alert('Hello%20potato')\">Alert</button>"
    app.textFields["address-field"].typeText(page + "\n")

    // A page alert shows as a dialog.
    let alertButton = app.webViews.buttons["Alert"]
    XCTAssertTrue(alertButton.waitForExistence(timeout: 10))
    alertButton.tap()
    XCTAssertTrue(app.staticTexts["Hello potato"].waitForExistence(timeout: 5), "the page's alert shows")
    app.buttons["OK"].firstMatch.tap()

    // window.open from a tap opens a new tab.
    app.webViews.buttons["Popup"].tap()
    XCTAssertTrue(waitForAddress(app, containing: "example.com"), "the popup opens in a new tab")
    app.buttons["tabs-button"].tap()
    XCTAssertTrue(app.buttons["tab-card"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(identifier: "tab-card").count, 2)
    app.buttons.matching(identifier: "tab-card").element(boundBy: 0).tap()

    // target=_blank links too (once the tab switcher has closed).
    let link = app.webViews.links["Blank link"]
    XCTAssertTrue(link.waitForExistence(timeout: 5))
    sleep(1)
    // After a web view moves back into the window, XCUITest misjudges its elements as not
    // hittable although they are on screen; a tap at the link's position is what a person does.
    link.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    XCTAssertTrue(waitForAddress(app, containing: "example.org"))
    app.buttons["tabs-button"].tap()
    XCTAssertTrue(app.buttons["tab-card"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(identifier: "tab-card").count, 3)
    app.buttons["tabs-done"].tap()

    // Bookmark the page from the menu; the menu then offers to remove it.
    XCTAssertTrue(bar.waitForExistence(timeout: 5))
    app.buttons["menu"].tap()
    XCTAssertTrue(app.buttons["menu-add-bookmark"].waitForExistence(timeout: 5))
    app.buttons["menu-add-bookmark"].tap()
    XCTAssertTrue(app.buttons["bookmark-save"].waitForExistence(timeout: 5))
    app.buttons["bookmark-save"].tap()
    app.buttons["menu"].tap()
    XCTAssertTrue(app.buttons["Remove Bookmark"].waitForExistence(timeout: 5))
  }

  /// Regression: a web view made before the app had a window crashed on the first tap.
  func testFirstTapOnAPage() {
    let app = XCUIApplication()
    app.launchArguments = ["-potato-fresh", "-potato-test"]
    app.launchEnvironment["POTATO_TEST_STEPS"] = #"[{"action":"open","url":"https://example.com/","wait":1}]"#
    app.launch()
    let link = app.webViews.links.firstMatch
    XCTAssertTrue(link.waitForExistence(timeout: 20))
    link.tap()
    XCTAssertTrue(waitForAddress(app, containing: "iana.org"), "the link opens")
    XCTAssertEqual(app.state, .runningForeground)
  }
}
