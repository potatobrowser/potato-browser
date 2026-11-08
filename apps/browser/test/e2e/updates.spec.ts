import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { TestBrowser } from './support/browser';

let b: TestBrowser;
test.afterEach(async () => b?.close());

const setUpdate = (patch: Record<string, unknown>) => b.app.evaluate(({}, p) => (globalThis as any).__potato.ctx.updates.set(p), patch);

test('a downloaded update restarts with one click and brings the tabs back', async () => {
  // startup "newtab" (the test default): only an update restart restores.
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.goto('https://site.test/', ui);
  await b.cmd('newTab');
  await b.goto('https://other.test/', ui);
  await expect(ui.getByTestId('update-button')).toHaveCount(0);

  await setUpdate({ phase: 'ready', version: '9.9.9', percent: 100 });
  const button = ui.getByTestId('update-button');
  await expect(button).toHaveText('Restart to update');
  await expect(ui.getByTestId('update-dot')).toHaveCount(0);

  await b.app.evaluate(({ app }) => {
    (globalThis as any).__potato.ctx.updates.restart = () => app.quit();
  });
  const userData = b.userData;
  const closed = b.app.waitForEvent('close');
  await button.click();
  await closed;
  expect(JSON.parse(fs.readFileSync(path.join(userData, 'session.json'), 'utf8')).restore).toBe(true);

  b = await TestBrowser.launch({ userData });
  await expect.poll(() => b.tabUrls()).toEqual(['https://site.test/', 'https://other.test/']);
  // Only once: the next launch follows the startup setting again.
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(userData, 'session.json'), 'utf8')).restore).toBeUndefined();
});

test('About shows the update as it downloads, and copies that cannot update point to the download page', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  await b.cmd('showAbout');
  const about = await b.tabPage('potato://settings/');
  const status = about.getByTestId('update-status');
  const check = about.getByTestId('update-check');
  await expect(check).toHaveText('Check for updates');

  await setUpdate({ phase: 'downloading', version: '9.9.9', percent: 42, manual: null });
  await expect(status).toHaveText('Digging up version 9.9.9... 42%');
  await expect(check).toBeDisabled();
  await expect(ui.getByTestId('update-button')).toHaveCount(0);

  await setUpdate({ phase: 'ready', percent: 100 });
  await expect(status).toContainText('Version 9.9.9 is ready.');
  await expect(check).toHaveText('Restart to update');
  await expect(ui.getByTestId('update-button')).toBeVisible();

  await setUpdate({ phase: 'available', manual: 'location' });
  await expect(status).toContainText('Version 9.9.9 is fresh out of the ground. Move Potato Browser to the Applications folder');
  await expect(about.getByTestId('update-download')).toBeVisible();
  await expect(check).toBeEnabled();
  await expect(ui.getByTestId('update-dot')).toBeVisible();
  await expect(ui.getByTestId('update-button')).toHaveCount(0);

  await setUpdate({ phase: 'error', version: null, error: 'net::ERR_INTERNET_DISCONNECTED' });
  await expect(status).toHaveText('Could not check for updates. Try again in a bit.');
  await expect(ui.getByTestId('update-dot')).toHaveCount(0);
});
