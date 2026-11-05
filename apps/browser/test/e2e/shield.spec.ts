import { expect, test, type Page } from '@playwright/test';
import { TestBrowser } from './support/browser';

let b: TestBrowser;
test.afterEach(async () => b?.close());

async function hidden(page: Page, selectors: string[]) {
  for (const s of selectors) await expect(page.locator(s).first(), `${s} should be hidden`).toBeHidden();
}
async function visible(page: Page, selectors: string[]) {
  for (const s of selectors) await expect(page.locator(s).first(), `${s} should be visible`).toBeVisible();
}

const GOOGLE_AI = ['#aio-css', '#aio-wrapper', '#aio-text', '#tab-ai', '#paa-ai', '#dive'];
const GOOGLE_HUMAN = ['#r0', '#r3', '#r-ai-title', '#tab-all', '#tab-images', '#paa-human'];

test('hides Google AI Overviews, AI Mode and AI answers, keeps real results', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto('https://www.google.com/search?q=how+do+magnets+work', ui);
  await hidden(page, GOOGLE_AI);
  await visible(page, GOOGLE_HUMAN);
  // The async AI Overview request never reaches Google.
  await expect(page.locator('body')).toHaveAttribute('data-folsrch', 'blocked');

  const badge = ui.getByTestId('shield-badge');
  await expect(badge).toBeVisible();
  expect(Number(await badge.textContent())).toBeGreaterThanOrEqual(4);
  await ui.getByTestId('shield-button').click();
  await expect(ui.getByTestId('shield-panel')).toContainText('AI Overviews');
  await expect(ui.getByTestId('shield-panel')).toContainText('AI Mode');
});

test('the toolbar shield turns hiding off and on per site, live and persistently', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto('https://www.google.com/search?q=how+do+magnets+work', ui);
  await hidden(page, GOOGLE_AI);

  await ui.getByTestId('shield-button').click();
  const toggle = ui.getByTestId('shield-site-toggle');
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  // Applied live, without a reload.
  await visible(page, ['#aio-css', '#aio-text', '#tab-ai', '#paa-ai', '#dive']);
  await expect(ui.getByTestId('shield-badge')).toHaveCount(0);
  await expect(ui.getByTestId('shield-button')).toHaveAttribute('data-state', 'off');
  expect((await b.settings()).shield.disabledSites).toContain('google.com');

  // Requests flow again once the page reloads.
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-folsrch', 'AI content');

  // Other sites are unaffected.
  await ui.keyboard.press('Escape');
  await b.cmd('newTab');
  const bing = await b.goto('https://www.bing.com/search?q=magnets', ui);
  await hidden(bing, ['#copilot-answer']);

  // Survives a restart.
  const userData = b.userData;
  await b.close();
  b = await TestBrowser.launch({ userData });
  const ui2 = await b.uiPage();
  const page2 = await b.goto('https://www.google.com/search?q=how+do+magnets+work', ui2);
  await visible(page2, ['#aio-css', '#tab-ai']);

  // And back on.
  await ui2.getByTestId('shield-button').click();
  await ui2.getByTestId('shield-site-toggle').click();
  await hidden(page2, GOOGLE_AI);
  expect((await b.settings()).shield.disabledSites).not.toContain('google.com');
});

test('sends Google AI Mode back to normal results', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const open = async (url: string) => {
    await ui.getByTestId('omnibox-input').fill(url);
    await ui.getByTestId('omnibox-input').press('Enter');
  };
  await open('https://www.google.com/search?q=cats&udm=50&aep=1');
  await expect.poll(() => b.activeTabUrl()).toBe('https://www.google.com/search?q=cats');

  await b.updateSettings({ shield: { disabledSites: ['google.com'] } });
  await open('https://www.google.com/search?q=dogs&udm=50');
  await expect.poll(() => b.activeTabUrl()).toBe('https://www.google.com/search?q=dogs&udm=50');
});

