import SwiftUI

struct Suggestion: Identifiable, Hashable {
  enum Kind { case page, search, url }
  let kind: Kind
  let title: String
  let subtitle: String
  let target: String
  var id: String { "\(kind)|\(target)" }
}

/// Address bar suggestions: typed URLs, history and bookmarks, and the search engine's ideas.
struct SuggestionsView: View {
  @ObservedObject var tab: Tab
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var store: Store
  @State private var remote: [String] = []
  @State private var remoteFor = ""

  var body: some View {
    let items = suggestions
    List {
      ForEach(items) { s in
        Button {
          open(s)
        } label: {
          HStack(spacing: 12) {
            Image(systemName: s.kind == .search ? "magnifyingglass" : s.kind == .url ? "globe" : "clock")
              .foregroundStyle(.secondary)
              .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
              Text(s.title).lineLimit(1)
              if !s.subtitle.isEmpty {
                Text(s.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
              }
            }
            Spacer(minLength: 0)
            if s.kind == .search {
              Button {
                app.suggestionText = s.target + " "
              } label: { Image(systemName: "arrow.up.left").foregroundStyle(.secondary) }
                .buttonStyle(.borderless)
                .accessibilityLabel("Edit \(s.target)")
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("suggestion")
      }
    }
    .listStyle(.plain)
    .scrollDismissesKeyboard(.interactively)
    .background(Color(.systemBackground))
    .task(id: app.suggestionText) { await loadRemote(app.suggestionText) }
  }

  private var suggestions: [Suggestion] {
    let text = app.suggestionText.trimmingCharacters(in: .whitespaces)
    guard !text.isEmpty else {
      return store.topSites(limit: 8).map { Suggestion(kind: .page, title: $0.title.isEmpty ? URLInput.host(of: $0.url) : $0.title, subtitle: $0.url, target: $0.url) }
    }
    var out: [Suggestion] = []
    let engine = SearchEngine.get(app.settings.value.searchEngine)
    switch URLInput.classify(text) {
    case .url(let u): out.append(Suggestion(kind: .url, title: u.absoluteString, subtitle: "Open address", target: u.absoluteString))
    case .search(let q): out.append(Suggestion(kind: .search, title: q, subtitle: "Search \(engine.name)", target: q))
    case nil: break
    }
    if !tab.isPrivate, let host = store.inlineHost(text), !out.contains(where: { URLInput.host(of: $0.target).hasSuffix(host) }) {
      out.insert(Suggestion(kind: .url, title: host, subtitle: "Open address", target: "https://\(host)/"), at: 0)
    }
    for p in store.suggestPages(text, limit: 5) where !out.contains(where: { $0.target == p.url }) {
      out.append(Suggestion(kind: .page, title: p.title.isEmpty ? p.url : p.title, subtitle: p.url, target: p.url))
    }
    for r in remote.prefix(6) where r.lowercased() != text.lowercased() {
      out.append(Suggestion(kind: .search, title: r, subtitle: "", target: r))
    }
    return out
  }

  private func open(_ s: Suggestion) {
    app.editingAddress = false
    switch s.kind {
    case .search: if let u = SearchEngine.get(app.settings.value.searchEngine).url(for: s.target) { tab.load(u, typed: true) }
    case .url, .page: if let u = URL(string: s.target) { tab.load(u, typed: true) }
    }
  }

  /// The search engine's suggestions (OpenSearch JSON), never from private tabs.
  private func loadRemote(_ text: String) async {
    let t = text.trimmingCharacters(in: .whitespaces)
    guard app.settings.value.searchSuggestions, !tab.isPrivate, !t.isEmpty, t.count < 120,
      case .search = URLInput.classify(t),
      let template = SearchEngine.get(app.settings.value.searchEngine).suggest
    else {
      remote = []
      return
    }
    try? await Task.sleep(nanoseconds: 150_000_000)
    if Task.isCancelled { return }
    let q = t.addingPercentEncoding(withAllowedCharacters: .urlQueryValueAllowed) ?? ""
    guard let url = URL(string: template.replacingOccurrences(of: "%s", with: q)) else { return }
    var req = URLRequest(url: url, timeoutInterval: 1.5)
    req.httpShouldHandleCookies = false
    guard let (data, _) = try? await URLSession.shared.data(for: req),
      let arr = try? JSONSerialization.jsonObject(with: data) as? [Any], arr.count > 1, let list = arr[1] as? [Any]
    else { return }
    if Task.isCancelled { return }
    remote = list.compactMap { $0 as? String }
    remoteFor = t
  }
}

struct NewTabView: View {
  @ObservedObject var tab: Tab
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var store: Store
  @EnvironmentObject var settings: SettingsStore

  var body: some View {
    let today = store.todayStats()
    let favorites = store.favorites(limit: 12)
    let frequent = tab.isPrivate ? [] : store.topSites(limit: 8)
    ScrollView {
      VStack(spacing: 28) {
        VStack(spacing: 10) {
          Image("Potato")
            .resizable()
            .scaledToFit()
            .frame(width: 64, height: 64)
            .accessibilityHidden(true)
          Text(tab.isPrivate ? "Private tab" : "Potato Browser")
            .font(.title2.bold())
          Text(tab.isPrivate ? "No history, no cookies kept. Your flags here go out under a throwaway id." : "Grown, not generated.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }
        .padding(.top, 40)

        Button {
          app.editingAddress = true
        } label: {
          HStack {
            Image(systemName: "magnifyingglass")
            Text("Search or enter address")
            Spacer()
          }
          .foregroundStyle(.secondary)
          .padding(.horizontal, 16)
          .frame(height: 48)
          .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("ntp-search")

        HStack(spacing: 12) {
          StatTile(value: today.shieldHidden, label: "AI features peeled off today", icon: "shield.lefthalf.filled")
          StatTile(value: today.adsBlocked, label: "ads and trackers mashed today", icon: "nosign")
        }
        .accessibilityIdentifier("ntp-stats")

        if !favorites.isEmpty {
          TileGrid(title: "Bookmarks", items: favorites.map { ($0.title, $0.url ?? "") }) { open($0) }
        }
        if !frequent.isEmpty {
          TileGrid(title: "Frequently visited", items: frequent.map { ($0.title, $0.url) }) { open($0) }
        }
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 40)
      .frame(maxWidth: 640)
      .frame(maxWidth: .infinity)
    }
    .background(Color(.systemBackground))
    .accessibilityIdentifier("new-tab-page")
  }

  private func open(_ url: String) {
    if let u = URL(string: url) { tab.load(u) }
  }
}

struct StatTile: View {
  let value: Int
  let label: String
  let icon: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Image(systemName: icon).foregroundStyle(Color.potato)
      Text("\(value)").font(.title.bold().monospacedDigit())
      Text(label).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
  }
}

struct TileGrid: View {
  let title: String
  let items: [(String, String)]
  let open: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).font(.headline)
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 14)], spacing: 16) {
        ForEach(items.indices, id: \.self) { i in
          let (name, url) = items[i]
          Button { open(url) } label: {
            VStack(spacing: 6) {
              Text(initial(name, url))
                .font(.title3.bold())
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(color(url), in: RoundedRectangle(cornerRadius: 14))
              Text(name.isEmpty ? URLInput.displayHost(URL(string: url)) : name)
                .font(.caption)
                .lineLimit(1)
                .foregroundStyle(.primary)
            }
          }
          .buttonStyle(.plain)
        }
      }
    }
  }

  private func initial(_ name: String, _ url: String) -> String {
    let host = URLInput.displayHost(URL(string: url))
    return String((host.isEmpty ? name : host).prefix(1)).uppercased()
  }

  private func color(_ url: String) -> Color {
    let palette: [Color] = [.orange, .brown, .teal, .indigo, .pink, .green, .blue, .purple]
    let h = URLInput.host(of: url).unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xffff }
    return palette[h % palette.count].opacity(0.85)
  }
}
