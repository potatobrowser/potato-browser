import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { apiSummary } from './support/api-server';
import { TestBrowser } from './support/browser';

let b: TestBrowser;
test.afterEach(async () => b?.close());

const VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).version as string;

test('Report a problem sends the page address and the choice, nothing else', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  // Runs share one test Worker: each gets its own address.
  const q = `report+me+${Date.now()}`;
  await b.goto(`https://www.google.com/search?q=${q}#section`, ui);
  await ui.getByTestId('shield-button').click();
  await ui.getByTestId('shield-report').click();
  await expect(ui.getByTestId('report-choices')).toContainText("Sends this page's address");
  await ui.getByTestId('report-showing').click();
  await expect(ui.getByTestId('report-sent')).toBeVisible();
  const { reports } = await apiSummary();
  const r = reports.find((x: { url: string }) => x.url.includes(q));
  expect(r).toMatchObject({ url: `https://www.google.com/search?q=${q}`, feature: 'shield', problem: 'showing', app: 'mac', version: VERSION, status: 'new' });

  await ui.keyboard.press('Escape');
  await ui.getByTestId('adblock-button').click();
  await ui.getByTestId('adblock-report').click();
  await ui.getByTestId('report-broken').click();
  await expect(ui.getByTestId('report-sent')).toBeVisible();
  const again = (await apiSummary()).reports.filter((x: { url: string }) => x.url.includes(q));
  expect(again.map((x: { feature: string; problem: string }) => `${x.feature}:${x.problem}`).sort()).toEqual(['adblock:broken', 'shield:showing']);
});

test('the daily check names the app and its version, and counts as one install', async () => {
  b = await TestBrowser.launch({
    settings: { adblock: { autoUpdate: false } },
    env: { POTATO_ADBLOCK_UPDATES: '1', POTATO_UPDATE_CHECK_DELAY_MS: '300' },
  });
  await expect
    .poll(async () => ((await apiSummary()).installs as { app: string; version: string; n: number }[]).some((r) => r.app === 'mac' && r.version === VERSION), { timeout: 20_000 })
    .toBe(true);
});

/** A stand-in for potatobrowser.com that offers a signed rule update with one extra rule. */
async function rulesServer(opts: { tamper?: boolean } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
  const { RULES } = await import('../../src/content/shield/rules');
  const rules = [...RULES, { id: 'e2e-widget', site: 'E2E test site', hosts: ['site.test'], features: [{ id: 'widget', name: 'Test AI widget', css: ['#e2e-ai-widget'] }] }];
  const json = JSON.stringify(rules);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  const version = 4_000_000_000;
  const payload = JSON.stringify({ format: 1, version, hash, rules });
  const signature = crypto.sign(null, Buffer.from(opts.tamper ? payload.replace('Test AI widget', 'Tampered') : payload), privateKey).toString('base64');
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/api/v1/filters?')) res.end(JSON.stringify({ lists: {}, shield: { version, hash } }));
    else if (req.url === '/api/v1/shield/rules') res.end(JSON.stringify({ payload, signature }));
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, pub, seen, close: () => new Promise((r) => server.close(r)) };
}

const widgetHidden = (page: import('@playwright/test').Page) => page.evaluate(() => getComputedStyle(document.getElementById('e2e-ai-widget')!).display === 'none');

test('AI Shield rules update from the site, signed, and stay after a restart', async () => {
  const srv = await rulesServer();
  const env = { POTATO_API_BASE: srv.url, POTATO_SHIELD_KEYS: srv.pub, POTATO_ADBLOCK_UPDATES: '1', POTATO_UPDATE_CHECK_DELAY_MS: '300' };
  try {
    b = await TestBrowser.launch({ settings: { adblock: { autoUpdate: false } }, env });
    await expect.poll(() => srv.seen.includes('/api/v1/shield/rules'), { timeout: 20_000 }).toBe(true);
    // The scheduled check: it says it is the day's one, so the site counts the install.
    expect(srv.seen.find((u) => u.startsWith('/api/v1/filters?'))).toBe(`/api/v1/filters?lists=&app=mac&v=${VERSION}&daily=1`);
    await expect.poll(() => b.app.evaluate(() => (globalThis as any).__potato.ctx.shield.status().source)).toBe('update');
    const page = await b.goto('https://site.test/ai-widget.html');
    await expect.poll(() => widgetHidden(page)).toBe(true);
    await expect(page.locator('#e2e-content')).toBeVisible();
    const userData = b.userData;
    await b.close();

    // Offline now, the saved update still applies.
    b = await TestBrowser.launch({ userData, env: { POTATO_SHIELD_KEYS: srv.pub } });
    expect(await b.app.evaluate(() => (globalThis as any).__potato.ctx.shield.status())).toMatchObject({ source: 'update', version: 4_000_000_000 });
    const again = await b.goto('https://site.test/ai-widget.html');
    await expect.poll(() => widgetHidden(again)).toBe(true);
  } finally {
    await srv.close();
  }
});

test('rule updates whose signature does not check out are ignored', async () => {
  const srv = await rulesServer({ tamper: true });
  try {
    b = await TestBrowser.launch({
      settings: { adblock: { autoUpdate: false } },
      env: { POTATO_API_BASE: srv.url, POTATO_SHIELD_KEYS: srv.pub, POTATO_ADBLOCK_UPDATES: '1', POTATO_UPDATE_CHECK_DELAY_MS: '300' },
    });
    await expect.poll(() => srv.seen.includes('/api/v1/shield/rules'), { timeout: 20_000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect((await b.app.evaluate(() => (globalThis as any).__potato.ctx.shield.status())).source).toBe('app');
    const page = await b.goto('https://site.test/ai-widget.html');
    await page.waitForTimeout(500);
    expect(await widgetHidden(page)).toBe(false);
    expect(fs.existsSync(path.join(b.userData, 'Shield', 'rules.json'))).toBe(false);
  } finally {
    await srv.close();
  }
});

const crashScript = path.resolve(__dirname, '../fixtures/crash.js');
const crashUtility = (app: TestBrowser['app'], script: string) =>
  app.evaluate(({ utilityProcess }, file) => new Promise<number | null>((resolve) => utilityProcess.fork(file).once('exit', resolve)), script);

test('crash reports reach the site only after the user opts in', async () => {
  b = await TestBrowser.launch();
  expect(await b.app.evaluate(({ crashReporter }) => crashReporter.getUploadToServer())).toBe(false);
  await crashUtility(b.app, crashScript);
  await b.close();

  b = await TestBrowser.launch({ settings: { privacy: { globalPrivacyControl: true, blockAiChatbots: false, crashReports: true } } });
  expect(await b.app.evaluate(({ crashReporter }) => crashReporter.getUploadToServer())).toBe(true);
  const before = ((await apiSummary()).crashes as unknown[]).length;
  await crashUtility(b.app, crashScript);
  await expect.poll(async () => ((await apiSummary()).crashes as unknown[]).length, { timeout: 45_000 }).toBeGreaterThan(before);
  const latest = (await apiSummary()).crashes[0];
  expect(latest).toMatchObject({ app: 'mac', version: VERSION, process: 'utility' });

  // Turning it off stops uploads at once.
  await b.updateSettings({ privacy: { crashReports: false } });
  expect(await b.app.evaluate(({ crashReporter }) => crashReporter.getUploadToServer())).toBe(false);
});
