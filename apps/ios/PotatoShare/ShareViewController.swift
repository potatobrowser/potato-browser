import UIKit

/// "Open in Potato": hands the shared page to the app through its URL scheme and goes away.
final class ShareViewController: UIViewController {
  private var link: URL?
  private var read = false
  private var appeared = false
  private var handedOver = false
  private var finished = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
    Task { @MainActor in
      link = await SharedLink.page(in: items).flatMap(AppLink.link(opening:))
      read = true
      handOver()
    }
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    appeared = true
    handOver()
  }

  /// Runs once the share is read and this view is on screen: only then does the responder chain
  /// reach the extension's UIApplication, whose open(_:) is what launches the app (iOS 18 and up).
  private func handOver() {
    guard read, appeared, !handedOver else { return }
    handedOver = true
    guard let link else { return nothingToOpen() }
    var responder: UIResponder? = self
    while let r = responder, !(r is UIApplication) { responder = r.next }
    if let application = responder as? UIApplication {
      application.open(link, options: [:]) { [weak self] _ in self?.finish() }
    } else {
      extensionContext?.open(link) { [weak self] _ in Task { @MainActor in self?.finish() } }
    }
  }

  private func finish() {
    guard !finished else { return }
    finished = true
    extensionContext?.completeRequest(returningItems: nil)
  }

  private func nothingToOpen() {
    let alert = UIAlertController(title: "No web link here", message: "Potato opens web pages, and this share has none.", preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
      self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
    })
    present(alert, animated: true)
  }
}
