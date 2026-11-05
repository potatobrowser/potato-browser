import { net } from 'electron';
import {
  hashContentKey,
  hashPrefix,
  MAX_LOOKUP_PREFIXES,
  parseContentKey,
  type FlagResponse,
  type LookupResponse,
} from '@noai/shared';
import type { FlagStatus } from '../shared/types';
import { ctx } from './context';
import { apiBase } from './paths';

const CACHE_TTL_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 6_000;

interface PrefixEntry {
  at: number;
  counts: Map<string, number>;
}

async function postJson<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await net.fetch(apiBase() + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Anonymous AI flags. Content keys stay on this machine: lookups send only hash prefixes, and
 * the server matches full hashes locally against what it returns (k-anonymity).
 */
export class FlagsService {
  private prefixCache = new Map<string, PrefixEntry>();
  private hashCache = new Map<string, string>();
  private inflight = new Map<string, Promise<void>>();
  /** Flags made in private windows are remembered only until the private session ends. */
  private privateMine = new Set<string>();

  private async hash(key: string): Promise<string> {
    let h = this.hashCache.get(key);
    if (!h) {
      h = await hashContentKey(key);
      if (this.hashCache.size > 20_000) this.hashCache.clear();
      this.hashCache.set(key, h);
    }
    return h;
  }

  private fresh(prefix: string): PrefixEntry | null {
    const e = this.prefixCache.get(prefix);
    return e && Date.now() - e.at < CACHE_TTL_MS ? e : null;
  }

  private async fetchPrefixes(prefixes: string[]): Promise<void> {
    const todo = prefixes.filter((p) => !this.fresh(p) && !this.inflight.has(p));
    const waits = prefixes.map((p) => this.inflight.get(p)).filter(Boolean) as Promise<void>[];
    for (let i = 0; i < todo.length; i += MAX_LOOKUP_PREFIXES) {
      const batch = todo.slice(i, i + MAX_LOOKUP_PREFIXES);
      const p = postJson<LookupResponse>('/api/v1/lookup', { prefixes: batch })
        .then((res) => {
          const now = Date.now();
          const grouped = new Map<string, Map<string, number>>(batch.map((b) => [b, new Map()]));
          for (const item of res.items ?? []) grouped.get(hashPrefix(item.h))?.set(item.h, item.n);
          for (const [prefix, counts] of grouped) this.prefixCache.set(prefix, { at: now, counts });
        })
        .catch((err) => {
          console.warn('flags lookup failed:', err.message);
        })
        .finally(() => batch.forEach((b) => this.inflight.delete(b)));
      batch.forEach((b) => this.inflight.set(b, p));
      waits.push(p);
    }
    await Promise.all(waits);
  }

  async lookup(keys: string[], isPrivate: boolean, localOnly = false): Promise<Record<string, FlagStatus>> {
    const valid = [...new Set(keys)].filter((k) => parseContentKey(k)).slice(0, 500);
    const mine = ctx.db.myFlags(valid);
    const out: Record<string, FlagStatus> = {};
    if (localOnly) {
      for (const k of valid) out[k] = { n: 0, mine: mine.has(k) || (isPrivate && this.privateMine.has(k)) };
      return out;
    }
    const hashes = await Promise.all(valid.map((k) => this.hash(k)));
    await this.fetchPrefixes([...new Set(hashes.map(hashPrefix))]);
    valid.forEach((k, i) => {
      const h = hashes[i]!;
      const n = this.prefixCache.get(hashPrefix(h))?.counts.get(h) ?? 0;
      out[k] = { n, mine: mine.has(k) || (isPrivate && this.privateMine.has(k)) };
    });
    return out;
  }

  /** Flags (or un-flags) all keys of one post for the user and returns their new status. */
  async set(keys: string[], flag: boolean, isPrivate: boolean): Promise<Record<string, FlagStatus>> {
    const valid = [...new Set(keys)].filter((k) => parseContentKey(k)).slice(0, 10);
    if (!valid.length) throw new Error('invalid content key');
    const client = ctx.settings.get().installId;
    const out: Record<string, FlagStatus> = {};
    for (const key of valid) {
      const { platform } = parseContentKey(key)!;
      const h = await this.hash(key);
      const res = await postJson<FlagResponse>('/api/v1/flags', { h, platform, client }, flag ? 'POST' : 'DELETE');
      if (isPrivate) {
        if (flag) this.privateMine.add(key);
        else this.privateMine.delete(key);
      }
      if (!isPrivate || !flag) ctx.db.setMyFlag(key, h, platform, flag && !isPrivate);
      const prefix = hashPrefix(h);
      const entry = this.prefixCache.get(prefix) ?? { at: Date.now(), counts: new Map<string, number>() };
      entry.counts.set(h, res.n);
      this.prefixCache.set(prefix, entry);
      out[key] = { n: res.n, mine: flag };
    }
    return out;
  }

  forgetPrivate(): void {
    this.privateMine.clear();
  }

  clearCache(): void {
    this.prefixCache.clear();
  }
}
