import SwiftUI

struct SettingsView: View {
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var settings: SettingsStore
  @EnvironmentObject var adblock: AdblockService
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss

  private func bind<T>(_ key: WritableKeyPath<Settings, T>) -> Binding<T> {
    Binding(get: { settings.value[keyPath: key] }, set: { v in settings.update { $0[keyPath: key] = v } })
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Search engine", selection: bind(\.searchEngine)) {
            ForEach(SearchEngine.all) { Text($0.name).tag($0.id) }
          }
          .accessibilityIdentifier("search-engine")
          Toggle("Search suggestions", isOn: bind(\.searchSuggestions))
          Picker("On startup", selection: bind(\.startup)) {
            Text("Continue where you left off").tag(StartupMode.restore)
            Text("Open a new tab").tag(StartupMode.newtab)
          }
          Picker("Appearance", selection: bind(\.theme)) {
            Text("System").tag(Theme.system)
            Text("Light").tag(Theme.light)
            Text("Dark").tag(Theme.dark)
          }
        } header: {
          Text("General")
        } footer: {
          if let note = SearchEngine.get(settings.value.searchEngine).note { Text(note) }
        }

        Section {
          Toggle("Hide AI features on websites", isOn: bind(\.shield.enabled))
            .accessibilityIdentifier("shield-global")
          NavigationLink("AI features by site") { ShieldRulesView() }
          NavigationLink {
            SiteListView(title: "Sites where AI features are shown", empty: "None. Every AI feature we know of is peeled off, everywhere.", sites: bind(\.shield.disabledSites))
          } label: {
            LabeledContent("Sites where AI features are shown", value: "\(settings.value.shield.disabledSites.count)")
          }
        } header: {
          Text("AI Shield")
        } footer: {
          Text("Peels the AI features off the websites you visit: AI summaries, chat assistants, AI writing buttons and AI search modes. The shield button in the address bar brings them back on a single site.")
        }

        Section {
          Toggle("Block ads", isOn: bind(\.adblock.enabled))
            .accessibilityIdentifier("adblock-global")
          Group {
            Toggle(isOn: bind(\.adblock.trackers)) { described("Block trackers", "Analytics, tracking pixels and fingerprinting scripts that follow you from site to site.") }
            Toggle(isOn: bind(\.adblock.cookieNotices)) { described("Hide cookie notices", "Removes most cookie consent banners. Sites then usually act as if you made no choice.") }
            Toggle(isOn: bind(\.adblock.annoyances)) { described("Hide annoyances", "Newsletter pop-ups, open-in-app banners, chat bubbles and similar clutter.") }
          }
          .disabled(!settings.value.adblock.enabled)
          NavigationLink {
            SiteListView(title: "Sites where ads are allowed", empty: "None. Ads get mashed everywhere.", sites: bind(\.adblock.disabledSites))
          } label: {
            LabeledContent("Sites where ads are allowed", value: "\(settings.value.adblock.disabledSites.count)")
          }
          NavigationLink("Your own filters") { CustomFiltersView() }
          NavigationLink("Filter lists") { FilterListsView() }
        } header: {
          Text("Ad blocker")
        } footer: {
          Text("Mashes ads and trackers before they load: banners, video ads, pop-ups, tracking pixels and the scripts behind them. It uses the EasyList, EasyPrivacy and uBlock Origin filter lists.")
        }

        Section {
          Picker("Posts flagged as AI-generated", selection: bind(\.flags.mode)) {
            Text("Bury them").tag(FlagMode.hide)
            Text("Label them").tag(FlagMode.label)
            Text("Leave them").tag(FlagMode.ignore)
          }
          .accessibilityIdentifier("flag-mode")
          Stepper(value: bind(\.flags.threshold), in: 1...100) {
            LabeledContent("Flags needed", value: "\(settings.value.flags.threshold)")
          }
          Toggle(isOn: bind(\.flags.showButtons)) {
            described("Show flag buttons on posts", store.myFlagCount() > 0 ? "You have flagged \(store.myFlagCount()) \(store.myFlagCount() == 1 ? "post" : "posts"). Sharp eyes." : "No flags from you yet. Keep your eyes peeled.")
          }
          NavigationLink("Sites") { FlagPlatformsView() }
        } header: {
          Text("AI flags")
        } footer: {
          Text(flagModeText + " People flag posts they think are AI-generated. Flags are anonymous: no account, and when the browser checks posts it sends only short hash prefixes that thousands of other posts share, never the posts or the page.")
        }

        Section {
          Toggle(isOn: bind(\.privacy.globalPrivacyControl)) { described("Send Global Privacy Control", "Tells websites not to sell or share your data.") }
          Toggle(isOn: bind(\.privacy.blockAiChatbots)) { described("Block AI chatbot sites", "ChatGPT, Gemini, Claude, Copilot, Perplexity and others. You can still open them once from the block page.") }
            .accessibilityIdentifier("block-chatbots")
          NavigationLink("Clear browsing data") { ClearDataView() }
        } header: {
          Text("Privacy")
        }

        Section {
          NavigationLink("No AI in the engine") { EngineView() }
          NavigationLink("Import bookmarks and history") { ImportView() }
        }

        Section {
          LabeledContent("Version", value: Bundle.main.versionString)
          Link("potatobrowser.com", destination: URL(string: "https://potatobrowser.com")!)
          Link("Source code", destination: URL(string: "https://github.com/potatobrowser/potato-browser")!)
          LabeledContent("Anonymous flag id", value: String(settings.value.installId.prefix(8)) + "...")
        } header: {
          Text("About Potato Browser")
        } footer: {
          Text("Open source under the MIT license. The flag id is random and used only to count your flags once; the server stores it as a keyed hash, scrambled beyond recognition.")
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.bold() }
      }
    }
  }

  private var flagModeText: String {
    switch settings.value.flags.mode {
    case .hide: "Bury them: tucked behind a notice. One tap digs them up."
    case .label: "Label them: shown with an amber outline, like a sticker on the sack."
    case .ignore: "Leave them: shown as usual. You can still flag posts for everyone else."
    }
  }

  private func described(_ title: String, _ detail: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title)
      Text(detail).font(.footnote).foregroundStyle(.secondary)
    }
  }
}

