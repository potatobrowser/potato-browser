import QuickLook
import SwiftUI

struct PanelView: View {
  let panel: Panel
  @EnvironmentObject var tabs: TabManager

  var body: some View {
    switch panel {
    case .tabs: TabSwitcherView()
    case .menu: MenuView().presentationDetents([.medium, .large])
    case .protections:
      if let tab = tabs.selected { ProtectionsView(tab: tab).presentationDetents([.medium, .large]) }
    case .settings: SettingsView()
    case .history: NavigationStack { HistoryView() }
    case .bookmarks: NavigationStack { BookmarksView(folder: Store.bookmarksRoot, title: "Bookmarks") }
    case .downloads: NavigationStack { DownloadsView() }
    case .addBookmark:
      if let tab = tabs.selected { AddBookmarkView(tab: tab).presentationDetents([.medium]) }
    case .welcome: WelcomeView().interactiveDismissDisabled()
    }
  }
}

// MARK: - Tabs

struct TabSwitcherView: View {
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var tabs: TabManager
  @Environment(\.dismiss) private var dismiss
  /// Which tabs the grid shows; switching it does not open or select anything.
  @State private var showPrivate: Bool?

  private var isPrivate: Bool { showPrivate ?? tabs.privateMode }
  private var shown: [Tab] { isPrivate ? tabs.privateTabs : tabs.tabs }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 14)], spacing: 14) {
          ForEach(shown) { tab in
            TabCard(tab: tab, selected: tab.id == tabs.selectedID) {
              tabs.select(tab)
              dismiss()
            } close: {
              withAnimation { tabs.close(tab) }
            }
          }
        }
        .padding(14)
        if shown.isEmpty {
          Text(isPrivate ? "No private tabs. What happens in a private tab stays in the pantry." : "No tabs open.")
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(40)
        }
      }
      .background(Color(.systemGroupedBackground))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .principal) {
          Picker("Tabs", selection: Binding(get: { isPrivate }, set: { showPrivate = $0 })) {
            Text(tabs.tabs.count == 1 ? "1 Tab" : "\(tabs.tabs.count) Tabs").tag(false)
            Text("Private").tag(true)
          }
          .pickerStyle(.segmented)
          .frame(width: 220)
          .accessibilityIdentifier("tab-mode")
        }
        ToolbarItem(placement: .topBarLeading) {
          Menu {
            if tabs.canReopenClosed {
              Button("Reopen Closed Tab", systemImage: "arrow.uturn.backward") {
                tabs.reopenClosed()
                dismiss()
              }
            }
            Button("Close All Tabs", systemImage: "xmark", role: .destructive) { tabs.closeAll(isPrivate: isPrivate) }
          } label: { Image(systemName: "ellipsis.circle") }
            .accessibilityLabel("Tab options")
        }
        ToolbarItem(placement: .bottomBar) {
          Button {
            tabs.newTab(isPrivate: isPrivate)
            dismiss()
            app.editingAddress = true
          } label: { Image(systemName: "plus") }
            .accessibilityLabel("New tab")
            .accessibilityIdentifier("new-tab")
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }.bold()
            .accessibilityIdentifier("tabs-done")
        }
      }
    }
  }
}

struct TabCard: View {
  @ObservedObject var tab: Tab
  let selected: Bool
  let open: () -> Void
  let close: () -> Void

