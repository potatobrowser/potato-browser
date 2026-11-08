import { clipboard, dialog, ipcMain, safeStorage, shell, systemPreferences, type IpcMainEvent, type WebFrameMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AutofillView, LoginInfo, PasswordImportResult, PasswordPrompt, PasswordsOverview } from '../../shared/types';
import { openInternal } from '../commands';
import { ctx } from '../context';
import { notifyInternalPages } from '../notify';
import { isTest } from '../paths';
import type { Tab } from '../tab';
import type { BrowserWindowController } from '../window';
import { CsvError, passwordCsv, readPasswordCsv } from './csv';
import { hostOfOrigin, matchKind, normalizeOrigin, pickPasswords, siteOfOrigin } from './match';
import { AutofillPopup } from './popup';
import { DuplicateLoginError, LoginStore, type Cipher } from './store';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Suggestion {
  id: number;
  username: string;
  host: string | null;
}

/** The login field that has focus in a window, and its dropdown. */
interface FieldState {
  tab: Tab;
  frame: WebFrameMain;
  origin: string;
  kind: 'username' | 'password';
  /** The field in the top frame's viewport, CSS pixels. */
  rect: Rect | null;
  all: Suggestion[];
  items: Suggestion[];
  highlighted: number;
  open: boolean;
  hideTimer: NodeJS.Timeout | null;
}

/** A sign-in that was submitted; it becomes a prompt once it looks successful. */
interface Pending {
  origin: string;
  username: string;
  password: string;
  current: string | null;
  at: number;
  /** A document loaded after the submit; a password field on it means the sign-in failed. */
  navigated: boolean;
  failed: boolean;
}

interface Prompt extends PasswordPrompt {
  tabId: number;
  origin: string;
  password: string;
  loginId: number | null;
  shownAt: number;
  /** Shown because the sign-in form went away (single page apps), not after a page load. */
  fromGone: boolean;
}

const safeStorageCipher: Cipher = {
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  decrypt: async (data) => {
    const r = await safeStorage.decryptStringAsync(data);
    return { text: r.result, stale: r.shouldReEncrypt };
  },
};

const PENDING_MS = 30_000;
/** A page can move a field so the dropdown lands under the pointer: picks in the first half second it is somewhere are not the user's. */
const EARLY_PICK_MS = 500;
const USERNAME_MS = 10 * 60_000;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const sameFrame = (a: WebFrameMain, b: WebFrameMain | null) => !!b && a.processId === b.processId && a.routingId === b.routingId;

