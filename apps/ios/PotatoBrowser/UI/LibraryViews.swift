import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct HistoryView: View {
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var tabs: TabManager
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""

  var body: some View {
    let _ = store.historyVersion
    let entries = store.history(matching: query)
    let days = Dictionary(grouping: entries) { Calendar.current.startOfDay(for: $0.time) }
    List {
      if entries.isEmpty {
        Text(query.isEmpty ? "No history yet. Every page you visit lands here, except in private tabs." : "Nothing matches.").foregroundStyle(.secondary)
      }
      ForEach(days.keys.sorted(by: >), id: \.self) { day in
        Section(day.formatted(date: .complete, time: .omitted)) {
          ForEach(days[day] ?? []) { e in
            Button {
              open(e.url)
            } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(e.title.isEmpty ? e.url : e.title).lineLimit(1).foregroundStyle(.primary)
                Text("\(e.time.formatted(date: .omitted, time: .shortened))  \(URLInput.displayHost(URL(string: e.url)))").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
              }
            }
            .swipeActions { Button("Delete", role: .destructive) { store.deleteVisit(e.id) } }
            .contextMenu {
              Button("Open in New Tab", systemImage: "plus.square.on.square") {
                if let u = URL(string: e.url) { tabs.newTab(url: u, isPrivate: false) }
                dismiss()
              }
              Button("Copy Link", systemImage: "doc.on.doc") { UIPasteboard.general.string = e.url }
            }
          }
        }
      }
    }
    .searchable(text: $query, prompt: "Search history")
    .navigationTitle("History")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Menu("Clear") {
          Button("Last hour") { store.clearHistory(since: Date().addingTimeInterval(-3600)) }
          Button("Today") { store.clearHistory(since: Calendar.current.startOfDay(for: Date())) }
          Button("All history", role: .destructive) { store.clearHistory(since: nil) }
        }
      }
      ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.bold() }
    }
  }

  private func open(_ url: String) {
    guard let u = URL(string: url) else { return }
    if let tab = tabs.selected, !tab.isPrivate { tab.load(u) } else { tabs.newTab(url: u, isPrivate: false) }
    dismiss()
  }
}

struct BookmarksView: View {
  let folder: Int64
  let title: String
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var tabs: TabManager
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss
  @State private var editing: Bookmark?
  @State private var newFolder = false
  @State private var folderName = ""

  var body: some View {
    let _ = store.bookmarksVersion
    let items = store.bookmarks(in: folder)
    List {
      if items.isEmpty {
        Text("No bookmarks here yet. Add one from the menu on any page.").foregroundStyle(.secondary)
      }
      ForEach(items) { b in
        Group {
          if b.isFolder {
            NavigationLink {
              BookmarksView(folder: b.id, title: b.title)
            } label: {
              Label(b.title, systemImage: "folder")
            }
          } else {
            Button {
              if let u = b.url.flatMap(URL.init(string:)) {
                if let tab = tabs.selected { tab.load(u) } else { tabs.newTab(url: u) }
              }
              app.panel = nil
            } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(b.title).foregroundStyle(.primary).lineLimit(1)
                Text(URLInput.displayHost(b.url.flatMap(URL.init(string:)))).font(.footnote).foregroundStyle(.secondary)
              }
            }
          }
        }
        .swipeActions {
          Button("Delete", role: .destructive) { store.deleteBookmark(b.id) }
          Button("Edit") { editing = b }.tint(.orange)
        }
      }
      .onMove { store.moveBookmarks(in: folder, from: $0, to: $1) }
    }
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        if folder == Store.bookmarksRoot { Button("Done") { app.panel = nil }.bold() }
      }
      ToolbarItemGroup(placement: .bottomBar) {
        Button("New Folder") {
          folderName = ""
          newFolder = true
        }
        Spacer()
        EditButton()
      }
    }
    .sheet(item: $editing) { b in EditBookmarkView(bookmark: b) }
    .alert("New Folder", isPresented: $newFolder) {
      TextField("Name", text: $folderName)
      Button("Cancel", role: .cancel) {}
      Button("Add") { if !folderName.isEmpty { store.addBookmark(url: nil, title: folderName, parent: folder) } }
    }
  }
}

struct EditBookmarkView: View {
  let bookmark: Bookmark
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var url = ""
  @State private var parent: Int64 = Store.bookmarksRoot

  var body: some View {
    NavigationStack {
      Form {
        TextField("Title", text: $title)
        if !bookmark.isFolder {
          TextField("Address", text: $url).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
        }
        FolderPicker(selection: $parent, excluding: bookmark.isFolder ? bookmark.id : nil)
      }
      .navigationTitle(bookmark.isFolder ? "Edit Folder" : "Edit Bookmark")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            store.updateBookmark(bookmark.id, title: title, url: bookmark.isFolder ? nil : url, parent: parent)
            dismiss()
          }
        }
      }
      .onAppear {
        title = bookmark.title
        url = bookmark.url ?? ""
        parent = bookmark.parentId ?? Store.bookmarksRoot
      }
    }
  }
}

