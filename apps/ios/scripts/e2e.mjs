// End-to-end tests of the iOS app on the simulator, against the Mac app's fixture sites (served
// under their real hostnames through a local proxy with a test CA) and the real flags Worker
// under `wrangler dev`. Mirrors apps/browser/test/e2e.
//   node scripts/e2e.mjs [--build] [--only shield,adblock,flags,shell] [--shots dir]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { flagAsOthers, flagCount, startApiServer } from '../test/support/api-server.mjs';
import { ensureCerts, startFixtureProxy } from '../test/support/fixture-proxy.mjs';
import { boot, DEVICE, runSteps, simctl } from './simrun.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;

if (args.includes('--build')) {
  const b = spawnSync('xcodebuild', ['-project', 'PotatoBrowser.xcodeproj', '-scheme', 'PotatoBrowser', '-destination', `platform=iOS Simulator,name=${DEVICE}`, '-derivedDataPath', 'build/DerivedData', '-quiet', 'build'], { cwd: root, stdio: 'inherit' });
  if (b.status !== 0) process.exit(1);
}

// ---- helpers -----------------------------------------------------------------------------------

const vis = (sels) => `return Object.fromEntries(${JSON.stringify(sels)}.map((s) => { const el = document.querySelector(s); return [s, el ? el.checkVisibility() : 'missing']; }))`;
const attr = (sel, name) => `const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.getAttribute(${JSON.stringify(name)}) : 'missing'`;
const count = (sel) => `return document.querySelectorAll(${JSON.stringify(sel)}).length`;
const open = (url, name, wait = 2) => ({ action: 'open', url, name, wait });
const evalStep = (name, js, world) => ({ action: 'eval', name, js, ...(world ? { world } : {}) });
const settings = (s) => ({ action: 'settings', settings: s });
const shot = (name) => ({ action: 'shot', name });

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  if (ok) passes++;
  else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}

function byName(results) {
  const m = new Map();
  for (const r of results) if (r.name) m.set(r.name, r);
  return m;
}

function expectVisibility(r, name, hidden, visible) {
  const v = r.get(name)?.value ?? {};
  for (const s of hidden) check(`${name}: ${s} hidden`, v[s] === false, v[s]);
  for (const s of visible) check(`${name}: ${s} visible`, v[s] === true, v[s]);
}

// ---- scenarios ---------------------------------------------------------------------------------

const GOOGLE = 'https://www.google.com/search?q=how+do+magnets+work';
const GOOGLE_AI = ['#aio-css', '#aio-wrapper', '#aio-text', '#tab-ai', '#paa-ai', '#dive'];
const GOOGLE_HUMAN = ['#r0', '#r3', '#r-ai-title', '#tab-all', '#tab-images', '#paa-human'];

