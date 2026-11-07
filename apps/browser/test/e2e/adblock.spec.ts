import { expect, test, type Page } from '@playwright/test';
import { TestBrowser } from './support/browser';

let b: TestBrowser;
test.afterEach(async () => b?.close());

const NEWS = 'https://adblock.test/';
const ALL_ADS = 'adsense,apstag,fbevents,ga,gpt';
const CUSTOM = 'adblock.test##.potato-custom-ad\nadblock.test##+js(set-constant, potatoAdTest, true)';

/** Waits until the engine matches the settings (own filters compile in a utility process). */
async function engineReady(b: TestBrowser): Promise<void> {
  await expect.poll(() => b.app.evaluate(() => (globalThis as any).__potato.ctx.adblock.isCurrent()), { timeout: 30_000 }).toBe(true);
}

async function loaded(page: Page): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-ads', /.*/);
}

test('blocks ad and tracker requests and hides ad markup, keeps the page', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto(NEWS, ui);
  await loaded(page);
  // No ad or tracker script ran; the page's own script did.
  await expect(page.locator('body')).toHaveAttribute('data-ads', '');
  await expect(page.locator('body')).toHaveAttribute('data-app', 'true');
  // gpt.js got uBlock's neutered stand-in, so pages calling googletag do not break.
  await expect(page.locator('body')).toHaveAttribute('data-gpt', 'true');
  // Pages cannot probe for the stand-ins (and so for the browser) without the per-launch path.
  expect(await page.evaluate(() => fetch('potato-res://r/googletagservices_gpt.js').then((r) => r.status, () => 'failed'))).not.toBe(200);
  await expect(page.locator('#headline')).toBeVisible();
  await expect(page.locator('#story')).toBeVisible();
  // Generic cosmetic rules, also for ad markup added after load.
  await expect(page.locator('#generic-ad')).toBeHidden();
  await expect(page.locator('#late-ad')).toBeHidden();

  const badge = ui.getByTestId('adblock-badge');
  await expect.poll(async () => Number((await badge.textContent()) ?? 0)).toBeGreaterThanOrEqual(6);
  await expect(ui.getByTestId('adblock-button')).toHaveAttribute('data-state', 'on');
  await ui.getByTestId('adblock-button').click();
  const panel = ui.getByTestId('adblock-panel');
  await expect(panel).toContainText('mashed on this page');
  await expect(ui.getByTestId('adblock-hosts')).toContainText('googlesyndication.com');
  await expect(ui.getByTestId('adblock-hosts')).toContainText('doubleclick.net');
});

test('the toolbar switch lets ads through on one site, reloads it, and persists', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto(NEWS, ui);
  await expect(page.locator('body')).toHaveAttribute('data-ads', '');

  await ui.getByTestId('adblock-button').click();
  const toggle = ui.getByTestId('adblock-site-toggle');
  await expect(toggle).toBeChecked();
  await toggle.click();
  // The page reloads by itself and everything loads.
  await expect(page.locator('body')).toHaveAttribute('data-ads', ALL_ADS);
  await expect(page.locator('#generic-ad')).toBeVisible();
  await expect(ui.getByTestId('adblock-badge')).toHaveCount(0);
  await expect(ui.getByTestId('adblock-button')).toHaveAttribute('data-state', 'off');
  expect((await b.settings()).adblock.disabledSites).toContain('adblock.test');

  // Other sites are still filtered.
  await ui.keyboard.press('Escape');
  await b.cmd('newTab');
  const yt = await b.goto('https://www.youtube.com/adtest', ui);
  await expect(yt.locator('html')).toHaveAttribute('data-ad-placements', 'false');

  // Survives a restart, and switches back on.
  const userData = b.userData;
  await b.close();
  b = await TestBrowser.launch({ userData });
  const ui2 = await b.uiPage();
  const page2 = await b.goto(NEWS, ui2);
  await expect(page2.locator('body')).toHaveAttribute('data-ads', ALL_ADS);
  await ui2.getByTestId('adblock-button').click();
  await ui2.getByTestId('adblock-site-toggle').click();
  await expect(page2.locator('body')).toHaveAttribute('data-ads', '');
  expect((await b.settings()).adblock.disabledSites).not.toContain('adblock.test');
});

