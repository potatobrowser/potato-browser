import { BaseWindow, screen, session as electronSession, type ContextMenuParams, type Rectangle, type Session, type WebContents } from 'electron';
import path from 'node:path';
import { isNewTabUrl, NEW_TAB_URL } from '../shared/urls';
import { ctx } from './context';
import { showPageContextMenu } from './menus';
import { paths } from './paths';
import { configureSession } from './sessions';
import { parseSession, persistable, toDisk, trimHistory, type DiskSession, type SavedSession, type TabHistory } from './sessionfile';
import { TabSleeper } from './sleep';
import { JsonFile } from './store';
import type { Tab } from './tab';
import { BrowserWindowController, type ClosedTab } from './window';

export class WindowManager {
  windows: BrowserWindowController[] = [];
  readonly mainSession: Session;
  readonly uiSession: Session;
  private privateSession: Session | null = null;
  private privateSeq = 0;
  private lastFocused: BrowserWindowController | null = null;
  private tabsByWc = new Map<number, Tab>();
  private sessionFile: JsonFile<DiskSession>;
  private saveTimer: NodeJS.Timeout | null = null;
  readonly sleeper = new TabSleeper();
  private recentlyClosed: { win: BrowserWindowController; tab: ClosedTab }[] = [];
  /** "host|fingerprint" exceptions per session, so private windows never inherit them. */
  private certAllowed = new WeakMap<Session, Set<string>>();
  private lastCertError = new Map<number, { host: string; fingerprint: string }>();
  quitting = false;
  private restoreNext = false;

  constructor() {
    this.mainSession = electronSession.fromPartition('persist:main');
    configureSession(this.mainSession, { isPrivate: false });
    this.uiSession = electronSession.fromPartition('persist:ui');
    configureSession(this.uiSession, { isPrivate: false, ui: true });
    this.sessionFile = new JsonFile<DiskSession>(path.join(paths.userData, 'session.json'), 500);
    this.sleeper.start();
  }

  // ---- windows --------------------------------------------------------------------------------

  createWindow(
    opts: { isPrivate?: boolean; urls?: string[]; restore?: TabHistory[]; active?: number; bounds?: Partial<Rectangle> } = {},
  ): BrowserWindowController {
    const isPrivate = !!opts.isPrivate;
    const ses = isPrivate ? this.getPrivateSession() : this.mainSession;
    const bounds = opts.bounds ?? this.cascadeBounds();
    const win = new BrowserWindowController(this, { isPrivate, session: ses, uiSession: this.uiSession, bounds });
    this.windows.push(win);
    this.lastFocused = win;
    if (opts.restore?.length) {
      // Restored tabs stay asleep until opened, so only the active one loads now.
      for (const history of opts.restore) win.createTab({ history, asleep: true, background: true });
    } else {
      const urls = opts.urls?.length ? opts.urls : [NEW_TAB_URL];
      urls.forEach((url, i) => win.createTab({ url, background: i !== (opts.active ?? 0) }));
    }
    const active = win.tabs[opts.active ?? 0] ?? win.tabs[0];
    if (active) win.activate(active);
    this.saveSessionSoon();
    return win;
  }

