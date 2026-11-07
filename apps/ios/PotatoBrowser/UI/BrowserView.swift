import SwiftUI
import WebKit

struct BrowserView: View {
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var tabs: TabManager
  @Environment(\.horizontalSizeClass) private var sizeClass

  var body: some View {
    ZStack(alignment: .bottom) {
      VStack(spacing: 0) {
        if sizeClass == .regular, let tab = tabs.selected { ChromeBar(tab: tab, compact: false) }
        ZStack {
          if let tab = tabs.selected {
            TabContent(tab: tab).id(tab.id)
          }
          if app.editingAddress, let tab = tabs.selected {
            SuggestionsView(tab: tab)
              .transition(.opacity)
          }
        }
        if sizeClass != .regular, let tab = tabs.selected { ChromeBar(tab: tab, compact: true) }
      }
      if let toast = app.toast {
        Text(toast)
          .font(.subheadline.weight(.medium))
          .padding(.horizontal, 16)
          .padding(.vertical, 10)
          .background(.thinMaterial, in: Capsule())
          .padding(.bottom, 120)
          .transition(.move(edge: .bottom).combined(with: .opacity))
          .accessibilityIdentifier("toast")
      }
    }
    .animation(.easeOut(duration: 0.2), value: app.toast)
    .animation(.easeOut(duration: 0.15), value: app.editingAddress)
    .sheet(item: $app.panel) { panel in
      PanelView(panel: panel)
        .tint(Color.potato)
        .environmentObject(app)
        .environmentObject(tabs)
        .environmentObject(app.settings)
        .environmentObject(app.store)
        .environmentObject(app.adblock)
        .environmentObject(app.downloads)
    }
  }
}

/// What a tab shows: the page, the new tab page or an error.
struct TabContent: View {
  @ObservedObject var tab: Tab
  @EnvironmentObject var app: AppModel

  var body: some View {
    ZStack {
      if !tab.isBlank || tab.isLoading {
        WebViewContainer(webView: tab.webView)
      }
      if let i = tab.interstitial {
        InterstitialView(tab: tab, interstitial: i)
      } else if tab.isBlank && !tab.isLoading {
        NewTabView(tab: tab)
      }
    }
    // The status bar takes the page's theme color, as in Safari.
    .background(Color(uiColor: tab.interstitial == nil && !tab.isBlank ? tab.themeColor ?? .systemBackground : .systemBackground).ignoresSafeArea(edges: .top))
  }
}

struct WebViewContainer: UIViewRepresentable {
  let webView: WKWebView

  final class Container: UIView {
    func show(_ web: WKWebView) {
      guard web.superview !== self else { return }
      subviews.forEach { $0.removeFromSuperview() }
      web.translatesAutoresizingMaskIntoConstraints = false
      addSubview(web)
      NSLayoutConstraint.activate([
        web.leadingAnchor.constraint(equalTo: leadingAnchor),
        web.trailingAnchor.constraint(equalTo: trailingAnchor),
        web.topAnchor.constraint(equalTo: topAnchor),
        web.bottomAnchor.constraint(equalTo: bottomAnchor),
      ])
    }
  }

  func makeUIView(context: Context) -> Container { Container() }
  func updateUIView(_ view: Container, context: Context) { view.show(webView) }
}

struct InterstitialView: View {
  @ObservedObject var tab: Tab
  let interstitial: Interstitial

  var body: some View {
    VStack(spacing: 16) {
      Spacer()
      Image(systemName: icon)
        .font(.system(size: 44, weight: .light))
        .foregroundStyle(.secondary)
      Text(title).font(.title2.bold()).multilineTextAlignment(.center)
      Text(message).font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
      VStack(spacing: 10) {
        switch interstitial {
        case .chatbot(let url):
          Button("Go back") { tab.goBack() }.buttonStyle(.borderedProminent)
          Button("Open \(url.host ?? "it") this time") { tab.allowChatbotOnce(url) }
            .accessibilityIdentifier("chatbot-allow-once")
        case .insecure(let url, _):
          Button("Go back") { tab.goBack() }.buttonStyle(.borderedProminent)
          Button("Continue to \(url.host ?? "the site") (not secure)", role: .destructive) { tab.trustCertificateAndContinue(url) }
        case .failed, .crashed:
          Button("Try again") { tab.reload() }.buttonStyle(.borderedProminent)
          if tab.canGoBack { Button("Go back") { tab.goBack() } }
        }
      }
      .padding(.top, 8)
      Spacer()
      Spacer()
    }
    .padding(32)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(.systemBackground))
    .accessibilityIdentifier("interstitial")
  }

  private var icon: String {
    switch interstitial {
    case .chatbot: "hand.raised"
    case .insecure: "exclamationmark.lock"
    case .failed: "wifi.exclamationmark"
    case .crashed: "exclamationmark.triangle"
    }
  }

  private var title: String {
    switch interstitial {
    case .chatbot: "AI chatbot blocked"
    case .insecure: "Your connection is not private"
    case .failed(_, let t, _): t
    case .crashed: "This tab got mashed"
    }
  }

  private var message: String {
    switch interstitial {
    case .chatbot(let url): "\(url.host ?? "This site") is an AI chatbot, and you asked to keep those out of the pantry in Settings. This is a no-artificial-ingredients zone."
    case .insecure(_, let host): "Someone might be trying to read what you send to \(host), or the site's security certificate is broken."
    case .failed(_, _, let m): m
    case .crashed: "Something went wrong while showing this page. Trying again usually un-mashes it."
    }
  }
}
