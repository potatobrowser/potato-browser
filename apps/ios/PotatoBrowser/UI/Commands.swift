import SwiftUI

/// Keyboard shortcuts, on iPad and on iPhone with a hardware keyboard. They are main menu
/// commands, so they show in the iPad menu bar and work while a page has focus (Cmd+W and Cmd+F
/// get there through BrowserWebView).
struct BrowserCommands: Commands {
  @ObservedObject var app: AppModel
  @ObservedObject var tabs: TabManager

  private var setup: Bool { app.panel == .welcome }

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Group {
        Button("New Tab") { app.newTabFromKeyboard(isPrivate: false) }
          .keyboardShortcut("t")
        Button("New Private Tab") { app.newTabFromKeyboard(isPrivate: true) }
          .keyboardShortcut("n", modifiers: [.command, .shift])
        Button("Reopen Closed Tab") { app.pageShortcut { app.tabs.reopenClosed() } }
          .keyboardShortcut("t", modifiers: [.command, .shift])
          .disabled(!tabs.canReopenClosed)
        Divider()
        Button("Open Location") { app.shortcut { app.focusAddress() } }
          .keyboardShortcut("l")
      }
      .disabled(setup)
    }
    // In place of the system's Close (Window), which wants Cmd+W too. A focused page sends Cmd+W
    // and Cmd+F through BrowserWebView instead.
    CommandGroup(replacing: .saveItem) {
      Button("Close Tab") { app.closeTabShortcut() }
        .keyboardShortcut("w")
        .disabled(setup)
    }
    CommandGroup(after: .pasteboard) {
      SelectedTabItems(tabs: tabs) { tab in
        Button("Find on Page") { app.findShortcut() }
          .keyboardShortcut("f")
          .disabled(!tab.hasPage)
      }
      .disabled(setup)
    }
    CommandGroup(before: .toolbar) {
      SelectedTabItems(tabs: tabs) { tab in
        Button("Reload Page") { app.pageShortcut { tab.reload() } }
          .keyboardShortcut("r")
          .disabled(tab.url == nil && tab.interstitial == nil)
      }
      .disabled(setup)
    }
    CommandMenu("History") {
      SelectedTabItems(tabs: tabs) { tab in
        Button("Back") { app.pageShortcut { tab.goBack() } }
          .keyboardShortcut("[")
          .disabled(!tab.canGoBack && tab.interstitial == nil)
        Button("Forward") { app.pageShortcut { tab.goForward() } }
          .keyboardShortcut("]")
          .disabled(!tab.canGoForward)
      }
      .disabled(setup)
    }
    CommandMenu("Bookmarks") {
      SelectedTabItems(tabs: tabs) { tab in
        Button("Add Bookmark") { app.shortcut { app.bookmarkPage() } }
          .keyboardShortcut("d")
          .disabled(!tab.hasPage || !URLInput.isWeb(tab.url))
      }
      .disabled(setup)
    }
    CommandMenu("Tabs") {
      Group {
        Button("Show Next Tab") { app.pageShortcut { app.tabs.selectAdjacent(1) } }
          .keyboardShortcut(.tab, modifiers: .control)
          .disabled(tabs.current.count < 2)
        Button("Show Previous Tab") { app.pageShortcut { app.tabs.selectAdjacent(-1) } }
          .keyboardShortcut(.tab, modifiers: [.control, .shift])
          .disabled(tabs.current.count < 2)
        Divider()
        ForEach(1..<9) { n in
          Button("Tab \(n)") { app.pageShortcut { app.selectTab(n - 1) } }
            .keyboardShortcut(KeyEquivalent(Character("\(n)")))
            .disabled(tabs.current.count < n)
        }
        Button("Last Tab") { app.pageShortcut { app.selectTab(app.tabs.current.count - 1) } }
          .keyboardShortcut("9")
      }
      .disabled(setup)
    }
  }
}

/// Menu items that follow the selected tab (back and forward, what the page allows).
private struct SelectedTabItems<Content: View>: View {
  @ObservedObject var tabs: TabManager
  @ViewBuilder let content: (Tab) -> Content

  var body: some View {
    if let tab = tabs.selected { Observed(tab: tab, content: content) }
  }

  private struct Observed: View {
    @ObservedObject var tab: Tab
    let content: (Tab) -> Content
    var body: some View { content(tab) }
  }
}

// MARK: - What the shortcuts do

extension AppModel {
  /// Runs a shortcut once any open sheet is out of the way (none run during the first-run setup).
  func shortcut(_ action: @escaping () -> Void) {
    guard let p = panel else {
      action()
      return
    }
    guard p != .welcome else { return }
    panel = nil
    Task { @MainActor in
      // The sheet animates away before the page or the address field can take focus.
      try? await Task.sleep(nanoseconds: 350_000_000)
      action()
    }
  }

  /// A shortcut for the page or the tabs: the address field closes too.
  func pageShortcut(_ action: @escaping () -> Void) {
    shortcut {
      self.editingAddress = false
      action()
    }
  }

  func closeTabShortcut() {
    pageShortcut { if let t = self.tabs.selected { self.tabs.close(t) } }
  }

  func findShortcut() {
    shortcut { self.findOnPage() }
  }

  func newTabFromKeyboard(isPrivate: Bool) {
    shortcut {
      self.tabs.newTab(isPrivate: isPrivate)
      self.focusAddress(clearing: true)
    }
  }

  func focusAddress(clearing: Bool = false) {
    if !editingAddress {
      editingAddress = true
    } else if clearing {
      suggestionText = ""
    }
  }

  func selectTab(_ index: Int) {
    let list = tabs.current
    if list.indices.contains(index) { tabs.select(list[index]) }
  }

  func findOnPage() {
    guard let tab = tabs.selected, tab.hasPage else { return }
    let wasEditing = editingAddress
    editingAddress = false
    Task { @MainActor in
      if wasEditing { try? await Task.sleep(nanoseconds: 300_000_000) }
      // The find bar comes with the first responder.
      tab.webView.becomeFirstResponder()
      tab.webView.findInteraction?.presentFindNavigator(showingReplace: false)
    }
  }

  func bookmarkPage() {
    guard let tab = tabs.selected, tab.hasPage, let url = tab.url, URLInput.isWeb(url) else { return }
    editingAddress = false
    if store.bookmarkId(for: url.absoluteString) != nil {
      showToast("Already in your bookmarks")
    } else {
      panel = .addBookmark
    }
  }
}
