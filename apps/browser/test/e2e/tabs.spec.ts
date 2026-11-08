import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestBrowser } from './support/browser';

let b: TestBrowser;
test.afterEach(async () => b?.close());

// A "minute" of 100 ms: tabs set to sleep after 15 minutes sleep after 1.5 s.
const SLEEPY = { env: { POTATO_TEST_MINUTE_MS: '100' }, settings: { tabs: { sleepAfter: 15 } } };

interface TabInfo {
  url: string;
  title: string;
  loaded: boolean;
  pid: number;
}

/** The focused window's tabs as the main process sees them. */
function tabs(): Promise<TabInfo[]> {
  return b.app.evaluate(() =>
    (globalThis as any).__potato.ctx.windows.focused().tabs.map((t: any) => ({ url: t.url, title: t.title, loaded: !!t.wc, pid: t.wc?.getOSProcessId() ?? 0 })),
  );
}

const loaded = async () => (await tabs()).map((t) => t.loaded);

function tabWc<T>(index: number, js: string): Promise<T> {
  return b.app.evaluate(({}, [i, code]) => (globalThis as any).__potato.ctx.windows.focused().tabs[i as number].wc.executeJavaScript(code), [index, js] as const);
}

const visits = (url: string) => b.app.evaluate(({}, u) => (globalThis as any).__potato.ctx.db.queryHistory('', 500).filter((h: any) => h.url === u).length, url);

function writeSession(dir: string, session: unknown): void {
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session));
}

test('restored tabs show their saved title and load when first opened, with their history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-e2e-'));
  const t = (name: string) => `https://site.test/title?t=${name}`;
  writeSession(dir, {
    windows: [
      {
        bounds: { x: 40, y: 40, width: 1100, height: 760 },
        tabs: [t('One'), t('Two'), t('Three')],
        active: 1,
        history: [
          { index: 1, entries: [{ url: t('Zero'), title: 'Zero' }, { url: t('One'), title: 'Saved One' }] },
          { index: 0, entries: [{ url: t('Two'), title: 'Saved Two' }] },
          { index: 0, entries: [{ url: t('Three'), title: 'Saved Three' }] },
        ],
      },
    ],
  });
  b = await TestBrowser.launch({ userData: dir, settings: { startup: 'restore' } });
  const ui = await b.uiPage();
  // Only the active tab loads; the others show what was saved, dimmed.
  await expect(ui.getByTestId('tab-title')).toHaveText(['Saved One', 'Two', 'Saved Three']);
  expect(await loaded()).toEqual([false, true, false]);
  await expect(ui.locator('[data-testid=tab][data-asleep]')).toHaveCount(2);
  expect((await tabs()).map((x) => x.url)).toEqual([t('One'), t('Two'), t('Three')]);

  await ui.getByTestId('tab').nth(0).click();
  await expect.poll(() => b.activeTabUrl()).toBe(t('One'));
  await expect(ui.getByTestId('tab-title').nth(0)).toHaveText('One');
  expect(await loaded()).toEqual([true, true, false]);
  await expect(ui.getByTestId('back')).toBeEnabled();
  await ui.getByTestId('back').click();
  await expect.poll(() => b.activeTabUrl()).toBe(t('Zero'));
  // Bringing tabs back is not visiting them again.
  expect(await visits(t('One'))).toBe(0);
  expect(await visits(t('Two'))).toBe(0);
});

test('a session saved by 0.7, with addresses only, still comes back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-e2e-'));
  writeSession(dir, { windows: [{ bounds: { x: 40, y: 40, width: 1100, height: 760 }, tabs: ['https://site.test/page2', 'https://other.test/'], active: 1 }] });
  b = await TestBrowser.launch({ userData: dir, settings: { startup: 'restore' } });
  const ui = await b.uiPage();
  await expect(ui.getByTestId('tab-title')).toHaveText(['https://site.test/page2', 'Other Site']);
  expect(await loaded()).toEqual([false, true]);
  await ui.getByTestId('tab').nth(0).click();
  await expect(ui.getByTestId('tab-title').nth(0)).toHaveText('Page Two');
  await expect(ui.getByTestId('back')).toBeDisabled();
});

