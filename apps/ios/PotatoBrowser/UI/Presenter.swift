import UIKit

/// UIKit dialogs for what WebKit asks (JavaScript alerts, logins) and the share sheet.
@MainActor
enum Presenter {
  static weak var app: AppModel?

  static var top: UIViewController? {
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
      ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    var vc = scene?.windows.first { $0.isKeyWindow }?.rootViewController ?? scene?.windows.first?.rootViewController
    while let p = vc?.presentedViewController { vc = p }
    return vc
  }

  static func alert(title: String, message: String, done: @escaping () -> Void) {
    let a = UIAlertController(title: title.isEmpty ? nil : title, message: message, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "OK", style: .default) { _ in done() })
    present(a, fallback: done)
  }

  static func confirm(title: String, message: String, action: String, done: @escaping (Bool) -> Void) {
    let a = UIAlertController(title: title.isEmpty ? nil : title, message: message, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done(false) })
    a.addAction(UIAlertAction(title: action, style: .default) { _ in done(true) })
    present(a) { done(false) }
  }

  static func prompt(title: String, message: String, text: String?, done: @escaping (String?) -> Void) {
    let a = UIAlertController(title: title.isEmpty ? nil : title, message: message, preferredStyle: .alert)
    a.addTextField { $0.text = text }
    a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done(nil) })
    a.addAction(UIAlertAction(title: "OK", style: .default) { _ in done(a.textFields?.first?.text ?? "") })
    present(a) { done(nil) }
  }

  static func login(host: String) async -> (String, String)? {
    await withCheckedContinuation { cont in
      let a = UIAlertController(title: "Sign in", message: "\(host) asks for a user name and password.", preferredStyle: .alert)
      a.addTextField {
        $0.placeholder = "User name"
        $0.textContentType = .username
        $0.autocapitalizationType = .none
      }
      a.addTextField {
        $0.placeholder = "Password"
        $0.isSecureTextEntry = true
        $0.textContentType = .password
      }
      a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in cont.resume(returning: nil) })
      a.addAction(UIAlertAction(title: "Sign In", style: .default) { _ in
        cont.resume(returning: (a.textFields?[0].text ?? "", a.textFields?[1].text ?? ""))
      })
      present(a) { cont.resume(returning: nil) }
    }
  }

  static func share(_ items: [Any]) {
    let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
    if let pop = vc.popoverPresentationController, let view = top?.view {
      pop.sourceView = view
      pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 60, width: 1, height: 1)
    }
    present(vc, fallback: {})
  }

  static func toast(_ text: String) {
    app?.showToast(text)
  }

  private static func present(_ vc: UIViewController, fallback: @escaping () -> Void) {
    guard let top else {
      fallback()
      return
    }
    top.present(vc, animated: true)
  }
}
