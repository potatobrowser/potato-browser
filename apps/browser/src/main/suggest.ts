import { net } from 'electron';
import type { SuggestResult, Suggestion } from '../shared/types';
import { classifyInput, getSearchEngine, searchUrl } from '../shared/urls';
import { ctx } from './context';
import { isTest } from './paths';

const remoteCache = new Map<string, string[]>();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function remoteSuggestions(template: string, query: string): Promise<string[]> {
  const key = template + '|' + query;
  const hit = remoteCache.get(key);
  if (hit) return hit;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await net.fetch(template.replace('%s', encodeURIComponent(query)), {
      signal: controller.signal,
      credentials: 'omit',
    });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    // OpenSearch format: [query, [s1, s2, ...]]
    const list = Array.isArray(data) && Array.isArray(data[1]) ? (data[1] as unknown[]).filter((s): s is string => typeof s === 'string') : [];
    if (remoteCache.size > 200) remoteCache.clear();
    remoteCache.set(key, list);
    return list;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function suggest(input: string): Promise<SuggestResult> {
  const text = input.trim();
  if (!text) return { input, suggestions: [], inline: null };
  const settings = ctx.settings.get();
  const engine = getSearchEngine(settings.searchEngine);
  const target = classifyInput(text);
  const out: Suggestion[] = [];

  const history = ctx.db.suggestUrls(text, 6);
  const inline = ctx.db.inlineHost(text);
  if (inline) {
    // Complete to the page the user actually visits on that host, with its title.
    const match = history.find((h) => hostOf(h.url) === inline);
    out.push({ kind: 'url', title: match?.title || inline, url: match?.url ?? `https://${inline}/`, fill: inline });
  }

  if (target?.type === 'url') out.push({ kind: 'url', title: target.url, url: target.url, fill: text });
  else out.push({ kind: 'search', title: text, url: searchUrl(engine.id, text), fill: text });

  for (const r of history) {
    out.push({ kind: r.bookmarked ? 'bookmark' : 'history', title: r.title || r.url, url: r.url, fill: r.url });
  }

  if (settings.searchSuggestions && engine.suggest && target?.type !== 'url' && !isTest()) {
    for (const s of (await remoteSuggestions(engine.suggest, text)).slice(0, 5)) {
      out.push({ kind: 'suggest', title: s, url: searchUrl(engine.id, s), fill: s });
    }
  }

  const seen = new Set<string>();
  const suggestions = out.filter((s) => {
    const k = s.url.replace(/\/$/, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { input, suggestions: suggestions.slice(0, 10), inline };
}