extension Bundle {
  var versionString: String {
    let v = infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
    let b = infoDictionary?["CFBundleVersion"] as? String ?? "?"
    return "\(v) (\(b))"
  }
}

struct SiteListView: View {
  let title: String
  let empty: String
  @Binding var sites: [String]

  var body: some View {
    List {
      if sites.isEmpty {
        Text(empty).foregroundStyle(.secondary)
      }
      ForEach(sites, id: \.self) { Text($0) }
        .onDelete { sites.remove(atOffsets: $0) }
    }
    .navigationTitle(title)
    .toolbar { if !sites.isEmpty { EditButton() } }
  }
}

struct ShieldRulesView: View {
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var settings: SettingsStore

  var body: some View {
    List {
      ForEach(app.shield.rules.filter { !$0.features.isEmpty }) { rule in
        Section(rule.site) {
          ForEach(rule.features) { f in
            Toggle(f.name, isOn: Binding(get: {
              let d = settings.value.shield.disabledRules
              return !d.contains(rule.id) && !d.contains("\(rule.id):\(f.id)")
            }, set: { on in
              settings.update { s in
                let key = "\(rule.id):\(f.id)"
                s.shield.disabledRules.removeAll { $0 == key }
                if !on { s.shield.disabledRules.append(key) }
              }
            }))
          }
        }
      }
    }
    .navigationTitle("AI features by site")
  }
}

struct FlagPlatformsView: View {
  @EnvironmentObject var settings: SettingsStore

