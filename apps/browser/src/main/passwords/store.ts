import type { DatabaseSync } from 'node:sqlite';
import type { LoginInfo } from '../../shared/types';
import { hostOfOrigin, siteOfOrigin } from './match';

/** Encrypts secrets; in the app it is Electron's safeStorage, keyed from the macOS Keychain. */
export interface Cipher {
  encrypt(plain: string): Promise<Buffer>;
  /** `stale`: the key was rotated and the value should be encrypted again. */
  decrypt(data: Buffer): Promise<{ text: string; stale?: boolean }>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS logins (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,
  site TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  password BLOB NOT NULL,
  note BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL DEFAULT 0,
  times_used INTEGER NOT NULL DEFAULT 0,
  UNIQUE (origin, username)
);
CREATE INDEX IF NOT EXISTS logins_site ON logins(site);
`;

type Row = Record<string, any>;

const COLS = 'id, origin, username, created_at, updated_at, last_used, times_used, note IS NOT NULL AS has_note';

function info(r: Row): LoginInfo {
  return {
    id: Number(r.id),
    origin: r.origin,
    host: hostOfOrigin(r.origin),
    username: r.username,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastUsed: Number(r.last_used),
    timesUsed: Number(r.times_used),
    hasNote: !!r.has_note,
  };
}

export class DuplicateLoginError extends Error {
  constructor() {
    super('A password for this website and username is already saved.');
  }
}

/**
 * Saved logins. Websites and usernames are plain (they are needed to find matches without
 * touching the Keychain); passwords and notes are encrypted.
 */
export class LoginStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: Cipher,
  ) {
    db.exec(SCHEMA);
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM logins').get() as Row).n);
  }

  list(): LoginInfo[] {
    return (this.db.prepare(`SELECT ${COLS} FROM logins ORDER BY site, origin, username`).all() as Row[]).map(info);
  }

  get(id: number): LoginInfo | null {
    const r = this.db.prepare(`SELECT ${COLS} FROM logins WHERE id = ?`).get(id) as Row | undefined;
    return r ? info(r) : null;
  }

  find(origin: string, username: string): LoginInfo | null {
    const r = this.db.prepare(`SELECT ${COLS} FROM logins WHERE origin = ? AND username = ?`).get(origin, username) as Row | undefined;
    return r ? info(r) : null;
  }

  /** Everything saved on the same registrable domain (callers narrow it with matchKind). */
  forSite(site: string): LoginInfo[] {
    if (!site) return [];
    return (this.db.prepare(`SELECT ${COLS} FROM logins WHERE site = ? ORDER BY last_used DESC, times_used DESC, username`).all(site) as Row[]).map(info);
  }

  async add(l: { origin: string; username: string; password: string; note?: string }): Promise<number> {
    if (this.find(l.origin, l.username)) throw new DuplicateLoginError();
    const now = Date.now();
    const pw = await this.cipher.encrypt(l.password);
    const note = l.note ? await this.cipher.encrypt(l.note) : null;
    const r = this.db
      .prepare('INSERT INTO logins (origin, site, username, password, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(l.origin, siteOfOrigin(l.origin), l.username, pw, note, now, now);
    return Number(r.lastInsertRowid);
  }

  async update(id: number, patch: { username?: string; password?: string; note?: string }): Promise<void> {
    const cur = this.get(id);
    if (!cur) return;
    if (patch.username !== undefined && patch.username !== cur.username && this.find(cur.origin, patch.username)) throw new DuplicateLoginError();
    const now = Date.now();
    if (patch.username !== undefined) this.db.prepare('UPDATE logins SET username = ?, updated_at = ? WHERE id = ?').run(patch.username, now, id);
    if (patch.password !== undefined) {
      this.db.prepare('UPDATE logins SET password = ?, updated_at = ? WHERE id = ?').run(await this.cipher.encrypt(patch.password), now, id);
    }
    if (patch.note !== undefined) {
      const note = patch.note ? await this.cipher.encrypt(patch.note) : null;
      this.db.prepare('UPDATE logins SET note = ?, updated_at = ? WHERE id = ?').run(note, now, id);
    }
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM logins WHERE id = ?').run(id);
  }

  removeAll(): void {
    this.db.exec('DELETE FROM logins');
  }

  markUsed(id: number): void {
    this.db.prepare('UPDATE logins SET last_used = ?, times_used = times_used + 1 WHERE id = ?').run(Date.now(), id);
  }

  async password(id: number): Promise<string | null> {
    const r = this.db.prepare('SELECT password FROM logins WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const { text, stale } = await this.cipher.decrypt(Buffer.from(r.password));
    if (stale) this.db.prepare('UPDATE logins SET password = ? WHERE id = ?').run(await this.cipher.encrypt(text), id);
    return text;
  }

  async note(id: number): Promise<string> {
    const r = this.db.prepare('SELECT note FROM logins WHERE id = ?').get(id) as Row | undefined;
    if (!r?.note) return '';
    return (await this.cipher.decrypt(Buffer.from(r.note))).text;
  }

  /**
   * Adds logins that are not saved yet. A saved login for the same website and username is
   * never overwritten: a password changed here is newer than any export.
   */
  async import(logins: { origin: string; username: string; password: string; note: string }[]): Promise<{ added: number; same: number; kept: number }> {
    const res = { added: 0, same: 0, kept: 0 };
    for (const l of logins) {
      const existing = this.find(l.origin, l.username);
      if (!existing) {
        await this.add(l);
        res.added++;
      } else if ((await this.password(existing.id).catch(() => null)) === l.password) res.same++;
      else res.kept++;
    }
    return res;
  }
}