test('a background tab falls asleep and wakes with its page, history, scroll position and form', async () => {
  b = await TestBrowser.launch(SLEEPY);
  const ui = await b.uiPage();
  await b.goto('https://site.test/', ui);
  const page = await b.goto('https://site.test/long', ui);
  await page.locator('#field').fill('half a potato');
  await page.evaluate(() => window.scrollTo(0, 1500));
  await b.cmd('newTab');
  await b.goto('https://other.test/', ui);
  const pid = (await tabs())[0]!.pid;
  expect(pid).toBeGreaterThan(0);

  await expect.poll(loaded, { timeout: 20_000 }).toEqual([false, true]);
  await expect(ui.getByTestId('tab').nth(0)).toHaveAttribute('data-asleep', 'true');
  await expect(ui.getByTestId('tab-title')).toHaveText(['Long Furrow', 'Other Site']);
  // Its renderer is gone; sleeping is not closing.
  const pids = await b.app.evaluate(({ app }) => app.getAppMetrics().map((m) => m.pid));
  expect(pids).not.toContain(pid);
  expect(await b.app.evaluate(() => (globalThis as any).__potato.ctx.windows.focused().closedTabs.length)).toBe(0);

  await ui.getByTestId('tab').nth(0).click();
  await expect.poll(() => b.activeTabUrl()).toBe('https://site.test/long');
  await expect.poll(() => tabWc<number>(0, 'document.readyState === "complete" ? window.scrollY : -1')).toBe(1500);
  expect(await tabWc<string>(0, 'document.getElementById("field").value')).toBe('half a potato');
  await expect(ui.getByTestId('back')).toBeEnabled();
  expect(await visits('https://site.test/long')).toBe(1);
  // The tab in front now is the other one's turn to sleep.
  await expect.poll(loaded, { timeout: 20_000 }).toEqual([true, false]);
});

test('tabs playing sound or holding unsaved changes stay awake', async () => {
  b = await TestBrowser.launch(SLEEPY);
  const ui = await b.uiPage();
  const audio = await b.goto('https://site.test/audio', ui);
  await audio.locator('#play').click();
  await expect(audio.locator('#state')).toHaveText('running');
  await b.cmd('newTab');
  const note = await b.goto('https://site.test/unsaved', ui);
  await note.locator('#note').click();
  await note.keyboard.type('Dear diary, the potatoes');
  await b.cmd('newTab');
  await b.goto('https://other.test/', ui);

  // Well past the 1.5 s: both stay, and no "Leave site?" dialog came up (it would block this call).
  await new Promise((r) => setTimeout(r, 5000));
  expect(await loaded()).toEqual([true, true, true]);
  expect(await b.app.evaluate(() => (globalThis as any).__potato.ctx.windows.focused().tabs[1].refusedSleepAt)).toBeGreaterThan(0);
  expect(await b.app.evaluate(() => (globalThis as any).__potato.ctx.windows.focused().tabs[0].wc.isCurrentlyAudible())).toBe(true);

  // Silence lets it sleep a little later.
  await audio.locator('#stop').click();
  await expect.poll(loaded, { timeout: 20_000 }).toEqual([false, true, true]);
  // Quitting is not held up by the page that would not unload.
  expect(await b.close(15_000)).toBeLessThan(15_000);
});

test('sites allowed to notify and tabs linked by window.open stay awake', async () => {
  b = await TestBrowser.launch(SLEEPY);
  const ui = await b.uiPage();
  const geo = await b.goto('https://site.test/geo', ui);
  await geo.click('#notify');
  await ui.getByTestId('permission-allow').click();
  await expect(geo.locator('#out')).toHaveText('notifications:granted');
  await b.cmd('newTab');
  await b.goto('https://other.test/', ui);
  await b.cmd('newTab');
  const shop = await b.goto('https://shop.test/', ui);
  await shop.evaluate(() => {
    (window as any).child = window.open('https://frame.test/', '_blank');
  });
  await expect.poll(() => b.activeTabUrl()).toBe('https://frame.test/');
  await b.cmd('newTab');
  // Only the plain tab sleeps: the web app may notify, the opener and its popup still talk.
  await expect.poll(loaded, { timeout: 20_000 }).toEqual([true, false, true, true, true]);
  await new Promise((r) => setTimeout(r, 3000));
  expect(await loaded()).toEqual([true, false, true, true, true]);
  expect(await shop.evaluate(() => (window as any).child.closed)).toBe(false);
});

