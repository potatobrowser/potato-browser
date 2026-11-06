import { dialog, WebContentsView, type WebContents, type WebPreferences, type Session } from 'electron';
import type { FlagTabState, Security, ShieldTabState, TabState } from '../shared/types';
import { isInternalUrl, isNewTabUrl, NEW_TAB_URL, nextZoom, siteKey } from '../shared/urls';
import { ctx } from './context';
import { errorPageHtml } from './errorpage';
import { paths } from './paths';
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
}

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

export class Tab {
  private static seq = 1;
  readonly id = Tab.seq++;
  readonly view: WebContentsView;
  win: BrowserWindowController;
  title = '';
  favicon: string | null = null;
  crashed = false;
  openerTabId: number | null;
  lastActive = Date.now();
  /** Last committed URL, still available after the WebContents is destroyed. */
  lastUrl = '';
  flags: FlagTabState = { platform: null, hidden: 0, labeled: 0 };
  private faviconUrl = '';
  private errorPage: { url: string; code: number; desc: string } | null = null;
  private frameShield = new Map<string, { count: number; features: string[] }>();
  private lastCommitted = '';
  private typedPending = false;
  private destroyedHandled = false;

  constructor(win: BrowserWindowController, init: TabInit) {
    this.win = win;
    this.openerTabId = init.openerTabId ?? null;
    this.view = new WebContentsView({
      webPreferences: init.webPreferences ?? webPreferencesFor(win.session),
      ...(init.webContents ? { webContents: init.webContents } : {}),
    });
    this.view.setBackgroundColor(win.isPrivate ? '#1b1b1f' : '#ffffff');
    this.wire();
    if (init.url) this.navigate(init.url, { typed: init.typed });
  }

  get wc(): WebContents {
    return this.view.webContents;
  }

  get url(): string {
    if (this.wc.isDestroyed()) return '';
    return this.wc.getURL();
  }

  get isDestroyed(): boolean {
    return this.wc.isDestroyed();
  }

  navigate(url: string, opts: { typed?: boolean } = {}): void {
    this.typedPending = !!opts.typed;
    this.crashed = false;
    if (!this.lastUrl) this.lastUrl = url;
    this.wc.loadURL(url).catch(() => {
      // Failures are surfaced through did-fail-load (error page); aborted loads need nothing.
    });
  }

  /** Closes the tab, giving the page a chance to run beforeunload. */
  close(force = false): void {
    if (this.wc.isDestroyed()) {
      this.handleDestroyed();
      return;
    }
    if (force || this.crashed) this.wc.close();
    else this.wc.close({ waitForBeforeUnload: true });
  }

  zoomStep(dir: 1 | -1 | 0): void {
    const current = this.wc.getZoomFactor();
    const next = dir === 0 ? 1 : nextZoom(current, dir);
    this.wc.setZoomFactor(next);
    const host = hostOf(this.url);
    if (host && !this.win.isPrivate) ctx.db.setSiteSetting(host, 'zoom', next === 1 ? null : String(next));
    this.win.update();
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
    if (url.startsWith('https:')) return this.errorPage ? 'insecure' : 'secure';
    if (url.startsWith('http:')) return 'insecure';
    if (url.startsWith('file:')) return 'file';
    return 'none';
  }

  state(): TabState {
    const url = this.url;
    const internalNtp = isNewTabUrl(url);
    return {
      id: this.id,
      title: this.title || (internalNtp ? 'New Tab' : url || 'New Tab'),
      url: internalNtp ? '' : url,
      favicon: this.favicon,
      loading: !this.wc.isDestroyed() && this.wc.isLoading(),
      canGoBack: !this.wc.isDestroyed() && this.wc.navigationHistory.canGoBack(),
      canGoForward: !this.wc.isDestroyed() && this.wc.navigationHistory.canGoForward(),
      audible: !this.wc.isDestroyed() && this.wc.isCurrentlyAudible(),
      muted: !this.wc.isDestroyed() && this.wc.isAudioMuted(),
      crashed: this.crashed,
      security: this.security(),
      zoom: this.wc.isDestroyed() ? 1 : this.wc.getZoomFactor(),
      bookmarked: !!url && !internalNtp && ctx.db.isBookmarked(url),
      shield: this.shieldState(),
      flags: this.flags,
    };
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
    try {
      ctx.db.addVisit(url, this.wc.getTitle() === url ? '' : this.wc.getTitle(), { typed });
    } catch (err) {
      console.error('history', err);
    }
  }

  private applySiteZoom(url: string): void {
    const host = hostOf(url);
    if (!host || this.win.isPrivate) return;
    const saved = Number(ctx.db.getSiteSetting(host, 'zoom') || '1');
    if (Number.isFinite(saved) && Math.abs(this.wc.getZoomFactor() - saved) > 0.001) this.wc.setZoomFactor(saved);
  }

  private resetPageState(): void {
    this.frameShield.clear();
    this.flags = { platform: null, hidden: 0, labeled: 0 };
  }

