import SwiftUI

/// The address bar and toolbar: at the bottom on iPhone, at the top on iPad.
struct ChromeBar: View {
  @ObservedObject var tab: Tab
  let compact: Bool
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var tabs: TabManager
  @FocusState private var focused: Bool

  var body: some View {
    VStack(spacing: 0) {
      if compact { progress }
      VStack(spacing: compact ? 8 : 0) {
        if compact {
          address
          if !app.editingAddress { toolbar }
        } else {
          HStack(spacing: 14) {
            if !app.editingAddress {
              navButtons
            }
            address
            if !app.editingAddress {
              trailingButtons
            }
          }
        }
      }
      .padding(.horizontal, 12)
      .padding(.top, 8)
      .padding(.bottom, compact ? 2 : 8)
      if !compact { progress }
    }
    .background(tab.isPrivate ? AnyShapeStyle(Color.purple.opacity(0.18)) : AnyShapeStyle(.bar))
    .onChange(of: app.editingAddress) { _, editing in
      if editing {
        app.suggestionText = tab.displayURL.map { SearchEngine.get(app.settings.value.searchEngine).query(in: $0) ?? $0.absoluteString } ?? ""
        focused = true
      } else {
        focused = false
      }
    }
    .onChange(of: focused) { _, f in
      if !f && app.editingAddress { app.editingAddress = false }
    }
  }

  private var progress: some View {
    GeometryReader { geo in
      Rectangle()
        .fill(Color.potato)
        .frame(width: geo.size.width * (tab.isLoading ? max(0.05, tab.progress) : 0))
        .opacity(tab.isLoading ? 1 : 0)
        .animation(.linear(duration: 0.2), value: tab.progress)
    }
    .frame(height: 2)
  }