  private cascadeBounds(): Partial<Rectangle> {
    const ref = this.focused();
    if (ref && !ref.base.isDestroyed() && !ref.base.isFullScreen()) {
      const b = ref.base.getBounds();
      return { x: b.x + 24, y: b.y + 24, width: b.width, height: b.height };
    }
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1360, Math.round(area.width * 0.85));
    const height = Math.min(900, Math.round(area.height * 0.9));
    return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 3), width, height };
  }

  getPrivateSession(): Session {
    if (!this.privateSession) {
      // A fresh in-memory partition per private "session": nothing is ever written to disk and
      // nothing survives once the last private window closes.
      this.privateSession = electronSession.fromPartition(`private-${++this.privateSeq}`);
      configureSession(this.privateSession, { isPrivate: true });
    }
    return this.privateSession;
  }

  focused(): BrowserWindowController | null {
    const focused = BaseWindow.getFocusedWindow();
    const win = focused ? this.windows.find((w) => w.base === focused) : null;
    if (win) return win;
    if (this.lastFocused && this.windows.includes(this.lastFocused)) return this.lastFocused;
    return this.windows[this.windows.length - 1] ?? null;
  }

  onWindowFocused(win: BrowserWindowController): void {
    this.lastFocused = win;
  }

  onWindowClosed(win: BrowserWindowController): void {
    this.windows = this.windows.filter((w) => w !== win);
    if (this.lastFocused === win) this.lastFocused = null;
    this.recentlyClosed = this.recentlyClosed.filter((r) => r.win !== win);
    ctx.permissions.dropWindow(win);
    ctx.passwords.windowClosed(win);
    if (win.isPrivate && !this.windows.some((w) => w.isPrivate)) void this.destroyPrivateSession();
    if (!this.quitting) this.saveSessionSoon();
  }

  private async destroyPrivateSession(): Promise<void> {
    const ses = this.privateSession;
    this.privateSession = null;
    if (!ses) return;
    ctx.downloads.forgetPrivate();
    ctx.flags.forgetPrivate();
    await Promise.allSettled([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache(), ses.clearHostResolverCache()]);
  }

  openUrl(url: string, opts: { newWindow?: boolean; isPrivate?: boolean; background?: boolean } = {}): void {
    if (opts.newWindow || opts.isPrivate) {
      if (opts.isPrivate) {
        const existing = this.focused();
        if (existing?.isPrivate && !opts.newWindow) {
          existing.newTab(url, { background: opts.background });
          return;
        }
      }
      this.createWindow({ isPrivate: opts.isPrivate, urls: [url] }).focus();
      return;
    }
    const f = this.focused();
    const win = f && !f.isPrivate ? f : [...this.windows].reverse().find((x) => !x.isPrivate);
    if (!win) {
      // No window yet (cold launch from a link, or all windows closed): open just the link.
      this.createWindow({ urls: [url] }).focus();
      return;
    }
    win.newTab(url, { background: opts.background });
    win.focus();
  }

  // ---- tabs registry --------------------------------------------------------------------------

  registerTab(tab: Tab): void {
    const wc = tab.wc;
    if (wc) this.tabsByWc.set(wc.id, tab);
  }

  /** A tab's page was unloaded for sleep; a new one is registered when it wakes. */
  forgetWebContents(wcId: number): void {
    this.tabsByWc.delete(wcId);
    this.lastCertError.delete(wcId);
  }

  unregisterTab(tab: Tab): void {
    for (const [id, t] of this.tabsByWc) {
      if (t === tab) {
        this.tabsByWc.delete(id);
        this.lastCertError.delete(id);
      }
    }
  }

  tabFor(wc: WebContents | null | undefined): Tab | null {
    if (!wc) return null;
    return this.tabsByWc.get(wc.id) ?? null;
  }

  allTabs(): Tab[] {
    return this.windows.flatMap((w) => w.tabs);
  }

  findTab(id: number): Tab | null {
    return this.allTabs().find((t) => t.id === id) ?? null;
  }

  noteClosedTab(win: BrowserWindowController, tab: ClosedTab): void {
    this.recentlyClosed.push({ win, tab });
    if (this.recentlyClosed.length > 25) this.recentlyClosed.shift();
  }

  reopenClosedTab(): void {
    const win = this.focused();
    if (win?.reopenClosedTab()) {
      this.recentlyClosed = this.recentlyClosed.filter((r) => !(r.win === win && !win.closedTabs.includes(r.tab)));
      return;
    }
    const last = this.recentlyClosed.pop();
    if (last && this.windows.includes(last.win)) last.win.reopenClosedTab();
  }

  showPageContextMenu(tab: Tab, params: ContextMenuParams): void {
    showPageContextMenu(this, tab, params);
  }

  /** Remembers the certificate a tab was just warned about, for its "Continue anyway" link. */
  noteCertificateError(wc: WebContents, host: string, fingerprint: string): void {
    this.lastCertError.set(wc.id, { host, fingerprint });
  }

  /** Accepts exactly the certificate the user was shown, for this host and session only. */
  allowCertificateFor(wc: WebContents, host: string): void {
    const seen = this.lastCertError.get(wc.id);
    if (!host || !seen || seen.host !== host) return;
    let set = this.certAllowed.get(wc.session);
    if (!set) this.certAllowed.set(wc.session, (set = new Set()));
    set.add(`${host}|${seen.fingerprint}`);
  }

  /** Whether the user accepted a bad certificate for this host in this session. */
  hasCertificateException(ses: Session, host: string): boolean {
    for (const k of this.certAllowed.get(ses) ?? []) if (k.startsWith(`${host}|`)) return true;
    return false;
  }

  isCertificateAllowed(ses: Session, host: string, fingerprint: string): boolean {
    return this.certAllowed.get(ses)?.has(`${host}|${fingerprint}`) ?? false;
  }

  broadcast(): void {
    for (const w of this.windows) w.update();
  }

  // ---- session restore ------------------------------------------------------------------------

  /** Saves the session shortly; the snapshot is taken then, so bursts of changes cost one. */
  saveSessionSoon(): void {
    if (this.quitting || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveSession(), 500);
  }

  /** A window is about to close: a save still waiting is written now, with that window in it. */
  flushPendingSession(): void {
    if (this.saveTimer && !this.quitting) this.saveSession();
  }

  private saveSession(restore = false): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const snap = this.snapshot();
    // Closing the last window keeps the previous session, so a later launch can restore it.
    if (snap.windows.length) this.sessionFile.write(toDisk(restore ? { ...snap, restore: true } : snap));
    this.sessionFile.flush();
  }

  /** Each normal window's tabs with their back/forward history, asleep tabs included. */
  private snapshot(): SavedSession {
    return {
      windows: this.windows
        .filter((w) => !w.isPrivate && !w.base.isDestroyed() && !w.isClosing)
        .map((w) => {
          const tabs: TabHistory[] = [];
          let active = 0;
          for (const t of w.tabs) {
            const fallback = persistable(t.lastUrl) ? { entries: [{ url: t.lastUrl, title: t.title }], index: 0 } : null;
            const h = trimHistory(t.history() ?? t.closingHistory) ?? fallback;
            if (!h) continue;
            if (t === w.activeTab) active = tabs.length;
            tabs.push(h);
          }
          return { bounds: w.base.getNormalBounds(), tabs, active };
        })
        .filter((w) => w.tabs.length > 0),
    };
  }

  /** Called on quit before windows close, so the session reflects what was open. */
  persistSessionNow(): void {
    this.saveSession(this.restoreNext);
  }

  restoreOnNextLaunch(): void {
    this.restoreNext = true;
  }

  /** A restart into an update closed the windows but did not quit: reopen them and keep saving. */
  resumeAfterFailedQuit(): void {
    this.quitting = false;
    this.restoreNext = false;
    if (!this.windows.length) this.restoreOrOpen(false);
  }

  restoreOrOpen(firstRun: boolean, links: string[] = []): void {
    const settings = ctx.settings.get();
    const saved = parseSession(this.sessionFile.read());
    const restore = settings.startup === 'restore' || saved.restore === true;
    if (links.length && !firstRun && !restore) {
      this.createWindow({ urls: links });
      return;
    }
    if (firstRun) {
      this.createWindow({ urls: ['potato://welcome/', ...links] });
      return;
    }
    if (restore && saved.windows.length) {
      for (const w of saved.windows) this.createWindow({ restore: w.tabs, active: w.active, bounds: this.visibleBounds(w.bounds) });
      for (const url of links) this.openUrl(url);
      return;
    }
    const home = settings.startup === 'homepage' && settings.homepage ? settings.homepage : NEW_TAB_URL;
    this.createWindow({ urls: [home] });
    for (const url of links) this.openUrl(url);
  }

  private visibleBounds(b: Rectangle | undefined): Partial<Rectangle> | undefined {
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.width)) return undefined;
    const display = screen.getDisplayMatching(b);
    const area = display.workArea;
    const width = Math.min(Math.max(500, b.width), area.width);
    const height = Math.min(Math.max(320, b.height), area.height);
    const x = Math.min(Math.max(area.x, b.x), area.x + area.width - width);
    const y = Math.min(Math.max(area.y, b.y), area.y + area.height - height);
    return { x, y, width, height };
  }

  isNewTab(url: string): boolean {
    return isNewTabUrl(url);
  }
}
