import SwiftUI
import WebKit

@main
struct PotatoApp: App {
  @StateObject private var app: AppModel
  @Environment(\.scenePhase) private var phase

  init() {
    let model = AppModel()
    _app = StateObject(wrappedValue: model)
    Presenter.app = model
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(app)
        .environmentObject(app.tabs)
        .environmentObject(app.settings)
        .environmentObject(app.store)
        .environmentObject(app.adblock)
        .environmentObject(app.downloads)
        .onOpenURL { app.open(link: $0) }
    }
    .commands { BrowserCommands(app: app, tabs: app.tabs) }
    .onChange(of: phase) { _, p in
      if p == .background {
        app.tabs.save()
        app.adblock.flushStats()
      }
    }
  }
}

struct RootView: View {
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var settings: SettingsStore

  var body: some View {
    BrowserView()
      .preferredColorScheme(settings.value.theme == .dark ? .dark : settings.value.theme == .light ? .light : nil)
      .tint(Color.potato)
  }
}

extension Color {
  /// The app's accent: potato skin brown (darker in light mode for contrast).
  static let potato = Color("AccentColor")
}
