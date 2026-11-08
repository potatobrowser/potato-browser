import SwiftUI

/// The address bar and toolbar: at the bottom on iPhone, at the top on iPad.
struct ChromeBar: View {
  @ObservedObject var tab: Tab
  let compact: Bool
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var tabs: TabManager
  @State private var swipe: CGFloat = 0
  @State private var swiping = false
  @State private var pillWidth: CGFloat = 0

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
      }
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
    Group {
      if app.editingAddress {
        HStack(spacing: 8) {
          Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
          AddressField(text: $app.suggestionText) {
            submit(app.suggestionText)
          } close: {
            if app.editingAddress { app.editingAddress = false }
          }
          .frame(maxWidth: .infinity)
          if !app.suggestionText.isEmpty {
            Button { app.suggestionText = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
              .accessibilityLabel("Clear")
          }
        }
        .addressPill()
      } else {
        swipeableAddress
      }
    }
    .safeAreaInset(edge: .trailing, spacing: app.editingAddress ? 8 : 0) {
      if app.editingAddress {
        Button("Cancel") { app.editingAddress = false }
          .accessibilityIdentifier("address-cancel")
      }
    }
  }

  // MARK: Swiping between tabs

  private enum SwipeTarget {
    case tab(Tab), newTab
  }

  /// Where a swipe goes: left to the next tab (a new one past the last, as in Safari, unless this
  /// one is new and empty), right to the previous one.
  private func swipeTarget(_ dx: CGFloat) -> SwipeTarget? {
    if dx > 0 { return tabs.neighbour(-1).map(SwipeTarget.tab) }
    if let next = tabs.neighbour(1) { return .tab(next) }
    return tab.isBlank ? nil : .newTab
  }

  private var swipeGap: CGFloat { compact ? 24 : 16 }

  /// The address pill follows the finger, the neighbouring tab's pill comes in beside it.
  private var swipeableAddress: some View {
    ZStack {
      if swipe != 0, let target = swipeTarget(swipe) {
        Group {
          switch target {
          case .tab(let t): AddressPill(tab: t, preview: true)
          case .newTab: AddressPill(tab: nil, preview: true)
          }
        }
        .offset(x: swipe + (swipe < 0 ? 1 : -1) * (pillWidth + swipeGap))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
      }
      AddressPill(tab: tab, preview: false) { next in switchTab(to: swipeTarget(next ? -1 : 1)) }
        .offset(x: swipe)
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { pillWidth = $0 }
    // Clipped at the screen edges on iPhone, at the pill's own place between the buttons on iPad.
    .padding(.horizontal, compact ? 12 : 0)
    .clipped()
    .padding(.horizontal, compact ? -12 : 0)
    .highPriorityGesture(tabSwipe)
  }

  private var tabSwipe: some Gesture {
    DragGesture(minimumDistance: 12)
      .onChanged { v in
        let dx = v.translation.width
        if !swiping {
          guard abs(dx) > abs(v.translation.height) else { return }
          swiping = true
        }
        // Rubber band where there is nothing to swipe to.
        swipe = swipeTarget(dx) == nil ? dx / 4 : dx
      }
      .onEnded { v in
        let dx = v.translation.width
        let far = abs(dx) > pillWidth * 0.3 || abs(v.predictedEndTranslation.width) > pillWidth * 0.6
        let target = swiping && far ? swipeTarget(dx) : nil
        swiping = false
        guard let target else {
          withAnimation(.spring(duration: 0.3)) { swipe = 0 }
          return
        }
        withAnimation(.easeOut(duration: 0.18)) {
          swipe = (dx < 0 ? -1 : 1) * (pillWidth + swipeGap)
        } completion: {
          // The neighbour's pill now sits where the selected tab's pill will be: no jump.
          var t = Transaction()
          t.disablesAnimations = true
          withTransaction(t) {
            switchTab(to: target)
            swipe = 0
          }
        }
      }
  }

  private func switchTab(to target: SwipeTarget?) {
    switch target {
    case .tab(let t): tabs.select(t)
    case .newTab: tabs.newTab(isPrivate: tabs.privateMode)
    case nil: return
    }
    UISelectionFeedbackGenerator().selectionChanged()
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

/// The address bar while it is not being edited: protections, the page's address, reload. No tab
/// is the new tab that a swipe past the last tab opens. A preview (the neighbour sliding in during
/// a swipe) looks the same but has no buttons, so it never doubles the real ones.
private struct AddressPill: View {
  let tab: Tab?
  let preview: Bool
  /// VoiceOver's way to the next (true) or previous tab, as the swipe is not at hand there.
  var switchTab: ((Bool) -> Void)?

  var body: some View {
    if let tab {
      Content(tab: tab, preview: preview, switchTab: switchTab)
    } else {
      HStack(spacing: 8) {
        Image(systemName: "shield").foregroundStyle(.secondary).frame(minWidth: 28, minHeight: 28)
        Text("Search or enter address").lineLimit(1).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        Color.clear.frame(width: 28, height: 28)
      }
      .addressPill()
    }
  }

  private struct Content: View {
    @ObservedObject var tab: Tab
    let preview: Bool
    let switchTab: ((Bool) -> Void)?
    @EnvironmentObject var app: AppModel

    var body: some View {
      HStack(spacing: 8) {
        if preview {
          ProtectionsLabel(tab: tab)
          address
          if tab.url != nil { reloadIcon.foregroundStyle(.tint) }
        } else {
          ProtectionsButton(tab: tab)
          Button {
            app.editingAddress = true
          } label: {
            address
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("address-bar")
          .accessibilityValue(tab.displayURL?.absoluteString ?? "")
          .accessibilityActions {
            if let switchTab {
              Button("Next Tab") { switchTab(true) }
              Button("Previous Tab") { switchTab(false) }
            }
          }
          if tab.url != nil {
            Button {
              tab.isLoading ? tab.stop() : tab.reload()
            } label: {
              reloadIcon
            }
            .accessibilityLabel(tab.isLoading ? "Stop" : "Reload")
            .accessibilityIdentifier("reload")
          }
        }
      }
      .addressPill()
    }

    private var address: some View {
      HStack(spacing: 4) {
        if let url = tab.url, url.scheme == "http", tab.interstitial == nil {
          Image(systemName: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange)
            .accessibilityLabel("Not secure")
        }
        Text(title)
          .lineLimit(1)
          .truncationMode(.middle)
          .foregroundStyle(tab.displayURL == nil ? .secondary : .primary)
      }
      .frame(maxWidth: .infinity)
      .contentShape(Rectangle())
    }

    private var reloadIcon: some View {
      Image(systemName: tab.isLoading ? "xmark" : "arrow.clockwise")
        .frame(width: 28, height: 28)
    }

    private var title: String {
      guard let url = tab.displayURL else { return "Search or enter address" }
      if let q = SearchEngine.get(app.settings.value.searchEngine).query(in: url) { return q }
      return URLInput.displayHost(url)
    }
  }
}

/// The address field while editing. A UITextField rather than a TextField: a focused TextField
/// keeps Esc to itself, and this one gives Esc to `close`. It takes focus as it appears, selects
/// the address so typing replaces it, and closes when it loses focus.
private struct AddressField: UIViewRepresentable {
  @Binding var text: String
  let submit: () -> Void
  let close: () -> Void

  final class Field: UITextField {
    var close: () -> Void = {}

    override var keyCommands: [UIKeyCommand]? {
      let esc = UIKeyCommand(title: "Close Address Field", action: #selector(escape), input: UIKeyCommand.inputEscape)
      esc.wantsPriorityOverSystemBehavior = true
      return (super.keyCommands ?? []) + [esc]
    }

    @objc private func escape() { close() }

    override func didMoveToWindow() {
      super.didMoveToWindow()
      if window != nil { becomeFirstResponder() }
    }
  }

  final class Coordinator: NSObject, UITextFieldDelegate {
    var parent: AddressField
    init(_ parent: AddressField) { self.parent = parent }

    @objc func changed(_ field: UITextField) { parent.text = field.text ?? "" }

    func textFieldDidBeginEditing(_ field: UITextField) {
      // After the address is filled in (the same update that shows the field).
      DispatchQueue.main.async { field.selectedTextRange = field.textRange(from: field.beginningOfDocument, to: field.endOfDocument) }
    }

    func textFieldShouldReturn(_ field: UITextField) -> Bool {
      // The keyboard starts to go right away, as with a SwiftUI TextField.
      field.resignFirstResponder()
      parent.submit()
      return false
    }

    func textFieldDidEndEditing(_ field: UITextField) { parent.close() }
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> Field {
    let f = Field()
    f.placeholder = "Search or enter address"
    f.font = .preferredFont(forTextStyle: .body)
    f.adjustsFontForContentSizeCategory = true
    f.keyboardType = .webSearch
    f.returnKeyType = .go
    f.autocapitalizationType = .none
    f.autocorrectionType = .no
    f.spellCheckingType = .no
    f.smartQuotesType = .no
    f.smartDashesType = .no
    f.inlinePredictionType = .no
    f.writingToolsBehavior = .none
    f.accessibilityIdentifier = "address-field"
    f.setContentHuggingPriority(.defaultLow, for: .horizontal)
    f.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    f.delegate = context.coordinator
    f.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
    return f
  }

  func updateUIView(_ f: Field, context: Context) {
    context.coordinator.parent = self
    f.close = close
    if f.text != text { f.text = text }
  }
}

extension View {
  /// The capsule the address bar sits in.
  fileprivate func addressPill() -> some View {
    font(.body)
      .padding(.horizontal, 12)
      .frame(height: 44)
      .background(Color(.secondarySystemBackground), in: Capsule())
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
      ProtectionsLabel(tab: tab)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Page protections")
    .accessibilityValue("\(tab.shield.count) AI features hidden, \(tab.adblock.blocked) ads and trackers blocked")
    .accessibilityIdentifier("protections")
  }
}

struct ProtectionsLabel: View {
  @ObservedObject var tab: Tab
  @EnvironmentObject var app: AppModel

  var body: some View {
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

  private var blockedCount: Int { tab.adblock.blocked }

  private var shieldIcon: String {
    guard let url = tab.url, URLInput.isWeb(url) else { return "shield" }
    if !app.shield.isEnabled(for: url) && !app.adblock.isEnabled(for: url) { return "shield.slash" }
    return tab.shield.count > 0 ? "shield.lefthalf.filled" : "shield"
  }
}
