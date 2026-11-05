import { expect, test } from '@playwright/test';
import { TestBrowser } from './support/browser';

let b: TestBrowser;
test.afterEach(async () => b?.close());

test('starts with a new tab and navigates from the omnibox', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await expect(ui.getByTestId('tab')).toHaveCount(1);
  await expect(ui.getByTestId('tab-title')).toHaveText('New Tab');
  await expect(ui.getByTestId('omnibox-input')).toBeFocused();

  const page = await b.goto('site.test', ui);
  await expect(page).toHaveTitle('Site Test Home');
  expect(await b.activeTabUrl()).toBe('https://site.test/');
  await expect(ui.getByTestId('tab-title')).toHaveText('Site Test Home');
  await expect(ui.getByTestId('omnibox')).toContainText('site.test');
});

test('back, forward and reload', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto('https://site.test/', ui);
  await page.click('#to-page2');
  await expect(ui.getByTestId('tab-title')).toHaveText('Page Two');
  await expect(ui.getByTestId('back')).toBeEnabled();
  await ui.getByTestId('back').click();
  await expect(ui.getByTestId('tab-title')).toHaveText('Site Test Home');
  await expect(ui.getByTestId('forward')).toBeEnabled();
  await ui.getByTestId('forward').click();
  await expect(ui.getByTestId('tab-title')).toHaveText('Page Two');
  await b.cmd('back');
  await expect(ui.getByTestId('tab-title')).toHaveText('Site Test Home');
  await ui.getByTestId('reload').click();
  await expect(ui.getByTestId('tab-title')).toHaveText('Site Test Home');
});

test('searches with the configured engine when input is not a URL', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const input = ui.getByTestId('omnibox-input');
  await input.fill('how do magnets work');
  await input.press('Enter');
  const page = await b.tabPage('https://noai.duckduckgo.com/');
  await expect(page.locator('#q')).toHaveText('how do magnets work');

  await b.updateSettings({ searchEngine: 'google-web' });
  await input.click();
  await input.fill('cats');
  await input.press('Enter');
  await expect.poll(() => b.activeTabUrl()).toContain('https://www.google.com/search?q=cats&udm=14');
});

test('opens, switches, closes, reorders and reopens tabs', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.goto('https://site.test/title?t=Alpha', ui);
  await ui.getByTestId('new-tab').click();
  await expect(ui.getByTestId('tab')).toHaveCount(2);
  await expect(ui.getByTestId('omnibox-input')).toBeFocused();
  await b.goto('https://site.test/title?t=Beta', ui);
  await b.cmd('newTab');
  await b.goto('https://site.test/title?t=Gamma', ui);
  await expect(ui.getByTestId('tab-title')).toHaveText(['Alpha', 'Beta', 'Gamma']);

  // Switch by clicking and by shortcut command.
  await ui.getByTestId('tab').nth(0).click();
  await expect.poll(() => b.activeTabUrl()).toContain('Alpha');
  await b.cmd('selectTab', 2);
  await expect.poll(() => b.activeTabUrl()).toContain('Gamma');
  await b.cmd('previousTab');
  await expect.poll(() => b.activeTabUrl()).toContain('Beta');

  // Drag "Alpha" to the end.
  const first = ui.getByTestId('tab').nth(0);
  const box = (await first.boundingBox())!;
  const last = (await ui.getByTestId('tab').nth(2).boundingBox())!;
  await ui.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await ui.mouse.down();
  await ui.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 3 });
  await ui.mouse.move(last.x + last.width / 2 + 10, last.y + last.height / 2, { steps: 8 });
  await ui.mouse.up();
  await expect(ui.getByTestId('tab-title')).toHaveText(['Beta', 'Gamma', 'Alpha']);

  // Close via the tab's close button, then reopen it.
  await ui.getByTestId('tab').nth(1).hover();
  await ui.getByTestId('tab').nth(1).getByTestId('tab-close').click();
  await expect(ui.getByTestId('tab-title')).toHaveText(['Beta', 'Alpha']);
  await b.cmd('reopenClosedTab');
  await expect(ui.getByTestId('tab-title')).toHaveText(['Beta', 'Gamma', 'Alpha']);

  // Middle click closes a tab.
  await ui.getByTestId('tab').nth(0).click({ button: 'middle' });
  await expect(ui.getByTestId('tab-title')).toHaveText(['Gamma', 'Alpha']);
});

