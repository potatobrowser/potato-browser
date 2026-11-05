import { expect, test } from '@playwright/test';
import { TestBrowser } from './support/browser';

let b: TestBrowser;
test.afterEach(async () => b?.close());

test('permission prompts: block, allow and remember per site', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto('https://site.test/geo', ui);

  await page.click('#ask');
  const prompt = ui.getByTestId('permission-prompt');
  await expect(prompt).toContainText('site.test wants to know your location');
  await ui.getByTestId('permission-block').click();
  await expect(prompt).toHaveCount(0);
  await expect(page.locator('#out')).toHaveText('denied:1');
  // Remembered: no second prompt.
  await page.click('#ask');
  await expect(page.locator('#out')).toHaveText('denied:1');
  await expect(prompt).toHaveCount(0);

  await page.click('#notify');
  await expect(prompt).toContainText('show notifications');
  await ui.getByTestId('permission-allow').click();
  await expect(page.locator('#out')).toHaveText('notifications:granted');

  await b.cmd('showSettings');
  const settings = await b.tabPage('noai://settings/');
  await expect(settings.locator('.perm-list')).toContainText('site.test');
});

test('optional AI chatbot blocking with a one-time bypass', async () => {
  b = await TestBrowser.launch({ settings: { privacy: { globalPrivacyControl: true, blockAiChatbots: true } } });
  const ui = await b.uiPage();
  await ui.getByTestId('omnibox-input').fill('chatgpt.com');
  await ui.getByTestId('omnibox-input').press('Enter');
  const blocked = () =>
    b.app.windows().find((w) => w.url().startsWith('chrome-error://') || w.url().includes('chatgpt.com'));
  await expect.poll(async () => (await blocked()?.evaluate(() => document.body.innerText).catch(() => '')) ?? '').toContain('AI chatbot blocked');
  await blocked()!.getByRole('link', { name: 'Open chatgpt.com this time' }).click();
  const page = await b.tabPage('https://chatgpt.com/');
  await expect(page.locator('#chatbot')).toBeVisible();
});

test('new windows, private windows and the new tab page', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.goto('https://site.test/title?t=Visited%20often', ui);
  await b.cmd('newWindow');
  await expect.poll(() => b.app.evaluate(() => (globalThis as any).__noai.ctx.windows.windows.length)).toBe(2);
  const ntp = await b.tabPage('noai://newtab/');
  await expect(ntp.getByTestId('top-sites')).toContainText('Visited often');
  await ntp.getByTestId('ntp-search').fill('site.test/page2');
  await ntp.getByTestId('ntp-search').press('Enter');
  await expect.poll(() => b.activeTabUrl()).toBe('https://site.test/page2');

  await b.cmd('newPrivateWindow');
  await expect.poll(() => b.app.evaluate(() => (globalThis as any).__noai.ctx.windows.windows.filter((w: any) => w.isPrivate).length)).toBe(1);
});

test('settings changes apply immediately', async () => {
  b = await TestBrowser.launch();
  await b.cmd('showSettings');
  const settings = await b.tabPage('noai://settings/');
  await settings.getByTestId('engine-select').selectOption('brave');
  await expect.poll(async () => (await b.settings()).searchEngine).toBe('brave');
  await settings.getByTestId('startup-select').selectOption('restore');
  await expect.poll(async () => (await b.settings()).startup).toBe('restore');
  await settings.evaluate(() => {
    location.hash = '#flags';
  });
  await settings.getByTestId('flag-mode-hide').click();
  await settings.getByTestId('flag-threshold').selectOption('5');
  await expect.poll(async () => (await b.settings()).flags).toMatchObject({ mode: 'hide', threshold: 5 });
});
