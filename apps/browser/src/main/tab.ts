import crypto from 'node:crypto';
import { dialog, WebContentsView, type WebContents, type WebPreferences, type Session } from 'electron';
import type { FlagTabState, Security, ShieldTabState, TabState } from '../shared/types';
import { isInternalUrl, isNewTabUrl, migrateLegacyUrl, nextZoom, siteKey } from '../shared/urls';
import { ctx } from './context';
import { errorPageHtml } from './errorpage';
import { paths } from './paths';
import { persistable, type TabHistory } from './sessionfile';
import { allowChatbotOnce } from './sessions';
import type { BrowserWindowController } from './window';

export interface TabInit {
  url?: string;
  /** Adopted from window.open (keeps the opener relationship). */
  webContents?: WebContents;
  webPreferences?: WebPreferences;
  background?: boolean;
  index?: number;
  openerTabId?: number | null;
  typed?: boolean;
  /** Back and forward entries to bring back instead of loading `url` (restored, reopened or duplicated tabs). */
  history?: TabHistory;
  /** Starts without a page, showing the history's title, and loads it when first activated. */
  asleep?: boolean;
}

/** Chromium's PDF viewer, which shows PDFs in a frame of this extension. */
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';
/** An isolated world of our own (0 is the page's, 999 the preload's). */
const SLEEP_WORLD = 2601;

export function webPreferencesFor(session: Session): WebPreferences {
  return {
    session,
    preload: paths.webPreload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    // Runs the (sandboxed) preload in iframes too, so the AI Shield also covers embedded widgets.
    nodeIntegrationInSubFrames: true,
    webviewTag: false,
    spellcheck: true,
    safeDialogs: true,
    autoplayPolicy: 'document-user-activation-required',
    scrollBounce: true,
    // No `plugins` needed for PDFs: Electron 45 runs Chromium's PDF viewer out of process either way.
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const faviconCache = new Map<string, string>();

async function fetchFavicon(session: Session, url: string): Promise<string | null> {
  if (url.startsWith('data:image/')) return url;
  if (!/^https?:/i.test(url)) return null;
  const hit = faviconCache.get(url);
  if (hit) return hit;
  try {
    const res = await session.fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || 'image/x-icon').split(';')[0]!.trim();
    if (!type.startsWith('image/') && type !== 'application/octet-stream') return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 256 * 1024 || buf.length === 0) return null;
    const data = `data:${type === 'application/octet-stream' ? 'image/x-icon' : type};base64,${buf.toString('base64')}`;
    if (faviconCache.size > 500) faviconCache.clear();
    faviconCache.set(url, data);
    return data;
  } catch {
    return null;
  }
}

/**
 * A tab. Its page lives in a WebContentsView, which a tab may also be without: put to sleep to
 * free memory, or restored at launch and not opened yet. Such a tab keeps its back/forward history
 * (with scroll positions and form fields while the browser runs) and gets a new view when woken.
 */
export class Tab {
  private static seq = 1;
  readonly id = Tab.seq++;
  win: BrowserWindowController;
  title = '';
  favicon: string | null = null;
  crashed = false;
  openerTabId: number | null;
  /** Last time the tab was in front (or opened); background tabs sleep after a while. */
  lastActive = Date.now();
  lastAudible = 0;
  /** The page asked for the camera, microphone or screen; it stays awake until it navigates away. */
  capturing = false;
  /** When the page last refused to unload for sleep (unsaved changes); it stays awake a while longer. */
  refusedSleepAt = 0;
  /** Asked to unload, waiting for the page's beforeunload. */
  sleepPending = false;
  /** Last committed URL, still available after the WebContents is destroyed. */
  lastUrl = '';
  flags: FlagTabState = { platform: null, hidden: 0, labeled: 0 };
  /** History at the last close attempt, for "Reopen Closed Tab". */
  closingHistory: TabHistory | null = null;
  private view_: WebContentsView | null = null;
  /** The history to restore while the tab has no page. */
  private parked: { history: TabHistory; muted: boolean } | null = null;
  /** The next commit brings back a restored history entry: not a new visit. */
  private restoring = false;
  /** A history step or reload asked for while a restored entry is on its way, sent once it commits. */
  private afterRestore: ((wc: WebContents) => void) | null = null;
  private faviconUrl = '';
  /** `token` is a secret only this error page's own links carry, so other pages cannot act for it. */
  private errorPage: { url: string; code: number; desc: string; token: string } | null = null;
  private frameShield = new Map<string, { count: number; features: string[] }>();
  private lastCommitted = '';
  private typedPending = false;
  private closed = false;

