import SwiftUI

struct WelcomeView: View {
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var settings: SettingsStore

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 28) {
          VStack(alignment: .leading, spacing: 10) {
            Image("Potato").resizable().scaledToFit().frame(width: 72, height: 72)
            Text("Potato Browser").font(.largeTitle.bold())
            Text("The web without AI, and without ads. Grown, not generated.").font(.title3).foregroundStyle(.secondary)
          }

          VStack(alignment: .leading, spacing: 16) {
            feature("shield.lefthalf.filled", "AI Shield", "AI Overviews, chat assistants and AI writing buttons are peeled off the sites you visit.")
            feature("nosign", "Ad blocker", "Ads, video ads, pop-ups and trackers get mashed before they load.")
            feature("cpu", "No AI in the engine", "Writing Tools, predictive text and the AI web APIs are switched off in every page.")
            feature("flag", "Community AI flags", "Flag posts you think are AI-generated. Flagged posts can be hidden or labeled.")
          }

          VStack(alignment: .leading, spacing: 10) {
            Text("1. Pick a search engine").font(.headline)
            ForEach(["duckduckgo", "google", "google-web"], id: \.self) { id in
              let e = SearchEngine.get(id)
              choice(selected: settings.value.searchEngine == id, title: e.name, detail: e.note ?? "") {
                settings.update { $0.searchEngine = id }
              }
            }
          }

          VStack(alignment: .leading, spacing: 10) {
            Text("2. Posts others flagged as AI-generated").font(.headline)
            choice(selected: settings.value.flags.mode == .hide, title: "Bury them", detail: "Tucked behind a notice. One tap digs them up.") { settings.update { $0.flags.mode = .hide } }
            choice(selected: settings.value.flags.mode == .label, title: "Label them", detail: "Shown with an amber outline, like a sticker on the sack.") { settings.update { $0.flags.mode = .label } }
            choice(selected: settings.value.flags.mode == .ignore, title: "Leave them", detail: "Shown as usual. You can still flag posts for everyone else.") { settings.update { $0.flags.mode = .ignore } }
          }
        }
        .padding(24)
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity)
      }
      .safeAreaInset(edge: .bottom) {
        Button {
          settings.update { $0.firstRunDone = true }
          app.panel = nil
        } label: {
          Text("Start browsing").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
        .background(.bar)
        .accessibilityIdentifier("start-browsing")
      }
    }
  }

  private func feature(_ icon: String, _ title: String, _ text: String) -> some View {
    HStack(alignment: .top, spacing: 14) {
      Image(systemName: icon).font(.title2).foregroundStyle(Color.potato).frame(width: 32)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.headline)
        Text(text).font(.subheadline).foregroundStyle(.secondary)
      }
    }
  }

  private func choice(selected: Bool, title: String, detail: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: selected ? "largecircle.fill.circle" : "circle").foregroundStyle(selected ? Color.potato : .secondary)
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.body.weight(.medium)).foregroundStyle(.primary)
          if !detail.isEmpty { Text(detail).font(.footnote).foregroundStyle(.secondary) }
        }
        Spacer(minLength: 0)
      }
      .padding(12)
      .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }
    .buttonStyle(.plain)
  }
}
