import { app, clipboard, Menu, shell, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';
import { getSearchEngine, searchUrl } from '../shared/urls';
import { commands, openInternal } from './commands';
import { ctx } from './context';
import { bookmarksChanged } from './notify';
import { BOOKMARKS_BAR_ID } from './db';
import type { Tab } from './tab';
import type { BrowserWindowController } from './window';
import type { WindowManager } from './windows';

const sep: MenuItemConstructorOptions = { type: 'separator' };

export function buildAppMenu(): void {
  const tabItems: MenuItemConstructorOptions[] = Array.from({ length: 8 }, (_, i) => ({
    label: `Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    visible: false,
    click: () => commands.selectTab(i),
  }));
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: commands.showAbout },
        { label: 'Check for Updates...', click: commands.showAbout },
        sep,
        { label: 'Settings...', id: 'settings', accelerator: 'CmdOrCtrl+,', click: commands.showSettings },
        { label: 'Import Bookmarks and History...', click: commands.showImport },
        sep,
        { role: 'services' },
        sep,
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        sep,
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', id: 'new-tab', accelerator: 'CmdOrCtrl+T', click: commands.newTab },
        { label: 'New Window', id: 'new-window', accelerator: 'CmdOrCtrl+N', click: commands.newWindow },
        { label: 'New Private Window', id: 'new-private-window', accelerator: 'CmdOrCtrl+Shift+N', click: commands.newPrivateWindow },
        { label: 'Reopen Closed Tab', id: 'reopen-tab', accelerator: 'CmdOrCtrl+Shift+T', click: commands.reopenClosedTab },
        { label: 'Open Location...', id: 'open-location', accelerator: 'CmdOrCtrl+L', click: commands.focusOmnibox },
        sep,
        { label: 'Close Tab', id: 'close-tab', accelerator: 'CmdOrCtrl+W', click: commands.closeTab },
        { label: 'Close Window', id: 'close-window', accelerator: 'CmdOrCtrl+Shift+W', click: commands.closeWindow },
        sep,
        { label: 'Save Page As...', accelerator: 'CmdOrCtrl+S', click: () => void commands.savePage() },
        { label: 'Print...', accelerator: 'CmdOrCtrl+P', click: commands.print },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        sep,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        sep,
        { label: 'Find...', id: 'find', accelerator: 'CmdOrCtrl+F', click: commands.find },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: commands.findNext },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: commands.findPrevious },
        sep,
        { role: 'startSpeaking' },
        { role: 'stopSpeaking' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Always Show Bookmarks Bar', id: 'toggle-bookmarks-bar', type: 'checkbox', checked: ctx.settings.get().showBookmarksBar, accelerator: 'CmdOrCtrl+Shift+B', click: commands.toggleBookmarksBar },
        sep,
        { label: 'Stop', accelerator: 'Esc', registerAccelerator: false, click: commands.stop },
        { label: 'Reload This Page', id: 'reload', accelerator: 'CmdOrCtrl+R', click: commands.reload },
        { label: 'Force Reload This Page', accelerator: 'CmdOrCtrl+Shift+R', click: commands.hardReload },
        sep,
        { role: 'togglefullscreen' },
        { label: 'Actual Size', id: 'zoom-reset', accelerator: 'CmdOrCtrl+0', click: commands.zoomReset },
        { label: 'Zoom In', id: 'zoom-in', accelerator: 'CmdOrCtrl+Plus', click: commands.zoomIn },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, click: commands.zoomIn },
        { label: 'Zoom Out', id: 'zoom-out', accelerator: 'CmdOrCtrl+-', click: commands.zoomOut },
        sep,
        { label: 'Show AI Features on This Site', id: 'toggle-shield', click: commands.toggleShieldForSite },
        sep,
        {
          label: 'Developer',
          submenu: [
            { label: 'View Source', accelerator: 'Alt+CmdOrCtrl+U', click: commands.viewSource },
            { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: commands.toggleDevTools },
          ],
        },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', id: 'back', accelerator: 'CmdOrCtrl+[', click: commands.back },
        { label: 'Forward', id: 'forward', accelerator: 'CmdOrCtrl+]', click: commands.forward },
        { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: commands.home },
        sep,
        { label: 'Show All History', id: 'history', accelerator: 'CmdOrCtrl+Y', click: commands.showHistory },
        { label: 'Downloads', id: 'downloads', accelerator: 'CmdOrCtrl+Alt+L', click: commands.showDownloads },
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        { label: 'Bookmark This Tab...', id: 'bookmark-page', accelerator: 'CmdOrCtrl+D', click: commands.bookmarkPage },
        { label: 'Bookmark Manager', id: 'bookmarks', accelerator: 'Alt+CmdOrCtrl+B', click: commands.showBookmarks },
      ],
    },
    {
      label: 'Tab',
      submenu: [
        { label: 'Select Next Tab', id: 'next-tab', accelerator: 'Ctrl+Tab', click: commands.nextTab },
        { label: 'Select Previous Tab', id: 'previous-tab', accelerator: 'Ctrl+Shift+Tab', click: commands.previousTab },
        { label: 'Select Next Tab', accelerator: 'Alt+CmdOrCtrl+Right', visible: false, click: commands.nextTab },
        { label: 'Select Previous Tab', accelerator: 'Alt+CmdOrCtrl+Left', visible: false, click: commands.previousTab },
        { label: 'Select Next Tab', accelerator: 'CmdOrCtrl+Shift+]', visible: false, click: commands.nextTab },
        { label: 'Select Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', visible: false, click: commands.previousTab },
        ...tabItems,
        { label: 'Last Tab', accelerator: 'CmdOrCtrl+9', visible: false, click: commands.selectLastTab },
        sep,
        { label: 'Mute Tab', click: commands.toggleMute },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'No-AI Browser Website', click: () => void shell.openExternal('https://noaibrowser.laszlo-kiss27.workers.dev') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function refreshMenuChecks(): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('toggle-bookmarks-bar');
  if (item) item.checked = ctx.settings.get().showBookmarksBar;
}

function truncate(s: string, n = 30): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function showPageContextMenu(manager: WindowManager, tab: Tab, p: ContextMenuParams): void {
  const items: MenuItemConstructorOptions[] = [];
  const win = tab.win;
  const wc = tab.wc;
  const engine = getSearchEngine(ctx.settings.get().searchEngine);

  if (p.isEditable && p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!p.dictionarySuggestions.length) items.push({ label: 'No Guesses Found', enabled: false });
    items.push({ label: 'Learn Spelling', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, sep);
  }
  if (p.linkURL) {
    const link = p.linkURL;
    items.push(
      { label: 'Open Link in New Tab', click: () => win.newTab(link, { background: true, index: win.tabs.indexOf(tab) + 1 }) },
      { label: 'Open Link in New Window', click: () => manager.createWindow({ isPrivate: win.isPrivate, urls: [link] }) },
      { label: 'Open Link in Private Window', click: () => manager.openUrl(link, { isPrivate: true }) },
      sep,
      { label: 'Copy Link Address', click: () => clipboard.writeText(link) },
      sep,
    );
  }
  if (p.mediaType === 'image' && p.srcURL) {
    const src = p.srcURL;
    items.push(
      { label: 'Open Image in New Tab', click: () => win.newTab(src, { background: true, index: win.tabs.indexOf(tab) + 1 }) },
      { label: 'Save Image As...', click: () => wc.downloadURL(src) },
      { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(src) },
      sep,
    );
  }
  if (p.selectionText && !p.isEditable) {
    const text = p.selectionText;
    items.push(
      { label: 'Copy', role: 'copy' },
      { label: `Search ${engine.name.replace(/ \(.*\)$/, '')} for "${truncate(text)}"`, click: () => win.newTab(searchUrl(engine.id, text), { index: win.tabs.indexOf(tab) + 1 }) },
      sep,
    );
  }
  if (p.isEditable) {
    items.push(
      { role: 'undo', enabled: p.editFlags.canUndo },
      { role: 'redo', enabled: p.editFlags.canRedo },
      sep,
      { role: 'cut', enabled: p.editFlags.canCut },
      { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste },
      { role: 'pasteAndMatchStyle', enabled: p.editFlags.canPaste },
      { role: 'selectAll', enabled: p.editFlags.canSelectAll },
      sep,
    );
  }
  if (!p.linkURL && !p.selectionText && !p.isEditable && p.mediaType !== 'image') {
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      sep,
      { label: 'Save As...', click: () => void commands.savePage() },
      { label: 'Print...', click: () => wc.print({}, () => {}) },
      sep,
      { label: 'View Page Source', click: commands.viewSource },
    );
  }
  items.push({ label: 'Inspect', click: () => {
    wc.inspectElement(p.x, p.y);
    if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus();
  } });
  while (items[0]?.type === 'separator') items.shift();
  Menu.buildFromTemplate(items.filter((it, i, arr) => !(it.type === 'separator' && arr[i - 1]?.type === 'separator'))).popup({
    window: win.base,
  });
}

export function showTabContextMenu(win: BrowserWindowController, tab: Tab): void {
  const i = win.tabs.indexOf(tab);
  const muted = tab.wc.isAudioMuted();
  Menu.buildFromTemplate([
    { label: 'New Tab to the Right', click: () => win.newTab(undefined, { index: i + 1 }) },
    sep,
    { label: 'Reload', click: () => tab.wc.reload() },
    { label: 'Duplicate', click: () => win.duplicateTab(tab) },
    { label: muted ? 'Unmute Tab' : 'Mute Tab', click: () => { tab.wc.setAudioMuted(!muted); win.update(); } },
    sep,
    { label: 'Close Tab', click: () => win.closeTab(tab) },
    { label: 'Close Other Tabs', enabled: win.tabs.length > 1, click: () => win.closeOtherTabs(tab) },
    { label: 'Close Tabs to the Right', enabled: i < win.tabs.length - 1, click: () => win.closeTabsToRight(tab) },
    sep,
    { label: 'Reopen Closed Tab', enabled: win.closedTabs.length > 0, click: () => win.reopenClosedTab() },
  ]).popup({ window: win.base });
}

export function showOverflowMenu(win: BrowserWindowController, x: number, y: number): void {
  const t = win.activeTab;
  const zoom = Math.round((t?.wc.getZoomFactor() ?? 1) * 100);
  const update = ctx.updates.available();
  Menu.buildFromTemplate([
    ...(update ? [{ label: `Update available: ${update}`, click: commands.showAbout }, sep] : []),
    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: commands.newTab },
    { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: commands.newWindow },
    { label: 'New Private Window', accelerator: 'CmdOrCtrl+Shift+N', click: commands.newPrivateWindow },
    sep,
    { label: 'History', accelerator: 'CmdOrCtrl+Y', click: commands.showHistory },
    { label: 'Downloads', accelerator: 'CmdOrCtrl+Alt+L', click: commands.showDownloads },
    {
      label: 'Bookmarks',
      submenu: [
        { label: t && ctx.db.isBookmarked(t.url) ? 'Edit Bookmark...' : 'Bookmark This Tab', accelerator: 'CmdOrCtrl+D', click: commands.bookmarkPage },
        { label: 'Show Bookmarks Bar', type: 'checkbox', checked: ctx.settings.get().showBookmarksBar, click: commands.toggleBookmarksBar },
        { label: 'Bookmark Manager', click: commands.showBookmarks },
      ],
    },
    sep,
    { label: `Zoom (${zoom}%)`, submenu: [
      { label: 'Zoom In', click: commands.zoomIn },
      { label: 'Zoom Out', click: commands.zoomOut },
      { label: 'Actual Size', click: commands.zoomReset },
    ] },
    { label: 'Find...', accelerator: 'CmdOrCtrl+F', click: commands.find },
    { label: 'Print...', accelerator: 'CmdOrCtrl+P', click: commands.print },
    sep,
    { label: 'Import Bookmarks and History...', click: commands.showImport },
    { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: commands.showSettings },
    { label: 'About No-AI Browser', click: commands.showAbout },
  ]).popup({ window: win.base, x: Math.round(x), y: Math.round(y) });
}

/** Native dropdown for a bookmarks-bar folder. */
export function showBookmarkFolderMenu(win: BrowserWindowController, folderId: number, x: number, y: number): void {
  const build = (parentId: number, depth = 0): MenuItemConstructorOptions[] => {
    const children = ctx.db.bookmarkChildren(parentId);
    if (!children.length) return [{ label: '(empty)', enabled: false }];
    return children.map((c) =>
      c.type === 'folder'
        ? { label: truncate(c.title, 60), submenu: depth > 6 ? [] : build(c.id, depth + 1) }
        : { label: truncate(c.title || c.url || '', 60), click: () => win.activeTab?.navigate(c.url!) },
    );
  };
  Menu.buildFromTemplate(build(folderId)).popup({ window: win.base, x: Math.round(x), y: Math.round(y) });
}

export function showBookmarkItemMenu(win: BrowserWindowController, id: number, x: number, y: number): void {
  const b = ctx.db.getBookmark(id);
  if (!b) return;
  const items: MenuItemConstructorOptions[] = [];
  if (b.type === 'url' && b.url) {
    const url = b.url;
    items.push(
      { label: 'Open in New Tab', click: () => win.newTab(url, { background: true }) },
      { label: 'Open in New Window', click: () => ctx.windows.createWindow({ urls: [url] }) },
      { label: 'Open in Private Window', click: () => ctx.windows.openUrl(url, { isPrivate: true }) },
      sep,
      { label: 'Copy Link', click: () => clipboard.writeText(url) },
      sep,
    );
  }
  items.push(
    { label: 'Bookmark Manager', click: () => openInternal('bookmarks') },
    { label: 'Delete', click: () => { ctx.db.removeBookmark(id); bookmarksChanged(); } },
  );
  Menu.buildFromTemplate(items).popup({ window: win.base, x: Math.round(x), y: Math.round(y) });
}

export { BOOKMARKS_BAR_ID };
