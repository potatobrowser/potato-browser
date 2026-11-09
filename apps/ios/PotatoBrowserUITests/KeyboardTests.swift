import XCTest

/// Keyboard shortcuts from a hardware keyboard (iPad, or iPhone with one), with the page focused.
///
/// Unless a Mac keyboard is attached, the simulator runs its on-screen keyboard for whatever text
/// input has focus (a page counts), and that keyboard keeps some keys: Esc, Cmd+W, and on iPhone
/// Cmd+F (Safari's Cmd+W goes the same way), the first key after it goes away, and a press can
/// repeat while it slides in. A real keyboard hides it. Keys also reach the app only after a first
/// tap, and the first one after it can still be lost. So Cmd+W and Cmd+F are pressed after a tap on
/// the new tab page, with nothing focused, and each test ends with the one shortcut that opens a
/// text field.
final class KeyboardTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// A tap on the page gives the web view focus, as when reading it.
  private func focusPage(_ app: XCUIApplication) {
    app.webViews.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)).tap()
  }

  /// The app on `paths`, then a new tab whose title it taps: keys arrive, and nothing has focus.
  private func launchUnfocused(_ paths: [String]) -> XCUIApplication {
    let steps = tabSteps(paths).dropLast() + #",{"action":"newTab"}]"#
    let app = launchApp(steps: String(steps))
    let title = app.staticTexts["Potato Browser"]
    XCTAssertTrue(title.waitForExistence(timeout: 20))
    XCTAssertTrue(waitForTabs(app, paths.count + 1))
    title.tap()
    return app
  }

  /// Presses a key, and once more if it went astray (see above), until `done`.
  private func pressUntil(_ app: XCUIApplication, _ key: String, _ flags: XCUIElement.KeyModifierFlags, until done: () -> Bool) -> Bool {
    press(app, key, flags)
    if waitFor(3, done) { return true }
    press(app, key, flags)
    return waitFor(10, done)
  }

  private func press(_ app: XCUIApplication, _ key: String, _ flags: XCUIElement.KeyModifierFlags = .command) {
    app.typeKey(key, modifierFlags: flags)
  }

  private func addressEnds(_ app: XCUIApplication, with suffix: String) -> Bool {
    waitFor(10) { (app.buttons["address-bar"].value as? String)?.hasSuffix(suffix) == true }
  }

  private func tabCount(_ app: XCUIApplication) -> Int {
    let button = app.buttons["tabs-button"]
    guard button.exists else { return 0 }
    return Int(button.label.split(separator: " ").dropFirst().first ?? "") ?? 0
  }

  /// Esc closes the address field; Cancel stands in when the on-screen keyboard took the Esc.
  private func leaveAddressField(_ app: XCUIApplication) {
    let field = app.textFields["address-field"]
    if app.keyboards.count > 0 {
      app.buttons["address-cancel"].tap()
    } else {
      app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
    }
    XCTAssertTrue(waitFor(5) { !field.exists }, "Esc leaves the address field")
  }

  private func showing(_ app: XCUIApplication, _ path: String) -> () -> Bool {
    { (app.buttons["address-bar"].value as? String)?.hasSuffix(path) == true }
  }

  func testTabShortcuts() {
    // Tabs: k1, k2, and the new tab page, selected. Cmd+W closes that one, with nothing focused.
    let app = launchUnfocused(["/k1", "/k2"])
    XCTAssertTrue(pressUntil(app, "w", .command, until: { tabCount(app) == 2 }), "Cmd+W closes the tab")
    XCTAssertTrue(addressShows(app, containing: "/k2"))

    // Ctrl+Tab goes round; Cmd+1 to Cmd+8 pick a tab, Cmd+9 the last one.
    XCTAssertTrue(pressUntil(app, XCUIKeyboardKey.tab.rawValue, .control, until: showing(app, "/k1")), "Ctrl+Tab wraps around")
    XCTAssertTrue(pressUntil(app, XCUIKeyboardKey.tab.rawValue, [.control, .shift], until: showing(app, "/k2")), "Ctrl+Shift+Tab")
    XCTAssertTrue(pressUntil(app, "1", .command, until: showing(app, "/k1")), "Cmd+1")
    XCTAssertTrue(pressUntil(app, "9", .command, until: showing(app, "/k2")), "Cmd+9")

    // A tab closed in the tab switcher comes back with Shift+Cmd+T.
    app.buttons["tabs-button"].tap()
    XCTAssertTrue(app.buttons["close-tab"].firstMatch.waitForExistence(timeout: 5))
    app.buttons["close-tab"].firstMatch.tap()
    app.buttons["tabs-done"].tap()
    XCTAssertTrue(waitForTabs(app, 1))
    XCTAssertTrue(pressUntil(app, "t", [.command, .shift], until: { tabCount(app) == 2 }), "Shift+Cmd+T reopens the closed tab")
    XCTAssertTrue(addressShows(app, containing: "/k1"))
  }

  func testNewTabShortcut() {
    let app = launchApp(steps: tabSteps(["/k3"]))
    XCTAssertTrue(addressShows(app, containing: "/k3"))
    focusPage(app)
    press(app, "t")
    XCTAssertTrue(app.textFields["address-field"].waitForExistence(timeout: 5), "Cmd+T: a new tab, ready for an address")
    leaveAddressField(app)
    XCTAssertTrue(app.buttons["ntp-search"].waitForExistence(timeout: 5), "on the new tab page")
    // At least one: the press can repeat while the on-screen keyboard slides in (see above).
    XCTAssertTrue(waitFor(5) { tabCount(app) >= 2 })
  }

  func testNewPrivateTabShortcut() {
    let app = launchApp(steps: tabSteps(["/k4"]))
    XCTAssertTrue(addressShows(app, containing: "/k4"))
    focusPage(app)
    press(app, "n", [.command, .shift])
    XCTAssertTrue(app.staticTexts["Private tab"].waitForExistence(timeout: 5), "Shift+Cmd+N: a private tab")
    XCTAssertTrue(app.textFields["address-field"].waitForExistence(timeout: 5))
  }

  func testPageShortcuts() {
    let app = launchApp(steps: tabSteps(["/k5"]))
    XCTAssertTrue(app.webViews.staticTexts["Load 1"].waitForExistence(timeout: 20))
    focusPage(app)
    press(app, "r")
    XCTAssertTrue(app.webViews.staticTexts["Load 2"].waitForExistence(timeout: 10), "Cmd+R reloads")

    app.webViews.links["Next page"].tap()
    XCTAssertTrue(addressEnds(app, with: "/k5/next"))
    focusPage(app)
    press(app, "[")
    XCTAssertTrue(addressEnds(app, with: "/k5"), "Cmd+[ goes back")
    press(app, "]")
    XCTAssertTrue(addressEnds(app, with: "/k5/next"), "Cmd+] goes forward")

    press(app, "d")
    XCTAssertTrue(app.buttons["bookmark-save"].waitForExistence(timeout: 5), "Cmd+D adds a bookmark")
    app.buttons["bookmark-save"].tap()
    press(app, "d")
    XCTAssertTrue(app.staticTexts["Already in your bookmarks"].waitForExistence(timeout: 5))
  }

  func testFindShortcut() {
    let app = launchUnfocused(["/k8"])
    let page = app.webViews.staticTexts["Load 1"]
    XCTAssertTrue(pressUntil(app, XCUIKeyboardKey.tab.rawValue, [.control, .shift], until: { page.exists }))
    let find = app.searchFields["find.searchField"]
    XCTAssertTrue(pressUntil(app, "f", .command, until: { find.exists }), "Cmd+F finds on the page")
  }

  func testOpenLocationShortcut() {
    let app = launchApp(steps: tabSteps(["/k6"]))
    XCTAssertTrue(addressShows(app, containing: "/k6"))
    focusPage(app)
    press(app, "l")
    let field = app.textFields["address-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5), "Cmd+L")
    XCTAssertTrue((field.value as? String)?.hasSuffix("/k6") == true, "with the address to edit")
    field.typeText("x")
    XCTAssertEqual(field.value as? String, "x", "the address is selected, so typing replaces it")
    leaveAddressField(app)
  }

  func testShortcutsWhileTypingInThePage() {
    let app = launchApp(steps: tabSteps(["/k7"]))
    let input = app.webViews.textFields.firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 20))
    input.tap()
    press(app, "l")
    XCTAssertTrue(app.textFields["address-field"].waitForExistence(timeout: 5), "shortcuts work while typing in a page")
  }
}