function sanitizeRect(r: unknown): Rect | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const rect = { x: num(o.x), y: num(o.y), width: num(o.width), height: num(o.height) };
  if (Object.values(rect).some((v) => !Number.isFinite(v) || Math.abs(v) > 100_000) || rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

/**
 * Saved passwords: autofill through the browser's own dropdown, "Save password?" after sign-ins,
 * CSV import and export. Secrets are encrypted with Electron's safeStorage, whose key lives in the
 * macOS Keychain; the Keychain is touched only when a password is saved, filled or shown.
 */
export class PasswordService {
  readonly store: LoginStore;
  private popups = new Map<BrowserWindowController, AutofillPopup>();
  private fields = new Map<BrowserWindowController, FieldState>();
  private pending = new Map<number, Map<string, Pending>>();
  private prompts = new Map<number, Prompt>();
  private usernames = new Map<number, { site: string; username: string; at: number }>();
  private promptSeq = 1;
  private unlockedUntil = 0;
  /** Set when the Keychain refused (or failed) to give the key. */
  private keychainError: string | null = null;
  /** The last imported file, so the page can move it to the Trash. */
  private importedFile: string | null = null;

  constructor(cipher: Cipher = safeStorageCipher) {
    this.store = new LoginStore(ctx.db.db, cipher);
  }

  pageConfig(isPrivate: boolean): { autofill: boolean; save: boolean } {
    const s = ctx.settings.get().passwords;
    return { autofill: s.autofill, save: s.offerToSave && !isPrivate };
  }

  private keychain<T>(p: Promise<T>): Promise<T> {
    return p.then(
      (v) => {
        this.keychainError = null;
        return v;
      },
      (err) => {
        this.keychainError = String((err as Error)?.message ?? err);
        throw err;
      },
    );
  }

  /** Pages that kept going past a certificate warning get no passwords and save none. */
  private secureEnough(tab: Tab, origin: string): boolean {
    return /^https?:\/\//.test(origin) && !tab.win.manager.hasCertificateException(tab.win.session, hostOfOrigin(origin));
  }

  private suggestionsFor(origin: string): Suggestion[] {
    const exact: Suggestion[] = [];
    const site: Suggestion[] = [];
    for (const l of this.store.forSite(siteOfOrigin(origin))) {
      const kind = matchKind(l.origin, origin);
      if (kind === 'exact') exact.push({ id: l.id, username: l.username, host: null });
      else if (kind === 'site') site.push({ id: l.id, username: l.username, host: l.host });
    }
    return [...exact, ...site];
  }

  // ---- dropdown -------------------------------------------------------------------------------

  private popupFor(win: BrowserWindowController): AutofillPopup {
    let p = this.popups.get(win);
    if (!p) this.popups.set(win, (p = new AutofillPopup(win)));
    return p;
  }

  /** The window whose dropdown sent a command. */
  windowForPopup(sender: Electron.WebContents): BrowserWindowController | null {
    for (const [win, p] of this.popups) if (p.webContents === sender) return win;
    return null;
  }

  private fieldFor(e: IpcMainEvent): FieldState | null {
    const tab = ctx.windows.tabFor(e.sender);
    const s = tab ? this.fields.get(tab.win) : null;
    return s && s.tab === tab && sameFrame(s.frame, e.senderFrame) ? s : null;
  }

  private render(win: BrowserWindowController): void {
    const s = this.fields.get(win);
    const wc = s?.tab.wc;
    if (!s || !wc || !s.items.length || !s.rect || s.tab !== win.activeTab) return this.hidePopup(win);
    const vb = s.tab.view!.getBounds();
    const zoom = wc.getZoomFactor();
    const anchor = { x: vb.x + s.rect.x * zoom, y: vb.y + s.rect.y * zoom, width: s.rect.width * zoom, height: s.rect.height * zoom };
    // Only fields inside the page's own area: a frame cannot place the dropdown over the toolbar.
    if (anchor.y + anchor.height < vb.y || anchor.y > vb.y + vb.height || anchor.x > vb.x + vb.width || anchor.x + anchor.width < vb.x) return this.hidePopup(win);
    const view: AutofillView = { items: s.items.map((i) => ({ username: i.username, host: i.host })), highlighted: s.highlighted };
    this.popupFor(win).show(view, anchor);
    s.open = true;
    this.tellFrame(s);
  }

  private tellFrame(s: FieldState): void {
    try {
      if (!s.frame.isDestroyed()) s.frame.send('page:pw-popup', { open: s.open, highlighted: s.highlighted >= 0 });
    } catch {}
  }

  hidePopup(win: BrowserWindowController): void {
    this.popups.get(win)?.hide();
    const s = this.fields.get(win);
    if (!s) return;
    if (s.hideTimer) clearTimeout(s.hideTimer);
    s.hideTimer = null;
    if (s.open) {
      s.open = false;
      s.highlighted = -1;
      this.tellFrame(s);
    }
  }

  /** Navigations, tab switches, window changes: the dropdown goes away. */
  dropField(win: BrowserWindowController): void {
    this.hidePopup(win);
    this.fields.delete(win);
  }

  private filter(s: FieldState, typed: string): void {
    const t = typed.trim().toLowerCase();
    if (s.kind === 'password') s.items = t ? [] : s.all;
    else s.items = t ? s.all.filter((i) => i.username.toLowerCase().startsWith(t)) : s.all;
    s.highlighted = -1;
  }

  private onFocus(e: IpcMainEvent, f: { kind?: unknown; rect?: unknown; typed?: unknown }): void {
    const tab = ctx.windows.tabFor(e.sender);
    const frame = e.senderFrame;
    if (!tab || !frame || !f || !ctx.settings.get().passwords.autofill) return;
    const win = tab.win;
    // A field focused in a background tab must not touch the dropdown of the tab in front.
    if (tab !== win.activeTab) return;
    const origin = frame.origin;
    if (!this.secureEnough(tab, origin)) return this.dropField(win);
    const prev = this.fields.get(win);
    if (prev?.hideTimer) clearTimeout(prev.hideTimer);
    const all = this.suggestionsFor(origin);
    const s: FieldState = {
      tab,
      frame,
      origin,
      kind: f.kind === 'password' ? 'password' : 'username',
      rect: sanitizeRect(f.rect),
      all,
      items: all,
      highlighted: -1,
      open: false,
      hideTimer: null,
    };
    this.fields.set(win, s);
    this.filter(s, str(f.typed, 500));
    this.render(win);
  }

  private onBlur(e: IpcMainEvent): void {
    const s = this.fieldFor(e);
    if (!s) return;
    if (s.hideTimer) clearTimeout(s.hideTimer);
    // A click in the dropdown blurs the field first; give the click time to arrive.
    s.hideTimer = setTimeout(() => {
      s.hideTimer = null;
      if (this.fields.get(s.tab.win) === s) this.hidePopup(s.tab.win);
    }, 300);
  }

  private onKey(e: IpcMainEvent, key: unknown): void {
    const s = this.fieldFor(e);
    if (!s || !s.open) return;
    const n = s.items.length;
    if (key === 'down') s.highlighted = (s.highlighted + 1) % n;
    else if (key === 'up') s.highlighted = s.highlighted <= 0 ? n - 1 : s.highlighted - 1;
    else if (key === 'enter' && s.highlighted >= 0) return void (this.settled(s.tab.win) && this.pick(s.tab.win, s.highlighted));
    else if (key === 'escape') return this.hidePopup(s.tab.win);
    else return;
    this.render(s.tab.win);
  }

  private onTyped(e: IpcMainEvent, text: unknown): void {
    const s = this.fieldFor(e);
    if (!s) return;
    this.filter(s, str(text, 500));
    this.render(s.tab.win);
  }

  private onMove(e: IpcMainEvent, rect: unknown): void {
    const s = this.fieldFor(e);
    if (!s || !s.open) return;
    s.rect = sanitizeRect(rect);
    this.render(s.tab.win);
  }

  /** Commands from the dropdown itself. */
  popupCommand(win: BrowserWindowController, cmd: { type: string; [k: string]: unknown }): void {
    const s = this.fields.get(win);
    if (cmd.type === 'autofill.hold') {
      if (s?.hideTimer) clearTimeout(s.hideTimer);
      if (s) s.hideTimer = null;
    } else if (cmd.type === 'autofill.pick' && Number.isInteger(cmd.index)) {
      if (s?.open && this.settled(win)) void this.pick(win, cmd.index as number);
    } else if (cmd.type === 'autofill.manage') {
      this.hidePopup(win);
      openInternal('passwords');
    }
  }

  private settled(win: BrowserWindowController): boolean {
    return (this.popups.get(win)?.shownFor() ?? 0) >= EARLY_PICK_MS;
  }

  /** Fills the picked login into the frame it was offered to, after checking it still matches. */
  private async pick(win: BrowserWindowController, index: number): Promise<void> {
    const s = this.fields.get(win);
    const item = s?.items[index];
    if (!s || !item) return;
    this.hidePopup(win);
    s.tab.wc?.focus();
    const { frame, origin } = s;
    if (frame.isDestroyed() || frame.detached || frame.origin !== origin) return;
    const login = this.store.get(item.id);
    if (!login || !matchKind(login.origin, origin)) return;
    let password: string | null;
    try {
      password = await this.keychain(this.store.password(login.id));
    } catch (err) {
      console.error('passwords: decrypt', err);
      return;
    }
    if (password === null || frame.isDestroyed() || frame.detached || frame.origin !== origin) return;
    frame.send('page:pw-fill', { username: login.username, password });
    if (!s.tab.win.isPrivate) this.store.markUsed(login.id);
  }

  // ---- saving ---------------------------------------------------------------------------------

  private mayOfferSave(tab: Tab, origin: string): boolean {
    const s = ctx.settings.get().passwords;
    return s.offerToSave && !tab.win.isPrivate && this.secureEnough(tab, origin) && !s.neverSave.includes(origin);
  }

  private onSubmit(e: IpcMainEvent, data: { username?: unknown; fields?: unknown }): void {
    const tab = ctx.windows.tabFor(e.sender);
    const origin = e.senderFrame?.origin ?? '';
    if (!tab || !data || !this.mayOfferSave(tab, origin)) return;
    const fields = (Array.isArray(data.fields) ? data.fields : [])
      .slice(0, 10)
      .map((f: { value?: unknown; autocomplete?: unknown }) => ({ value: str(f?.value, 1000), autocomplete: str(f?.autocomplete, 200) }));
    const picked = pickPasswords(fields);
    if (!picked) return;
    let username = str(data.username, 500).trim();
    const remembered = this.usernames.get(tab.id);
    if (!username && remembered && remembered.site === siteOfOrigin(origin) && Date.now() - remembered.at < USERNAME_MS) username = remembered.username;
    // Per origin, so a frame of another site (an ad) cannot replace the sign-in the user just made.
    let byOrigin = this.pending.get(tab.id);
    if (!byOrigin) this.pending.set(tab.id, (byOrigin = new Map()));
    byOrigin.set(origin, { origin, username, password: picked.password, current: picked.current, at: Date.now(), navigated: false, failed: false });
  }

  private onUsername(e: IpcMainEvent, username: unknown): void {
    const tab = ctx.windows.tabFor(e.sender);
    const origin = e.senderFrame?.origin ?? '';
    const u = str(username, 500).trim();
    if (tab && u && this.mayOfferSave(tab, origin)) this.usernames.set(tab.id, { site: siteOfOrigin(origin), username: u, at: Date.now() });
  }

  private livePending(tab: Tab, origin: string): Pending | null {
    const p = this.pending.get(tab.id)?.get(origin);
    return p && Date.now() - p.at <= PENDING_MS ? p : null;
  }

  private dropPending(tab: Tab, p: Pending): void {
    const byOrigin = this.pending.get(tab.id);
    if (byOrigin?.get(p.origin) === p) byOrigin.delete(p.origin);
  }

  private onGone(e: IpcMainEvent): void {
    const tab = ctx.windows.tabFor(e.sender);
    const p = tab && this.livePending(tab, e.senderFrame?.origin ?? '');
    if (p) void this.resolve(tab, p, true);
  }

  /** A password field shows in a document: after a submit, the sign-in did not work. */
  private onLoginForm(e: IpcMainEvent): void {
    const tab = ctx.windows.tabFor(e.sender);
    const origin = e.senderFrame?.origin ?? '';
    if (!tab) return;
    const p = this.livePending(tab, origin);
    if (p?.navigated) p.failed = true;
    // A single page app brought its sign-in form back after the prompt showed: take it back.
    const prompt = this.prompts.get(tab.id);
    if (prompt?.fromGone && prompt.origin === origin && Date.now() - prompt.shownAt < 10_000) {
      this.prompts.delete(tab.id);
      tab.win.update();
    }
  }

  /** A document committed in the tab after a submit; once it settles, offer to save. */
  frameNavigated(tab: Tab, url: string, isMainFrame: boolean): void {
    for (const p of this.pending.get(tab.id)?.values() ?? []) {
      if (p.navigated || this.livePending(tab, p.origin) !== p) continue;
      if (!isMainFrame && normalizeOrigin(url) !== p.origin) continue;
      p.navigated = true;
      const started = Date.now();
      const check = () => {
        if (this.livePending(tab, p.origin) !== p || !tab.wc) return;
        if (tab.wc.isLoading() && Date.now() - started < 8000) return void setTimeout(check, 250);
        // The new page reports a password field shortly after it loads.
        setTimeout(() => {
          if (this.livePending(tab, p.origin) !== p) return;
          if (p.failed) this.dropPending(tab, p);
          else void this.resolve(tab, p, false);
        }, 1000);
      };
      setTimeout(check, 250);
    }
  }

  private async resolve(tab: Tab, p: Pending, fromGone: boolean): Promise<void> {
    this.dropPending(tab, p);
    if (tab.isDestroyed) return;
    let username = p.username;
    let loginId: number | null = null;
    try {
      const existing = this.store.find(p.origin, username);
      if (existing) {
        if ((await this.keychain(this.store.password(existing.id))) === p.password) {
          this.store.markUsed(existing.id);
          return;
        }
        loginId = existing.id;
      } else {
        // No username on the form: a change of a saved password, or one already saved.
        for (const l of this.store.forSite(siteOfOrigin(p.origin)).filter((x) => x.origin === p.origin)) {
          const pw = await this.keychain(this.store.password(l.id));
          if (pw === p.password && (!username || l.username === username)) return;
          if (!username && p.current && pw === p.current) {
            loginId = l.id;
            username = l.username;
            break;
          }
        }
      }
    } catch (err) {
      console.error('passwords: compare', err);
    }
    // The Keychain may have asked the user first; the tab can be gone by now.
    if (tab.isDestroyed || !ctx.windows.findTab(tab.id)) return;
    this.prompts.set(tab.id, {
      id: this.promptSeq++,
      tabId: tab.id,
      host: hostOfOrigin(p.origin),
      origin: p.origin,
      username,
      password: p.password,
      update: loginId !== null,
      loginId,
      shownAt: Date.now(),
      fromGone,
    });
    tab.win.update();
  }

  promptFor(win: BrowserWindowController): PasswordPrompt | null {
    const p = win.activeTab ? this.prompts.get(win.activeTab.id) : undefined;
    return p ? { id: p.id, host: p.host, username: p.username, update: p.update } : null;
  }

  private takePrompt(win: BrowserWindowController, id: unknown): Prompt | null {
    const tab = win.activeTab;
    const p = tab ? this.prompts.get(tab.id) : undefined;
    if (!tab || !p || p.id !== id) return null;
    this.prompts.delete(tab.id);
    win.update();
    return p;
  }

  async savePrompt(win: BrowserWindowController, id: unknown, editedUsername: unknown): Promise<void> {
    const p = this.takePrompt(win, id);
    if (!p) return;
    try {
      if (p.loginId !== null) await this.keychain(this.store.update(p.loginId, { password: p.password }));
      else {
        const username = typeof editedUsername === 'string' ? editedUsername.trim().slice(0, 500) : p.username;
        const existing = this.store.find(p.origin, username);
        if (existing) await this.keychain(this.store.update(existing.id, { password: p.password }));
        else await this.keychain(this.store.add({ origin: p.origin, username, password: p.password }));
      }
    } catch (err) {
      console.error('passwords: save', err);
    }
    this.changed();
  }

  neverForSite(win: BrowserWindowController, id: unknown): void {
    const p = this.takePrompt(win, id);
    if (!p) return;
    const s = ctx.settings.get().passwords;
    ctx.settings.update({ passwords: { neverSave: [...s.neverSave, p.origin] } });
  }

  dismissPrompt(win: BrowserWindowController, id: unknown): void {
    this.takePrompt(win, id);
  }

  /** A new page in the tab: the dropdown closes; a prompt stays for redirects, not for browsing on. */
  navigationStarted(tab: Tab, url: string): void {
    if (this.fields.get(tab.win)?.tab === tab) this.dropField(tab.win);
    const p = this.prompts.get(tab.id);
    if (p && (Date.now() - p.shownAt > 5000 || siteOfOrigin(normalizeOrigin(url) ?? '') !== siteOfOrigin(p.origin))) {
      this.prompts.delete(tab.id);
      tab.win.update();
    }
  }

  /** The dropdown is up in the tab, or a sign-in there waits to be saved: it must not be put to sleep. */
  busyWith(tab: Tab): boolean {
    const s = this.fields.get(tab.win);
    return (s?.tab === tab && s.open) || [...(this.pending.get(tab.id)?.values() ?? [])].some((p) => this.livePending(tab, p.origin) === p);
  }

  tabClosed(tab: Tab): void {
    this.pending.delete(tab.id);
    this.prompts.delete(tab.id);
    this.usernames.delete(tab.id);
    if (this.fields.get(tab.win)?.tab === tab) this.dropField(tab.win);
  }

  windowClosed(win: BrowserWindowController): void {
    this.fields.delete(win);
    this.popups.get(win)?.destroy();
    this.popups.delete(win);
  }

  private changed(): void {
    notifyInternalPages({ type: 'passwords' });
  }

  // ---- passwords page -------------------------------------------------------------------------

  private asksAuth(): boolean {
    return process.platform === 'darwin' && !isTest();
  }

  /**
   * Touch ID, or the Mac's login password where there is no Touch ID (macOS falls back to it),
   * before passwords are shown, copied or exported; then not again for a minute.
   */
  private async unlock(reason: string): Promise<boolean> {
    if (!this.asksAuth() || Date.now() < this.unlockedUntil) return true;
    const started = Date.now();
    try {
      await systemPreferences.promptTouchID(reason);
      this.unlockedUntil = Date.now() + 60_000;
      return true;
    } catch {
      // A Mac that cannot ask at all fails at once; a person cancelling takes longer than that.
      return !systemPreferences.canPromptTouchID() && Date.now() - started < 400;
    }
  }

  overview(): PasswordsOverview & { keychainError: string | null } {
    const logins = this.store.list().map((l) => ({ ...l, favicon: ctx.db.favicon(l.host) }));
    return { available: !this.keychainError, logins, asksAuth: this.asksAuth(), keychainError: this.keychainError };
  }

  async reveal(id: number): Promise<{ password: string; note: string } | null> {
    if (!this.store.get(id) || !(await this.unlock('show your saved password'))) return null;
    return { password: await this.keychain(this.store.password(id)) ?? '', note: await this.keychain(this.store.note(id)) };
  }

  async add(l: { origin?: unknown; username?: unknown; password?: unknown; note?: unknown }): Promise<{ id?: number; error?: string }> {
    const origin = normalizeOrigin(str(l?.origin, 2000));
    const password = str(l?.password, 1000);
    if (!origin) return { error: 'Enter a website address, like example.com.' };
    if (!password) return { error: 'Enter a password.' };
    try {
      const id = await this.keychain(this.store.add({ origin, username: str(l.username, 500).trim(), password, note: str(l.note, 10_000) }));
      this.changed();
      return { id };
    } catch (err) {
      return { error: err instanceof DuplicateLoginError ? err.message : 'The password could not be saved: the macOS Keychain did not give access.' };
    }
  }

  async update(id: number, patch: { username?: unknown; password?: unknown; note?: unknown }): Promise<{ error?: string }> {
    if (!this.store.get(id)) return { error: 'This password is gone.' };
    const password = typeof patch?.password === 'string' ? patch.password.slice(0, 1000) : undefined;
    if (password === '') return { error: 'Enter a password.' };
    try {
      await this.keychain(
        this.store.update(id, {
          username: typeof patch?.username === 'string' ? patch.username.trim().slice(0, 500) : undefined,
          password,
          note: typeof patch?.note === 'string' ? patch.note.slice(0, 10_000) : undefined,
        }),
      );
      this.changed();
      return {};
    } catch (err) {
      return { error: err instanceof DuplicateLoginError ? err.message : 'The change could not be saved: the macOS Keychain did not give access.' };
    }
  }

  remove(id: number): void {
    this.store.remove(id);
    this.changed();
  }

  async importFile(): Promise<PasswordImportResult | null> {
    const win = ctx.windows.focused();
    const opts = { title: 'Import Passwords', properties: ['openFile' as const], filters: [{ name: 'Password export (CSV)', extensions: ['csv'] }] };
    const res = win ? await dialog.showOpenDialog(win.base, opts) : await dialog.showOpenDialog(opts);
    const file = res.canceled ? null : res.filePaths[0];
    if (!file) return null;
    const empty = { noPassword: 0, noWebsite: 0, archived: 0, duplicates: 0 };
    const fail = (error: string): PasswordImportResult => ({ error, source: null, added: 0, same: 0, kept: 0, skipped: empty, file: null });
    try {
      if (fs.statSync(file).size > MAX_IMPORT_BYTES) return fail('This file is too large for a password export.');
      const read = readPasswordCsv(fs.readFileSync(file, 'utf8'));
      const counts = await this.keychain(this.store.import(read.logins));
      this.importedFile = file;
      this.changed();
      return { error: null, source: read.source, ...counts, skipped: read.skipped, file: path.basename(file) };
    } catch (err) {
      if (err instanceof CsvError) return fail(err.message);
      console.error('passwords: import', err);
      return fail(this.keychainError ? 'The passwords could not be saved: the macOS Keychain did not give access.' : 'The file could not be read.');
    }
  }

  /** Moves the CSV just imported to the Trash: it holds every password in plain text. */
  async trashImportedFile(): Promise<boolean> {
    const file = this.importedFile;
    this.importedFile = null;
    if (!file || !fs.existsSync(file)) return false;
    await shell.trashItem(file);
    return true;
  }

  async exportFile(): Promise<{ count: number } | null> {
    if (!(await this.unlock('export your saved passwords'))) return null;
    const win = ctx.windows.focused();
    const opts = { title: 'Export Passwords', defaultPath: 'Potato Browser Passwords.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] };
    const res = win ? await dialog.showSaveDialog(win.base, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    const logins: { origin: string; username: string; password: string; note: string }[] = [];
    for (const l of this.store.list()) {
      logins.push({ origin: l.origin, username: l.username, password: (await this.keychain(this.store.password(l.id))) ?? '', note: await this.keychain(this.store.note(l.id)) });
    }
    fs.writeFileSync(res.filePath, passwordCsv(logins), { mode: 0o600 });
    // The mode above only applies to a new file, not one the dialog chose to replace.
    fs.chmodSync(res.filePath, 0o600);
    return { count: logins.length };
  }

  async copy(id: number, what: 'username' | 'password'): Promise<boolean> {
    const login = this.store.get(id);
    if (!login) return false;
    if (what === 'username') {
      clipboard.writeText(login.username);
      return true;
    }
    if (!(await this.unlock('copy your saved password'))) return false;
    clipboard.writeText((await this.keychain(this.store.password(id))) ?? '');
    return true;
  }

  list(): LoginInfo[] {
    return this.store.list();
  }

  // ---- wiring ---------------------------------------------------------------------------------

  registerIpc(): void {
    ipcMain.on('page:pw-focus', (e, f) => this.onFocus(e, f));
    ipcMain.on('page:pw-move', (e, r) => this.onMove(e, r));
    ipcMain.on('page:pw-blur', (e) => this.onBlur(e));
    ipcMain.on('page:pw-key', (e, k) => this.onKey(e, k));
    ipcMain.on('page:pw-typed', (e, t) => this.onTyped(e, t));
    ipcMain.on('page:pw-hide', (e) => {
      const s = this.fieldFor(e);
      if (s) this.hidePopup(s.tab.win);
    });
    ipcMain.on('page:pw-submit', (e, d) => this.onSubmit(e, d));
    ipcMain.on('page:pw-username', (e, u) => this.onUsername(e, u));
    ipcMain.on('page:pw-gone', (e) => this.onGone(e));
    ipcMain.on('page:pw-form', (e) => this.onLoginForm(e));
  }
}