test('Gmail: hides Gemini and Help me write without touching email content', async () => {
  b = await TestBrowser.launch();
  const page = await b.goto('https://mail.google.com/mail/u/0/');
  await hidden(page, ['#gemini-wrap', '#gemini-btn', '#hmw', '#hmw-de', '#summary-card']);
  await visible(page, ['#row-gemini', '#row-lunch', '#send', '#support']);
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search mail');
});

test('YouTube, Bing, DuckDuckGo and Amazon AI features are hidden', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const yt = await b.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', ui);
  await hidden(yt, ['#ask-wrap', '#video-summary']);
  await visible(yt, ['#like', '#desc-text']);

  const bing = await b.goto('https://www.bing.com/search?q=magnets', ui);
  await hidden(bing, ['#copilot-answer', '#b-scopeListItem-copilotsearch', '#codex']);
  await visible(bing, ['#result1', '#b-scopeListItem-web']);

  const ddg = await b.goto('https://duckduckgo.com/?q=magnets', ui);
  await hidden(ddg, ['#assist', '#duckai', '#duck-link']);
  await visible(ddg, ['#result1']);

  const amazon = await b.goto('https://www.amazon.com/dp/B000TEST', ui);
  await hidden(amazon, ['#nav-rufus-disco', '#nile-inline_feature_div', '#highlights', '#cr-summary_feature_div']);
  await visible(amazon, ['#productTitle', '#reviews', '#nav-cart']);
});

test('social sites: Grok, Meta AI, Reddit Answers and LinkedIn AI writing are hidden', async () => {
  b = await TestBrowser.launch({ settings: { flags: { mode: 'ignore', showButtons: false, threshold: 3, disabledPlatforms: [] } } });
  const ui = await b.uiPage();
  const x = await b.goto('https://x.com/home', ui);
  await hidden(x, ['#nav-grok', '#grok-drawer', '#grok-actions-1', '#grok-actions-2']);
  await visible(x, ['#nav-home', '#tw1 [data-testid=tweetText]', '#tw2']);

  const fb = await b.goto('https://www.facebook.com/', ui);
  await hidden(fb, ['#nav-metaai']);
  await visible(fb, ['#nav-friends', '#fb1', '#fb2']);
  await expect(fb.locator('#fb-search')).toHaveAttribute('placeholder', 'Search Facebook');

  const ig = await b.goto('https://www.instagram.com/', ui);
  await hidden(ig, ['#nav-metaai']);
  await visible(ig, ['#nav-home', '#ig1']);
  await expect(ig.locator('#ig-search')).toHaveAttribute('placeholder', 'Search');

  const reddit = await b.goto('https://www.reddit.com/r/test/', ui);
  await hidden(reddit, ['#answers-nav-button', '#comment-summary']);
  await visible(reddit, ['#home', '#a1', '#c1']);

  const li = await b.goto('https://www.linkedin.com/feed/', ui);
  await hidden(li, ['#rewrite-ai']);
  await visible(li, ['#post-btn', '#li1']);
});

test('the global switch in Settings shows everything again', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto('https://www.google.com/search?q=how+do+magnets+work', ui);
  await hidden(page, ['#aio-css']);

  await b.cmd('showSettings');
  const settings = await b.tabPage('noai://settings/');
  await settings.getByTestId('shield-global-toggle').click();
  expect((await b.settings()).shield.enabled).toBe(false);

  await ui.getByTestId('tab').nth(0).click();
  await visible(page, ['#aio-css', '#tab-ai']);
  await ui.getByTestId('shield-button').click();
  await expect(ui.getByTestId('shield-site-toggle')).toBeDisabled();
});

test('settings list per-site exceptions and can remove them', async () => {
  b = await TestBrowser.launch({ settings: { shield: { enabled: true, disabledSites: ['bing.com', 'google.com'], disabledRules: [] } } });
  await b.cmd('showSettings');
  const settings = await b.tabPage('noai://settings/');
  const list = settings.getByTestId('shield-exceptions');
  await expect(list).toContainText('bing.com');
  await list.getByRole('button', { name: 'Hide AI on bing.com again' }).click();
  await expect(list).not.toContainText('bing.com');
  expect((await b.settings()).shield.disabledSites).toEqual(['google.com']);
});
