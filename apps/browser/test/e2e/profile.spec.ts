import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { TestBrowser } from './support/browser';

let b: TestBrowser;
test.afterEach(async () => b?.close());

test('private windows keep cookies and history separate and forget them on close', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const normal = await b.goto('https://site.test/cookie', ui);
  await normal.click('#set');
  await expect(normal.locator('#before')).toHaveText('visited=yes');

  await b.cmd('newPrivateWindow');
  const pui = await b.uiPage();
  await expect(pui.getByTestId('private-indicator')).toBeVisible();
  expect(await b.app.evaluate(() => (globalThis as any).__noai.ctx.windows.focused().isPrivate)).toBe(true);
  const priv = await b.goto('https://site.test/cookie?private=1', pui);
  await expect(priv.locator('#before')).toHaveText('none');
  await expect(priv.locator('#storage-before')).toHaveText('none');
  await priv.click('#set');
  await expect(priv.locator('#before')).toHaveText('visited=yes');

  // Private visits never reach history.
  const urls: string[] = await b.app.evaluate(() => (globalThis as any).__noai.ctx.db.queryHistory('', 100).map((h: any) => h.url));
  expect(urls.some((u) => u.includes('private=1'))).toBe(false);
  expect(urls.some((u) => u === 'https://site.test/cookie')).toBe(true);

  // Closing the last private window wipes the private session.
  await b.cmd('closeWindow');
  await expect.poll(() => b.app.evaluate(() => (globalThis as any).__noai.ctx.windows.windows.filter((w: any) => w.isPrivate).length)).toBe(0);
  await b.cmd('newPrivateWindow');
  const pui2 = await b.uiPage();
  const priv2 = await b.goto('https://site.test/cookie?again=1', pui2);
  await expect(priv2.locator('#before')).toHaveText('none');
  await expect(priv2.locator('#storage-before')).toHaveText('none');
});

test('history page lists, searches and deletes visits', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.goto('https://site.test/title?t=Apple%20pie', ui);
  await b.goto('https://site.test/title?t=Banana%20bread', ui);
  await b.cmd('showHistory');
  const history = await b.tabPage('noai://history/');
  await expect(history.getByTestId('history-item')).toHaveCount(2);
  await expect(history.getByTestId('history-item').first()).toContainText('Banana bread');
  await history.getByTestId('history-search').fill('apple');
  await expect(history.getByTestId('history-item')).toHaveCount(1);
  await history.getByTestId('history-item').first().getByRole('button', { name: 'Remove from history' }).click();
  await expect(history.getByTestId('history-empty')).toBeVisible();
});

test('bookmark star, bookmarks bar and bookmark manager', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.goto('https://site.test/page2', ui);
  const star = ui.getByTestId('bookmark-star');
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(ui.getByTestId('bookmark-item')).toHaveText('Page Two');

  // Clicking the bar item navigates.
  await b.goto('https://site.test/', ui);
  await ui.getByTestId('bookmark-item').click();
  await expect.poll(() => b.activeTabUrl()).toBe('https://site.test/page2');

  await b.cmd('showBookmarks');
  const manager = await b.tabPage('noai://bookmarks/');
  await expect(manager.getByTestId('bookmark-row')).toHaveCount(1);
  await manager.getByTestId('bookmark-delete').click();
  await expect(manager.getByTestId('bookmark-row')).toHaveCount(0);
  await expect(ui.getByTestId('bookmark-item')).toHaveCount(0);

  // Toggle the bar off and on (Cmd+Shift+B).
  await b.cmd('toggleBookmarksBar');
  await expect(ui.getByTestId('bookmarks-bar')).toHaveCount(0);
  await b.cmd('toggleBookmarksBar');
  await expect(ui.getByTestId('bookmarks-bar')).toBeVisible();
});

test('downloads save to the downloads folder and show in the toolbar and page', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto('https://site.test/', ui);
  await page.click('#download');
  await expect(ui.getByTestId('downloads-button')).toBeVisible();
  const file = path.join(b.userData, 'Downloads', 'report.bin');
  await expect.poll(() => fs.existsSync(file) && fs.statSync(file).size).toBe(256 * 1024);

  // A second download of the same file gets a unique name.
  await page.click('#download');
  await expect.poll(() => fs.existsSync(path.join(b.userData, 'Downloads', 'report (1).bin'))).toBe(true);

  await ui.getByTestId('downloads-button').click();
  await expect(ui.getByTestId('downloads-panel')).toContainText('report.bin');
  await ui.keyboard.press('Escape');

  await b.cmd('showDownloads');
  const downloads = await b.tabPage('noai://downloads/');
  await expect(downloads.getByTestId('download-row')).toHaveCount(2);
  await expect(downloads.getByTestId('download-row').first()).toHaveAttribute('data-state', 'completed');
});

test('restores the previous session on startup', async () => {
  b = await TestBrowser.launch({ settings: { startup: 'restore' } });
  const ui = await b.uiPage();
  await b.goto('https://site.test/title?t=One', ui);
  await b.cmd('newTab');
  await b.goto('https://site.test/title?t=Two', ui);
  await b.cmd('selectTab', 0);
  await expect.poll(() => b.activeTabUrl()).toContain('t=One');
  const userData = b.userData;
  await b.close();

  b = await TestBrowser.launch({ userData });
  await expect.poll(() => b.tabUrls()).toEqual(['https://site.test/title?t=One', 'https://site.test/title?t=Two']);
  await expect.poll(() => b.activeTabUrl()).toContain('t=One');
});

test('clearing browsing data removes history', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.goto('https://site.test/title?t=Secret', ui);
  await b.cmd('showSettings');
  const settings = await b.tabPage('noai://settings/');
  await settings.evaluate(() => {
    location.hash = '#privacy';
  });
  await settings.getByTestId('clear-data').click();
  await expect(settings.getByTestId('clear-data')).toHaveText('Cleared');
  const count = await b.app.evaluate(() => (globalThis as any).__noai.ctx.db.historyCount());
  expect(count).toBe(0);
});
