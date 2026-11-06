import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { TestBrowser } from './support/browser';
import { makeFakeHome } from './support/fake-profiles';

let b: TestBrowser;
test.afterEach(async () => b?.close());

const tree = () => b.app.evaluate(() => (globalThis as any).__noai.ctx.db.bookmarkTree());
const historyUrls = () => b.app.evaluate(() => (globalThis as any).__noai.ctx.db.queryHistory('', 500).map((h: any) => h.url));

test('detects browsers and imports bookmarks and history from Chrome, Firefox and Safari', async () => {
  b = await TestBrowser.launch({ importHome: makeFakeHome() });
  const ui = await b.uiPage();
  await b.cmd('showImport');
  const settings = await b.tabPage('noai://settings/');
  const sources = settings.getByTestId('import-source');
  await expect(sources).toHaveCount(4);
  await expect(settings.getByTestId('import-sources')).toContainText('Google Chrome');
  await expect(settings.getByTestId('import-sources')).toContainText('Work');
  await expect(settings.getByTestId('import-sources')).toContainText('Firefox');
  await expect(settings.getByTestId('import-sources')).toContainText('Safari');

  // Chrome default profile: the bar comes over as is (ours was empty).
  const chrome = settings.locator('[data-source-id="chromium:chrome:Default"]');
  await chrome.getByTestId('import-run').click();
  await expect(chrome.getByTestId('import-result')).toHaveText('Imported 4 bookmarks and 2 history entries.');
  await expect(ui.getByTestId('bookmark-item')).toHaveText(['Hacker News', 'Wikipedia', 'Recipes']);
  const urls = await historyUrls();
  expect(urls).toContain('https://chrome-history.test/page');
  expect(urls.some((u: string) => u.startsWith('chrome://'))).toBe(false);

  // Firefox goes into its own folder now that the bar has items.
  const firefox = settings.locator('[data-source-id^="firefox:"]');
  await firefox.getByTestId('import-run').click();
  await expect(firefox.getByTestId('import-result')).toHaveText('Imported 2 bookmarks and 2 history entries.');
  await expect(ui.getByTestId('bookmark-item').last()).toHaveText('Imported from Firefox');

  const safari = settings.locator('[data-source-id="safari"]');
  await safari.getByTestId('import-run').click();
  await expect(safari.getByTestId('import-result')).toHaveText('Imported 3 bookmarks and 1 history entries.');
  expect(await historyUrls()).toContain('https://safari-history.test/');
  const [bar, other] = await tree();
  // Safari's bar goes into a bar folder; its menu and Reading List into Other Bookmarks.
  const barFolder = bar.children.find((c: any) => c.title === 'Imported from Safari');
  expect(barFolder.children.map((c: any) => c.title)).toEqual(['Apple & Co']);
  const otherJson = JSON.stringify(other);
  expect(otherJson).toContain('Imported from Safari');
  expect(otherJson).toContain('Reading List');

  // Importing again does not duplicate anything.
  await chrome.getByTestId('import-run').click();
  await expect(chrome.getByTestId('import-result')).toHaveText(/Imported 0 bookmarks/);
});

test('imported history powers omnibox suggestions', async () => {
  b = await TestBrowser.launch({ importHome: makeFakeHome() });
  const ui = await b.uiPage();
  await b.cmd('showImport');
  const settings = await b.tabPage('noai://settings/');
  const firefox = settings.locator('[data-source-id^="firefox:"]');
  await firefox.getByTestId('import-run').click();
  await expect(firefox.getByTestId('import-result')).toBeVisible();
  await b.cmd('newTab');
  await ui.getByTestId('omnibox-input').pressSequentially('mdn', { delay: 30 });
  await expect(ui.getByTestId('suggestions')).toContainText('MDN Web Docs');
  await expect(ui.getByTestId('omnibox-input')).toHaveValue('mdn.test');
});

