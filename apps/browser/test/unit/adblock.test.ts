import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FiltersEngine, Request } from '@ghostery/adblocker';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOG,
  compileEngine,
  customFilterErrors,
  DEFAULT_GROUPS,
  dropTrustedScriptlets,
  trustedScriptletNames,
  ENGINE_OPTIONS,
  groupsFor,
  isPlausibleList,
  listsForGroups,
  loadEngine,
  specKey,
} from '../../src/main/adblock/compile';
import { sanitizeSettings } from '../../src/main/settings';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-adblock-'));
let engine: FiltersEngine;
let files: Record<string, string>;

// The real pinned lists (filters/lock.json), compiled the way the app does it.
beforeAll(async () => {
  const { ensureLists } = (await import('../../scripts/filters.mjs' as string)) as { ensureLists(): Promise<Record<string, string>> };
  files = await ensureLists();
  const out = path.join(tmp, 'engine.bin');
  compileEngine({
    lists: listsForGroups(DEFAULT_GROUPS).map((id) => files[id]!),
    resources: files[CATALOG.resources]!,
    custom: 'site.test##.potato-test-ad\n||tracker.potato.test^',
    out,
  });
  engine = loadEngine(out);
}, 180_000);

const match = (url: string, sourceUrl: string, type: string) =>
  engine.match(Request.fromRawDetails({ url, sourceUrl, type: type as Parameters<typeof Request.fromRawDetails>[0]['type'] }));

