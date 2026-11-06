import { app, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { isPlatform } from '@potato/shared';
import type { ClearDataOptions, SettingsPatch } from '../shared/types';
import { NEW_TAB_URL, resolveInput, SEARCH_ENGINES } from '../shared/urls';
import { commands, openInternal } from './commands';
import { ctx } from './context';
import { engineReport } from './engine';
import { detectSources, runImport } from './importers';
import { showBookmarkFolderMenu, showBookmarkItemMenu, showOverflowMenu, showTabContextMenu } from './menus';
import { bookmarksChanged } from './notify';
import { apiBase, APP_VERSION } from './paths';
import { allowChatbotOnce } from './sessions';
import { suggest } from './suggest';
import type { BrowserWindowController } from './window';

type Cmd = { type: string; [k: string]: any };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const str = (v: unknown, max = 8192) => (typeof v === 'string' ? v.slice(0, max) : '');

function windowForUi(sender: WebContents): BrowserWindowController | null {
  return ctx.windows.windows.find((w) => w.ui.webContents === sender) ?? null;
}

function handleUiCommand(win: BrowserWindowController, cmd: Cmd): void {
  const tabById = (id: unknown) => win.tabs.find((t) => t.id === id) ?? null;
  const active = win.activeTab;
  switch (cmd.type) {
    case 'tab.new':
      win.newTab(typeof cmd.url === 'string' ? cmd.url : undefined);
      break;
    case 'tab.close': {
      const t = tabById(cmd.tabId);
      if (t) win.closeTab(t);
      break;
    }
    case 'tab.activate': {
      const t = tabById(cmd.tabId);
      if (t) win.activate(t);
      break;
    }
    case 'tab.move': {
      const t = tabById(cmd.tabId);
      if (t && Number.isInteger(cmd.index)) win.moveTab(t, cmd.index);
      break;
    }
    case 'tab.menu': {
      const t = tabById(cmd.tabId);
      if (t) showTabContextMenu(win, t);
      break;
    }
    case 'tab.mute': {
      const t = tabById(cmd.tabId);
      if (t) {
        t.wc.setAudioMuted(!t.wc.isAudioMuted());
        win.update();
      }
      break;
    }
    case 'nav.go': {
      const url = resolveInput(str(cmd.input), ctx.settings.get().searchEngine);
      if (!url) break;
      if (cmd.newTab || !active) win.newTab(url, { typed: true, background: !!cmd.background });
      else {
        active.navigate(url, { typed: true });
        active.wc.focus();
      }
      break;
    }
    case 'nav.open': {
      const url = str(cmd.url);
      if (!/^(https?|potato|file|about|view-source|data):/i.test(url)) break;
      if (cmd.newTab || !active) win.newTab(url, { typed: true, background: !!cmd.background });
      else {
        active.navigate(url, { typed: true });
        active.wc.focus();
      }
      break;
    }
    case 'nav.back':
      if (active?.wc.navigationHistory.canGoBack()) active.wc.navigationHistory.goBack();
      break;
    case 'nav.forward':
      if (active?.wc.navigationHistory.canGoForward()) active.wc.navigationHistory.goForward();
      break;
    case 'nav.reload':
      if (cmd.hard) active?.wc.reloadIgnoringCache();
      else active?.wc.reload();
      break;
    case 'nav.stop':
      active?.wc.stop();
      break;
    case 'ui.overlay':
      win.setOverlay(!!cmd.open);
      break;
    case 'ui.height':
      if (Number.isFinite(num(cmd.height))) win.setChromeHeight(cmd.height);
      break;
    case 'ui.menu':
      showOverflowMenu(win, num(cmd.x) || 0, num(cmd.y) || 0);
      break;
    case 'ui.focusPage':
      active?.wc.focus();
      break;
    case 'ui.titlebarDoubleClick':
      if (win.base.isMaximized()) win.base.unmaximize();
      else win.base.maximize();
      break;
    case 'shield.setSite':
      if (active && /^https?:/.test(active.url)) ctx.shield.setSiteEnabled(active.url, !!cmd.enabled);
      break;
    case 'shield.openSettings':
      openInternal('settings', '#shield');
      break;
    case 'flags.openSettings':
      openInternal('settings', '#flags');
      break;
    case 'bookmark.toggle':
      commands.bookmarkPage();
      break;
    case 'bookmark.open': {
      const b = ctx.db.getBookmark(num(cmd.id));
      if (!b?.url) break;
      if (cmd.newTab) win.newTab(b.url, { background: !!cmd.background });
      else active?.navigate(b.url);
      break;
    }
    case 'bookmark.folder':
      showBookmarkFolderMenu(win, num(cmd.id), num(cmd.x) || 0, num(cmd.y) || 0);
      break;
    case 'bookmark.context':
      showBookmarkItemMenu(win, num(cmd.id), num(cmd.x) || 0, num(cmd.y) || 0);
      break;
    case 'find.query':
      win.findQuery(str(cmd.text, 500), cmd.forward !== false, !!cmd.findNext);
      break;
    case 'find.close':
      win.closeFind();
      active?.wc.focus();
      break;
    case 'permission.respond':
      ctx.permissions.respond(num(cmd.id), !!cmd.allow);
      break;
    case 'downloads.open':
      ctx.downloads.open(str(cmd.id));
      break;
    case 'downloads.show':
      ctx.downloads.show(str(cmd.id));
      break;
    case 'downloads.cancel':
      ctx.downloads.cancel(str(cmd.id));
      break;
    case 'downloads.showAll':
      openInternal('downloads');
      break;
    case 'zoom.reset':
      active?.zoomStep(0);
      break;
    case 'command':
      if (typeof cmd.name === 'string' && cmd.name in commands && cmd.name !== 'selectTab') {
        (commands as unknown as Record<string, () => unknown>)[cmd.name]!();
      }
      break;
  }
}

/** Methods available to internal potato:// pages through `window.potato.call(method, ...args)`. */
const internalApi: Record<string, (...args: any[]) => unknown> = {
  'settings.get': () => {
    const s = ctx.settings.get();
    return { ...s, installId: s.installId.slice(0, 8) };
  },
  'settings.set': (patch: SettingsPatch) => {
    if (!patch || typeof patch !== 'object') return null;
    const { installId: _ignored, ...rest } = patch as SettingsPatch & { installId?: unknown };
    const s = ctx.settings.update(rest);
    return { ...s, installId: s.installId.slice(0, 8) };
  },
  'search.engines': () => SEARCH_ENGINES,
  'history.query': (text: unknown, limit: unknown, before: unknown) =>
    ctx.db.queryHistory(str(text, 500), Math.min(500, num(limit) || 100), num(before) || Number.MAX_SAFE_INTEGER),
  'history.delete': (ids: unknown) => {
    if (Array.isArray(ids)) ctx.db.deleteVisits(ids.filter((i): i is number => Number.isInteger(i)));
  },
  'history.deleteUrl': (url: unknown) => ctx.db.deleteUrl(str(url)),
  'history.clear': (since: unknown) => ctx.db.clearHistory(num(since) || 0),
  'bookmarks.tree': () => ctx.db.bookmarkTree(),
  'bookmarks.add': (b: { parentId?: number; type?: 'folder' | 'url'; title?: string; url?: string; index?: number }) => {
    const id = ctx.db.addBookmark({
      parentId: Number.isInteger(b?.parentId) ? b.parentId : undefined,
      type: b?.type === 'folder' ? 'folder' : 'url',
      title: str(b?.title, 1000),
      url: b?.type === 'folder' ? null : str(b?.url),
      index: Number.isInteger(b?.index) ? b.index : undefined,
    });
    bookmarksChanged();
    return id;
  },
  'bookmarks.update': (id: unknown, patch: { title?: unknown; url?: unknown }) => {
    ctx.db.updateBookmark(num(id), {
      title: typeof patch?.title === 'string' ? patch.title.slice(0, 1000) : undefined,
      url: typeof patch?.url === 'string' ? patch.url.slice(0, 8192) : undefined,
    });
    bookmarksChanged();
  },
  'bookmarks.remove': (id: unknown) => {
    ctx.db.removeBookmark(num(id));
    bookmarksChanged();
  },
  'bookmarks.move': (id: unknown, parentId: unknown, index: unknown) => {
    ctx.db.moveBookmark(num(id), num(parentId), num(index));
    bookmarksChanged();
  },
  'downloads.list': () => ctx.downloads.list().map((d) => ({ ...d, exists: d.state === 'completed' ? ctx.downloads.exists(d.id) : true })),
  'downloads.open': (id: unknown) => ctx.downloads.open(str(id)),
  'downloads.show': (id: unknown) => ctx.downloads.show(str(id)),
  'downloads.cancel': (id: unknown) => ctx.downloads.cancel(str(id)),
  'downloads.pause': (id: unknown) => ctx.downloads.pause(str(id)),
  'downloads.remove': (id: unknown) => ctx.downloads.remove(str(id)),
  'downloads.clear': () => ctx.downloads.clear(),
  topSites: () => ctx.db.topSites(8),
  'shield.stats': () => ctx.db.shieldStats(),
  'shield.rules': () => ctx.shield.summaries(),
  'shield.setSite': (host: unknown, enabled: unknown) => {
    const h = str(host, 300).replace(/^https?:\/\//, '').split('/')[0];
    if (h) ctx.shield.setSiteEnabled(`https://${h}/`, !!enabled);
  },
  'flags.stats': () => ({ mine: ctx.db.myFlagCount() }),
  'permissions.list': () => ctx.permissions.list(),
  'permissions.reset': (origin: unknown, kind: unknown) => ctx.permissions.reset(str(origin), str(kind)),
  'import.detect': () => detectSources(),
  'import.run': (sourceId: unknown, what: { bookmarks?: unknown; history?: unknown }) =>
    runImport(str(sourceId), { bookmarks: what?.bookmarks !== false, history: what?.history !== false }).then((r) => {
      bookmarksChanged();
      return r;
    }),
  'app.info': () => ({
    name: app.name,
    version: APP_VERSION,
    chromium: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
    v8: process.versions.v8,
    engine: engineReport(),
    installIdShort: ctx.settings.get().installId.slice(0, 8),
    apiBase: apiBase(),
  }),
  'app.isDefaultBrowser': () => app.isDefaultProtocolClient('https') && app.isDefaultProtocolClient('http'),
  'app.defaultBrowserName': () => app.getApplicationNameForProtocol('https://') || null,
  'app.setDefaultBrowser': () => {
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');
    return true;
  },
  'app.checkUpdates': async () => {
    const info = await ctx.updates.check();
    return { latest: info, available: ctx.updates.available(), current: APP_VERSION };
  },
  'app.openDownloadPage': () => void shell.openExternal(apiBase() + '/#download'),
  'app.chooseDownloadsDir': async () => {
    const win = ctx.windows.focused();
    const opts = { defaultPath: ctx.settings.get().downloadsDir, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const res = win ? await dialog.showOpenDialog(win.base, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  },
  'app.openFullDiskAccess': () =>
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'),
  'app.relaunch': () => {
    app.relaunch();
    app.quit();
  },
  'app.clearData': async (o: ClearDataOptions) => {
    const since = num(o?.since) || 0;
    if (o?.history) ctx.db.clearHistory(since);
    if (o?.downloads) ctx.db.clearDownloads(since);
    if (o?.cookies) await ctx.windows.mainSession.clearStorageData();
    if (o?.cache) await ctx.windows.mainSession.clearCache();
    ctx.windows.broadcast();
    return true;
  },
  'app.finishWelcome': () => {
    ctx.settings.update({ firstRunDone: true });
  },
  'chatbot.allowOnce': (url: unknown) => allowChatbotOnce(str(url)),
  newTab: () => NEW_TAB_URL,
};

function isInternalSender(e: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = e.senderFrame;
  return !!frame && frame.parent === null && frame.url.startsWith('potato://') && !!ctx.windows.tabFor(e.sender);
}

export function registerIpc(): void {
  ipcMain.on('ui:command', (e, cmd: Cmd) => {
    const win = windowForUi(e.sender);
    if (win && cmd && typeof cmd.type === 'string') handleUiCommand(win, cmd);
  });
  ipcMain.handle('ui:suggest', (e, text: unknown) => {
    if (!windowForUi(e.sender)) return { input: '', suggestions: [], inline: null };
    return suggest(str(text, 2000));
  });

  ipcMain.handle('potato:api', async (e, method: unknown, ...args: unknown[]) => {
    if (!isInternalSender(e) || typeof method !== 'string' || !(method in internalApi)) {
      throw new Error('Not allowed');
    }
    return internalApi[method]!(...args);
  });

  // ---- web pages (preload) ----------------------------------------------------------------------
  ipcMain.on('page:config', (e) => {
    const tab = ctx.windows.tabFor(e.sender);
    // Never trust a URL the page reports about itself; ask the browser which document this is.
    const frame = e.senderFrame;
    const topUrl = frame && frame.parent === null ? frame.url : e.sender.getURL();
    e.returnValue = ctx.shield.pageConfig(e.sender, topUrl, tab?.win.isPrivate ?? false);
  });
  ipcMain.on('page:shield-report', (e, r: { count?: unknown; features?: unknown; delta?: unknown }) => {
    const tab = ctx.windows.tabFor(e.sender);
    if (!tab || !r) return;
    const count = Math.max(0, Math.min(10_000, num(r.count) || 0));
    const features = Array.isArray(r.features) ? r.features.filter((f): f is string => typeof f === 'string').slice(0, 30) : [];
    tab.setShieldReport(`${e.processId}:${e.frameId}`, count, features);
    ctx.shield.recordHidden(Math.max(0, Math.min(1000, num(r.delta) || 0)), tab.win.isPrivate);
  });
  const keyList = (keys: unknown) =>
    Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string' && k.length < 300) : [];
  ipcMain.handle('page:flags-lookup', (e, keys: unknown, localOnly: unknown) => {
    const tab = ctx.windows.tabFor(e.sender);
    if (!tab) return {};
    return ctx.flags.lookup(keyList(keys), tab.win.isPrivate, localOnly === true);
  });
  ipcMain.handle('page:flags-set', (e, keys: unknown, flag: unknown) => {
    const tab = ctx.windows.tabFor(e.sender);
    if (!tab) throw new Error('Not allowed');
    return ctx.flags.set(keyList(keys), flag === true, tab.win.isPrivate);
  });
  ipcMain.on('page:flags-report', (e, r: { platform?: unknown; hidden?: unknown; labeled?: unknown }) => {
    const tab = ctx.windows.tabFor(e.sender);
    if (!tab || !r || (e.senderFrame && e.senderFrame.parent !== null)) return;
    tab.flags = {
      platform: isPlatform(r.platform) ? r.platform : null,
      hidden: Math.max(0, num(r.hidden) || 0),
      labeled: Math.max(0, num(r.labeled) || 0),
    };
    tab.win.update();
  });
}