const scenarios = {
  async shield() {
    const sites = [
      ['gmail', 'https://mail.google.com/mail/u/0/', ['#gemini-wrap', '#gemini-btn', '#hmw', '#hmw-de', '#summary-card'], ['#row-gemini', '#row-lunch', '#send', '#support']],
      ['youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', ['#ask-wrap', '#video-summary'], ['#like', '#desc-text']],
      ['bing', 'https://www.bing.com/search?q=magnets', ['#copilot-answer', '#b-scopeListItem-copilotsearch', '#codex'], ['#result1', '#b-scopeListItem-web']],
      ['ddg', 'https://duckduckgo.com/?q=magnets', ['#assist', '#duckai', '#duck-link'], ['#result1']],
      ['amazon', 'https://www.amazon.com/dp/B000TEST', ['#nav-rufus-disco', '#nile-inline_feature_div', '#highlights', '#cr-summary_feature_div'], ['#productTitle', '#reviews', '#nav-cart']],
      ['x', 'https://x.com/home', ['#nav-grok', '#grok-drawer', '#grok-actions-1', '#grok-actions-2'], ['#nav-home', '#tw1 [data-testid=tweetText]', '#tw2']],
      ['facebook', 'https://www.facebook.com/', ['#nav-metaai'], ['#nav-friends', '#fb1', '#fb2']],
      ['instagram', 'https://www.instagram.com/', ['#nav-metaai'], ['#nav-home', '#ig1']],
      ['reddit', 'https://www.reddit.com/r/test/', ['#answers-nav-button', '#comment-summary'], ['#home', '#a1', '#c1']],
      ['linkedin', 'https://www.linkedin.com/feed/', ['#rewrite-ai'], ['#post-btn', '#li1']],
    ];
    const steps = [
      { action: 'ready', wait: 180 },
      settings({ 'flags.mode': 'ignore', 'flags.showButtons': false }),
      open(GOOGLE, 'google'),
      evalStep('google-vis', vis([...GOOGLE_AI, ...GOOGLE_HUMAN])),
      evalStep('google-folsrch', attr('body', 'data-folsrch')),
      { action: 'state', name: 'google-state' },
      shot('shield-google'),
      open('https://www.google.com/search?q=cats&udm=50&aep=1', 'aimode'),
      settings({ 'shield.disabledSites': ['google.com'] }),
      open(GOOGLE, 'google-off'),
      evalStep('google-off-vis', vis(GOOGLE_AI)),
      evalStep('google-off-folsrch', attr('body', 'data-folsrch')),
      open('https://www.google.com/search?q=dogs&udm=50', 'aimode-off'),
      settings({ 'shield.disabledSites': [] }),
      ...sites.flatMap(([name, url, hidden, visible]) => [open(url, name), evalStep(`${name}-vis`, vis([...hidden, ...visible]))]),
      evalStep('facebook-placeholder', `return document.querySelector('#fb-search')?.placeholder`),
      settings({ 'shield.enabled': false }),
      open(GOOGLE, 'google-global-off'),
      evalStep('google-global-off-vis', vis(['#aio-css', '#tab-ai'])),
    ];
    // The Facebook placeholder check needs the Facebook page: run it right after Facebook.
    const fbIndex = steps.findIndex((s) => s.name === 'facebook-vis');
    steps.splice(steps.indexOf(steps.find((s) => s.name === 'facebook-placeholder')), 1);
    steps.splice(fbIndex + 1, 0, evalStep('facebook-placeholder', `return document.querySelector('#fb-search')?.placeholder`));
    const r = byName((await run(steps)).results);
    expectVisibility(r, 'google-vis', GOOGLE_AI, GOOGLE_HUMAN);
    check('google: AI Overview request blocked', r.get('google-folsrch')?.value === 'blocked', r.get('google-folsrch')?.value);
    const st = r.get('google-state');
    check('google: shield counts 4+', st?.shield?.count >= 4, st?.shield);
    check('google: panel lists AI Overviews and AI Mode', st?.shield?.features?.includes('AI Overviews') && st?.shield?.features?.includes('AI Mode'), st?.shield?.features);
    check('AI Mode goes back to normal results', r.get('aimode')?.url === 'https://www.google.com/search?q=cats', r.get('aimode')?.url);
    expectVisibility(r, 'google-off-vis', [], GOOGLE_AI);
    check('google off: AI request flows again', r.get('google-off-folsrch')?.value === 'AI content', r.get('google-off-folsrch')?.value);
    check('AI Mode stays when the shield is off for Google', r.get('aimode-off')?.url === 'https://www.google.com/search?q=dogs&udm=50', r.get('aimode-off')?.url);
    for (const [name, , hidden, visible] of sites) expectVisibility(r, `${name}-vis`, hidden, visible);
    check('facebook: search placeholder rewritten', r.get('facebook-placeholder')?.value === 'Search Facebook', r.get('facebook-placeholder')?.value);
    expectVisibility(r, 'google-global-off-vis', [], ['#aio-css', '#tab-ai']);
  },

  async adblock() {
    const NEWS = 'https://adblock.test/';
    const ALL = 'adsense,apstag,fbevents,ga,gpt';
    const AD_HOSTS = ['securepubads.g.doubleclick.net', 'pagead2.googlesyndication.com', 'www.google-analytics.com', 'connect.facebook.net', 'c.amazon-adsystem.com', 'googleads.g.doubleclick.net'];
    const page = (name) => evalStep(name, `return { ads: document.body.dataset.ads, app: document.body.dataset.app, gpt: document.body.dataset.gpt, scriptlet: document.documentElement.dataset.scriptlet }`);
    const steps = [
      { action: 'ready', wait: 180 },
      open(NEWS, 'news', 3),
      page('news-data'),
      evalStep('news-vis', vis(['#headline', '#story', '#generic-ad', '#late-ad', '#ad-frame'])),
      { action: 'state', name: 'news-state' },
      shot('adblock-news'),
      open('https://www.youtube.com/adtest', 'yt-adtest'),
      evalStep('yt-adtest-data', `return { ...document.documentElement.dataset, parse: Function.prototype.toString.call(JSON.parse).includes('native code') }`),
      settings({ 'adblock.disabledSites': ['adblock.test'] }),
      open(NEWS, 'news-allowed', 3),
      page('news-allowed-data'),
      evalStep('news-allowed-vis', vis(['#generic-ad'])),
      settings({ 'adblock.disabledSites': [], 'adblock.customFilters': 'adblock.test##.potato-custom-ad\nadblock.test##+js(set-constant, potatoAdTest, true)' }),
      { action: 'wait', wait: 6 },
      open(NEWS, 'news-custom', 3),
      evalStep('news-custom-vis', vis(['#custom-ad', '#headline'])),
      page('news-custom-data'),
      settings({ 'adblock.enabled': false }),
      open(NEWS, 'news-off', 3),
      page('news-off-data'),
      settings({ 'adblock.enabled': true }),
      { action: 'newTab', text: 'private', url: NEWS, wait: 3, name: 'private-news' },
      page('private-data'),
      { action: 'state', name: 'private-state' },
    ];
    const results = (await run(steps)).results;
    const r = byName(results);
    const d = r.get('news-data')?.value ?? {};
    check('news: no ad or tracker script ran', d.ads === '', d);
    check("news: the page's own script ran", d.app === 'true', d);
    expectVisibility(r, 'news-vis', ['#generic-ad', '#late-ad'], ['#headline', '#story']);
    const st = r.get('news-state');
    check('news: blocked count 4+', st?.adblock?.blocked >= 4, st?.adblock);
    check('news: hosts listed', (st?.adblock?.hosts ?? []).some((h) => h.includes('doubleclick') || h.includes('googlesyndication')), st?.adblock?.hosts);
    // Requests while the first visit loaded (later visits allow ads on purpose).
    const openIdx = results.findIndex((x) => x.name === 'news');
    const firstVisit = proxy.hostsBetween(results[openIdx - 1].at, r.get('news-state').at);
    check('news: the page itself was requested', firstVisit.includes('adblock.test'), firstVisit);
    for (const h of AD_HOSTS) check(`news: ${h} never requested`, !firstVisit.includes(h), firstVisit);
    const yt = r.get('yt-adtest-data')?.value ?? {};
    check('youtube: scriptlets ran before page scripts', yt.adPlacements === 'false' && yt.title === 'How potatoes grow', yt);
    check('youtube: builtins intact', yt.builtins === 'true' && yt.parse === true, yt);
    check('site allowed: everything loads', r.get('news-allowed-data')?.value?.ads === ALL, r.get('news-allowed-data')?.value);
    expectVisibility(r, 'news-allowed-vis', [], ['#generic-ad']);
    expectVisibility(r, 'news-custom-vis', ['#custom-ad'], ['#headline']);
    check('own filters: scriptlet ran', r.get('news-custom-data')?.value?.scriptlet === 'true', r.get('news-custom-data')?.value);
    check('blocker off: everything loads', r.get('news-off-data')?.value?.ads === ALL, r.get('news-off-data')?.value);
    check('private tab opened', r.get('private-state')?.isPrivate === true, r.get('private-state'));
    check('private tab: ads blocked too', r.get('private-data')?.value?.ads === '', r.get('private-data')?.value);
  },

  async flags() {
    const cases = [
      { url: 'https://x.com/home', key: 'x:2058156237737295001', flagged: '#tw2', clean: '#tw1' },
      { url: 'https://www.instagram.com/', key: 'instagram:DeBBBBBBBBB', flagged: '#ig2', clean: '#ig1' },
      { url: 'https://www.facebook.com/', key: 'facebook:1206903601483960', flagged: '#fb1', clean: '#fb2' },
      { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', key: 'youtube:BBBBBBBBBBB', flagged: '#next2', clean: '#next1' },
      { url: 'https://bsky.app/', key: 'bluesky:did:plc:z72i7hdynmk6r22z27h6tvur/3l6oveex3ii2l', flagged: '#bs1', clean: null },
      { url: 'https://www.threads.com/', key: 'threads:DZceA72Drjf', flagged: '#th1', clean: null },
      { url: 'https://www.tiktok.com/', key: 'tiktok:7658705304611261716', flagged: '#tt1', clean: null },
      { url: 'https://www.linkedin.com/feed/', key: 'linkedin:ugcPost:7497764716677758977', flagged: '#li1', clean: null },
    ];
    await flagAsOthers(api.url, 'reddit:t3_1xabc22', 3);
    for (const c of cases) await flagAsOthers(api.url, c.key, 1);
    const reply = 'reddit:t1_p9reply1';
    const replyBefore = await flagCount(api.url, reply);
    const bridge = (keys, flag) => `return await window.webkit.messageHandlers.potato.postMessage({ type: 'flagsSet', keys: ${JSON.stringify(keys)}, flag: ${flag} })`;
    const labeled = (sel) => `return !!document.querySelector('${sel}[data-potato-flag="label"], ${sel} [data-potato-flag="label"]')`;
    const steps = [
      { action: 'ready', wait: 180 },
      settings({ 'flags.mode': 'label', 'flags.threshold': 3, 'flags.showButtons': true }),
      open('https://www.reddit.com/r/test/', 'reddit', 3),
      evalStep('reddit-buttons', `return Object.fromEntries(['#a1', '#a2', '#c1 > details > summary', '#c2', '#ad1'].map((s) => [s, document.querySelectorAll(s + ' potato-flag').length]))`),
      evalStep('reddit-label', `return { a2: document.querySelector('#a2 shreddit-post')?.getAttribute('data-potato-flag'), a1: document.querySelector('#a1 shreddit-post')?.getAttribute('data-potato-flag') }`),
      { action: 'state', name: 'reddit-state' },
      shot('flags-reddit-label'),
      evalStep('flag-reply', bridge([reply], true), 'potato'),
      { action: 'wait', wait: 0.5, name: 'after-flag' },
      evalStep('unflag-reply', bridge([reply], false), 'potato'),
      settings({ 'flags.mode': 'hide' }),
      { action: 'reload', wait: 3 },
      evalStep('reddit-hide', `const n = document.querySelector('#a2 potato-flag-hidden'); return { postVisible: document.querySelector('#a2 shreddit-post')?.checkVisibility(), notice: n?.shadowRoot?.textContent ?? n?.textContent ?? null, a1Visible: document.querySelector('#a1 shreddit-post')?.checkVisibility() }`),
      shot('flags-reddit-hide'),
      settings({ 'flags.mode': 'label', 'flags.threshold': 1 }),
      ...cases.flatMap((c, i) => [
        open(c.url, `case-${i}`, 2.5),
        evalStep(`case-${i}-check`, `return { button: !!document.querySelector('${c.flagged} potato-flag'), labeled: (() => { ${labeled(c.flagged).replace('return ', 'return ')} })(), clean: ${c.clean ? `document.querySelectorAll('${c.clean}[data-potato-flag], ${c.clean} [data-potato-flag]').length` : 0} }`),
      ]),
      settings({ 'flags.disabledPlatforms': ['reddit'] }),
      open('https://www.reddit.com/r/test/', 'reddit-off', 2),
      evalStep('reddit-off-buttons', count('potato-flag')),
      settings({ 'flags.disabledPlatforms': [] }),
      { action: 'newTab', text: 'private', url: 'https://www.reddit.com/r/test/', wait: 3 },
      evalStep('private-flag', bridge(['reddit:t1_p9comment1'], true), 'potato'),
      { action: 'state', name: 'private-state' },
      evalStep('private-unflag', bridge(['reddit:t1_p9comment1'], false), 'potato'),
    ];
    const res = await run(steps);
    const r = byName(res.results);
    const b = r.get('reddit-buttons')?.value ?? {};
    for (const s of ['#a1', '#a2', '#c1 > details > summary', '#c2']) check(`reddit: flag button in ${s}`, b[s] === 1, b);
    check('reddit: no button on the ad', b['#ad1'] === 0, b);
    check('reddit: post over the threshold is labeled', r.get('reddit-label')?.value?.a2 === 'label', r.get('reddit-label')?.value);
    check('reddit: other posts unlabeled', r.get('reddit-label')?.value?.a1 == null, r.get('reddit-label')?.value);
    check('flag count reported to the toolbar', r.get('reddit-state')?.flags?.labeled >= 1, r.get('reddit-state')?.flags);
    const flagged = r.get('flag-reply')?.value?.[reply];
    check('flagging through the bridge reaches the server', flagged?.mine === true && flagged?.n === replyBefore + 1, flagged);
    check('undo reaches the server', (await flagCount(api.url, reply)) === replyBefore, await flagCount(api.url, reply));
    const h = r.get('reddit-hide')?.value ?? {};
    check('hide mode: flagged post buried', h.postVisible === false, h);
    check('hide mode: notice shown', /flagged as AI-generated/.test(h.notice ?? ''), h.notice);
    check('hide mode: other posts stay', h.a1Visible === true, h);
    cases.forEach((c, i) => {
      const v = r.get(`case-${i}-check`)?.value ?? {};
      check(`${c.key.split(':')[0]}: button and label on the right post`, v.button && v.labeled && v.clean === 0, v);
    });
    check('platform switched off: no buttons', r.get('reddit-off-buttons')?.value === 0, r.get('reddit-off-buttons')?.value);
    check('private tab: flag not stored', r.get('private-state')?.myFlags === 0 && r.get('private-flag')?.value?.['reddit:t1_p9comment1']?.mine === true, { stored: r.get('private-state')?.myFlags, reply: r.get('private-flag')?.value });
  },

  async shell() {
    const steps = [
      { action: 'ready', wait: 180 },
      settings({ 'privacy.blockAiChatbots': true }),
      open('https://chatgpt.com/', 'chatgpt', 1),
      { action: 'state', name: 'chatgpt-state' },
      shot('shell-chatbot'),
      { action: 'allowChatbot', name: 'chatgpt-allowed' },
      evalStep('chatgpt-page', vis(['#chatbot'])),
      open('https://site.test/', 'site'),
      evalStep('download-click', `document.querySelector('#download').click(); return true`),
      { action: 'wait', wait: 3 },
      { action: 'state', name: 'download-state' },
      { action: 'submit', text: 'potato salad', name: 'search' },
      { action: 'submit', text: 'site.test/title?t=Typed', name: 'typed' },
      { action: 'back', wait: 2 },
      { action: 'state', name: 'after-back' },
      { action: 'engineCheck', name: 'engine' },
      open('https://site.test/engine.html', 'engine-page'),
      evalStep('engine-globals', `return ['LanguageModel','Summarizer','Writer','Rewriter','Proofreader','Translator','LanguageDetector','webkitSpeechRecognition','SpeechRecognition'].filter((n) => n in window)`),
    ];
    const r = byName((await run(steps)).results);
    check('chatbot: block page shown', /chatbot/.test(r.get('chatgpt-state')?.interstitial ?? ''), r.get('chatgpt-state')?.interstitial);
    check('chatbot: open once', r.get('chatgpt-allowed')?.url === 'https://chatgpt.com/' && r.get('chatgpt-page')?.value?.['#chatbot'] === true, r.get('chatgpt-allowed'));
    const dl = r.get('download-state')?.downloads ?? [];
    check('download saved', dl.some((d) => /^report( \d+)?\.bin:completed:262144$/.test(d)), dl);
    check('search goes to the default engine (DuckDuckGo, no AI)', String(r.get('search')?.url).startsWith('https://noai.duckduckgo.com/?q=potato'), r.get('search')?.url);
    check('typed host opens as https', r.get('typed')?.url === 'https://site.test/title?t=Typed', r.get('typed')?.url);
    check('back goes to the search', String(r.get('after-back')?.url).includes('duckduckgo'), r.get('after-back')?.url);
    const e = r.get('engine');
    check('engine check: no AI APIs in pages, workers, frames', e && e.window?.length === 0 && e.worker?.length === 0 && e.frame?.length === 0, e);
    check('engine: no AI globals on a page', JSON.stringify(r.get('engine-globals')?.value) === '[]', r.get('engine-globals')?.value);
  },

  async session() {
    await run([{ action: 'ready', wait: 180 }, open('https://site.test/title?t=One', 'one'), { action: 'newTab', url: 'https://site.test/title?t=Two', wait: 2 }, { action: 'wait', wait: 2 }]);
    const r = byName((await run([{ action: 'wait', wait: 2 }, { action: 'state', name: 'restored' }], { fresh: false })).results);
    const s = r.get('restored');
    check('session: two tabs restored', s?.tabs === 2, s);
    check('session: last tab selected', s?.url === 'https://site.test/title?t=Two', s?.url);
  },
};

// ---- run ---------------------------------------------------------------------------------------

let proxy;
let api;
let env;

async function run(steps, { fresh = true } = {}) {
  return runSteps(steps, { out: shots ?? undefined, fresh, env, install: false });
}

const certs = ensureCerts(path.join(root, 'build/test-ca'));
boot();
simctl('keychain', DEVICE, 'add-root-cert', certs.ca);
simctl('install', DEVICE, path.join(root, 'build/DerivedData/Build/Products/Debug-iphonesimulator/PotatoBrowser.app'));
proxy = await startFixtureProxy({ certDir: path.join(root, 'build/test-ca') });
api = await startApiServer();
env = { POTATO_TEST_PROXY: `127.0.0.1:${proxy.port}`, POTATO_API_BASE: api.url };
console.log(`fixtures on proxy :${proxy.port}, Worker at ${api.url}`);

try {
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue;
    console.log(`${name}`);
    const started = Date.now();
    try {
      await fn();
    } catch (e) {
      check(`${name} ran`, false, String(e.stack ?? e));
    }
    console.log(`  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
} finally {
  await proxy.close();
  await api.stop();
}
console.log(`\n${passes} passed, ${failures} failed`);
if (shots) fs.mkdirSync(shots, { recursive: true });
process.exit(failures ? 1 : 0);