  private handleDestroyed(): void {
    if (this.destroyedHandled) return;
    this.destroyedHandled = true;
    ctx.permissions.dropTab(this.id);
    this.win.onTabDestroyed(this);
  }

  private wire(): void {
    const wc = this.wc;
    const update = () => this.win.update();

    wc.on('destroyed', () => this.handleDestroyed());
    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      if (!this.win.isPrivate && /^https?:/.test(this.url)) ctx.db.updateTitle(this.url, title);
      update();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      const url = favicons[0];
      if (!url || url === this.faviconUrl) return;
      this.faviconUrl = url;
      const pageHost = hostOf(this.url);
      void fetchFavicon(this.win.session, url).then((data) => {
        if (!data || this.faviconUrl !== url || this.wc.isDestroyed()) return;
        this.favicon = data;
        if (!this.win.isPrivate && pageHost) ctx.db.setFavicon(pageHost, data);
        update();
      });
    });
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', () => {
      const current = wc.getTitle();
      if (!this.title && current && current !== this.url) this.title = current;
      update();
    });
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        this.errorPage = null;
        this.resetPageState();
        ctx.permissions.dropTab(this.id);
      }
    });
    wc.on('did-navigate', (_e, url) => {
      this.crashed = false;
      this.lastUrl = url;
      const host = hostOf(url);
      if (host !== hostOf(this.lastCommitted) || !host) {
        this.faviconUrl = '';
        this.favicon = host ? ctx.db.favicon(host) : null;
      }
      if (isInternalUrl(url)) this.favicon = null;
      // Reloads keep their title and Chromium does not announce it again, so read it back.
      const current = wc.getTitle();
      this.title = current && current !== url ? current : '';
      this.recordVisit(url);
      this.applySiteZoom(url);
      this.win.onTabNavigated(this);
      update();
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
      this.errorPage = { url, code, desc };
      this.typedPending = false;
      update();
    });
    wc.on('did-finish-load', () => {
      const err = this.errorPage;
      if (!err) return;
      const html = errorPageHtml(err.url, err.code, err.desc);
      wc.executeJavaScript(
        `if (location.protocol === 'chrome-error:') { document.open(); document.write(${JSON.stringify(html)}); document.close(); }`,
      ).catch(() => {});
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit' || this.wc.isDestroyed()) return;
      this.crashed = true;
      this.resetPageState();
      update();
      // A new renderer shows the crash page; its button reloads the original URL.
      const failed = this.lastUrl;
      setTimeout(() => {
        if (!this.wc.isDestroyed()) this.navigate(`noai://error/?reason=crashed&url=${encodeURIComponent(failed)}`);
      }, 50);
    });
    wc.on('audio-state-changed', update);
    wc.on('found-in-page', (_e, result) => this.win.onFindResult(this, result));
    wc.on('enter-html-full-screen', () => this.win.setHtmlFullscreen(this, true));
    wc.on('leave-html-full-screen', () => this.win.setHtmlFullscreen(this, false));
    wc.on('zoom-changed', (_e, dir) => this.zoomStep(dir === 'in' ? 1 : -1));
    wc.on('context-menu', (_e, params) => this.win.manager.showPageContextMenu(this, params));
    wc.on('will-prevent-unload', (event) => {
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
    wc.on('will-navigate', (event) => this.guardNavigation(event, event.url));
    wc.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame && event.url.startsWith('noai://')) event.preventDefault();
    });
    wc.setWindowOpenHandler((details) => {
      const { url, disposition } = details;
      const opener = this.url;
      if (url.startsWith('noai://') && !isInternalUrl(opener)) return { action: 'deny' };
      if (/^(javascript|file|chrome|devtools|view-source):/i.test(url)) return { action: 'deny' };
      return {
        action: 'allow',
        outlivesOpener: true,
        createWindow: (options) => {
          const tab = this.win.createTab({
            webContents: (options as { webContents?: WebContents }).webContents,
            webPreferences: options.webPreferences,
            background: disposition === 'background-tab',
            index: this.win.tabs.indexOf(this) + 1,
            openerTabId: this.id,
          });
          return tab.wc;
        },
      };
    });
  }

  private guardNavigation(event: Electron.Event, url: string): void {
    if (url.startsWith('noai://action/')) {
      event.preventDefault();
      void this.handleAction(url);
      return;
    }
    // Web pages may not navigate into privileged internal pages (except the new tab page).
    if (url.startsWith('noai://') && !isInternalUrl(this.url) && !url.startsWith(NEW_TAB_URL)) {
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
      if (!target) return;
      this.win.manager.allowCertificateFor(this.wc, hostOf(target));
      this.errorPage = null;
      this.navigate(target);
    } else if (action === 'allow-chatbot') {
      const target = u.searchParams.get('url');
      if (!target) return;
      allowChatbotOnce(target);
      this.errorPage = null;
      this.navigate(target);
    }
  }

  siteKey(): string {
    return siteKey(this.url);
  }
}
