import { describe, expect, it } from 'vitest';
import { classifyInput, displayUrl, hostMatches, nextZoom, prettyUrl, resolveInput, searchUrl, siteKey } from '../../src/shared/urls';

describe('classifyInput', () => {
  it.each([
    ['example.com', 'https://example.com/'],
    ['example.com/path?q=1#x', 'https://example.com/path?q=1#x'],
    ['https://example.com', 'https://example.com/'],
    ['http://example.com/a', 'http://example.com/a'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['localhost', 'http://localhost/'],
    ['192.168.1.10', 'http://192.168.1.10/'],
    ['192.168.1.10:8080/admin', 'http://192.168.1.10:8080/admin'],
    ['myhost:8080', 'http://myhost:8080/'],
    ['xn--bcher-kva.example', 'https://xn--bcher-kva.example/'],
    ['noai://settings', 'noai://settings'],
    ['about:blank', 'about:blank'],
    ['file:///Users/me/a.html', 'file:///Users/me/a.html'],
  ])('%s is a URL', (input, url) => {
    expect(classifyInput(input)).toEqual({ type: 'url', url });
  });

  it.each(['cats', 'how do magnets work', 'example', 'foo.bar baz', '999.1.1.1', 'node.js tutorial', 'c++', 'a..b'])('%s is a search', (input) => {
    expect(classifyInput(input)?.type).toBe('search');
  });

  it('forces a search with a leading question mark', () => {
    expect(classifyInput('?example.com')).toEqual({ type: 'search', query: 'example.com' });
    expect(classifyInput('   ')).toBeNull();
    expect(classifyInput('?')).toBeNull();
  });

  it('builds search URLs per engine with encoding', () => {
    expect(searchUrl('duckduckgo', 'a&b c')).toBe('https://noai.duckduckgo.com/?q=a%26b%20c');
    expect(searchUrl('google-web', 'x')).toBe('https://www.google.com/search?q=x&udm=14');
    expect(resolveInput('cats', 'bing')).toBe('https://www.bing.com/search?q=cats');
  });
});

describe('url helpers', () => {
  it('formats URLs for the omnibox', () => {
    expect(prettyUrl('https://www.example.com/a%20b?x=1')).toEqual({ host: 'example.com', rest: '/a b?x=1', scheme: 'https:' });
    expect(prettyUrl('https://example.com/')).toEqual({ host: 'example.com', rest: '', scheme: 'https:' });
    expect(displayUrl('noai://newtab/')).toBe('');
  });

  it('matches sites for per-site exceptions', () => {
    expect(siteKey('https://www.google.com/search?q=1')).toBe('google.com');
    expect(hostMatches('mail.google.com', 'google.com')).toBe(true);
    expect(hostMatches('notgoogle.com', 'google.com')).toBe(false);
    expect(hostMatches('www.reddit.com', 'reddit.com')).toBe(true);
  });

  it('steps through Chrome zoom levels', () => {
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
    expect(nextZoom(5, 1)).toBe(5);
    expect(nextZoom(0.25, -1)).toBe(0.25);
    expect(nextZoom(1.05, 1)).toBe(1.1);
  });
});