  private var address: some View {
    HStack(spacing: 8) {
      if app.editingAddress {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("Search or enter address", text: $app.suggestionText)
          .focused($focused)
          .keyboardType(.webSearch)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.go)
          .writingToolsBehavior(.disabled)
          .onSubmit { submit(app.suggestionText) }
          .accessibilityIdentifier("address-field")
        if !app.suggestionText.isEmpty {
          Button { app.suggestionText = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
            .accessibilityLabel("Clear")
        }
      } else {
        ProtectionsButton(tab: tab)
        Button {
          app.editingAddress = true
        } label: {
          HStack(spacing: 4) {
            if let url = tab.url, url.scheme == "http", tab.interstitial == nil {
              Image(systemName: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange)
                .accessibilityLabel("Not secure")
            }
            Text(addressTitle)
              .lineLimit(1)
              .truncationMode(.middle)
              .foregroundStyle(tab.displayURL == nil ? .secondary : .primary)
          }
          .frame(maxWidth: .infinity)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("address-bar")
        .accessibilityValue(tab.displayURL?.absoluteString ?? "")
        if tab.url != nil {
          Button {
            tab.isLoading ? tab.stop() : tab.reload()
          } label: {
            Image(systemName: tab.isLoading ? "xmark" : "arrow.clockwise")
              .frame(width: 28, height: 28)
          }
          .accessibilityLabel(tab.isLoading ? "Stop" : "Reload")
          .accessibilityIdentifier("reload")
        }
      }
    }
    .font(.body)
    .padding(.horizontal, 12)
    .frame(height: 44)
    .background(Color(.secondarySystemBackground), in: Capsule())
    .safeAreaInset(edge: .trailing, spacing: 8) {
      if app.editingAddress {
        Button("Cancel") { app.editingAddress = false }
          .accessibilityIdentifier("address-cancel")
      }
    }
  }

  private var addressTitle: String {
    guard let url = tab.displayURL else { return "Search or enter address" }
    if let q = SearchEngine.get(app.settings.value.searchEngine).query(in: url) { return q }
    return URLInput.displayHost(url)
  }

  private func submit(_ text: String) {
    app.editingAddress = false
    tab.submit(text)
  }

  private var navButtons: some View {
    HStack(spacing: 18) {
      Button { tab.goBack() } label: { Image(systemName: "chevron.backward") }
        .disabled(!tab.canGoBack && tab.interstitial == nil)
        .accessibilityLabel("Back")
        .accessibilityIdentifier("back")
      Button { tab.goForward() } label: { Image(systemName: "chevron.forward") }
        .disabled(!tab.canGoForward)
        .accessibilityLabel("Forward")
        .accessibilityIdentifier("forward")
    }
  }

  private var trailingButtons: some View {
    HStack(spacing: 18) {
      Button {
        if let url = tab.url { Presenter.share([url]) }
      } label: { Image(systemName: "square.and.arrow.up") }
        .disabled(tab.url == nil)
        .accessibilityLabel("Share")
      Button { app.panel = .menu } label: { Image(systemName: "ellipsis.circle") }
        .accessibilityLabel("Menu")
        .accessibilityIdentifier("menu")
      TabsButton(count: tabs.current.count, isPrivate: tabs.privateMode) {
        tab.takeSnapshot()
        app.panel = .tabs
      }
    }
  }

  private var toolbar: some View {
    HStack {
      Button { tab.goBack() } label: { Image(systemName: "chevron.backward") }
        .disabled(!tab.canGoBack && tab.interstitial == nil)
        .accessibilityLabel("Back")
        .accessibilityIdentifier("back")
      Spacer()
      Button { tab.goForward() } label: { Image(systemName: "chevron.forward") }
        .disabled(!tab.canGoForward)
        .accessibilityLabel("Forward")
        .accessibilityIdentifier("forward")
      Spacer()
      Button {
        if let url = tab.url { Presenter.share([url, tab.webView.viewPrintFormatter()]) }
      } label: { Image(systemName: "square.and.arrow.up") }
        .disabled(tab.url == nil)
        .accessibilityLabel("Share")
        .accessibilityIdentifier("share")
      Spacer()
      Button { app.panel = .menu } label: { Image(systemName: "ellipsis.circle") }
        .accessibilityLabel("Menu")
        .accessibilityIdentifier("menu")
      Spacer()
      TabsButton(count: tabs.current.count, isPrivate: tabs.privateMode) {
        tab.takeSnapshot()
        app.panel = .tabs
      }
    }
    .font(.title3)
    .padding(.horizontal, 8)
    .frame(height: 40)
  }
}

struct TabsButton: View {
  let count: Int
  let isPrivate: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: "square.on.square")
        .overlay {
          Text(count > 99 ? ":D" : "\(count)")
            .font(.system(size: 10, weight: .bold))
            .offset(x: -2, y: 2)
        }
    }
    .accessibilityLabel("Tabs, \(count) open")
    .accessibilityIdentifier("tabs-button")
  }
}

/// Shield glyph with what was hidden and blocked on the page; opens the protections panel.
struct ProtectionsButton: View {
  @ObservedObject var tab: Tab
  @EnvironmentObject var app: AppModel

  var body: some View {
    Button {
      app.panel = .protections
    } label: {
      HStack(spacing: 3) {
        Image(systemName: shieldIcon)
          .foregroundStyle(tab.shield.count > 0 ? Color.potato : .secondary)
        if blockedCount > 0 {
          Text("\(blockedCount)")
            .font(.caption2.monospacedDigit().weight(.semibold))
            .foregroundStyle(.secondary)
        }
      }
      .frame(minWidth: 28, minHeight: 28)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Page protections")
    .accessibilityValue("\(tab.shield.count) AI features hidden, \(tab.adblock.blocked) ads and trackers blocked")
    .accessibilityIdentifier("protections")
  }

  private var blockedCount: Int { tab.adblock.blocked }

  private var shieldIcon: String {
    guard let url = tab.url, URLInput.isWeb(url) else { return "shield" }
    if !app.shield.isEnabled(for: url) && !app.adblock.isEnabled(for: url) { return "shield.slash" }
    return tab.shield.count > 0 ? "shield.lefthalf.filled" : "shield"
  }
}