test('asleep tabs are kept when quitting and come back on the next launch', async () => {
  b = await TestBrowser.launch({ ...SLEEPY, settings: { ...SLEEPY.settings, startup: 'restore' } });
  const ui = await b.uiPage();
  await b.goto('https://site.test/title?t=Alpha', ui);
  await b.goto('https://site.test/title?t=Beta', ui);
  await b.cmd('newTab');
  await b.goto('https://site.test/title?t=Gamma', ui);
  await b.cmd('newTab');
  await b.goto('https://other.test/', ui);
  await expect.poll(loaded, { timeout: 20_000 }).toEqual([false, false, true]);
  const userData = b.userData;
  await b.close();

  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'session.json'), 'utf8'));
  expect(saved.windows[0].tabs).toEqual(['https://site.test/title?t=Beta', 'https://site.test/title?t=Gamma', 'https://other.test/']);
  expect(saved.windows[0].history[0].entries.map((e: any) => e.title)).toEqual(['New Tab', 'Alpha', 'Beta']);

  b = await TestBrowser.launch({ userData, settings: { tabs: { sleepAfter: 0 } } });
  const ui2 = await b.uiPage();
  await expect(ui2.getByTestId('tab-title')).toHaveText(['Beta', 'Gamma', 'Other Site']);
  expect(await loaded()).toEqual([false, false, true]);
  await ui2.getByTestId('tab').nth(0).click();
  await expect.poll(() => b.activeTabUrl()).toBe('https://site.test/title?t=Beta');
  await ui2.getByTestId('back').click();
  await expect.poll(() => b.activeTabUrl()).toBe('https://site.test/title?t=Alpha');
});

test('tab menu actions and private windows work with asleep tabs', async () => {
  b = await TestBrowser.launch(SLEEPY);
  await b.cmd('newPrivateWindow');
  const ui = await b.uiPage();
  const cookie = await b.goto('https://site.test/cookie', ui);
  await cookie.click('#set');
  await expect(cookie.locator('#before')).toHaveText('visited=yes');
  await b.goto('https://site.test/title?t=Second', ui);
  await b.cmd('newTab');
  await b.goto('https://other.test/', ui);
  await expect.poll(loaded, { timeout: 20_000 }).toEqual([false, true]);

  // Mute, duplicate and reload act on the saved tab.
  await b.app.evaluate(() => {
    const win = (globalThis as any).__potato.ctx.windows.focused();
    win.tabs[0].setMuted(true);
    win.duplicateTab(win.tabs[0]);
  });
  await expect.poll(() => b.activeTabUrl()).toBe('https://site.test/title?t=Second');
  await expect(ui.getByTestId('back')).toBeEnabled();
  expect((await b.windowState()).tabs[0]).toMatchObject({ muted: true, asleep: true });
  await b.app.evaluate(() => (globalThis as any).__potato.ctx.windows.focused().tabs[0].reload());
  await expect.poll(async () => (await tabs())[0]).toMatchObject({ loaded: true, url: 'https://site.test/title?t=Second' });
  expect(await b.app.evaluate(() => (globalThis as any).__potato.ctx.windows.focused().tabs[0].wc.isAudioMuted())).toBe(true);
  // The private session lives on while its tabs sleep: going back finds the cookie.
  await b.app.evaluate(() => (globalThis as any).__potato.ctx.windows.focused().activateIndex(0));
  await ui.getByTestId('back').click();
  await expect.poll(() => b.activeTabUrl()).toBe('https://site.test/cookie');
  const again = await b.tabPage('https://site.test/cookie');
  await expect(again.locator('#before')).toHaveText('visited=yes');

  // Closing others closes asleep tabs too, and reopening brings their history back.
  await expect.poll(loaded, { timeout: 20_000 }).toEqual([true, false, false]);
  await b.app.evaluate(() => {
    const win = (globalThis as any).__potato.ctx.windows.focused();
    win.closeOtherTabs(win.tabs[0]);
  });
  await expect.poll(async () => (await tabs()).length).toBe(1);
  await b.cmd('reopenClosedTab');
  await expect.poll(() => b.activeTabUrl()).toBe('https://other.test/');
  await b.cmd('reopenClosedTab');
  await expect.poll(() => b.activeTabUrl()).toBe('https://site.test/title?t=Second');
  await expect(ui.getByTestId('back')).toBeEnabled();
  // Private tabs never reach the session file.
  const file = path.join(b.userData, 'session.json');
  expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').not.toContain('Second');
});

test('the sleep setting is in Settings', async () => {
  b = await TestBrowser.launch();
  await b.cmd('showSettings');
  const settings = await b.tabPage('potato://settings/');
  const select = settings.getByTestId('sleep-select');
  await expect(select).toHaveValue('120');
  await expect(select.locator('option')).toHaveText(['Never', 'After 15 minutes', 'After 1 hour', 'After 2 hours', 'After 6 hours']);
  await select.selectOption('15');
  await expect.poll(async () => (await b.settings()).tabs.sleepAfter).toBe(15);
});
