import type { Rectangle } from 'electron';
import { migrateLegacyUrl } from '../shared/urls';

/** One back/forward entry; `pageState` (scroll position, form fields) only lives in memory. */
export interface NavEntry {
  url: string;
  title: string;
  pageState?: string;
}

export interface TabHistory {
  entries: NavEntry[];
  index: number;
}

export interface SavedWindow {
  bounds?: Rectangle;
  active: number;
  tabs: TabHistory[];
}

export interface SavedSession {
  windows: SavedWindow[];
  /** Written by a restart into an update: the next launch restores, whatever the startup setting. */
  restore?: boolean;
}

/**
 * session.json. `tabs` lists each tab's address, as before 0.8, so an older version still restores
 * the tabs; `history` holds each tab's back and forward entries at the same position.
 */
export interface DiskSession {
  windows: { bounds?: Rectangle; tabs: string[]; active: number; history: { index: number; entries: { url: string; title: string }[] }[] }[];
  restore?: true;
}

export const MAX_TABS_PER_WINDOW = 100;
const MAX_BACK = 20;
const MAX_FORWARD = 5;
const MAX_URL = 8192;
const MAX_TITLE = 300;

/** Addresses that load again on the next launch (not data:, blob:, error pages or internal actions). */
export function persistable(url: string): boolean {
  if (!url || url.length > MAX_URL || url.startsWith('potato://action/') || !URL.canParse(url)) return false;
  return /^(https?:|file:|potato:|view-source:https?:)/i.test(url) || url === 'about:blank';
}

/** What is kept of a tab's history across launches: entries around the current one, without page state. */
export function trimHistory(h: TabHistory | null): TabHistory | null {
  const current = h?.entries[h.index];
  if (!h || !current || !persistable(current.url)) return null;
  const entries: NavEntry[] = [];
  let index = 0;
  for (let i = Math.max(0, h.index - MAX_BACK); i < Math.min(h.entries.length, h.index + MAX_FORWARD + 1); i++) {
    const e = h.entries[i]!;
    if (i === h.index) index = entries.length;
    else if (!persistable(e.url)) continue;
    entries.push({ url: e.url, title: (e.title || '').slice(0, MAX_TITLE) });
  }
  return { entries, index };
}

export function toDisk(s: SavedSession): DiskSession {
  return {
    windows: s.windows.map((w) => ({
      bounds: w.bounds,
      tabs: w.tabs.map((t) => t.entries[t.index]!.url),
      active: w.active,
      history: w.tabs.map((t) => ({ index: t.index, entries: t.entries.map((e) => ({ url: e.url, title: e.title })) })),
    })),
    ...(s.restore ? { restore: true as const } : {}),
  };
}

function parseHistory(raw: unknown, url: string): TabHistory | null {
  if (!raw || typeof raw !== 'object') return null;
  const { index, entries } = raw as { index?: unknown; entries?: unknown };
  if (!Array.isArray(entries) || typeof index !== 'number' || !Number.isInteger(index)) return null;
  const list: NavEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object' || typeof e.url !== 'string' || !URL.canParse(e.url)) return null;
    list.push({ url: migrateLegacyUrl(e.url), title: typeof e.title === 'string' ? e.title : '' });
  }
  // A history that does not end up at the tab's own address is not this tab's.
  return list[index]?.url === url ? trimHistory({ entries: list, index }) : null;
}

/** Reads session.json, the format before 0.8 (`tabs` only) included, skipping anything malformed. */
export function parseSession(raw: unknown): SavedSession {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { windows?: unknown; restore?: unknown };
  const windows: SavedWindow[] = [];
  for (const w of Array.isArray(r.windows) ? r.windows : []) {
    if (!w || typeof w !== 'object' || !Array.isArray(w.tabs)) continue;
    const history: unknown[] = Array.isArray(w.history) ? w.history : [];
    const wantActive = typeof w.active === 'number' && Number.isInteger(w.active) ? w.active : 0;
    const tabs: TabHistory[] = [];
    let active = 0;
    (w.tabs as unknown[]).forEach((u, i) => {
      if (typeof u !== 'string' || !URL.canParse(u) || tabs.length >= MAX_TABS_PER_WINDOW) return;
      const url = migrateLegacyUrl(u);
      if (i <= wantActive) active = tabs.length;
      tabs.push(parseHistory(history[i], url) ?? { entries: [{ url, title: '' }], index: 0 });
    });
    if (!tabs.length) continue;
    const b = w.bounds as Rectangle | undefined;
    windows.push({ bounds: b && typeof b === 'object' ? b : undefined, active, tabs });
  }
  return { windows, ...(r.restore === true ? { restore: true } : {}) };
}