  var body: some View {
    Button(action: open) {
      VStack(spacing: 0) {
        ZStack {
          Color(.secondarySystemBackground)
          if let snap = tab.snapshot, !tab.isBlank {
            Image(uiImage: snap).resizable().scaledToFill()
          } else {
            Image("Potato").resizable().scaledToFit().frame(width: 40).opacity(0.5)
          }
        }
        .frame(height: 190)
        .clipped()
        HStack {
          Text(tab.displayTitle).font(.caption.weight(.medium)).lineLimit(1)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color(.systemBackground))
      }
      .clipShape(RoundedRectangle(cornerRadius: 14))
      .overlay(RoundedRectangle(cornerRadius: 14).stroke(selected ? Color.potato : Color(.separator), lineWidth: selected ? 3 : 0.5))
      .overlay(alignment: .topTrailing) {
        Button(action: close) {
          Image(systemName: "xmark")
            .font(.caption.bold())
            .padding(7)
            .background(.thinMaterial, in: Circle())
        }
        .padding(6)
        .accessibilityLabel("Close \(tab.displayTitle)")
        .accessibilityIdentifier("close-tab")
      }
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("tab-card")
  }
}

// MARK: - Menu

struct MenuView: View {
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var tabs: TabManager
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let tab = tabs.selected
    let page = tab?.url.flatMap { URLInput.isWeb($0) ? $0 : nil }
    NavigationStack {
      List {
        Section {
          LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 12) {
            tile("New Tab", "plus.square.on.square", id: "menu-new-tab") {
              tabs.newTab(isPrivate: false)
              app.editingAddress = true
            }
            tile("Private Tab", "eye.slash", id: "menu-private-tab") {
              tabs.newTab(isPrivate: true)
              app.editingAddress = true
            }
            tile("Bookmarks", "book", id: "menu-bookmarks") { open(.bookmarks) }
            tile("History", "clock", id: "menu-history") { open(.history) }
            tile("Downloads", "arrow.down.circle", id: "menu-downloads") { open(.downloads) }
            tile("Settings", "gearshape", id: "menu-settings") { open(.settings) }
            if tabs.canReopenClosed {
              tile("Reopen Tab", "arrow.uturn.backward", id: "menu-reopen") { tabs.reopenClosed() }
            }
          }
          .padding(.vertical, 6)
        }
        if let tab, let page {
          Section(URLInput.displayHost(page)) {
            if let id = store.bookmarkId(for: page.absoluteString) {
              Button("Remove Bookmark", systemImage: "bookmark.slash") {
                store.deleteBookmark(id)
                app.showToast("Bookmark removed")
                dismiss()
              }
            } else {
              Button("Add Bookmark", systemImage: "bookmark") { app.panel = .addBookmark }
                .accessibilityIdentifier("menu-add-bookmark")
            }
            Button("Find on Page", systemImage: "doc.text.magnifyingglass") {
              dismiss()
              Task { @MainActor in
                try? await Task.sleep(nanoseconds: 450_000_000)
                tab.webView.findInteraction?.presentFindNavigator(showingReplace: false)
              }
            }
            .accessibilityIdentifier("menu-find")
            Button(tab.isDesktopSite ? "Request Mobile Site" : "Request Desktop Site", systemImage: tab.isDesktopSite ? "iphone" : "desktopcomputer") {
              tab.toggleDesktopSite()
              dismiss()
            }
            HStack {
              Label("Text Size", systemImage: "textformat.size")
              Spacer()
              ZoomControl(tab: tab)
            }
            Button("Copy Link", systemImage: "doc.on.doc") {
              UIPasteboard.general.url = page
              app.showToast("Link copied")
              dismiss()
            }
            Button("Share or Print", systemImage: "square.and.arrow.up") {
              dismiss()
              Presenter.share([page, tab.webView.viewPrintFormatter()])
            }
          }
        }
      }
      .navigationTitle("Potato")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
      }
    }
  }

  private func open(_ p: Panel) {
    app.panel = nil
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 350_000_000)
      app.panel = p
    }
  }

  private func tile(_ title: String, _ icon: String, id: String, action: @escaping () -> Void) -> some View {
    Button {
      action()
      if !["menu-bookmarks", "menu-history", "menu-downloads", "menu-settings"].contains(id) { dismiss() }
    } label: {
      VStack(spacing: 6) {
        Image(systemName: icon).font(.title3)
        Text(title).font(.caption2).lineLimit(1).minimumScaleFactor(0.8)
      }
      .frame(maxWidth: .infinity, minHeight: 56)
      .contentShape(Rectangle())
    }
    .buttonStyle(.borderless)
    .accessibilityIdentifier(id)
  }
}

struct ZoomControl: View {
  @ObservedObject var tab: Tab
  @State private var zoom: CGFloat = 1
  static let levels: [CGFloat] = [0.5, 0.75, 0.85, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.5, 3]

  var body: some View {
    HStack(spacing: 14) {
      Button { step(-1) } label: { Image(systemName: "textformat.size.smaller") }.buttonStyle(.borderless)
      Text("\(Int(zoom * 100))%").font(.callout.monospacedDigit()).frame(minWidth: 48)
      Button { step(1) } label: { Image(systemName: "textformat.size.larger") }.buttonStyle(.borderless)
    }
    .onAppear { zoom = tab.webView.pageZoom }
  }