test('first run shows the welcome page with search engine, flag mode and import choices', async () => {
  b = await TestBrowser.launch({ firstRun: true, importHome: makeFakeHome() });
  const welcome = await b.tabPage('noai://welcome/');
  await expect(welcome.getByRole('heading', { name: 'The web, without the AI.' })).toBeVisible();

  await expect(welcome.getByTestId('welcome-engine-duckduckgo')).toHaveAttribute('aria-checked', 'true');
  await welcome.getByTestId('welcome-engine-google').click();
  await expect.poll(async () => (await b.settings()).searchEngine).toBe('google');
  await expect(welcome.getByTestId('welcome-engine-google')).toHaveAttribute('aria-checked', 'true');

  await welcome.getByTestId('welcome-mode-hide').click();
  await expect.poll(async () => (await b.settings()).flags.mode).toBe('hide');
  await expect(welcome.getByTestId('welcome-mode-hide')).toHaveAttribute('aria-checked', 'true');

  const firefox = welcome.locator('[data-testid=welcome-source][data-source-id^="firefox:"]');
  await firefox.getByTestId('welcome-import').click();
  await expect(firefox.getByTestId('welcome-import-result')).toHaveText('2 bookmarks, 2 pages');
  await welcome.getByTestId('welcome-start').click();
  await expect.poll(() => b.activeTabUrl()).toBe('noai://newtab/');
  expect((await b.settings()).firstRunDone).toBe(true);
});

/** Makes Safari's files unreadable, the way macOS blocks them without Full Disk Access. */
function setSafariAccess(home: string, allowed: boolean): void {
  for (const f of ['Bookmarks.plist', 'History.db']) fs.chmodSync(path.join(home, 'Library', 'Safari', f), allowed ? 0o644 : 0o000);
}

async function stubOpenExternal(): Promise<void> {
  await b.app.evaluate(({ shell }) => {
    (globalThis as any).__opened = [];
    shell.openExternal = async (url: string) => void (globalThis as any).__opened.push(url);
  });
}

test('welcome: importing blocked Safari opens Full Disk Access and resumes once access is granted', async () => {
  const home = makeFakeHome();
  setSafariAccess(home, false);
  try {
    b = await TestBrowser.launch({ firstRun: true, importHome: home });
    await stubOpenExternal();
    const welcome = await b.tabPage('noai://welcome/');
    const safari = welcome.locator('[data-testid=welcome-source][data-source-id="safari"]');
    await expect(safari).toContainText('macOS asks for access first');
    await safari.getByTestId('welcome-import').click();
    await expect(safari.getByTestId('import-access')).toBeVisible();
    await expect.poll(() => b.app.evaluate(() => (globalThis as any).__opened)).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    ]);

    // Coming back without access keeps waiting.
    await b.app.evaluate(({ app }) => app.emit('did-become-active'));
    await welcome.waitForTimeout(300);
    await expect(safari.getByTestId('import-access')).toBeVisible();

    // The user switched access on in System Settings and comes back.
    setSafariAccess(home, true);
    await b.app.evaluate(({ app }) => app.emit('did-become-active'));
    await expect(safari.getByTestId('welcome-import-result')).toHaveText('3 bookmarks, 1 page');
    await expect(safari.getByTestId('import-access')).toHaveCount(0);
    expect(await historyUrls()).toContain('https://safari-history.test/');
  } finally {
    setSafariAccess(home, true);
  }
});

test('welcome: a Safari import waiting for access finishes after the app is reopened', async () => {
  const home = makeFakeHome();
  setSafariAccess(home, false);
  try {
    b = await TestBrowser.launch({ firstRun: true, importHome: home });
    await stubOpenExternal();
    let welcome = await b.tabPage('noai://welcome/');
    await welcome.locator('[data-source-id="safari"]').getByTestId('welcome-import').click();
    await expect(welcome.getByTestId('import-access')).toBeVisible();
    const userData = b.userData;
    await b.close();

    setSafariAccess(home, true);
    b = await TestBrowser.launch({ firstRun: true, importHome: home, userData });
    welcome = await b.tabPage('noai://welcome/');
    await expect(welcome.locator('[data-source-id="safari"]').getByTestId('welcome-import-result')).toHaveText('3 bookmarks, 1 page');
  } finally {
    setSafariAccess(home, true);
  }
});

test('settings: importing blocked Safari waits for access and then imports', async () => {
  const home = makeFakeHome();
  setSafariAccess(home, false);
  try {
    b = await TestBrowser.launch({ importHome: home });
    await stubOpenExternal();
    await b.cmd('showImport');
    const settings = await b.tabPage('noai://settings/');
    const safari = settings.locator('[data-source-id="safari"]');
    await expect(safari).toContainText('Import opens System Settings');
    await safari.getByTestId('import-run').click();
    await expect(safari.getByTestId('import-access')).toBeVisible();
    setSafariAccess(home, true);
    await safari.getByTestId('import-recheck').click();
    await expect(safari.getByTestId('import-result')).toHaveText('Imported 3 bookmarks and 1 history entries.');
  } finally {
    setSafariAccess(home, true);
  }
});
