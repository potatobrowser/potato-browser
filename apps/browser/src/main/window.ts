import { BaseWindow, WebContentsView, type Rectangle, type Session } from 'electron';
import type { FindState, WindowState } from '../shared/types';
import { isNewTabUrl, NEW_TAB_URL } from '../shared/urls';
import { ctx } from './context';
import { BOOKMARKS_BAR_ID } from './db';
import { isTest, paths } from './paths';
import { Tab, type TabInit } from './tab';
import type { WindowManager } from './windows';

export const DEFAULT_CHROME_HEIGHT = 82;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface ClosedTab {
  url: string;
  title: string;
  index: number;
}

export class BrowserWindowController {
  private static seq = 1;
  readonly id = BrowserWindowController.seq++;
  readonly base: BaseWindow;
  readonly ui: WebContentsView;
  readonly session: Session;
  readonly isPrivate: boolean;
  readonly manager: WindowManager;
  tabs: Tab[] = [];
  activeTab: Tab | null = null;
  closedTabs: ClosedTab[] = [];
  private chromeHeight = DEFAULT_CHROME_HEIGHT;
  private overlayOpen = false;
  private htmlFullscreenTab: Tab | null = null;
  private find: FindState | null = null;
  private updateQueued = false;
  private uiReady = false;
  private closing = false;

