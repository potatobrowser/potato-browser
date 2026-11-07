import Foundation
import WebKit

/// Downloads go to Documents/Downloads, which the Files app shows under On My iPhone > Potato.
@MainActor
final class DownloadManager: NSObject, ObservableObject {
  @Published private(set) var items: [DownloadRecord] = []
  private let store: Store
  let folder: URL
  private var active: [ObjectIdentifier: (download: WKDownload, id: String, observation: NSKeyValueObservation?)] = [:]

  init(store: Store, directory: URL) {
    self.store = store
    folder = directory.appendingPathComponent("Downloads", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    super.init()
    // Downloads cut off by the app quitting are failed, not running.
    items = store.downloads().map { d in
      var d = d
      if d.state == "progressing" {
        d.state = "interrupted"
        store.saveDownload(d)
      }
      return d
    }
  }

  var activeCount: Int { items.filter { $0.state == "progressing" }.count }

  func track(_ download: WKDownload) {
    download.delegate = self
    let id = UUID().uuidString
    let record = DownloadRecord(id: id, url: download.originalRequest?.url?.absoluteString ?? "", filename: "Download", path: "", state: "progressing", received: 0, total: 0, startedAt: Date())
    items.insert(record, at: 0)
    store.saveDownload(record)
    let obs = download.progress.observe(\.completedUnitCount, options: [.new]) { [weak self] p, _ in
      Task { @MainActor in self?.update(id) { $0.received = p.completedUnitCount; $0.total = max(p.totalUnitCount, 0) } }
    }
    active[ObjectIdentifier(download)] = (download, id, obs)
  }

  private func update(_ id: String, _ change: (inout DownloadRecord) -> Void) {
    guard let i = items.firstIndex(where: { $0.id == id }) else { return }
    change(&items[i])
    if items[i].state != "progressing" || items[i].received == items[i].total { store.saveDownload(items[i]) }
  }

  private func uniqueURL(for name: String) -> URL {
    let clean = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
    let base = (clean as NSString).deletingPathExtension
    let ext = (clean as NSString).pathExtension
    var url = folder.appendingPathComponent(clean.isEmpty ? "Download" : clean)
    var n = 2
    while FileManager.default.fileExists(atPath: url.path) {
      url = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
      n += 1
    }
    return url
  }

  func cancel(_ id: String) {
    guard let entry = active.values.first(where: { $0.id == id }) else { return }
    entry.download.cancel(nil)
  }

  func remove(_ id: String) {
    if let d = items.first(where: { $0.id == id }), !d.path.isEmpty { try? FileManager.default.removeItem(atPath: d.path) }
    items.removeAll { $0.id == id }
    store.deleteDownload(id)
  }

  func clearFinished() {
    items.removeAll { $0.state != "progressing" }
    store.clearDownloads()
  }

  func fileURL(_ d: DownloadRecord) -> URL? {
    guard !d.path.isEmpty, FileManager.default.fileExists(atPath: d.path) else { return nil }
    return URL(fileURLWithPath: d.path)
  }
}

extension DownloadManager: WKDownloadDelegate {
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
    let url = uniqueURL(for: suggestedFilename)
    if let entry = active[ObjectIdentifier(download)] {
      update(entry.id) {
        $0.filename = url.lastPathComponent
        $0.path = url.path
        $0.total = max(response.expectedContentLength, 0)
      }
    }
    return url
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let entry = active.removeValue(forKey: ObjectIdentifier(download)) else { return }
    update(entry.id) {
      $0.state = "completed"
      if $0.total == 0 { $0.total = $0.received }
    }
    if let name = items.first(where: { $0.id == entry.id })?.filename { Presenter.toast("Downloaded \(name)") }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    guard let entry = active.removeValue(forKey: ObjectIdentifier(download)) else { return }
    let cancelled = (error as NSError).code == NSURLErrorCancelled
    update(entry.id) { $0.state = cancelled ? "cancelled" : "interrupted" }
  }
}
