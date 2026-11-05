import type { FlagAdapter } from '../types';
import { all, linkUrl, outermost } from './util';

export const FB_ID_ATTR = 'data-noai-fbid';

const ACTION = '[data-ad-rendering-role="like_button"], [data-ad-rendering-role="comment_button"], [data-ad-rendering-role="share_button"]';
const POST_CONTAINER = '[aria-posinset], [data-virtualized] > div, [role="article"]:not([aria-label]), [role="dialog"]';
const COMMENT = 'div[role="article"][aria-label]';

/** Post containers found by climbing from Facebook's untranslated action-bar markers. */
function posts(doc: Document): Element[] {
  const found = new Set<Element>();
  for (const marker of all(doc, ACTION)) {
    let el: Element | null = marker;
    for (let i = 0; el && i < 24; i++) {
      el = el.parentElement;
      if (el?.matches(POST_CONTAINER)) {
        found.add(el);
        break;
      }
    }
  }
  return outermost([...found]);
}

/** comment_id is numeric or base64 "comment:<postId>_<commentId>". */
export function decodeCommentId(raw: string): { post?: string; comment: string } | null {
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (/^\d+$/.test(v)) return { comment: v };
  try {
    const m = /^comment:(\d+)_(\d+)$/.exec(atob(v));
    if (m) return { post: m[1], comment: m[2]! };
  } catch {}
  return null;
}

/** Ids from links that already carry a real permalink (permalink pages, photos, comments). */
export function postIdsFromLinks(root: Element): string[] {
  const ids: string[] = [];
  for (const a of all(root, 'a[href]')) {
    if (a.closest(COMMENT) && a.closest(COMMENT) !== root) continue;
    const u = linkUrl(a);
    if (!u || !/facebook\.com$/.test(u.hostname.replace(/^(www|web|m)\./, ''))) continue;
    const p = u.pathname;
    let m = /\/posts\/(pfbid[A-Za-z0-9]{20,}|\d{6,})/.exec(p);
    if (m) ids.push(m[1]!);
    if ((m = /^\/groups\/[^/]+\/(?:posts|permalink)\/(\d{6,})/.exec(p))) ids.push(m[1]!);
    if ((m = /^\/(?:reel|videos)\/(\d{6,})/.exec(p)) || (m = /\/videos\/(\d{6,})/.exec(p))) ids.push(`video:${m[1]}`);
    const story = u.searchParams.get('story_fbid');
    if (story) ids.push(story);
    const set = u.searchParams.get('set');
    if (set && (m = /^(?:pcb|gm)\.(\d{6,})/.exec(set))) ids.push(m[1]!);
    const cid = u.searchParams.get('comment_id');
    if (cid) {
      const d = decodeCommentId(cid);
      if (d?.post) ids.push(d.post);
    }
  }
  // pfbid ranks above numeric ids so the primary key is deterministic.
  return [...new Set(ids)].sort((a, b) => Number(b.startsWith('pfbid')) - Number(a.startsWith('pfbid')));
}

export const facebook: FlagAdapter = {
  platform: 'facebook',
  hosts: ['facebook.com', 'web.facebook.com'],
  items(doc) {
    const list = posts(doc);
    for (const c of all(doc, COMMENT)) if (c.querySelector('a[href*="comment_id="]') && !c.querySelector(COMMENT)) list.push(c);
    return list;
  },
  id(el) {
    if (el.matches(COMMENT)) {
      for (const a of all(el, 'a[href*="comment_id="]')) {
        if (a.closest(COMMENT) !== el) continue;
        const u = linkUrl(a);
        const raw = u?.searchParams.get('reply_comment_id') ?? u?.searchParams.get('comment_id');
        const d = raw ? decodeCommentId(raw) : null;
        if (d) return `c:${d.comment}`;
      }
      return null;
    }
    // Set by the page-world helper from React props (the most reliable source).
    const fromFiber = el.getAttribute(FB_ID_ATTR);
    const fromLinks = postIdsFromLinks(el);
    const ids = [...new Set([fromFiber, ...fromLinks].filter(Boolean) as string[])];
    return ids.length ? ids : null;
  },
  mount(el) {
    if (el.matches(COMMENT)) {
      const time = all(el, 'a[href*="comment_id="]').find((a) => a.closest(COMMENT) === el && /\d/.test(a.textContent ?? ''));
      return time?.parentElement ? { parent: time.parentElement } : null;
    }
    const share = el.querySelector('[data-ad-rendering-role="share_button"]');
    let bar = share?.closest('[role="button"]')?.parentElement?.parentElement ?? null;
    if (bar && !el.contains(bar)) bar = null;
    return bar ? { parent: bar } : null;
  },
};

/**
 * Runs in the page's main world (React props are invisible to isolated scripts): walks each
 * post's React fiber to find its numeric post_id and writes it to `data-noai-fbid`.
 */
export function facebookPageWorldHelper(attr: string, actionSelector: string, containerSelector: string): void {
  const w = window as unknown as { __noaiFb?: boolean };
  if (w.__noaiFb) return;
  w.__noaiFb = true;
  const findId = (obj: unknown, depth: number, seen: Set<unknown>): string | null => {
    if (!obj || typeof obj !== 'object' || depth > 4 || seen.has(obj)) return null;
    seen.add(obj);
    const rec = obj as Record<string, unknown>;
    const v = rec.post_id;
    if (typeof v === 'string' && /^\d{12,20}$/.test(v)) return v;
    for (const key of Object.keys(rec)) {
      if (key === 'children' || key === '_owner') continue;
      const r = findId(rec[key], depth + 1, seen);
      if (r) return r;
    }
    return null;
  };
  const scan = () => {
    for (const marker of Array.from(document.querySelectorAll(actionSelector))) {
      let el: Element | null = marker;
      for (let i = 0; el && i < 24; i++) {
        el = el.parentElement;
        if (el?.matches(containerSelector)) break;
      }
      if (!el || el.hasAttribute(attr)) continue;
      const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      let fiber = fiberKey ? (el as unknown as Record<string, any>)[fiberKey] : null;
      for (let i = 0; fiber && i < 100; i++, fiber = fiber.return) {
        const id = findId(fiber.memoizedProps, 0, new Set());
        if (id) {
          el.setAttribute(attr, id);
          break;
        }
      }
    }
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      scan();
    }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
}

export const FB_HELPER_ARGS = [FB_ID_ATTR, ACTION, POST_CONTAINER] as const;
