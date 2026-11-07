// Manual live check of the ad blocker: opens real sites in the real browser, with the blocker on
// and (with --compare) off, and reports what was blocked. Screenshots land in <shotsDir>.
// Usage: node test/live/adblock-check.mjs <shotsDir> [--compare] [--wait=ms] [--adblock='{"cookieNotices":true}'] url...
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const shots = args.shift();
const compare = args.includes('--compare');
const wait = Number(args.find((a) => a.startsWith('--wait='))?.slice(7) ?? 8000);
const extra = JSON.parse(args.find((a) => a.startsWith('--adblock='))?.slice(10) ?? '{}');
const urls = args.filter((a) => !a.startsWith('--'));
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(enabled) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-adblock-'));
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ firstRunDone: true, startup: 'newtab', searchSuggestions: false, adblock: { ...extra, enabled } }),
  );
  const app = await electron.launch({ args: ['.'], env: { ...process.env, POTATO_USER_DATA: userData, POTATO_TEST: '1' } });
  await app.firstWindow();
  // Other list choices compile in a utility process after startup.
  const started = Date.now();
  while (!(await app.evaluate(() => globalThis.__potato.ctx.adblock.isCurrent())) && Date.now() - started < 30_000) await sleep(100);
  if (Object.keys(extra).length) console.log(`engine ready ${Date.now() - started} ms after the window`);
  const results = [];
  for (const [i, url] of urls.entries()) {
    await app.evaluate(({}, u) => globalThis.__potato.ctx.windows.focused().activeTab.navigate(u), url);
    await sleep(wait);
    const info = await app.evaluate(() => {
      const t = globalThis.__potato.ctx.windows.focused().activeTab;
      const s = t.state();
      return { url: t.url, title: t.title, adblock: s.adblock };
    });
    const page = app.windows().find((p) => p.url() === info.url) ?? app.windows().find((p) => !p.url().startsWith('potato://ui'));
    let dom = {};
    try {
      dom = await page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 20 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
        };
        const iframes = [...document.querySelectorAll('iframe')].filter(visible);
        return {
          adIframes: iframes.filter((f) => /doubleclick|googlesyndication|adservice|amazon-adsystem|taboola|outbrain|criteo|adnxs|rubicon|pubmatic/.test(f.src)).length,
          adSlotsVisible: [...document.querySelectorAll('ins.adsbygoogle, [id^="google_ads_iframe"], [id^="div-gpt-ad"], .ad-slot, .advertisement, [data-ad-slot]')].filter(visible).length,
          ytAdPlacements: window.ytInitialPlayerResponse ? (window.ytInitialPlayerResponse.adPlacements?.length ?? 0) : null,
          sponsored: [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /^(sponsored|promoted|advertisement|ad)$/i.test(e.textContent?.trim() ?? '') && visible(e)).length,
          bodyText: document.body?.innerText.slice(0, 200).replace(/\s+/g, ' '),
        };
      });
    } catch (e) {
      dom = { error: String(e).slice(0, 200) };
    }
    const r = { on: enabled, i, ...info, ...dom };
    results.push(r);
    console.log(JSON.stringify(r));
    if (page) await page.screenshot({ path: path.join(shots, `${enabled ? 'on' : 'off'}-${i}.png`) }).catch(() => {});
  }
  await app.close();
  return results;
}

const on = await run(true);
if (compare) await run(false);
const total = on.reduce((n, r) => n + (r.adblock?.blocked ?? 0), 0);
console.log(`blocked ${total} requests on ${on.length} pages`);