  private func step(_ dir: Int) {
    let next = dir > 0 ? Self.levels.first { $0 > zoom + 0.001 } : Self.levels.last { $0 < zoom - 0.001 }
    if let next {
      zoom = next
      tab.webView.pageZoom = next
    }
  }
}

// MARK: - Page protections

struct ProtectionsView: View {
  @ObservedObject var tab: Tab
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var settings: SettingsStore
  @EnvironmentObject var adblock: AdblockService
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let url = tab.url.flatMap { URLInput.isWeb($0) ? $0 : nil }
    NavigationStack {
      List {
        if let url {
          Section {
            Toggle(isOn: Binding(get: { !app.shield.isSiteDisabled(url) }, set: { on in
              app.shield.setSite(url, enabled: on)
            })) {
              VStack(alignment: .leading, spacing: 2) {
                Text("Hide AI on this site").font(.body.weight(.medium))
                Text(shieldStatus(url)).font(.footnote).foregroundStyle(.secondary)
              }
            }
            .disabled(!settings.value.shield.enabled)
            .accessibilityIdentifier("shield-site-toggle")
            if !settings.value.shield.enabled {
              Text("The AI Shield is turned off for all sites in Settings.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(tab.shield.features, id: \.self) { f in
              Label(f, systemImage: "eye.slash").font(.subheadline)
            }
          } header: {
            Text("AI Shield")
          }

          Section {
            Toggle(isOn: Binding(get: { !adblock.isSiteDisabled(url) }, set: { on in
              adblock.setSite(url, enabled: on)
              tab.reload()
            })) {
              VStack(alignment: .leading, spacing: 2) {
                Text("Block ads on this site").font(.body.weight(.medium))
                Text(adStatus(url)).font(.footnote).foregroundStyle(.secondary)
              }
            }
            .disabled(!settings.value.adblock.enabled)
            .accessibilityIdentifier("adblock-site-toggle")
            if !settings.value.adblock.enabled {
              Text("The ad blocker is turned off for all sites in Settings.").font(.footnote).foregroundStyle(.secondary)
            } else if !adblock.isReady {
              Label("Getting the ad blocker ready. Its filters are compiled once, on the first start.", systemImage: "hourglass")
                .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(tab.adblock.topHosts, id: \.host) { h in
              HStack {
                Text(h.host).font(.subheadline)
                Spacer()
                Text("\(h.count)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
              }
            }
          } header: {
            Text("Ad blocker")
          } footer: {
            Text("Switching reloads the page.")
          }

          if let platform = tab.flags.platform, let label = FlagPlatform.all.first(where: { $0.id == platform })?.label {
            Section("AI flags on \(label)") {
              Text(flagStatus).font(.subheadline)
            }
          }
        } else {
          Text("Open a website to see what's growing on it and peel off its AI features.")
            .foregroundStyle(.secondary)
        }
      }
      .navigationTitle(url.map { URLInput.displayHost($0) } ?? "Protections")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
      }
    }
  }

  private func shieldStatus(_ url: URL) -> String {
    if !app.shield.isEnabled(for: url) { return "AI features are shown on this site." }
    if tab.shield.count > 0 { return "\(tab.shield.count) AI \(tab.shield.count == 1 ? "feature" : "features") peeled off this page." }
    return app.shield.isSupported(url) ? "Watching this site for AI features." : "No known AI features on this site. Fresh from the field."
  }

  private func adStatus(_ url: URL) -> String {
    if !adblock.isEnabled(for: url) { return "Ads and trackers load normally here. Switch it back on anytime." }
    if tab.adblock.blocked > 0 { return "\(tab.adblock.blocked) ads and trackers blocked on this page." }
    return "No ads or trackers on this page so far. A clean spud."
  }

  private var flagStatus: String {
    let f = tab.flags
    switch settings.value.flags.mode {
    case .hide: return f.hidden == 1 ? "1 post flagged as AI-generated is buried." : "\(f.hidden) posts flagged as AI-generated are buried."
    case .label: return f.labeled == 1 ? "1 post flagged as AI-generated is labeled." : "\(f.labeled) posts flagged as AI-generated are labeled."
    case .ignore: return "Flagged posts are shown as usual. Tap AI? on a post to flag it."
    }
  }
}
