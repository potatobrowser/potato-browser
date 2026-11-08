import crypto from 'node:crypto';
import { net } from 'electron';
import {
  hashContentKey,
  hashPrefix,
  MAX_LOOKUP_PREFIXES,
  parseContentKey,
  type FlagResponse,
  type LookupResponse,
  type VoteKind,
} from '@potato/shared';
import type { FlagStatus } from '../shared/types';
import { ctx } from './context';
import { apiBase } from './paths';

const CACHE_TTL_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 6_000;

interface Counts {
  n: number;
  d: number;
}

interface PrefixEntry {
  at: number;
  counts: Map<string, Counts>;
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
  /** Votes cast in private windows are remembered only until the private session ends. */
  private privateMine = new Map<string, VoteKind>();
  /** Private windows flag under a throwaway id, so the server cannot link them to this install. */
  private privateClient: string | null = null;

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
      const p = postJson<LookupResponse>('/api/v1/lookup', { prefixes: batch, v: 2 })
        .then((res) => {
          const now = Date.now();
          const grouped = new Map<string, Map<string, Counts>>(batch.map((b) => [b, new Map()]));
          for (const item of res.items ?? []) grouped.get(hashPrefix(item.h))?.set(item.h, { n: item.n, d: item.d ?? 0 });
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

  private votesOf(keys: string[], isPrivate: boolean): Map<string, VoteKind> {
    if (!isPrivate) return ctx.db.myFlags(keys);
    return new Map(keys.flatMap((k) => (this.privateMine.has(k) ? [[k, this.privateMine.get(k)!] as const] : [])));
  }

  private status(c: Counts, vote: VoteKind | undefined): FlagStatus {
    return { n: c.n, d: c.d, mine: vote === 'ai', disputed: vote === 'human' };
  }

  async lookup(keys: string[], isPrivate: boolean, localOnly = false): Promise<Record<string, FlagStatus>> {
    const valid = [...new Set(keys)].filter((k) => parseContentKey(k)).slice(0, 500);
    const out: Record<string, FlagStatus> = {};
    if (localOnly) {
      const mine = this.votesOf(valid, isPrivate);
      for (const k of valid) out[k] = this.status({ n: 0, d: 0 }, mine.get(k));
      return out;
    }
    const hashes = await Promise.all(valid.map((k) => this.hash(k)));
    await this.fetchPrefixes([...new Set(hashes.map(hashPrefix))]);
    // Read the user's own votes only now: one may have been cast while the lookup was in flight.
    const mine = this.votesOf(valid, isPrivate);
    valid.forEach((k, i) => {
      const h = hashes[i]!;
      out[k] = this.status(this.prefixCache.get(hashPrefix(h))?.counts.get(h) ?? { n: 0, d: 0 }, mine.get(k));
    });
    return out;
  }

  /** Sets (or takes back, with null) the user's vote on all keys of one post; returns their new status. */
  async set(keys: string[], vote: VoteKind | null, isPrivate: boolean): Promise<Record<string, FlagStatus>> {
    const valid = [...new Set(keys)].filter((k) => parseContentKey(k)).slice(0, 10);
    if (!valid.length) throw new Error('invalid content key');
    const client = isPrivate ? (this.privateClient ??= crypto.randomBytes(16).toString('hex')) : ctx.settings.get().installId;
    const out: Record<string, FlagStatus> = {};
    for (const key of valid) {
      const { platform } = parseContentKey(key)!;
      const h = await this.hash(key);
      const res = await postJson<FlagResponse>('/api/v1/flags', { h, platform, client, vote: vote ?? 'ai', app: 'mac' }, vote ? 'POST' : 'DELETE');
      if (isPrivate) {
        if (vote) this.privateMine.set(key, vote);
        else this.privateMine.delete(key);
      } else {
        ctx.db.setMyFlag(key, h, platform, vote);
      }
      const counts = { n: res.n, d: res.d ?? 0 };
      const prefix = hashPrefix(h);
      const entry = this.prefixCache.get(prefix) ?? { at: Date.now(), counts: new Map<string, Counts>() };
      entry.counts.set(h, counts);
      this.prefixCache.set(prefix, entry);
      out[key] = this.status(counts, vote ?? undefined);
    }
    return out;
  }

  forgetPrivate(): void {
    this.privateMine.clear();
    this.privateClient = null;
  }

  clearCache(): void {
    this.prefixCache.clear();
  }
}
