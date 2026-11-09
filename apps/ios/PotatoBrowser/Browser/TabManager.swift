import Combine
import SwiftUI
import WebKit

/// Normal and private tabs, the selected one, recently closed tabs and the saved session.
@MainActor
final class TabManager: ObservableObject {
  unowned let app: AppModel
  @Published private(set) var tabs: [Tab] = []
  @Published private(set) var privateTabs: [Tab] = []
  @Published private(set) var selectedID: UUID?
  @Published var privateMode = false
  private var normalSelection: UUID?
  private var privateSelection: UUID?
  private var closed: [(url: URL, title: String)] = []
  private var bag = Set<AnyCancellable>()
  private var sessionURL: URL { app.directory.appendingPathComponent("session.json") }

  init(app: AppModel) {
    self.app = app
    restore()
    if tabs.isEmpty { newTab(select: true) }
  }

  var current: [Tab] { privateMode ? privateTabs : tabs }
  var selected: Tab? { (privateMode ? privateTabs : tabs).first { $0.id == selectedID } }
  var canReopenClosed: Bool { !closed.isEmpty }

  // MARK: Opening and closing

  @discardableResult
  func newTab(url: URL? = nil, isPrivate: Bool? = nil, select: Bool = true) -> Tab {
    let priv = isPrivate ?? privateMode
    let tab = Tab(app: app, isPrivate: priv, url: url)
    if priv { privateTabs.append(tab) } else { tabs.append(tab) }
    watch(tab)
    if select { self.select(tab) }
    if let url { tab.load(url) }
    save()
    return tab
  }

  func open(_ url: URL, after opener: Tab?, isPrivate: Bool, background: Bool = false) {
    let tab = Tab(app: app, isPrivate: isPrivate, url: nil)
    insert(tab, after: opener?.isPrivate == isPrivate ? opener : nil, select: !background)
    tab.load(url)
    if background { app.showToast("Opened in a new tab") }
  }

  func insert(_ tab: Tab, after opener: Tab?, select: Bool = true) {
    if tab.isPrivate {
      let i = opener.flatMap { o in privateTabs.firstIndex { $0 === o } }.map { $0 + 1 } ?? privateTabs.count
      privateTabs.insert(tab, at: i)
    } else {
      let i = opener.flatMap { o in tabs.firstIndex { $0 === o } }.map { $0 + 1 } ?? tabs.count
      tabs.insert(tab, at: i)
    }
    watch(tab)
    if select { self.select(tab) }
    save()
  }

  func select(_ tab: Tab) {
    selected?.takeSnapshot()
    if tab.isPrivate != privateMode { privateMode = tab.isPrivate }
    selectedID = tab.id
    if tab.isPrivate { privateSelection = tab.id } else { normalSelection = tab.id }
    tab.activate()
    save()
  }

  func close(_ tab: Tab) {
    if !tab.isPrivate, let url = tab.url, URLInput.isWeb(url) {
      closed.append((url, tab.title))
      if closed.count > 25 { closed.removeFirst() }
    }
    let list = tab.isPrivate ? privateTabs : tabs
    guard let i = list.firstIndex(where: { $0 === tab }) else { return }
    tab.webView.stopLoading()
    if tab.isPrivate { privateTabs.remove(at: i) } else { tabs.remove(at: i) }
    if tab.isPrivate && privateTabs.isEmpty { app.resetPrivateSession() }
    if selectedID == tab.id {
      let rest = tab.isPrivate ? privateTabs : tabs
      if let next = rest.indices.contains(i) ? rest[i] : rest.last {
        select(next)
      } else if tab.isPrivate {
        privateMode = false
        if let t = tabs.first(where: { $0.id == normalSelection }) ?? tabs.last { select(t) } else { newTab(isPrivate: false) }
      } else {
        newTab(isPrivate: false)
      }
    }
    save()
  }

  func closeAll(isPrivate: Bool) {
    for t in (isPrivate ? privateTabs : tabs) { close(t) }
  }

  func reopenClosed() {
    guard let last = closed.popLast() else { return }
    newTab(url: last.url, isPrivate: false)
  }

  /// Switches between normal and private tabs.
  func setPrivateMode(_ on: Bool) {
    guard on != privateMode else { return }
    selected?.takeSnapshot()
    privateMode = on
    let list = on ? privateTabs : tabs
    if let t = list.first(where: { $0.id == (on ? privateSelection : normalSelection) }) ?? list.last {
      select(t)
    } else {
      newTab(isPrivate: on)
    }
  }

  /// The tab `offset` places from the selected one among the shown (normal or private) tabs.
  func neighbour(_ offset: Int) -> Tab? {
    let list = current
    guard let i = list.firstIndex(where: { $0.id == selectedID }), list.indices.contains(i + offset) else { return nil }
    return list[i + offset]
  }

  /// The next or previous tab, wrapping around at the ends.
  func selectAdjacent(_ offset: Int) {
    let list = current
    guard list.count > 1, let i = list.firstIndex(where: { $0.id == selectedID }) else { return }
    select(list[((i + offset) % list.count + list.count) % list.count])
  }

  func move(from: IndexSet, to: Int) {
    if privateMode { privateTabs.move(fromOffsets: from, toOffset: to) } else { tabs.move(fromOffsets: from, toOffset: to) }
    save()
  }

  private func watch(_ tab: Tab) {
    // Saving on every URL change keeps the session current if the app is killed.
    tab.$url.dropFirst().removeDuplicates().sink { [weak self] _ in
      Task { @MainActor in self?.saveSoon() }
    }.store(in: &bag)
  }

  // MARK: Settings and rule lists

  func settingsChanged() {
    for t in tabs + privateTabs where t.hasWebView { t.settingsChanged() }
  }

  func applyRuleLists() {
    for t in tabs + privateTabs where t.hasWebView { t.applyRuleLists(for: t.url) }
  }

  // MARK: Session

  private struct SavedTab: Codable {
    let url: String?
    let title: String
    let state: Data?
  }

  private struct Session: Codable {
    let tabs: [SavedTab]
    let selected: Int?
  }

  private var saveTask: Task<Void, Never>?

  private func saveSoon() {
    saveTask?.cancel()
    saveTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      if !Task.isCancelled { save() }
    }
  }

  func save() {
    let saved = tabs.map { SavedTab(url: $0.url?.absoluteString, title: $0.title, state: $0.interactionState) }
    let selected = tabs.firstIndex { $0.id == normalSelection }
    if let data = try? JSONEncoder().encode(Session(tabs: saved, selected: selected)) {
      try? data.write(to: sessionURL, options: .atomic)
    }
  }

  private func restore() {
    guard let data = try? Data(contentsOf: sessionURL), let session = try? JSONDecoder().decode(Session.self, from: data) else { return }
    guard app.settings.value.startup == .restore else {
      return
    }
    for s in session.tabs {
      let tab = Tab(app: app, isPrivate: false, url: s.url.flatMap(URL.init(string:)), state: s.state, title: s.title)
      tabs.append(tab)
      watch(tab)
    }
    if let i = session.selected, tabs.indices.contains(i) { select(tabs[i]) } else if let last = tabs.last { select(last) }
  }
}