struct FolderPicker: View {
  @Binding var selection: Int64
  var excluding: Int64? = nil
  @EnvironmentObject var store: Store

  var body: some View {
    Picker("Folder", selection: $selection) {
      ForEach(store.allFolders().filter { $0.id != excluding }) { f in
        Text(f.id == Store.bookmarksRoot ? "Bookmarks" : f.title).tag(f.id)
      }
    }
  }
}

struct AddBookmarkView: View {
  @ObservedObject var tab: Tab
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var store: Store
  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var parent: Int64 = Store.bookmarksRoot

  var body: some View {
    NavigationStack {
      Form {
        TextField("Title", text: $title).accessibilityIdentifier("bookmark-title")
        Text(tab.url?.absoluteString ?? "").font(.footnote).foregroundStyle(.secondary).lineLimit(2)
        FolderPicker(selection: $parent)
      }
      .navigationTitle("Add Bookmark")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            if let url = tab.url { store.addBookmark(url: url.absoluteString, title: title.isEmpty ? url.absoluteString : title, parent: parent) }
            app.showToast("Bookmarked")
            dismiss()
          }
          .accessibilityIdentifier("bookmark-save")
        }
      }
      .onAppear { title = tab.displayTitle }
    }
  }
}

struct DownloadsView: View {
  @EnvironmentObject var app: AppModel
  @EnvironmentObject var downloads: DownloadManager
  @Environment(\.dismiss) private var dismiss
  @State private var preview: URL?

  var body: some View {
    List {
      if downloads.items.isEmpty {
        Text("No downloads yet. Files you download are kept in the Files app, under On My iPhone, Potato.").foregroundStyle(.secondary)
      }
      ForEach(downloads.items) { d in
        Button {
          if let url = downloads.fileURL(d) { preview = url }
        } label: {
          HStack(spacing: 12) {
            Image(systemName: d.state == "completed" ? "doc" : d.state == "progressing" ? "arrow.down.circle" : "exclamationmark.circle")
              .foregroundStyle(d.state == "completed" ? Color.potato : .secondary)
            VStack(alignment: .leading, spacing: 4) {
              Text(d.filename).lineLimit(1).foregroundStyle(.primary)
              if d.state == "progressing" {
                ProgressView(value: d.total > 0 ? Double(d.received) / Double(d.total) : 0)
              } else {
                Text(status(d)).font(.footnote).foregroundStyle(.secondary)
              }
            }
          }
        }
        .swipeActions {
          if d.state == "progressing" {
            Button("Cancel", role: .destructive) { downloads.cancel(d.id) }
          } else {
            Button("Delete", role: .destructive) { downloads.remove(d.id) }
            if let url = downloads.fileURL(d) { Button("Share") { Presenter.share([url]) }.tint(.blue) }
          }
        }
      }
    }
    .navigationTitle("Downloads")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button("Show in Files") {
          if let url = URL(string: "shareddocuments://" + downloads.folder.path) { UIApplication.shared.open(url) }
        }
      }
      ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.bold() }
    }
    .quickLookPreview($preview)
  }

  private func status(_ d: DownloadRecord) -> String {
    let size = ByteCountFormatter.string(fromByteCount: max(d.total, d.received), countStyle: .file)
    switch d.state {
    case "completed": return "\(size), \(d.startedAt.formatted(date: .abbreviated, time: .shortened))"
    case "cancelled": return "Cancelled"
    default: return "Failed"
    }
  }
}

struct ImportView: View {
  @EnvironmentObject var store: Store
  @State private var picking = false
  @State private var result: Importer.Result?

  var body: some View {
    List {
      Section {
        Text("Replant your bookmarks and history here. Passwords and cookies stay where they are.")
        Button("Choose a file") { picking = true }
          .accessibilityIdentifier("import-choose")
      } footer: {
        Text("From Safari: Settings > Apps > Safari > Export, then pick the ZIP file it saves. From other browsers: export bookmarks as an HTML file and pick that.")
      }
      if let r = result {
        Section("Result") {
          if r.bookmarks > 0 { Label("\(r.bookmarks) bookmarks imported", systemImage: "book") }
          if r.history > 0 { Label("\(r.history) history entries imported", systemImage: "clock") }
          ForEach(r.errors, id: \.self) { Text($0).foregroundStyle(.orange) }
        }
      }
    }
    .navigationTitle("Import")
    .fileImporter(isPresented: $picking, allowedContentTypes: [.zip, .html, .json, .data], allowsMultipleSelection: false) { res in
      if case .success(let urls) = res, let url = urls.first { result = Importer.importFile(url, into: store) }
    }
  }
}