  /** Kept for cleanup after the WebContents is gone. */
  private wcId = -1;

  constructor(win: BrowserWindowController, init: TabInit) {
    this.win = win;
    this.openerTabId = init.openerTabId ?? null;
    const current = init.history?.entries[init.history.index];
    if (init.history && current) {
      this.lastUrl = current.url;
      this.title = current.title || (persistable(current.url) && !win.isPrivate ? ctx.db.titleFor(current.url) : '');
    }
    if (init.asleep && init.history && current) {
      this.parked = { history: init.history, muted: false };
      this.favicon = isInternalUrl(current.url) ? null : ctx.db.favicon(hostOf(current.url));
      return;
    }
    const wc = this.attach(init);
    if (init.history && current) {
      this.restoring = true;
      wc.navigationHistory.restore(init.history).catch(() => {});
    } else if (init.url) {
      this.navigate(init.url, { typed: init.typed });
    }
  }

  /** The page's view; null while the tab is asleep. */
  get view(): WebContentsView | null {
    return this.view_;
  }

  /** The page; null while the tab is asleep or once it is closed. */
  get wc(): WebContents | null {
    const v = this.view_;
    // `closed` first: inside its own 'destroyed' event a WebContents is not destroyed yet, and touching it hangs.
    return v && !this.closed && !v.webContents.isDestroyed() ? v.webContents : null;
  }

  get url(): string {
    const wc = this.wc;
    const parked = this.parked?.history;
    // Before its first commit a page reports no URL: the one it is loading counts.
    if (wc) return wc.getURL() || this.lastUrl;
    return parked?.entries[parked.index]?.url ?? this.lastUrl;
  }

  /** The tab was closed. */
  get isDestroyed(): boolean {
    return this.closed;
  }

  get muted(): boolean {
    const wc = this.wc;
    return wc ? wc.isAudioMuted() : !!this.parked?.muted;
  }

  setMuted(muted: boolean): void {
    const wc = this.wc;
    if (wc) wc.setAudioMuted(muted);
    else if (this.parked) this.parked.muted = muted;
    this.win.update();
  }

  /** The page, loading it first if the tab is asleep. */
  wake(): WebContents {
    const live = this.wc;
    if (live) return live;
    const parked = this.parked;
    this.parked = null;
    const wc = this.attach({});
    if (parked) {
      wc.setAudioMuted(parked.muted);
      this.restoring = true;
      wc.navigationHistory.restore(parked.history).catch(() => {});
    } else if (this.lastUrl) {
      this.navigate(this.lastUrl);
    }
    this.win.update();
    return wc;
  }

  /** Unloads the page to free its memory and keeps its history. A page with unsaved changes says no. */
  sleep(): void {
    const wc = this.wc;
    if (!wc || this.sleepPending) return;
    this.sleepPending = true;
    // Electron hands a page a user activation before its beforeunload runs, so only pages the user
    // touched (the only ones Chromium lets ask) are asked; others just unload. Read where the page cannot lie.
    void wc
      .executeJavaScriptInIsolatedWorld(SLEEP_WORLD, [{ code: 'navigator.userActivation.hasBeenActive' }])
      .then((touched) => touched !== false, () => true)
      .then((ask) => {
        const history = this.history();
        // Closed, brought to the front or navigating meanwhile: it stays.
        if (!this.sleepPending || this.wc !== wc || this.win.activeTab === this || wc.isLoading() || !history) {
          this.sleepPending = false;
          return;
        }
        this.parked = { history, muted: wc.isAudioMuted() };
        this.lastUrl = history.entries[history.index]!.url;
        wc.close(ask ? { waitForBeforeUnload: true } : undefined);
      });
  }