describe('network filtering with the pinned lists', () => {
  it('blocks ad servers and trackers', () => {
    const blocked: [string, string, string][] = [
      ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1', 'https://news.example/', 'script'],
      ['https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'https://news.example/', 'script'],
      ['https://www.google-analytics.com/analytics.js', 'https://shop.example/', 'script'],
      ['https://www.googletagmanager.com/gtag/js?id=G-TEST', 'https://shop.example/', 'script'],
      ['https://connect.facebook.net/en_US/fbevents.js', 'https://shop.example/', 'script'],
      ['https://c.amazon-adsystem.com/aax2/apstag.js', 'https://news.example/', 'script'],
      ['https://www.youtube.com/api/stats/ads?ver=2', 'https://www.youtube.com/watch?v=x', 'xhr'],
      ['https://tracker.potato.test/pixel.gif', 'https://news.example/', 'image'],
    ];
    for (const [url, src, type] of blocked) {
      const r = match(url, src, type);
      expect(r.match || !!r.redirect, url).toBe(true);
    }
  });

  it('swaps blocked scripts that pages depend on for harmless stand-ins', () => {
    const r = match('https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'https://news.example/', 'script');
    expect(r.redirect?.dataUrl).toMatch(/^data:/);
  });

  it('leaves ordinary first- and third-party resources alone', () => {
    const allowed: [string, string, string][] = [
      ['https://news.example/assets/app.js', 'https://news.example/', 'script'],
      ['https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', 'https://news.example/', 'script'],
      ['https://fonts.googleapis.com/css2?family=Archivo', 'https://news.example/', 'stylesheet'],
      ['https://www.youtube.com/s/player/abc/player_ias.vflset/en_US/base.js', 'https://www.youtube.com/watch?v=x', 'script'],
      ['https://i.ytimg.com/vi/abc/hqdefault.jpg', 'https://www.youtube.com/', 'image'],
      ['https://www.google.com/recaptcha/api.js', 'https://shop.example/', 'script'],
    ];
    for (const [url, src, type] of allowed) {
      const r = match(url, src, type);
      expect(r.match || !!r.redirect, url).toBe(false);
    }
  });
});

describe('cosmetic filtering', () => {
  const cosmetics = (url: string, extra: Partial<Parameters<FiltersEngine['getCosmeticsFilters']>[0]> = {}) => {
    const u = new URL(url);
    return engine.getCosmeticsFilters({
      url,
      hostname: u.hostname,
      domain: u.hostname.replace(/^www\./, ''),
      getBaseRules: true,
      getInjectionRules: true,
      getExtendedRules: true,
      getRulesFromHostname: true,
      getRulesFromDOM: false,
      ...extra,
    });
  };

  it('runs scriptlets on YouTube to strip video ads', () => {
    const r = cosmetics('https://www.youtube.com/watch?v=x');
    expect(r.active).toBe(true);
    expect(r.scripts.length).toBeGreaterThan(0);
    expect(r.scripts.join('\n')).toMatch(/adPlacements|playerAds|adSlots/);
  });

  it('applies site-specific rules, including the user own filters', () => {
    expect(cosmetics('https://site.test/').styles).toContain('.potato-test-ad');
    expect(cosmetics('https://other.test/').styles).not.toContain('.potato-test-ad');
  });

  it('hides generic ad containers once they appear in the page', () => {
    const r = cosmetics('https://news.example/', {
      classes: ['ad-slot', 'article-body'],
      ids: [],
      hrefs: [],
      getBaseRules: false,
      getInjectionRules: false,
      getRulesFromHostname: false,
      getRulesFromDOM: true,
    });
    expect(r.styles).toContain('.ad-slot');
    expect(r.styles).not.toContain('article-body');
  });
});

describe('engine build', () => {
  it('evaluates !#if blocks for a Chromium browser', () => {
    const text = ['!#if env_firefox', '||firefox-only.test^', '!#endif', '!#if env_chromium', '||chromium-only.test^', '!#endif'].join('\n');
    const file = path.join(tmp, 'pre.bin');
    fs.writeFileSync(file, FiltersEngine.parse(text, ENGINE_OPTIONS).serialize());
    const e = loadEngine(file);
    const m = (host: string) => e.match(Request.fromRawDetails({ url: `https://${host}/x.js`, sourceUrl: 'https://a.test/', type: 'script' })).match;
    expect(m('chromium-only.test')).toBe(true);
    expect(m('firefox-only.test')).toBe(false);
  });

  it('lets only uBlock lists and own filters use trusted scriptlets', () => {
    const trusted = trustedScriptletNames(fs.readFileSync(files[CATALOG.resources]!, 'utf8'));
    expect(trusted.has('trusted-replace-node-text')).toBe(true);
    expect(trusted.has('set-constant')).toBe(false);
    const rules = 'a.test##+js(trusted-replace-node-text, script, x, alert(1))\na.test##+js(set-constant, adsOn, false)\na.test##.ad';
    expect(dropTrustedScriptlets(rules, trusted)).toBe('a.test##+js(set-constant, adsOn, false)\na.test##.ad');

    // Through the real compile: an EasyList-named file loses the trusted rule, a uBlock one keeps it.
    const scripts = (listName: string, custom = '') => {
      const dir = fs.mkdtempSync(path.join(tmp, 'trust-'));
      fs.writeFileSync(path.join(dir, listName), 'b.test##+js(trusted-set-constant, a.b, json:1)\n! pad\n');
      const out = path.join(dir, 'e.bin');
      compileEngine({ lists: [path.join(dir, listName)], resources: files[CATALOG.resources]!, custom, out });
      return loadEngine(out).getCosmeticsFilters({ url: 'https://b.test/', hostname: 'b.test', domain: 'b.test', getRulesFromDOM: false }).scripts.length;
    };
    expect(scripts('easylist-x.txt')).toBe(0);
    expect(scripts('ublock-filters-x.txt')).toBe(1);
    expect(scripts('easylist-x.txt', 'b.test##+js(trusted-set-constant, c.d, json:2)')).toBe(1);
  });

  it('keys engines by list revisions and own filters', () => {
    const base = { lists: [['easylist', 'a'.repeat(64)]] as [string, string][], resources: 'b'.repeat(64), custom: '' };
    expect(specKey(base)).toBe(specKey({ ...base, custom: '  \n' }));
    expect(specKey(base)).not.toBe(specKey({ ...base, custom: '##.x' }));
    expect(specKey(base)).not.toBe(specKey({ ...base, lists: [['easylist', 'c'.repeat(64)]] }));
  });

  it('maps settings to list groups', () => {
    expect(groupsFor({ trackers: true, cookieNotices: false, annoyances: false })).toEqual(['ads', 'trackers']);
    expect(groupsFor({ trackers: false, cookieNotices: true, annoyances: true })).toEqual(['ads', 'cookies', 'annoyances']);
    expect(listsForGroups(['ads'])).toContain('ublock-unbreak');
    expect(listsForGroups(['trackers'])).toEqual(['easyprivacy', 'ublock-privacy']);
  });

  it('rejects damaged list downloads', () => {
    const list = fs.readFileSync(files.easyprivacy!, 'utf8');
    expect(isPlausibleList('easyprivacy', list)).toBe(true);
    expect(isPlausibleList('easyprivacy', '<!doctype html><title>Error</title>' + ' '.repeat(300))).toBe(false);
    expect(isPlausibleList('easyprivacy', '||x^\n')).toBe(false);
    expect(isPlausibleList(CATALOG.resources, fs.readFileSync(files[CATALOG.resources]!, 'utf8'))).toBe(true);
    expect(isPlausibleList(CATALOG.resources, '{"oops": true}' + ' '.repeat(300))).toBe(false);
  });

  it('reports own filters the engine cannot read', () => {
    expect(customFilterErrors('example.com##.ad\n||ads.example^\nexample.com#%#window.x=1\n||x.example^$nonsense')).toEqual([
      'example.com#%#window.x=1',
      '||x.example^$nonsense',
    ]);
    expect(customFilterErrors('  ')).toEqual([]);
  });
});

describe('ad blocker settings', () => {
  it('defaults to blocking ads and trackers, with updates on', () => {
    const s = sanitizeSettings({});
    expect(s.adblock).toEqual({ enabled: true, disabledSites: [], trackers: true, cookieNotices: false, annoyances: false, customFilters: '', autoUpdate: true });
  });

  it('keeps valid values and repairs malformed ones', () => {
    const s = sanitizeSettings({ adblock: { enabled: false, disabledSites: ['Example.com', 'example.com', 3], trackers: 'yes', cookieNotices: true, customFilters: 42 } });
    expect(s.adblock.enabled).toBe(false);
    expect(s.adblock.disabledSites).toEqual(['example.com']);
    expect(s.adblock.trackers).toBe(true);
    expect(s.adblock.cookieNotices).toBe(true);
    expect(s.adblock.customFilters).toBe('');
  });
});
