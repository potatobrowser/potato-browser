import { app, dialog } from 'electron';
import { NEW_TAB_URL } from '../shared/urls';
import { ctx } from './context';
import { bookmarksChanged } from './notify';
import type { BrowserWindowController } from './window';

function win(): BrowserWindowController | null {
  return ctx.windows.focused();
}

function tab() {
  return win()?.activeTab ?? null;
}

/** Opens an internal page, reusing a tab that already shows it. */
export function openInternal(page: string, hash = ''): void {
  const w = win() ?? ctx.windows.createWindow();
  const url = `potato://${page}/${hash}`;
  const existing = w.tabs.find((t) => t.url.startsWith(`potato://${page}/`));
  if (existing) {
    w.activate(existing);
    if (hash && existing.url !== url) existing.navigate(url);
  } else {
    const active = w.activeTab;
    // Replace an untouched new tab page instead of piling up tabs.
    if (active && (active.url === NEW_TAB_URL || active.url === '') && !active.wc.navigationHistory.canGoBack()) active.navigate(url);
    else w.newTab(url);
  }
  w.focus();
}

export const commands = {
  newTab: () => {
    const w = win() ?? ctx.windows.createWindow();
    w.newTab();
    w.focus();
  },
  newWindow: () => ctx.windows.createWindow().focus(),
  newPrivateWindow: () => ctx.windows.createWindow({ isPrivate: true }).focus(),
  closeTab: () => {
    const t = tab();
    if (t) t.win.closeTab(t);
    else win()?.base.close();
  },
  closeWindow: () => win()?.base.close(),
  reopenClosedTab: () => ctx.windows.reopenClosedTab(),
  focusOmnibox: () => win()?.focusOmnibox(),
  reload: () => tab()?.wc.reload(),
  hardReload: () => tab()?.wc.reloadIgnoringCache(),
  stop: () => tab()?.wc.stop(),
  back: () => {
    const t = tab();
    if (t?.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack();
  },
  forward: () => {
    const t = tab();
    if (t?.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward();
  },
  home: () => {
    const t = tab();
    const s = ctx.settings.get();
    t?.navigate(s.homepage || NEW_TAB_URL);
  },
  zoomIn: () => tab()?.zoomStep(1),
  zoomOut: () => tab()?.zoomStep(-1),
  zoomReset: () => tab()?.zoomStep(0),
  find: () => win()?.openFind(),
  findNext: () => {
    const w = win();
    const f = w?.state().find;
    if (w && f?.text) w.findQuery(f.text, true, true);
    else w?.openFind();
  },
  findPrevious: () => {
    const w = win();
    const f = w?.state().find;
    if (w && f?.text) w.findQuery(f.text, false, true);
  },
  toggleBookmarksBar: () => {
    ctx.settings.update({ showBookmarksBar: !ctx.settings.get().showBookmarksBar });
  },
  bookmarkPage: () => {
    const t = tab();
    if (!t || !t.url || t.url.startsWith('potato://newtab')) return;
    if (ctx.db.isBookmarked(t.url)) ctx.db.removeBookmarksByUrl(t.url);
    else ctx.db.addBookmark({ title: t.title || t.url, url: t.url });
    bookmarksChanged();
  },
  showHistory: () => openInternal('history'),
  showDownloads: () => openInternal('downloads'),
  showBookmarks: () => openInternal('bookmarks'),
  showSettings: () => openInternal('settings'),
  showImport: () => openInternal('settings', '#import'),
  showPasswords: () => openInternal('passwords'),
  importPasswords: () => openInternal('passwords', '#import'),
  showAbout: () => openInternal('settings', '#about'),
  checkForUpdates: () => {
    openInternal('settings', '#about');
    void ctx.updates.check();
  },
  nextTab: () => win()?.activateRelative(1),
  previousTab: () => win()?.activateRelative(-1),
  selectTab: (i: number) => win()?.activateIndex(i),
  selectLastTab: () => win()?.activateIndex(-1),
  toggleDevTools: () => {
    const t = tab();
    if (!t) return;
    if (t.wc.isDevToolsOpened()) t.wc.closeDevTools();
    else t.wc.openDevTools({ mode: 'detach' });
  },
  viewSource: () => {
    const t = tab();
    if (t?.url && /^https?:/.test(t.url)) t.win.newTab(`view-source:${t.url}`, { index: t.win.tabs.indexOf(t) + 1 });
  },
  print: () => tab()?.wc.print({}, () => {}),
  savePage: async () => {
    const t = tab();
    if (!t || !/^https?:/.test(t.url)) return;
    const res = await dialog.showSaveDialog(t.win.base, {
      defaultPath: `${(t.title || 'page').replace(/[/\\:]/g, '_')}.html`,
    });
    if (!res.canceled && res.filePath) await t.wc.savePage(res.filePath, 'HTMLComplete').catch(() => {});
  },
  toggleShieldForSite: () => {
    const t = tab();
    if (!t || !/^https?:/.test(t.url)) return;
    ctx.shield.setSiteEnabled(t.url, !ctx.shield.isEnabledFor(t.url));
  },
  toggleAdblockForSite: () => {
    const t = tab();
    if (!t || !/^https?:/.test(t.url)) return;
    ctx.adblock.setSiteEnabled(t.url, !ctx.adblock.isEnabledFor(t.url));
    t.wc.reload();
  },
  toggleMute: () => {
    const t = tab();
    if (t) {
      t.wc.setAudioMuted(!t.wc.isAudioMuted());
      t.win.update();
    }
  },
  quit: () => app.quit(),
};

export type CommandName = keyof typeof commands;