  constructor(manager: WindowManager, opts: { isPrivate: boolean; session: Session; uiSession: Session; bounds?: Partial<Rectangle> }) {
    this.manager = manager;
    this.isPrivate = opts.isPrivate;
    this.session = opts.session;
    const b = opts.bounds ?? {};
    this.base = new BaseWindow({
      width: b.width ?? 1280,
      height: b.height ?? 820,
      x: b.x,
      y: b.y,
      minWidth: 500,
      minHeight: 320,
      show: false,
      // e2e runs several apps at once: a window that can take focus blurs the others, closing their autofill dropdowns.
      focusable: !isTest(),
      title: 'Potato Browser',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 13 },
      backgroundColor: this.isPrivate ? '#202024' : '#e8e8eb',
    });
    this.ui = new WebContentsView({
      webPreferences: {
        session: opts.uiSession,
        preload: paths.uiPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    this.ui.setBackgroundColor('#00000000');
    this.base.contentView.addChildView(this.ui);
    this.layout();

    this.ui.webContents.on('did-finish-load', () => {
      this.uiReady = true;
      this.sendState();
      if (!this.base.isVisible() && !process.env.POTATO_HIDE_WINDOWS) this.base.show();
      if (this.activeTab && isNewTabUrl(this.activeTab.url || NEW_TAB_URL)) this.focusOmnibox();
    });
    this.ui.webContents.on('render-process-gone', () => {
      // The chrome UI must never stay dead; reload it.
      this.uiReady = false;
      setTimeout(() => !this.ui.webContents.isDestroyed() && this.ui.webContents.reload(), 300);
    });
    void this.ui.webContents.loadURL(`potato://ui/?window=${this.id}${this.isPrivate ? '&private=1' : ''}`);

    this.base.on('resize', () => {
      ctx.passwords.dropField(this);
      this.layout();
    });
    this.base.on('blur', () => ctx.passwords.hidePopup(this));
    this.base.on('focus', () => manager.onWindowFocused(this));
    this.base.on('enter-full-screen', () => this.update());
    this.base.on('leave-full-screen', () => this.update());
    this.base.on('moved', () => manager.saveSessionSoon());
    this.base.on('resized', () => manager.saveSessionSoon());
    this.base.on('close', () => {
      this.closing = true;
      for (const tab of [...this.tabs]) {
        this.base.contentView.removeChildView(tab.view);
        tab.close(true);
      }
    });
    this.base.on('closed', () => {
      if (!this.ui.webContents.isDestroyed()) this.ui.webContents.close();
      manager.onWindowClosed(this);
    });
  }

  get isClosing(): boolean {
    return this.closing;
  }

  // ---- layout ---------------------------------------------------------------------------------

  layout(): void {
    if (this.base.isDestroyed()) return;
    const { width, height } = this.base.getContentBounds();
    const full = !!this.htmlFullscreenTab;
    const top = full ? 0 : this.chromeHeight;
    const content = { x: 0, y: top, width, height: Math.max(0, height - top) };
    if (this.activeTab && !this.activeTab.isDestroyed) this.activeTab.view.setBounds(content);
    this.ui.setVisible(!full);
    this.ui.setBounds({ x: 0, y: 0, width, height: this.overlayOpen ? height : Math.min(height, this.chromeHeight) });
  }

  contentBounds(): Rectangle {
    const { width, height } = this.base.getContentBounds();
    return { x: 0, y: this.chromeHeight, width, height: Math.max(0, height - this.chromeHeight) };
  }

  setChromeHeight(px: number): void {
    const h = Math.max(40, Math.min(400, Math.round(px)));
    if (h === this.chromeHeight) return;
    this.chromeHeight = h;
    this.layout();
  }

  /** While a popover is open the transparent UI view covers the window so it can float over pages. */
  setOverlay(open: boolean): void {
    if (this.overlayOpen === open) return;
    this.overlayOpen = open;
    if (open) ctx.passwords.hidePopup(this);
    this.layout();
  }

  setHtmlFullscreen(tab: Tab, on: boolean): void {
    ctx.passwords.dropField(this);
    if (on) {
      this.htmlFullscreenTab = tab;
      if (!this.base.isFullScreen()) this.base.setFullScreen(true);
    } else if (this.htmlFullscreenTab === tab) {
      this.htmlFullscreenTab = null;
      if (this.base.isFullScreen()) this.base.setFullScreen(false);
    }
    this.layout();
    this.update();
  }

  // ---- tabs -----------------------------------------------------------------------------------

  createTab(init: TabInit): Tab {
    const tab = new Tab(this, init);
    tab.view.setBounds(this.contentBounds());
    const index = Math.max(0, Math.min(init.index ?? this.tabs.length, this.tabs.length));
    this.tabs.splice(index, 0, tab);
    this.manager.registerTab(tab);
    if (!init.background || !this.activeTab) this.activate(tab);
    this.update();
    this.manager.saveSessionSoon();
    return tab;
  }

  newTab(url?: string, opts: { background?: boolean; index?: number; typed?: boolean } = {}): Tab {
    const target = url || NEW_TAB_URL;
    const tab = this.createTab({ url: target, background: opts.background, index: opts.index, typed: opts.typed });
    if (!opts.background && isNewTabUrl(target)) this.focusOmnibox();
    return tab;
  }

  activate(tab: Tab): void {
    if (tab.isDestroyed || this.closing || this.base.isDestroyed()) return;
    if (this.activeTab === tab) {
      this.layout();
      return;
    }
    const prev = this.activeTab;
    ctx.passwords.dropField(this);
    this.activeTab = tab;
    this.base.contentView.addChildView(tab.view, 0);
    if (prev && prev !== tab && !prev.isDestroyed) this.base.contentView.removeChildView(prev.view);
    tab.lastActive = Date.now();
    this.closeFind();
    this.layout();
    if (isNewTabUrl(tab.url || NEW_TAB_URL) && !tab.wc.isLoading()) this.focusOmnibox();
    else tab.wc.focus();
    this.update();
  }

  activateIndex(i: number): void {
    const tab = i < 0 ? this.tabs[this.tabs.length - 1] : this.tabs[i];
    if (tab) this.activate(tab);
  }

  activateRelative(delta: number): void {
    if (!this.activeTab || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.activeTab);
    const next = this.tabs[(i + delta + this.tabs.length) % this.tabs.length];
    if (next) this.activate(next);
  }

  moveTab(tab: Tab, index: number): void {
    const from = this.tabs.indexOf(tab);
    if (from < 0) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, tab);
    this.update();
    this.manager.saveSessionSoon();
  }

  closeTab(tab: Tab): void {
    tab.close();
  }

  onTabDestroyed(tab: Tab): void {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.manager.unregisterTab(tab);
    const url = tab.lastUrl;
    if (url && !isNewTabUrl(url) && !this.closing) {
      this.closedTabs.push({ url, title: tab.title, index: i });
      if (this.closedTabs.length > 25) this.closedTabs.shift();
      this.manager.noteClosedTab(this, { url, title: tab.title, index: i });
    }
    this.tabs.splice(i, 1);
    if (!this.base.isDestroyed()) this.base.contentView.removeChildView(tab.view);
    if (this.closing) {
      // The window is going away: never re-attach views to it (that keeps the process alive).
      if (this.activeTab === tab) this.activeTab = null;
      return;
    }
    if (this.htmlFullscreenTab === tab) this.setHtmlFullscreen(tab, false);
    if (this.activeTab === tab) {
      this.activeTab = null;
      const opener = tab.openerTabId != null ? this.tabs.find((t) => t.id === tab.openerTabId) : undefined;
      const next = opener ?? this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
    }
    if (this.tabs.length === 0) {
      if (!this.closing && !this.base.isDestroyed()) this.base.close();
      return;
    }
    this.update();
    this.manager.saveSessionSoon();
  }

  reopenClosedTab(): boolean {
    const last = this.closedTabs.pop();
    if (!last) return false;
    this.createTab({ url: last.url, index: last.index });
    return true;
  }

  closeOtherTabs(keep: Tab): void {
    for (const t of [...this.tabs]) if (t !== keep) t.close();
  }

  closeTabsToRight(tab: Tab): void {
    const i = this.tabs.indexOf(tab);
    for (const t of this.tabs.slice(i + 1)) t.close();
  }

  duplicateTab(tab: Tab): void {
    this.createTab({ url: tab.url || NEW_TAB_URL, index: this.tabs.indexOf(tab) + 1 });
  }

  onTabNavigated(tab: Tab): void {
    if (tab === this.activeTab) this.closeFind();
    this.manager.saveSessionSoon();
  }

  // ---- find in page ---------------------------------------------------------------------------

  findQuery(text: string, forward = true, findNext = false): void {
    const tab = this.activeTab;
    if (!tab) return;
    if (!text) {
      tab.wc.stopFindInPage('clearSelection');
      this.find = { text: '', active: 0, matches: 0 };
      this.update();
      return;
    }
    this.find = { text, active: this.find?.active ?? 0, matches: this.find?.matches ?? 0 };
    tab.wc.findInPage(text, { forward, findNext });
  }

  onFindResult(tab: Tab, result: Electron.Result): void {
    if (tab !== this.activeTab || !this.find) return;
    this.find = { ...this.find, active: result.activeMatchOrdinal, matches: result.matches };
    this.update();
  }

  openFind(): void {
    this.find = this.find ?? { text: '', active: 0, matches: 0 };
    this.send('ui:event', { type: 'open-find' });
    this.ui.webContents.focus();
    this.update();
  }

  closeFind(): void {
    if (!this.find) return;
    this.find = null;
    if (this.activeTab && !this.activeTab.isDestroyed) this.activeTab.wc.stopFindInPage('keepSelection');
    this.update();
  }

  // ---- UI bridge ------------------------------------------------------------------------------

  focusOmnibox(): void {
    if (this.ui.webContents.isDestroyed()) return;
    this.ui.webContents.focus();
    this.send('ui:event', { type: 'focus-omnibox' });
  }

  send(channel: string, payload: unknown): void {
    if (!this.ui.webContents.isDestroyed()) this.ui.webContents.send(channel, payload);
  }

  update(): void {
    if (this.updateQueued) return;
    this.updateQueued = true;
    setImmediate(() => {
      this.updateQueued = false;
      this.sendState();
    });
  }

  state(): WindowState {
    const settings = ctx.settings.get();
    const tabs = this.tabs.filter((t) => !t.isDestroyed).map((t) => t.state());
    return {
      windowId: this.id,
      isPrivate: this.isPrivate,
      tabs,
      activeTabId: this.activeTab?.id ?? -1,
      bookmarksBar: settings.showBookmarksBar
        ? ctx.db.bookmarkChildren(BOOKMARKS_BAR_ID).map((b) => ({ ...b, favicon: b.url ? ctx.db.favicon(hostOf(b.url)) : null }))
        : null,
      permissionPrompts: ctx.permissions.promptsFor(this),
      find: this.find,
      fullscreen: !this.base.isDestroyed() && this.base.isFullScreen(),
      downloads: ctx.downloads.summary(this.isPrivate),
      theme: settings.theme,
      shieldGloballyEnabled: settings.shield.enabled,
      adblockGloballyEnabled: settings.adblock.enabled,
      update: ctx.updates.state(),
      passwordPrompt: ctx.passwords.promptFor(this),
    };
  }

  private sendState(): void {
    if (!this.uiReady || this.base.isDestroyed()) return;
    this.send('ui:state', this.state());
    const title = this.activeTab?.state().title;
    this.base.setTitle(title ? `${title}${this.isPrivate ? ' (Private)' : ''}` : 'Potato Browser');
  }

  focus(): void {
    if (this.base.isMinimized()) this.base.restore();
    this.base.show();
    this.base.focus();
  }
}
