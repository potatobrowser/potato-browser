import type { SearchEngineId } from './types';

export interface SearchEngine {
  id: SearchEngineId;
  name: string;
  /** `%s` is replaced with the URL-encoded query. */
  search: string;
  /** OpenSearch JSON suggestions endpoint (`[query, [suggestions...]]`), or null. */
  suggest: string | null;
  note?: string;
}

export const SEARCH_ENGINES: SearchEngine[] = [
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo (no AI)',
    search: 'https://noai.duckduckgo.com/?q=%s',
    suggest: 'https://duckduckgo.com/ac/?q=%s&type=list',
    note: 'DuckDuckGo with its AI features turned off.',
  },
  {
    id: 'google',
    name: 'Google',
    search: 'https://www.google.com/search?q=%s',
    suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s',
    note: 'AI Overviews and AI Mode are hidden by the AI Shield.',
  },
  {
    id: 'google-web',
    name: 'Google (Web results only)',
    search: 'https://www.google.com/search?q=%s&udm=14',
    suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s',
    note: 'Plain links, no AI Overviews, no widgets.',
  },
  {
    id: 'bing',
    name: 'Bing',
    search: 'https://www.bing.com/search?q=%s',
    suggest: 'https://api.bing.com/osjson.aspx?query=%s',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    search: 'https://search.brave.com/search?q=%s&summary=0',
    suggest: 'https://search.brave.com/api/suggest?q=%s',
  },
  {
    id: 'startpage',
    name: 'Startpage',
    search: 'https://www.startpage.com/do/search?q=%s',
    suggest: null,
  },
  {
    id: 'ecosia',
    name: 'Ecosia',
    search: 'https://www.ecosia.org/search?q=%s',
    suggest: 'https://ac.ecosia.org/autocomplete?q=%s&type=list',
  },
  {
    id: 'kagi',
    name: 'Kagi',
    search: 'https://kagi.com/search?q=%s',
    suggest: null,
  },
];

export function getSearchEngine(id: SearchEngineId): SearchEngine {
  return SEARCH_ENGINES.find((e) => e.id === id) ?? SEARCH_ENGINES[0]!;
}

export function searchUrl(engineId: SearchEngineId, query: string): string {
  return getSearchEngine(engineId).search.replace('%s', encodeURIComponent(query.trim()));
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const KNOWN_SCHEMES = new Set([
  'http:',
  'https:',
  'file:',
  'potato:',
  'about:',
  'data:',
  'view-source:',
  'mailto:',
  'tel:',
  'blob:',
  'ftp:',
]);
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Common TLDs plus a length rule; anything else with a dot and no spaces still counts as a host
// when it has a path or a port, matching what people expect from Chrome.
function looksLikeHost(host: string): boolean {
  if (host === 'localhost') return true;
  const ip = IPV4_RE.exec(host);
  if (ip) return ip.slice(1).every((n) => Number(n) <= 255);
  if (host.startsWith('[') && host.endsWith(']')) return true; // IPv6 literal
  if (!host.includes('.')) return false;
  const labels = host.split('.');
  if (labels.some((l) => !l || !/^[a-z0-9-]+$/i.test(l) || l.startsWith('-') || l.endsWith('-'))) {
    return false;
  }
  const tld = labels[labels.length - 1]!;
  return /^[a-z]{2,24}$/i.test(tld) || /^xn--[a-z0-9-]+$/i.test(tld);
}

export type OmniboxTarget = { type: 'url'; url: string } | { type: 'search'; query: string };

/** Decides whether omnibox input is a URL to open or a query to search for. */
export function classifyInput(raw: string): OmniboxTarget | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('?')) {
    const q = text.slice(1).trim();
    return q ? { type: 'search', query: q } : null;
  }
  if (/\s/.test(text)) {
    // "example.com/a b" is still a URL in Chrome, but spaces almost always mean a search.
    return { type: 'search', query: text };
  }
  const scheme = SCHEME_RE.exec(text)?.[0]?.toLowerCase();
  if (scheme && KNOWN_SCHEMES.has(scheme)) {
    if (scheme === 'http:' || scheme === 'https:') {
      try {
        return { type: 'url', url: new URL(text).href };
      } catch {
        return { type: 'search', query: text };
      }
    }
    return { type: 'url', url: text };
  }
  // host[:port][/path] without a scheme
  const m = /^([^/?#:]+|\[[^\]]+\])(:\d{1,5})?([/?#].*)?$/.exec(text);
  if (m) {
    const host = m[1]!.toLowerCase();
    const port = m[2] ?? '';
    const rest = m[3] ?? '';
    if (looksLikeHost(host) || (port && /^[a-z0-9-]+$/i.test(host))) {
      const local = host === 'localhost' || IPV4_RE.test(host) || !host.includes('.') || host.endsWith('.local');
      try {
        return { type: 'url', url: new URL(`${local ? 'http' : 'https'}://${host}${port}${rest}`).href };
      } catch {
        return { type: 'search', query: text };
      }
    }
  }
  return { type: 'search', query: text };
}

export function resolveInput(raw: string, engine: SearchEngineId): string | null {
  const t = classifyInput(raw);
  if (!t) return null;
  return t.type === 'url' ? t.url : searchUrl(engine, t.query);
}

export const NEW_TAB_URL = 'potato://newtab/';

export function isNewTabUrl(url: string): boolean {
  return url === NEW_TAB_URL || url === 'potato://newtab' || url === 'about:blank#newtab';
}

/** Internal URLs saved before the rename (noai://) open as their potato:// equivalent. */
export function migrateLegacyUrl(url: string): string {
  return url.startsWith('noai://') ? `potato://${url.slice('noai://'.length)}` : url;
}

export function isInternalUrl(url: string): boolean {
  return url.startsWith('potato://');
}

/** URL shown in the omnibox: empty for the new tab page, otherwise the full URL. */
export function displayUrl(url: string): string {
  if (!url || isNewTabUrl(url)) return '';
  return url;
}

/** Compact host + path form shown while the omnibox is not focused. */
export function prettyUrl(url: string): { host: string; rest: string; scheme: string } {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const host = u.host.replace(/^www\./, '');
      let rest = decodeSafe(u.pathname + u.search + u.hash);
      if (rest === '/') rest = '';
      return { host, rest, scheme: u.protocol };
    }
    return { host: '', rest: url, scheme: u.protocol };
  } catch {
    return { host: '', rest: url, scheme: '' };
  }
}

function decodeSafe(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** Hostname without a leading www. Used as the per-site key for shield exceptions. */
export function siteKey(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** True when `host` equals `site` or is a subdomain of it. */
export function hostMatches(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const s = site.toLowerCase().replace(/^www\./, '');
  return h === s || h.endsWith('.' + s);
}

export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function nextZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_LEVELS.find((z) => z > current + 0.001) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!;
  return [...ZOOM_LEVELS].reverse().find((z) => z < current - 0.001) ?? ZOOM_LEVELS[0]!;
}
