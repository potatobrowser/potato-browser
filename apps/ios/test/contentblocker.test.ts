import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assemble,
  badfilterKey,
  convertFilter,
  convertLists,
  emptyConverted,
  evaluateCondition,
  isWebKitRegex,
  MAX_RULES,
  parseNetworkFilter,
  patternToRegexes,
  preprocess,
  webkitDomains,
  type WebKitRule,
} from '../web/contentblocker';
import { buildRuleLists } from '../web/rulelists';

const SEP = '[^a-zA-Z0-9_.%-]';

function convert(line: string) {
  const f = parseNetworkFilter(line);
  if (!f) return null;
  const out = emptyConverted();
  return convertFilter(f, out) ? out : null;
}

/** WebKit matches url-filters case-insensitively by default; so does this. */
function matches(rule: WebKitRule, url: string): boolean {
  return new RegExp(rule.trigger['url-filter'], rule.trigger['url-filter-is-case-sensitive'] ? '' : 'i').test(url);
}

describe('preprocessor', () => {
  const env = { env_safari: true, env_mobile: true };
  it('evaluates conditions', () => {
    expect(evaluateCondition('env_safari', env)).toBe(true);
    expect(evaluateCondition('!env_safari', env)).toBe(false);
    expect(evaluateCondition('env_chromium || env_safari', env)).toBe(true);
    expect(evaluateCondition('(env_chromium || env_firefox) && env_mobile', env)).toBe(false);
    expect(evaluateCondition('!(env_chromium || env_firefox)', env)).toBe(true);
  });
  it('keeps the lines of the active branches', () => {
    const text = ['a', '!#if env_chromium', 'b', '!#else', 'c', '!#if !env_mobile', 'd', '!#endif', '!#endif', 'e'].join('\n');
    expect(preprocess(text, env)).toEqual(['a', 'c', 'e']);
  });
});

describe('parseNetworkFilter', () => {
  it('reads types, party, domains and exceptions', () => {
    const f = parseNetworkFilter('@@||example.com/ads.js$script,~third-party,domain=a.com|~b.a.com')!;
    expect(f.exception).toBe(true);
    expect(f.pattern).toBe('||example.com/ads.js');
    expect([...f.types!]).toEqual(['script']);
    expect(f.party).toBe('first');
    expect(f.domains).toEqual(['a.com']);
    expect(f.notDomains).toEqual(['b.a.com']);
  });
  it('turns negated types into all other types', () => {
    const f = parseNetworkFilter('/ads/$~image')!;
    expect(f.types!.has('image')).toBe(false);
    expect(f.types!.has('script')).toBe(true);
    expect(f.types!.has('document')).toBe(false);
  });
  it('skips cosmetic filters, comments and options WebKit cannot express', () => {
    for (const line of ['example.com##.ad', '##.banner', 'example.com#@#.ad', 'example.com##+js(nobab)', '! comment', '[Adblock Plus 2.0]', '||x.com^$removeparam=utm', '||x.com^$redirect-rule=noopjs', '||x.com^$unknownoption']) {
      expect(parseNetworkFilter(line), line).toBeNull();
    }
  });
  it('finds the options after a regex that contains $', () => {
    const f = parseNetworkFilter('/^https:\\/\\/x\\.com\\/a$/$script')!;
    expect(f.pattern).toBe('/^https:\\/\\/x\\.com\\/a$/');
    expect([...f.types!]).toEqual(['script']);
  });
  it('matches $badfilter lines to their targets', () => {
    expect(badfilterKey('||example.com^$script,badfilter')).toBe('||example.com^$script');
    expect(badfilterKey('||example.com^$badfilter')).toBe('||example.com^');
    expect(badfilterKey('||x^$badfilter,script')).toBe('||x^$script');
  });
});

describe('isWebKitRegex', () => {
  it('accepts what URLFilterParser accepts', () => {
    for (const p of ['.*', '^https?://([^/]+\\.)?example\\.com[/:]', 'a+b*c?', '[^a-zA-Z0-9_.%-]', '(?:ab)+', '/ads$', 'a*?']) {
      expect(isWebKitRegex(p), p).toBe(true);
    }
  });
  it('rejects what URLFilterParser rejects', () => {
    for (const p of ['a|b', 'a{2}', '\\d+', '\\w', '\\bads', 'a$b', 'x^', '(?=a)', '(a', 'a)', 'é', '', '*a', '\\1', '[\\d]', 'a**']) {
      expect(isWebKitRegex(p), p).toBe(false);
    }
  });
});

