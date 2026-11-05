import { describe, expect, it } from 'vitest';
import { hostMatchesPattern, ruleMatchesPath } from '../../src/content/shield/match';
import { RULES, rulesForHost, siteRulesForHost } from '../../src/content/shield/rules';
import { ADAPTERS, adapterFor } from '../../src/content/flags/adapters';

describe('host patterns', () => {
  it('matches any Google country domain but nothing else', () => {
    for (const h of ['google.com', 'www.google.com', 'www.google.de', 'google.co.uk', 'www.google.com.br', 'google.hu']) {
      expect(hostMatchesPattern(h, 'google.*'), h).toBe(true);
    }
    for (const h of ['google.evil.com', 'notgoogle.com', 'google.com.evil.net', 'mail.google.com']) {
      expect(hostMatchesPattern(h, 'google.*'), h).toBe(false);
    }
  });

  it('handles subdomain wildcards and exact hosts', () => {
    expect(hostMatchesPattern('old.reddit.com', '*.reddit.com')).toBe(true);
    expect(hostMatchesPattern('reddit.com', '*.reddit.com')).toBe(true);
    expect(hostMatchesPattern('notreddit.com', '*.reddit.com')).toBe(false);
    expect(hostMatchesPattern('www.x.com', 'x.com')).toBe(true);
    expect(hostMatchesPattern('xx.com', 'x.com')).toBe(false);
    expect(hostMatchesPattern('anything.example', '*')).toBe(true);
  });
});

describe('AI Shield catalog', () => {
  it('has unique rule and feature ids and something to do per feature', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RULES) {
      expect(r.hosts.length, r.id).toBeGreaterThan(0);
      const fids = r.features.map((f) => f.id);
      expect(new Set(fids).size, r.id).toBe(fids.length);
      for (const f of r.features) {
        const work = (f.css?.length ?? 0) + (f.match?.length ?? 0) + (f.placeholders?.length ?? 0) + (f.block?.length ?? 0);
        expect(work, `${r.id}:${f.id}`).toBeGreaterThan(0);
        for (const m of f.match ?? []) {
          expect(m.any || m.texts?.length || m.patterns?.length, `${r.id}:${f.id} matcher`).toBeTruthy();
          for (const p of m.patterns ?? []) expect(() => new RegExp(p, 'i')).not.toThrow();
        }
      }
      for (const p of r.paths ?? []) expect(() => new RegExp(p)).not.toThrow();
    }
  });

  it('covers the sites the product promises', () => {
    const covered = (host: string) => siteRulesForHost(host).length > 0;
    for (const host of [
      'www.google.com',
      'mail.google.com',
      'docs.google.com',
      'www.youtube.com',
      'www.bing.com',
      'duckduckgo.com',
      'x.com',
      'www.facebook.com',
      'www.instagram.com',
      'web.whatsapp.com',
      'www.linkedin.com',
      'www.reddit.com',
      'www.amazon.com',
      'www.amazon.de',
      'github.com',
      'outlook.live.com',
    ]) {
      expect(covered(host), host).toBe(true);
    }
    expect(siteRulesForHost('example.com')).toEqual([]);
    expect(rulesForHost('example.com').map((r) => r.id)).toEqual(['widgets']);
  });

  it('scopes Google Search rules to search pages', () => {
    const google = RULES.find((r) => r.id === 'google-search')!;
    expect(ruleMatchesPath(google, '/search')).toBe(true);
    expect(ruleMatchesPath(google, '/')).toBe(true);
    expect(ruleMatchesPath(google, '/maps/place/x')).toBe(false);
  });
});

describe('flag adapters', () => {
  it('cover every platform exactly once', () => {
    expect(ADAPTERS.map((a) => a.platform).sort()).toEqual(['bluesky', 'facebook', 'instagram', 'linkedin', 'reddit', 'threads', 'tiktok', 'x', 'youtube']);
    expect(adapterFor('www.reddit.com')?.platform).toBe('reddit');
    expect(adapterFor('old.reddit.com')?.platform).toBe('reddit');
    expect(adapterFor('twitter.com')?.platform).toBe('x');
    expect(adapterFor('www.threads.net')?.platform).toBe('threads');
    expect(adapterFor('example.com')).toBeNull();
  });
});
