import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A bookmark tree in a browser-neutral shape. */
export interface ImportedBookmark {
  title: string;
  url?: string;
  children?: ImportedBookmark[];
  addedAt?: number;
}

export interface ImportedBookmarks {
  bar: ImportedBookmark[];
  other: ImportedBookmark[];
}

export interface ImportedHistoryItem {
  url: string;
  title: string;
  visitCount: number;
  typedCount: number;
  lastVisit: number;
}

export const HISTORY_LIMIT = 25_000;

export function homeDir(): string {
  return process.env.NOAI_IMPORT_HOME || os.homedir();
}

export function appSupport(...parts: string[]): string {
  return path.join(homeDir(), 'Library', 'Application Support', ...parts);
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Distinguishes "missing" from "present but macOS blocks us" (Full Disk Access). */
export function accessState(p: string): 'ok' | 'missing' | 'blocked' {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    fs.closeSync(fs.openSync(p, 'r'));
    return 'ok';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return 'blocked';
    return 'missing';
  }
}

/**
 * Opens a copy of a browser's SQLite database: the browser may hold locks on the original, and
 * copying the WAL/journal alongside keeps the latest writes.
 */
export function withDbCopy<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noai-import-'));
  const copy = path.join(dir, path.basename(file));
  try {
    fs.copyFileSync(file, copy);
    for (const suffix of ['-wal', '-journal', '-shm']) {
      if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, copy + suffix);
    }
    const db = new DatabaseSync(copy);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function isImportableUrl(url: unknown): url is string {
  return typeof url === 'string' && /^(https?|ftp|file):/i.test(url) && url.length < 8192;
}

/** WebKit/Chrome timestamps: microseconds since 1601-01-01. */
export function fromWebkitTime(us: number | bigint | string | null | undefined): number {
  if (us === null || us === undefined || us === '') return 0;
  const n = typeof us === 'bigint' ? Number(us / 1000n) : Number(us) / 1000;
  const ms = Math.round(n - 11_644_473_600_000);
  return ms > 0 ? ms : 0;
}