describe('patternToRegexes', () => {
  it('anchors hostnames and turns ^ into a separator', () => {
    const [re] = patternToRegexes('||doubleclick.net^')!;
    expect(re).toBe(`^[^:]+://+([^/]+\\.)?doubleclick\\.net${SEP}`);
    const rx = new RegExp(re!, 'i');
    expect(rx.test('https://securepubads.g.doubleclick.net/tag/js/gpt.js')).toBe(true);
    expect(rx.test('https://doubleclick.net/')).toBe(true);
    expect(rx.test('https://notdoubleclick.net/')).toBe(false);
    expect(rx.test('https://doubleclick.network/')).toBe(false);
    expect(rx.test('https://example.com/?u=doubleclick.net')).toBe(false);
  });
  it('handles wildcards and anchors', () => {
    expect(patternToRegexes('/ads/*')).toEqual(['/ads/']);
    expect(patternToRegexes('*/banner.')).toEqual(['/banner\\.']);
    expect(patternToRegexes('|https://x.com/ad|')).toEqual(['^https://x\\.com/ad$']);
    expect(patternToRegexes('*')).toEqual(['.*']);
  });
  it('adds an end-of-URL variant for a trailing separator', () => {
    expect(patternToRegexes('/ads.js^')).toEqual([`/ads\\.js${SEP}`, '/ads\\.js$']);
  });
  it('converts regex filters into the WebKit subset or drops them', () => {
    expect(patternToRegexes('/\\/ad\\d+\\.js/')).toEqual(['\\/ad[0-9]+\\.js']);
    expect(patternToRegexes('/(ads|banners)\\.js/')).toBeNull();
    expect(patternToRegexes('/[a-z]{8}\\.com/')).toBeNull();
  });
  it('drops non-ASCII patterns', () => {
    expect(patternToRegexes('||exämple.com^')).toBeNull();
  });
});

describe('webkitDomains', () => {
  it('matches subdomains and expands entities', () => {
    expect(webkitDomains(['example.com'])).toEqual(['*example.com']);
    const google = webkitDomains(['google.*']);
    expect(google).toContain('*google.com');
    expect(google).toContain('*google.co.uk');
    expect(google).toContain('*google.de');
  });
});

describe('convertFilter', () => {
  it('blocks with resource types, party and domains', () => {
    const c = convert('||ads.example.com^$script,image,third-party,domain=news.com')!;
    expect(c.blocks).toHaveLength(1);
    const t = c.blocks[0]!.trigger;
    expect(t['resource-type']).toEqual(['script', 'image']);
    expect(t['load-type']).toEqual(['third-party']);
    expect(t['if-domain']).toEqual(['*news.com']);
  });
  it('blocks iframes with a child-frame document rule', () => {
    const c = convert('||ads.example.com^$subdocument,script')!;
    expect(c.blocks.map((r) => [r.trigger['resource-type'], r.trigger['load-context']])).toEqual([
      [['script'], undefined],
      [['document'], ['child-frame']],
    ]);
  });
  it('turns exceptions into ignore-previous-rules', () => {
    const c = convert('@@||example.com/ok.js$script')!;
    expect(c.exceptions[0]!.action).toEqual({ type: 'ignore-previous-rules' });
  });
  it('keeps important blocks after exceptions', () => {
    const c = convert('||tracker.com^$important')!;
    expect(c.important).toHaveLength(1);
    expect(c.blocks).toHaveLength(0);
  });
  it('allows whole pages for @@...$document', () => {
    const c = convert('@@||bank.com^$document')!;
    expect(c.allowPages[0]!.trigger['if-top-url']![0]).toContain('bank\\.com');
  });
  it('blocks redirect filters (WKWebView has no redirects for apps)', () => {
    const c = convert('||googletagservices.com/tag/js/gpt.js$script,redirect=googletagservices_gpt.js')!;
    expect(c.blocks).toHaveLength(1);
    expect(c.blocks[0]!.action).toEqual({ type: 'block' });
  });
  it('turns denyallow into exceptions for the allowed request domains', () => {
    const c = convert('*$script,3p,denyallow=cdn.com,domain=site.com')!;
    expect(c.blocks).toHaveLength(1);
    expect(c.exceptions).toHaveLength(1);
    expect(matches(c.exceptions[0]!, 'https://cdn.com/lib.js')).toBe(true);
    expect(c.exceptions[0]!.trigger['if-domain']).toEqual(['*site.com']);
  });
  it('adds exceptions for negated subdomains', () => {
    const c = convert('||x.com^$domain=a.com|~b.a.com')!;
    expect(c.blocks[0]!.trigger['if-domain']).toEqual(['*a.com']);
    expect(c.exceptions[0]!.trigger['if-domain']).toEqual(['*b.a.com']);
  });
  it('skips what WebKit cannot do', () => {
    for (const line of ['||x.com^$csp=script-src none', '||popup.com^$popup', '||page.com^$document', '||x.com^$generichide']) {
      expect(convert(line), line).toBeNull();
    }
  });
});

