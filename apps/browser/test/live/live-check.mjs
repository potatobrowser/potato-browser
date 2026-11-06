// Manual live verification: opens real sites in the real browser and reports what the AI Shield
// hid and which posts got flag buttons. Usage: node test/live/live-check.mjs <shotsDir> [url...]
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [shots, ...urls] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-live-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ firstRunDone: true, startup: 'newtab', searchSuggestions: false, flags: { mode: 'label', threshold: 3, showButtons: true } }));
const app = await electron.launch({ args: ['.'], env: { ...process.env, POTATO_USER_DATA: userData, POTATO_TEST: '1' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await app.firstWindow();
await sleep(1500);
for (const [i, url] of urls.entries()) {
  await app.evaluate(({}, u) => globalThis.__potato.ctx.windows.focused().activeTab.navigate(u), url);
  await sleep(9000);
  const info = await app.evaluate(() => {
    const t = globalThis.__potato.ctx.windows.focused().activeTab;
    const s = t.state();
    return { url: t.url, title: t.title, shield: s.shield, flags: s.flags };
  });
  const page = app.windows().find((p) => p.url() === info.url) ?? app.windows().find((p) => !p.url().startsWith('potato://ui'));
  let dom = {};
  try {
    dom = await page.evaluate(() => ({
      hiddenMarks: [...document.querySelectorAll('[data-potato-hidden]')].map((e) => e.getAttribute('data-potato-hidden') + ':' + e.tagName).slice(0, 12),
      flagButtons: document.querySelectorAll('potato-flag').length,
      sampleKeys: [...document.querySelectorAll('potato-flag')].slice(0, 3).map((b) => b.parentElement?.closest('[id],[data-testid],[thingid]')?.getAttribute('id') ?? ''),
    }));
  } catch (e) {
    dom = { error: String(e).slice(0, 200) };
  }
  console.log(JSON.stringify({ i, ...info, ...dom }));
  if (page) await page.screenshot({ path: path.join(shots, `live-${i}.png`) }).catch(() => {});
}
await app.close();
