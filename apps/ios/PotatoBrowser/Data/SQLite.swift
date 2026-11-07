import Foundation
import SQLite3

enum SQLValue {
  case int(Int64)
  case double(Double)
  case text(String)
  case null
}

protocol SQLBindable { var sqlValue: SQLValue { get } }
extension Int: SQLBindable { var sqlValue: SQLValue { .int(Int64(self)) } }
extension Int64: SQLBindable { var sqlValue: SQLValue { .int(self) } }
extension Double: SQLBindable { var sqlValue: SQLValue { .double(self) } }
extension String: SQLBindable { var sqlValue: SQLValue { .text(self) } }
extension Bool: SQLBindable { var sqlValue: SQLValue { .int(self ? 1 : 0) } }
extension Optional: SQLBindable where Wrapped: SQLBindable {
  var sqlValue: SQLValue { self?.sqlValue ?? .null }
}

struct SQLRow {
  fileprivate let values: [String: SQLValue]
  func int(_ k: String) -> Int64 {
    switch values[k] {
    case .int(let v): v
    case .double(let v): Int64(v)
    case .text(let s): Int64(s) ?? 0
    default: 0
    }
  }
  func string(_ k: String) -> String {
    switch values[k] {
    case .text(let s): s
    case .int(let v): String(v)
    case .double(let v): String(v)
    default: ""
    }
  }
  func optionalInt(_ k: String) -> Int64? {
    if case .int(let v) = values[k] { return v }
    return nil
  }
  func optionalString(_ k: String) -> String? {
    if case .text(let s) = values[k] { return s }
    return nil
  }
}

struct SQLError: Error, CustomStringConvertible {
  let description: String
}

/// A small synchronous SQLite wrapper. Used from the main actor only.
final class SQLite {
  private var db: OpaquePointer?
  private var cache: [String: OpaquePointer] = [:]
  private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  init(path: String) throws {
    guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
      throw SQLError(description: "cannot open \(path)")
    }
    try exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")
  }

  deinit {
    for s in cache.values { sqlite3_finalize(s) }
    sqlite3_close_v2(db)
  }

  func exec(_ sql: String) throws {
    var err: UnsafeMutablePointer<CChar>?
    if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
      let msg = err.map { String(cString: $0) } ?? "error"
      sqlite3_free(err)
      throw SQLError(description: msg)
    }
  }

  private func statement(_ sql: String) throws -> OpaquePointer {
    if let s = cache[sql] {
      sqlite3_reset(s)
      sqlite3_clear_bindings(s)
      return s
    }
    var s: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &s, nil) == SQLITE_OK, let s else {
      throw SQLError(description: String(cString: sqlite3_errmsg(db)))
    }
    cache[sql] = s
    return s
  }

  private func bind(_ s: OpaquePointer, _ args: [SQLBindable]) {
    for (i, a) in args.enumerated() {
      let idx = Int32(i + 1)
      switch a.sqlValue {
      case .int(let v): sqlite3_bind_int64(s, idx, v)
      case .double(let v): sqlite3_bind_double(s, idx, v)
      case .text(let v): sqlite3_bind_text(s, idx, v, -1, Self.transient)
      case .null: sqlite3_bind_null(s, idx)
      }
    }
  }

  @discardableResult
  func runOrThrow(_ sql: String, _ args: [SQLBindable]) throws -> Int {
    let s = try statement(sql)
    bind(s, args)
    let rc = sqlite3_step(s)
    sqlite3_reset(s)
    guard rc == SQLITE_DONE || rc == SQLITE_ROW else { throw SQLError(description: String(cString: sqlite3_errmsg(db))) }
    return Int(sqlite3_changes(db))
  }

  /// Runs a statement; failures are logged, not thrown. Returns the changed row count.
  @discardableResult
  func run(_ sql: String, _ args: SQLBindable...) -> Int {
    do {
      return try runOrThrow(sql, args)
    } catch {
      print("sqlite:", error, sql.prefix(80))
      return 0
    }
  }

  func query(_ sql: String, _ args: SQLBindable...) -> [SQLRow] {
    guard let s = try? statement(sql) else { return [] }
    bind(s, args)
    var rows: [SQLRow] = []
    while sqlite3_step(s) == SQLITE_ROW {
      var values: [String: SQLValue] = [:]
      for i in 0..<sqlite3_column_count(s) {
        let name = String(cString: sqlite3_column_name(s, i))
        switch sqlite3_column_type(s, i) {
        case SQLITE_INTEGER: values[name] = .int(sqlite3_column_int64(s, i))
        case SQLITE_FLOAT: values[name] = .double(sqlite3_column_double(s, i))
        case SQLITE_TEXT: values[name] = .text(String(cString: sqlite3_column_text(s, i)))
        default: values[name] = .null
        }
      }
      rows.append(SQLRow(values: values))
    }
    sqlite3_reset(s)
    return rows
  }

  var lastInsertId: Int64 { sqlite3_last_insert_rowid(db) }

  func transaction(_ body: () throws -> Void) rethrows {
    try? exec("BEGIN")
    do {
      try body()
      try? exec("COMMIT")
    } catch {
      try? exec("ROLLBACK")
      throw error
    }
  }
}