describe('assemble', () => {
  it('orders blocks, exceptions, important, the top-document allow and page allows', () => {
    const { converted } = convertLists(['||a.com^', '@@||a.com/ok.js', '||b.com^$important', '@@||c.com^$document']);
    const rules = assemble(converted);
    expect(rules.map((r) => r.action.type)).toEqual(['block', 'ignore-previous-rules', 'block', 'ignore-previous-rules', 'ignore-previous-rules']);
    expect(rules[3]!.trigger).toEqual({ 'url-filter': '.*', 'resource-type': ['document'], 'load-context': ['top-frame'] });
  });
  it('applies $badfilter across lists', () => {
    const lists = buildRuleLists([
      { id: 'ads', lists: ['||a.com^\n||b.com^'] },
      { id: 'trackers', lists: ['||b.com^$badfilter'] },
    ]);
    expect(lists.ads!.rules.filter((r) => r.action.type === 'block').map((r) => r.trigger['url-filter'])).toEqual([`^[^:]+://+([^/]+\\.)?a\\.com${SEP}`]);
  });
  it('shares the ads exceptions and the user filters with every list', () => {
    const lists = buildRuleLists(
      [
        { id: 'ads', lists: ['@@||fix.com^'] },
        { id: 'trackers', lists: ['||t.com^'] },
      ],
      '||mine.com^\n@@||t.com/ok^',
    );
    const trackers = lists.trackers!.rules.map((r) => r.trigger['url-filter']);
    expect(trackers.some((u) => u.includes('fix'))).toBe(true);
    expect(trackers.some((u) => u.includes('t\\.com/ok'))).toBe(true);
    expect(lists.custom!.rules.some((r) => r.trigger['url-filter'].includes('mine'))).toBe(true);
  });
});

describe('the pinned lists', () => {
  const browser = path.resolve(import.meta.dirname, '../../browser');
  const lock = JSON.parse(fs.readFileSync(path.join(browser, 'filters/lock.json'), 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(path.join(browser, 'filters/lists.json'), 'utf8'));
  const file = (id: string) => path.join(browser, '.cache/filters', `${id}-${lock.lists[id].rev}.txt`);
  const available = catalog.groups.every((g: { lists: string[] }) => g.lists.every((id) => fs.existsSync(file(id))));

  it.skipIf(!available)('convert into valid WebKit lists that block known ad and tracker URLs', () => {
    const lists = buildRuleLists(catalog.groups.map((g: { id: string; lists: string[] }) => ({ id: g.id, lists: g.lists.map((id) => fs.readFileSync(file(id), 'utf8')) })));
    for (const [id, l] of Object.entries(lists)) {
      expect(l.rules.length, id).toBeLessThanOrEqual(MAX_RULES);
      const bad = l.rules.filter((r) => !isWebKitRegex(r.trigger['url-filter']) || (r.trigger['if-top-url'] ?? []).some((u) => !isWebKitRegex(u)));
      expect(bad, id).toEqual([]);
    }
    const blocks = (id: string, url: string) => lists[id]!.rules.some((r) => r.action.type === 'block' && !r.trigger['resource-type'] && !r.trigger['if-domain'] && matches(r, url));
    expect(blocks('ads', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js')).toBe(true);
    expect(blocks('ads', 'https://securepubads.g.doubleclick.net/tag/js/gpt.js')).toBe(true);
    expect(blocks('trackers', 'https://www.google-analytics.com/analytics.js')).toBe(true);
    expect(blocks('trackers', 'https://connect.facebook.net/en_US/fbevents.js')).toBe(true);
    expect(blocks('ads', 'https://www.wikipedia.org/')).toBe(false);
  });
});