test('closing the last tab closes the window', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.cmd('closeTab');
  await expect.poll(() => b.app.evaluate(() => (globalThis as any).__noai.ctx.windows.windows.length)).toBe(0);
  await expect.poll(() => ui.isClosed()).toBe(true);
});

test('omnibox suggests history and completes hosts inline', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.goto('https://site.test/page2', ui);
  await b.cmd('newTab');
  const input = ui.getByTestId('omnibox-input');
  await input.pressSequentially('sit', { delay: 40 });
  await expect(ui.getByTestId('suggestions')).toBeVisible();
  await expect(ui.getByTestId('suggestions')).toContainText('Page Two');
  await expect(input).toHaveValue('site.test');
  await input.press('Enter');
  await expect.poll(() => b.activeTabUrl()).toBe('https://site.test/');
});

test('target=_blank links and window.open open new tabs with an opener', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto('https://site.test/', ui);
  await page.click('#blank');
  await expect(ui.getByTestId('tab')).toHaveCount(2);
  await expect.poll(() => b.activeTabUrl()).toBe('https://site.test/page2?from=blank');
  await ui.getByTestId('tab').nth(0).click();
  await page.click('#open-popup');
  const popup = await b.tabPage('https://site.test/popup');
  await expect(popup.locator('#opener')).toHaveText('has-opener');
  await expect(ui.getByTestId('tab')).toHaveCount(3);
});

test('find in page counts matches', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.goto('https://site.test/', ui);
  await b.cmd('find');
  await expect(ui.getByTestId('findbar')).toBeVisible();
  await ui.getByTestId('find-input').fill('needle');
  await expect(ui.getByTestId('find-count')).toHaveText('1/3');
  await ui.getByTestId('find-input').press('Enter');
  await expect(ui.getByTestId('find-count')).toHaveText('2/3');
  await ui.getByTestId('find-input').press('Escape');
  await expect(ui.getByTestId('findbar')).toHaveCount(0);
});

test('zoom in, out and reset per site', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.goto('https://site.test/', ui);
  await b.cmd('zoomIn');
  await expect(ui.getByTestId('omnibox')).toContainText('110%');
  await b.cmd('zoomIn');
  await expect(ui.getByTestId('omnibox')).toContainText('125%');
  await b.cmd('zoomOut');
  await expect(ui.getByTestId('omnibox')).toContainText('110%');
  await b.cmd('zoomReset');
  await expect(ui.getByTestId('omnibox')).not.toContainText('%');
});

test('shows a friendly error page when a site cannot be reached', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await ui.getByTestId('omnibox-input').fill('https://nonexistent.invalid/');
  await ui.getByTestId('omnibox-input').press('Enter');
  await expect.poll(async () => {
    const p = b.app.windows().find((w) => w.url().startsWith('chrome-error://') || w.url().includes('nonexistent.invalid'));
    return p ? p.evaluate(() => document.body.innerText).catch(() => '') : '';
  }, { timeout: 20_000 }).toMatch(/can't be reached|isn't working/);
  await expect(ui.getByTestId('omnibox')).toContainText('nonexistent.invalid');
});

test('internal pages are reachable and web pages cannot navigate into them', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.cmd('showSettings');
  const settings = await b.tabPage('noai://settings/');
  await expect(settings.getByRole('heading', { name: 'General' })).toBeVisible();
  await b.cmd('newTab');
  const page = await b.goto('https://site.test/', ui);
  await page.evaluate(() => {
    location.href = 'noai://settings/';
  });
  await page.waitForTimeout(800);
  expect(await b.activeTabUrl()).toBe('https://site.test/');
});
