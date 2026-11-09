import XCTest

/// Pull to refresh, and swiping the address bar between tabs.
final class GestureTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// The page's load count (`Load 3`), from the local server.
  private func loads(_ app: XCUIApplication) -> Int? {
    let text = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Load '")).firstMatch
    guard text.waitForExistence(timeout: 20) else { return nil }
    return Int(text.label.dropFirst(5))
  }

  private func pull(_ app: XCUIApplication) {
    let web = app.webViews.firstMatch
    let start = web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
    start.press(forDuration: 0.1, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)), withVelocity: .slow, thenHoldForDuration: 0.3)
  }

  func testPullToRefreshReloadsThePage() throws {
    let app = launchApp(steps: tabSteps(["/pull"]))
    let first = try XCTUnwrap(loads(app))
    pull(app)
    XCTAssertTrue(app.webViews.staticTexts["Load \(first + 1)"].waitForExistence(timeout: 10), "pulling down reloads")
    // The spinner went with the load, so the next pull reloads again.
    pull(app)
    XCTAssertTrue(app.webViews.staticTexts["Load \(first + 2)"].waitForExistence(timeout: 10))
  }

  func testSwipingTheAddressBarSwitchesTabs() {
    let app = launchApp(steps: tabSteps(["/one", "/two", "/three"]))
    let bar = app.buttons["address-bar"]
    XCTAssertTrue(addressShows(app, containing: "/three"))
    XCTAssertTrue(waitForTabs(app, 3))

    bar.swipeRight()
    XCTAssertTrue(addressShows(app, containing: "/two"), "right goes to the tab before")
    bar.swipeRight()
    XCTAssertTrue(addressShows(app, containing: "/one"))
    bar.swipeRight()
    sleep(1)
    XCTAssertTrue(addressShows(app, containing: "/one", timeout: 1), "nothing before the first tab")
    bar.swipeLeft()
    XCTAssertTrue(addressShows(app, containing: "/two"), "left goes to the tab after")

    // A tap still edits the address.
    bar.tap()
    XCTAssertTrue(app.textFields["address-field"].waitForExistence(timeout: 5))
    app.buttons["address-cancel"].tap()

    // Past the last tab comes a new one, as in Safari, but never a second empty one.
    bar.swipeLeft()
    XCTAssertTrue(addressShows(app, containing: "/three"))
    bar.swipeLeft()
    XCTAssertTrue(waitForTabs(app, 4), "a new tab after the last")
    XCTAssertTrue(app.buttons["ntp-search"].waitForExistence(timeout: 5))
    bar.swipeLeft()
    sleep(1)
    XCTAssertTrue(waitForTabs(app, 4, timeout: 1))
    bar.swipeRight()
    XCTAssertTrue(addressShows(app, containing: "/three"), "and back")
  }
}