  var body: some View {
    List {
      Section {
        ForEach(FlagPlatform.all) { p in
          Toggle(p.label, isOn: Binding(get: { !settings.value.flags.disabledPlatforms.contains(p.id) }, set: { on in
            settings.update { s in
              s.flags.disabledPlatforms.removeAll { $0 == p.id }
              if !on { s.flags.disabledPlatforms.append(p.id) }
            }
          }))
        }
      } footer: {
        Text("Flag buttons and hiding work on these sites' websites in Potato Browser. Their apps are out of a browser's reach.")
      }
    }
    .navigationTitle("Sites")
  }
}

struct CustomFiltersView: View {
  @EnvironmentObject var settings: SettingsStore
  @EnvironmentObject var adblock: AdblockService
  @State private var text = ""

  var body: some View {
    Form {
      Section {
        TextEditor(text: $text)
          .font(.system(.footnote, design: .monospaced))
          .frame(minHeight: 220)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .accessibilityIdentifier("custom-filters")
      } footer: {
        Text("One filter per line, in uBlock Origin syntax, for example ||ads.example.com^ or example.com##.newsletter-popup. Exceptions (@@) here undo your own filters.")
      }
      ForEach(adblock.customErrors, id: \.self) { Text($0).font(.footnote).foregroundStyle(.red) }
      Section {
        Button("Save") { settings.update { $0.adblock.customFilters = text } }
          .disabled(text == settings.value.adblock.customFilters)
      }
    }
    .navigationTitle("Your own filters")
    .onAppear { text = settings.value.adblock.customFilters }
  }
}

struct FilterListsView: View {
  @EnvironmentObject var settings: SettingsStore
  @EnvironmentObject var adblock: AdblockService

  var body: some View {
    List {
      Section {
        LabeledContent("Rules in use", value: adblock.ruleCount.formatted())
        if !adblock.compiling.isEmpty {
          Label("Compiling \(adblock.compiling.sorted().joined(separator: ", "))", systemImage: "hourglass")
        }
        Toggle(isOn: Binding(get: { settings.value.adblock.autoUpdate }, set: { v in settings.update { $0.adblock.autoUpdate = v } })) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Update filter lists automatically")
            Text("Once a day, through potatobrowser.com. The request names the lists and nothing about you.").font(.footnote).foregroundStyle(.secondary)
          }
        }
        Button(adblock.updating ? "Checking..." : "Update now") { Task { await adblock.checkForUpdates() } }
          .disabled(adblock.updating)
        if let last = adblock.lastCheck {
          LabeledContent("Last checked", value: last.formatted(date: .abbreviated, time: .shortened))
        }
        if let err = adblock.lastError { Text(err).font(.footnote).foregroundStyle(.orange) }
      }
      Section("Lists") {
        ForEach(adblock.listInfo) { l in
          VStack(alignment: .leading, spacing: 2) {
            Text(l.name)
            if let d = l.updated { Text("Updated \(d.formatted(date: .abbreviated, time: .omitted))").font(.footnote).foregroundStyle(.secondary) }
          }
        }
      }
    }
    .navigationTitle("Filter lists")
  }
}

struct ClearDataView: View {
  @EnvironmentObject var app: AppModel
  @State private var range = 0
  @State private var history = true
  @State private var siteData = true
  @State private var done = false

  private let ranges: [(String, TimeInterval?)] = [("Last hour", 3600), ("Last 24 hours", 86400), ("Last 7 days", 604_800), ("All time", nil)]

  var body: some View {
    Form {
      Picker("Time range", selection: $range) {
        ForEach(ranges.indices, id: \.self) { Text(ranges[$0].0).tag($0) }
      }
      Toggle("Browsing history", isOn: $history)
      Toggle("Cookies, site data and cached files", isOn: $siteData)
      Button("Clear browsing data", role: .destructive) {
        let since = ranges[range].1.map { Date().addingTimeInterval(-$0) }
        Task {
          await app.clearBrowsingData(since: since, history: history, siteData: siteData)
          done = true
        }
      }
      .disabled(!history && !siteData)
      if done { Text("Cleared. Fresh as a new potato.").foregroundStyle(.secondary) }
    }
    .navigationTitle("Clear browsing data")
  }
}
