import { expect, test } from '@playwright/test';
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

test('first run shows the welcome page with import and flag mode choices', async () => {
  b = await TestBrowser.launch({ firstRun: true, importHome: makeFakeHome() });
  const welcome = await b.tabPage('noai://welcome/');
  await expect(welcome.getByRole('heading', { name: 'The web, without the AI.' })).toBeVisible();
  await welcome.getByTestId('welcome-mode-hide').click();
  await expect.poll(async () => (await b.settings()).flags.mode).toBe('hide');
  await welcome.getByTestId('welcome-start').click();
  await expect.poll(() => b.activeTabUrl()).toBe('noai://newtab/');
  expect((await b.settings()).firstRunDone).toBe(true);
});
