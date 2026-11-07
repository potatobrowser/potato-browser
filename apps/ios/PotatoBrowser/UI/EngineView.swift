import SwiftUI
import WebKit

/// Runs the Mac app's engine purity check on this device: which AI web APIs a page (its window,
/// a worker and an iframe) can reach in Potato Browser's web views.
@MainActor
final class EngineCheck: NSObject, ObservableObject, WKNavigationDelegate {
  struct Result: Equatable {
    var window: [String]
    var worker: [String]
    var frame: [String]
    var speech: String
  }

  @Published var result: Result?
  @Published var running = false
  private var web: WKWebView?
  private var loaded: CheckedContinuation<Void, Never>?

  func run(app: AppModel) async {
    running = true
    defer { running = false }
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    Tab.configure(config, test: app.isTest)
    config.userContentController.addUserScript(app.pageScript)
    let w = WKWebView(frame: CGRect(x: 0, y: 0, width: 10, height: 10), configuration: config)
    w.navigationDelegate = self
    web = w
    await withCheckedContinuation { cont in
      loaded = cont
      w.loadHTMLString("<!doctype html><title>check</title>", baseURL: URL(string: "https://engine-check.potatobrowser.com/"))
    }
    let names = WebResources.manifest.aiGlobals + ["navigator.ml"]
    let list = String(decoding: (try? JSONSerialization.data(withJSONObject: names)) ?? Data("[]".utf8), as: UTF8.self)
    let js = """
      const names = \(list);
      const present = (g) => names.filter(n => n === 'navigator.ml' ? !!(g.navigator && 'ml' in g.navigator) : n in g);
      const window_ = present(window);
      const src = 'const names = ' + JSON.stringify(names) + '; postMessage(names.filter(n => n === "navigator.ml" ? ("ml" in navigator) : n in self));';
      const worker = await new Promise(r => {
        try {
          const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
          w.onmessage = e => r(e.data); w.onerror = () => r(['(worker failed)']); setTimeout(() => r(['(timeout)']), 3000);
        } catch (e) { r(['(no worker)']); }
      });
      const f = document.createElement('iframe');
      document.body.appendChild(f);
      const frame = present(f.contentWindow);
      const C = window.SpeechRecognition || window.webkitSpeechRecognition || f.contentWindow.webkitSpeechRecognition;
      let speech = 'unavailable';
      if (C) {
        speech = await new Promise(res => { try { const r = new C(); r.onerror = e => res('denied (' + e.error + ')'); r.onstart = () => res('started'); r.start(); } catch (e) { res('denied'); } setTimeout(() => res('no answer'), 3000); });
      }
      return JSON.stringify({ window: window_, worker, frame, speech });
      """
    let out = try? await w.callAsyncJavaScript(js, contentWorld: .page) as? String
    if let data = out?.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      result = Result(window: obj["window"] as? [String] ?? [], worker: obj["worker"] as? [String] ?? [], frame: obj["frame"] as? [String] ?? [], speech: obj["speech"] as? String ?? "?")
    }
    web = nil
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    loaded?.resume()
    loaded = nil
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    loaded?.resume()
    loaded = nil
  }
}

struct EngineView: View {
  @EnvironmentObject var app: AppModel
  @StateObject private var check = EngineCheck()

  var body: some View {
    List {
      Section {
        Text("WebKit, the engine every iPhone browser runs on, has no switches like Chromium's. Potato Browser turns off what an app can turn off, removes the rest from every page, and checks the result on this device.")
          .font(.subheadline)
      }
      Section("Switched off") {
        row("Writing Tools in web pages", "Apple Intelligence rewriting and summaries in text fields")
        row("Inline predictive text", "On-device language model suggestions while typing")
        row("Genmoji in web pages", "Generated emoji images")
        row("Speech recognition", "The app does not ask for speech recognition, so WebKit refuses it")
        row("AI web APIs", "Prompt, Summarizer, Writer, Rewriter, Proofreader, Translator, Language Detector and WebNN are removed from every page and frame")
      }
      Section {
        if let r = check.result {
          result("Pages", r.window)
          result("Workers", r.worker)
          result("Frames", r.frame)
          LabeledContent("Speech recognition", value: r.speech)
        }
        Button(check.running ? "Checking..." : check.result == nil ? "Check this device" : "Check again") {
          Task { await check.run(app: app) }
        }
        .disabled(check.running)
        .accessibilityIdentifier("engine-check")
      } header: {
        Text("Check")
      } footer: {
        Text("Looks for \(WebResources.manifest.aiGlobals.count + 1) AI and speech recognition globals in a page, a worker and a frame. Apple Intelligence features of iOS itself, such as Siri or keyboard dictation, are outside any app's reach.")
      }
    }
    .navigationTitle("No AI in the engine")
    .task { if check.result == nil { await check.run(app: app) } }
  }

  private func row(_ title: String, _ detail: String) -> some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
        Text(detail).font(.footnote).foregroundStyle(.secondary)
      }
    } icon: {
      Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
    }
  }

  private func result(_ title: String, _ found: [String]) -> some View {
    LabeledContent(title) {
      if found.isEmpty {
        Label("No AI APIs", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
      } else {
        Text(found.joined(separator: ", ")).foregroundStyle(.red)
      }
    }
    .accessibilityIdentifier("engine-\(title.lowercased())")
  }
}