test('runs uBlock scriptlets before page scripts (YouTube video ads)', async () => {
  b = await TestBrowser.launch();
  const page = await b.goto('https://www.youtube.com/adtest');
  await expect(page.locator('html')).toHaveAttribute('data-title', 'How potatoes grow');
  await expect(page.locator('html')).toHaveAttribute('data-ad-placements', 'false');
  await expect(page.locator('html')).toHaveAttribute('data-builtins', 'true');
  expect(await page.evaluate(() => Function.prototype.toString.call(JSON.parse))).toContain('native code');
});

test('own filters compile in the background and apply, including scriptlets', async () => {
  b = await TestBrowser.launch({ settings: { adblock: { customFilters: CUSTOM } } });
  await engineReady(b);
  const ui = await b.uiPage();
  const page = await b.goto(NEWS, ui);
  await loaded(page);
  await expect(page.locator('#custom-ad')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-scriptlet', 'true');

  // Settings page: a bad line is reported, removing the filters brings the element back.
  await b.cmd('newTab');
  const settings = await b.goto('potato://settings/#adblock', ui);
  await settings.locator('[data-testid=adblock-custom] summary').click();
  const input = settings.getByTestId('adblock-custom-input');
  await expect(input).toHaveValue(CUSTOM);
  await input.fill('adblock.test#%#window.x = 1');
  await settings.getByTestId('adblock-custom-save').click();
  await expect(settings.getByTestId('adblock-custom-errors')).toContainText('adblock.test#%#window.x = 1');
  await engineReady(b);
  await b.cmd('closeTab');
  await page.reload();
  await loaded(page);
  await expect(page.locator('#custom-ad')).toBeVisible();
});

test('switching the blocker off in Settings lets everything load, list choices recompile', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const settings = await b.goto('potato://settings/#adblock', ui);
  await expect(settings.getByTestId('adblock-status')).toContainText('filters');
  await settings.getByTestId('adblock-global-toggle').click();
  expect((await b.settings()).adblock.enabled).toBe(false);

  await b.cmd('newTab');
  const page = await b.goto(NEWS, ui);
  await expect(page.locator('body')).toHaveAttribute('data-ads', ALL_ADS);
  await expect(ui.getByTestId('adblock-button')).toHaveAttribute('data-state', 'off');

  // Back on, with trackers allowed: analytics loads, ads still do not.
  await b.updateSettings({ adblock: { enabled: true, trackers: false } });
  await engineReady(b);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ads', /fbevents|ga/);
  expect(await page.locator('body').getAttribute('data-ads')).not.toMatch(/adsense|gpt|apstag/);
});

test('counts blocked requests for the new tab page, but not in private windows', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto(NEWS, ui);
  await expect(page.locator('body')).toHaveAttribute('data-ads', '');
  const stats = () =>
    b.app.evaluate(() => {
      const c = (globalThis as any).__potato.ctx;
      c.adblock.flushStats();
      return c.db.shieldStats().blockedToday as number;
    });
  await expect.poll(stats).toBeGreaterThanOrEqual(6);
  const before = await stats();

  await b.cmd('newTab');
  const ntp = await b.tabPage('potato://newtab');
  await expect(ntp.getByTestId('ntp-stats')).toContainText('ads and trackers mashed');

  await b.cmd('newPrivateWindow');
  const privUi = await b.uiPage();
  const priv = await b.goto(NEWS, privUi);
  await expect(priv.locator('body')).toHaveAttribute('data-ads', '');
  await expect(privUi.getByTestId('adblock-badge')).toBeVisible();
  expect(await stats()).toBe(before);
});
