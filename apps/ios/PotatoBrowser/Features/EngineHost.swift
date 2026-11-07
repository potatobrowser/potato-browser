import Foundation
import JavaScriptCore

/// The ad blocker's Ghostery engine (WebResources/js/engine.js) in a private JavaScriptCore
/// context, used from one serial queue. Big answers come back as JSON text.
final class EngineHost: @unchecked Sendable {
  private let queue = DispatchQueue(label: "com.potatobrowser.engine", qos: .userInitiated)
  private var context: JSContext?
  private var api: JSValue?
  private var call: JSValue?
  private(set) var lastError: String?

  private func onQueue<T>(_ body: @escaping () -> T) async -> T {
    await withCheckedContinuation { cont in queue.async { cont.resume(returning: body()) } }
  }

  func start() async {
    await onQueue { self.setUp() }
  }

  private func setUp() {
    guard context == nil, let ctx = JSContext() else { return }
    ctx.name = "Potato ad blocker"
    ctx.exceptionHandler = { [weak self] _, e in self?.lastError = e?.toString() }
    let log: @convention(block) (String) -> Void = { print("engine:", $0) }
    ctx.setObject(log, forKeyedSubscript: "__potatoLog" as NSString)
    ctx.evaluateScript(WebResources.engineScript)
    ctx.evaluateScript("globalThis.__call = (name, args) => JSON.stringify(PotatoEngine[name](...args) ?? null);")
    context = ctx
    api = ctx.objectForKeyedSubscript("PotatoEngine")
    call = ctx.objectForKeyedSubscript("__call")
  }

  private func json(_ name: String, _ args: [Any]) -> String? {
    guard let call else { return nil }
    let r = call.call(withArguments: [name, args])
    return r?.isString == true ? r?.toString() : nil
  }

  /// Loads a serialized engine; returns its filter count (0 on failure).
  func load(id: String, data: Data) async -> Int {
    await onQueue {
      self.setUp()
      guard let ctx = self.context, let bytes = Self.typedArray(ctx, data) else { return 0 }
      return Int(self.api?.invokeMethod("load", withArguments: [id, bytes])?.toInt32() ?? 0)
    }
  }

  func unload(id: String) async {
    await onQueue { _ = self.api?.invokeMethod("unload", withArguments: [id]) }
  }

  /// Cosmetics for a document, as JSON (`null` when there are none).
  func cosmeticsJSON(ids: [String], url: String) async -> String {
    await onQueue { self.json("cosmetics", [ids, url]) ?? "null" }
  }

  func domRules(ids: [String], url: String, dom: [String: [String]]) async -> String {
    await onQueue {
      guard let s = self.json("domRules", [ids, url, dom]), let data = s.data(using: .utf8) else { return "" }
      return (try? JSONDecoder().decode(String.self, from: data)) ?? ""
    }
  }

  /// Hostnames of the resources (url, type) the filters block on a page at `source`.
  func blocked(ids: [String], source: String, items: [[String: String]]) async -> [String] {
    await onQueue {
      guard let s = self.json("blocked", [ids, source, items]), let data = s.data(using: .utf8) else { return [] }
      return (try? JSONDecoder().decode([String].self, from: data)) ?? []
    }
  }

  /// Builds an engine from list texts (for list updates and the user's own filters).
  func compile(lists: [(id: String, text: String)], resources: String, custom: String = "") async -> Data? {
    await onQueue {
      self.setUp()
      guard let ctx = self.context else { return nil }
      let arg = lists.map { ["id": $0.id, "text": $0.text] }
      guard let value = self.api?.invokeMethod("compile", withArguments: [arg, resources, custom]) else { return nil }
      return Self.bytes(ctx, value)
    }
  }

  struct RuleListJSON: Decodable {
    let json: String
    let rules: Int
  }

  /// WebKit rule lists per group from list texts; `custom` adds the user's own as "custom".
  func ruleLists(groups: [(id: String, lists: [String])], custom: String = "") async -> [String: RuleListJSON] {
    await onQueue {
      self.setUp()
      let arg = groups.map { ["id": $0.id, "lists": $0.lists] as [String: Any] }
      guard let s = self.json("ruleLists", [arg, custom]), let data = s.data(using: .utf8) else { return [:] }
      return (try? JSONDecoder().decode([String: RuleListJSON].self, from: data)) ?? [:]
    }
  }

  // MARK: Typed arrays

  static func typedArray(_ ctx: JSContext, _ data: Data) -> JSValue? {
    let count = data.count
    let ptr = UnsafeMutableRawPointer.allocate(byteCount: max(count, 1), alignment: 8)
    data.copyBytes(to: ptr.assumingMemoryBound(to: UInt8.self), count: count)
    var exception: JSValueRef?
    let ref = JSObjectMakeTypedArrayWithBytesNoCopy(ctx.jsGlobalContextRef, kJSTypedArrayTypeUint8Array, ptr, count, { bytes, _ in bytes?.deallocate() }, nil, &exception)
    return ref.map { JSValue(jsValueRef: $0, in: ctx) }
  }

  static func bytes(_ ctx: JSContext, _ value: JSValue) -> Data? {
    guard let obj = value.jsValueRef.flatMap({ JSValueToObject(ctx.jsGlobalContextRef, $0, nil) }) else { return nil }
    var exception: JSValueRef?
    let count = JSObjectGetTypedArrayByteLength(ctx.jsGlobalContextRef, obj, &exception)
    guard count > 0, let ptr = JSObjectGetTypedArrayBytesPtr(ctx.jsGlobalContextRef, obj, &exception) else { return nil }
    let offset = JSObjectGetTypedArrayByteOffset(ctx.jsGlobalContextRef, obj, &exception)
    return Data(bytes: ptr.advanced(by: offset), count: count)
  }
}