  /** Back and forward entries with their page state, from the page or, while asleep, the parked copy. */
  history(): TabHistory | null {
    const wc = this.wc;
    if (!wc) return this.parked?.history ?? null;
    const entries = wc.navigationHistory.getAllEntries();
    const index = wc.navigationHistory.getActiveIndex();
    return entries[index] ? { entries, index } : null;
  }

  reload(hard = false): void {
    if (!this.wc) this.wake();
    else this.whenRestored((wc) => (hard ? wc.reloadIgnoringCache() : wc.reload()));
  }

  goBack(): void {
    this.whenRestored((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack());
  }

  goForward(): void {
    this.whenRestored((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward());
  }

  /** Back, forward or reload sent while a restored entry is on its way crashes the renderer (Electron 45). */
  private whenRestored(fn: (wc: WebContents) => void): void {
    const wc = this.wc;
    if (!wc) return;
    if (this.restoring) this.afterRestore = fn;
    else fn(wc);
  }

  private restored(wc: WebContents): void {
    this.restoring = false;
    const next = this.afterRestore;
    this.afterRestore = null;
    next?.(wc);
  }

  navigate(url: string, opts: { typed?: boolean } = {}): void {
    url = migrateLegacyUrl(url);
    const wc = this.wc ?? this.wake();
    this.restoring = false;
    this.afterRestore = null;
    this.typedPending = !!opts.typed;
    this.crashed = false;
    if (!this.lastUrl) this.lastUrl = url;
    wc.loadURL(url).catch(() => {
      // Failures are surfaced through did-fail-load (error page); aborted loads need nothing.
    });
  }

  /** Closes the tab, giving the page a chance to run beforeunload. */
  close(force = false): void {
    // Closing wins over a sleep that waits for beforeunload.
    this.sleepPending = false;
    if (!force) this.closingHistory = this.history();
    const wc = this.wc;
    if (!wc) {
      this.handleDestroyed();
      return;
    }
    this.parked = null;
    if (force || this.crashed) wc.close();
    else wc.close({ waitForBeforeUnload: true });
  }

  /** Shows Chromium's PDF viewer, which has its own zoom, save and print. */
  isPdf(): boolean {
    return !!this.wc?.mainFrame.frames.some((f) => f.origin === PDF_VIEWER_ORIGIN);
  }

  zoomStep(dir: 1 | -1 | 0): void {
    const wc = this.wc;
    // The PDF viewer ignores page zoom: it would only show a number and change the site's zoom.
    if (!wc || this.isPdf()) return;
    const current = wc.getZoomFactor();
    const next = dir === 0 ? 1 : nextZoom(current, dir);
    wc.setZoomFactor(next);
    const host = hostOf(this.url);
    if (host && !this.win.isPrivate) ctx.db.setSiteSetting(host, 'zoom', next === 1 ? null : String(next));
    this.win.update();
  }

  noteCapture(): void {
    this.capturing = true;
  }

  setShieldReport(frameKey: string, count: number, features: string[]): void {
    this.frameShield.set(frameKey, { count, features });
    this.win.update();
  }

  shieldState(): ShieldTabState {
    const url = this.url;
    const host = hostOf(url);
    const web = /^https?:/.test(url);
    let count = 0;
    const features = new Set<string>();
    for (const r of this.frameShield.values()) {
      count += r.count;
      r.features.forEach((f) => features.add(f));
    }
    return {
      host: web ? host.replace(/^www\./, '') : '',
      supported: web && ctx.shield.isSupported(url),
      enabled: web && ctx.shield.isEnabledFor(url),
      hiddenCount: count,
      features: [...features],
    };
  }

  security(): Security {
    const url = this.url;
    if (!url || isInternalUrl(url)) return 'internal';
    if (url.startsWith('https:')) {
      return this.errorPage || this.win.manager.hasCertificateException(this.win.session, hostOf(url)) ? 'insecure' : 'secure';
    }
    if (url.startsWith('http:')) return 'insecure';
    if (url.startsWith('file:')) return 'file';
    return 'none';
  }

  state(): TabState {
    const url = this.url;
    const wc = this.wc;
    const parked = this.parked?.history;
    const internalNtp = isNewTabUrl(url);
    const zoom = wc?.getZoomFactor() ?? 1;
    return {
      id: this.id,
      title: this.title || (internalNtp ? 'New Tab' : url || 'New Tab'),
      url: internalNtp ? '' : url,
      favicon: this.favicon,
      loading: !!wc?.isLoading(),
      canGoBack: wc ? wc.navigationHistory.canGoBack() : !!parked && parked.index > 0,
      canGoForward: wc ? wc.navigationHistory.canGoForward() : !!parked && parked.index < parked.entries.length - 1,
      audible: !!wc?.isCurrentlyAudible(),
      muted: this.muted,
      crashed: this.crashed,
      security: this.security(),
      zoom: zoom !== 1 && this.isPdf() ? 1 : zoom,
      bookmarked: !!url && !internalNtp && ctx.db.isBookmarked(url),
      shield: this.shieldState(),
      adblock: wc ? ctx.adblock.tabState(wc.id, url) : { enabled: ctx.adblock.isEnabledFor(url), blocked: 0, hosts: [] },
      flags: this.flags,
      asleep: !wc,
    };
  }

  /** Creates the view for a new page (or adopts a popup's) and wires it to the tab. */
  private attach(init: { webContents?: WebContents; webPreferences?: WebPreferences }): WebContents {
    const view = new WebContentsView({
      webPreferences: init.webPreferences ?? webPreferencesFor(this.win.session),
      ...(init.webContents ? { webContents: init.webContents } : {}),
    });
    view.setBackgroundColor(this.win.isPrivate ? '#1b1b1f' : '#ffffff');
    view.setBounds(this.win.contentBounds());
    this.view_ = view;
    const wc = view.webContents;
    this.wcId = wc.id;
    this.wire(wc);
    this.win.manager.registerTab(this);
    return wc;
  }

  private recordVisit(url: string): void {
    const typed = this.typedPending;
    this.typedPending = false;
    if (this.win.isPrivate || !/^https?:/.test(url)) {
      this.lastCommitted = url;
      return;
    }
    if (url === this.lastCommitted && !typed) return; // reloads are not new visits
    this.lastCommitted = url;
    const title = this.wc?.getTitle() ?? '';
    try {
      ctx.db.addVisit(url, title === url ? '' : title, { typed });
    } catch (err) {
      console.error('history', err);
    }
  }

  private applySiteZoom(wc: WebContents, url: string): void {
    const host = hostOf(url);
    if (!host || this.win.isPrivate) return;
    const saved = Number(ctx.db.getSiteSetting(host, 'zoom') || '1');
    if (Number.isFinite(saved) && Math.abs(wc.getZoomFactor() - saved) > 0.001) wc.setZoomFactor(saved);
  }

  private resetPageState(): void {
    this.frameShield.clear();
    this.flags = { platform: null, hidden: 0, labeled: 0 };
  }

  /** The page unloaded for sleep: the tab stays, without a view, until it is activated again. */
  private finishSleep(view: WebContentsView): void {
    this.view_ = null;
    this.sleepPending = false;
    this.resetPageState();
    ctx.adblock.resetPage(this.wcId);
    this.win.manager.forgetWebContents(this.wcId);
    this.win.onTabSlept(this, view);
  }

  private handleDestroyed(): void {
    if (this.closed) return;
    this.closed = true;
    this.parked = null;
    ctx.adblock.resetPage(this.wcId);
    ctx.permissions.dropTab(this.id);
    ctx.passwords.tabClosed(this);
    this.win.onTabDestroyed(this);
  }

  private wire(wc: WebContents): void {
    const update = () => this.win.update();
    const view = this.view_!;

    wc.on('destroyed', () => {
      if (this.view_ !== view) return;
      if (this.sleepPending) this.finishSleep(view);
      else this.handleDestroyed();
    });
    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      const url = wc.getURL();
      if (!this.win.isPrivate && /^https?:/.test(url)) ctx.db.updateTitle(url, title);
      update();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      const url = favicons[0];
      if (!url || url === this.faviconUrl) return;
      this.faviconUrl = url;
      const pageHost = hostOf(wc.getURL());
      void fetchFavicon(this.win.session, url).then((data) => {
        if (!data || this.faviconUrl !== url || wc.isDestroyed()) return;
        this.favicon = data;
        if (!this.win.isPrivate && pageHost) ctx.db.setFavicon(pageHost, data);
        update();
      });
    });
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', () => {
      const current = wc.getTitle();
      if (!this.title && current && current !== wc.getURL()) this.title = current;
      update();
    });
    wc.on('did-start-navigation', (details) => {
      // potato://action/ links are cancelled in will-navigate and must not clear the error page.
      if (details.isMainFrame && !details.isSameDocument && !details.url.startsWith('potato://action/')) {
        this.errorPage = null;
        this.resetPageState();
        ctx.permissions.dropTab(this.id);
        ctx.passwords.navigationStarted(this, details.url);
      }
    });
    wc.on('did-frame-navigate', (_e, url, _code, _status, isMainFrame) => ctx.passwords.frameNavigated(this, url, isMainFrame));
    wc.on('did-navigate', (_e, url) => {
      ctx.adblock.pageCommitted(wc.id, url);
      const restored = this.restoring;
      this.crashed = false;
      this.capturing = false;
      this.refusedSleepAt = 0;
      this.lastUrl = url;
      const host = hostOf(url);
      if (host !== hostOf(this.lastCommitted) || !host) {
        this.faviconUrl = '';
        this.favicon = host ? ctx.db.favicon(host) : null;
      }
      if (isInternalUrl(url)) this.favicon = null;
      // Reloads keep their title and Chromium does not announce it again, so read it back.
      const current = wc.getTitle();
      const title = current && current !== url ? current : '';
      // A restored page keeps the title it was saved with until it announces its own.
      if (title || !restored) this.title = title;
      // Waking up or restoring a tab brings a page back; it is not a new visit.
      if (restored) {
        this.lastCommitted = url;
        this.typedPending = false;
      } else {
        this.recordVisit(url);
      }
      this.applySiteZoom(wc, url);
      this.win.onTabNavigated(this);
      update();
      if (restored) this.restored(wc);
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.lastUrl = url;
      const prev = this.lastCommitted.split('#')[0];
      if (url.split('#')[0] !== prev) this.recordVisit(url);
      this.win.onTabNavigated(this);
      update();
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: aborted (replaced navigation, download)
      this.lastUrl = url;
      this.errorPage = { url, code, desc, token: crypto.randomBytes(16).toString('hex') };
      this.typedPending = false;
      update();
      if (this.restoring) this.restored(wc);
    });
    wc.on('did-finish-load', () => {
      const err = this.errorPage;
      if (!err) return;
      const html = errorPageHtml(err.url, err.code, err.desc, err.token);
      wc.executeJavaScript(
        `if (location.protocol === 'chrome-error:') { document.open(); document.write(${JSON.stringify(html)}); document.close(); }`,
      ).catch(() => {});
    });
    wc.on('render-process-gone', (_e, details) => {
      // An unload for sleep is not a crash.
      if (details.reason === 'clean-exit' || wc.isDestroyed() || this.sleepPending) return;
      this.crashed = true;
      this.resetPageState();
      ctx.adblock.resetPage(wc.id);
      update();
      // A new renderer shows the crash page; its button reloads the original URL.
      const failed = this.lastUrl;
      setTimeout(() => {
        if (!wc.isDestroyed()) this.navigate(`potato://error/?reason=crashed&url=${encodeURIComponent(failed)}`);
      }, 50);
    });
    wc.on('audio-state-changed', () => {
      this.lastAudible = Date.now();
      update();
    });
    wc.on('found-in-page', (_e, result) => this.win.onFindResult(this, result));
    wc.on('enter-html-full-screen', () => this.win.setHtmlFullscreen(this, true));
    wc.on('leave-html-full-screen', () => this.win.setHtmlFullscreen(this, false));
    wc.on('zoom-changed', (_e, dir) => this.zoomStep(dir === 'in' ? 1 : -1));
    wc.on('context-menu', (_e, params) => this.win.manager.showPageContextMenu(this, params));
    wc.on('will-prevent-unload', (event) => {
      if (this.sleepPending) {
        // Unsaved changes: the tab stays awake, and nobody is asked to leave a page they are not looking at.
        this.sleepPending = false;
        this.parked = null;
        this.refusedSleepAt = Date.now();
        return;
      }
      const choice = dialog.showMessageBoxSync(this.win.base, {
        type: 'question',
        buttons: ['Leave', 'Stay'],
        defaultId: 0,
        cancelId: 1,
        message: 'Leave site?',
        detail: 'Changes you made may not be saved.',
      });
      if (choice === 0) event.preventDefault();
    });
    wc.on('will-navigate', (event) => this.guardNavigation(wc, event, event.url, event.initiator));
    // No device chooser yet, and Electron would otherwise connect the first nearby device.
    wc.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault();
      callback('');
    });
    // will-navigate does not see server redirects; no internal page is ever reached by one.
    wc.on('will-redirect', (event) => {
      if (event.url.startsWith('potato://')) event.preventDefault();
    });
    wc.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame && event.url.startsWith('potato://')) event.preventDefault();
    });
    wc.setWindowOpenHandler((details) => {
      const { url, disposition } = details;
      const opener = wc.getURL();
      if (url.startsWith('potato://') && !isInternalUrl(opener)) return { action: 'deny' };
      if (/^(javascript|file|chrome|devtools|view-source):/i.test(url)) return { action: 'deny' };
      return {
        action: 'allow',
        outlivesOpener: true,
        // Electron does not pass the opener's preload on, so without this a popup would run
        // without the AI Shield and flags.
        overrideBrowserWindowOptions: { webPreferences: webPreferencesFor(this.win.session) },
        createWindow: (options) => {
          const tab = this.win.createTab({
            webContents: (options as { webContents?: WebContents }).webContents,
            webPreferences: options.webPreferences,
            background: disposition === 'background-tab',
            index: this.win.tabs.indexOf(this) + 1,
            openerTabId: this.id,
          });
          return tab.wc!;
        },
      };
    });
  }

  private guardNavigation(wc: WebContents, event: Electron.Event, url: string, initiator?: Electron.WebFrameMain | null): void {
    if (url.startsWith('potato://action/')) {
      event.preventDefault();
      // Any page, or a popup holding this tab as its opener, can navigate here: only this tab's
      // own main frame counts, and handleAction checks the error page's token.
      const main = wc.mainFrame;
      if (initiator && initiator.frameToken === main.frameToken && initiator.processId === main.processId) void this.handleAction(url);
      return;
    }
    // Web pages may not navigate into privileged internal pages (except the new tab page).
    if (url.startsWith('potato://') && !isInternalUrl(wc.getURL()) && !isNewTabUrl(url)) {
      event.preventDefault();
    }
  }

  private async handleAction(actionUrl: string): Promise<void> {
    const u = new URL(actionUrl);
    const action = u.pathname.replace(/^\/+/, '');
    if (action === 'retry') {
      const target = this.errorPage?.url || this.url;
      this.errorPage = null;
      this.navigate(target);
    } else if (action === 'proceed') {
      const target = u.searchParams.get('url');
      const wc = this.wc;
      if (!wc || !target || !this.actionAllowed(u, target) || !this.errorPage!.desc.startsWith('ERR_CERT_')) return;
      this.win.manager.allowCertificateFor(wc, hostOf(target));
      this.errorPage = null;
      this.navigate(target);
    } else if (action === 'allow-chatbot') {
      const target = u.searchParams.get('url');
      if (!target || !this.actionAllowed(u, target)) return;
      allowChatbotOnce(target);
      this.errorPage = null;
      this.navigate(target);
    }
  }

  /** The link came from the error page showing now (its token) and is about that page's host. */
  private actionAllowed(u: URL, target: string): boolean {
    const err = this.errorPage;
    return !!err && u.searchParams.get('t') === err.token && hostOf(err.url) === hostOf(target);
  }

  siteKey(): string {
    return siteKey(this.url);
  }
}
