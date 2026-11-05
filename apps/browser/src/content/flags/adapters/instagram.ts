import type { FlagAdapter } from '../types';
import { all, innermost, linkPath } from './util';

const POST_RE = /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/;
const COMMENT_RE = /\/(?:p|reel)\/[A-Za-z0-9_-]+\/c\/(\d+)/;
const REPLY_RE = /^(reply|válasz|antworten|répondre|responder|rispondi|responder|odpowiedz|antwoord)$/i;

const comments = new WeakSet<Element>();
/** Post page or modal containers whose id comes from the URL. */
const urlPosts = new WeakSet<Element>();

function postIdFromLinks(root: Element): string | null {
  // Prefer the permalink wrapping the timestamp; skip comment permalinks.
  for (const t of all(root, 'a[href] time')) {
    const path = linkPath(t.closest('a'));
    const m = POST_RE.exec(path);
    if (m && !COMMENT_RE.test(path)) return m[1]!;
  }
  for (const a of all(root, 'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]')) {
    const path = linkPath(a);
    if (path.includes('/reels/audio/') || COMMENT_RE.test(path)) continue;
    const m = POST_RE.exec(path);
    if (m) return m[1]!;
  }
  return null;
}

/** The smallest block holding a `/c/<id>/` time link and a Reply control is one comment. */
function commentBlocks(doc: Document): Element[] {
  const blocks: Element[] = [];
  for (const time of all(doc, 'a[href*="/c/"] time')) {
    let el: Element | null = time.closest('a');
    for (let i = 0; el && i < 7; i++) {
      el = el.parentElement;
      if (!el) break;
      const hasReply = all(el, '[role="button"], button').some((b) => REPLY_RE.test((b.textContent ?? '').trim()));
      if (hasReply) {
        blocks.push(el);
        break;
      }
    }
  }
  return innermost([...new Set(blocks)]);
}

export const instagram: FlagAdapter = {
  platform: 'instagram',
  hosts: ['instagram.com'],
  items(doc) {
    const items = all(doc, 'article').filter((a) => !a.parentElement?.closest('article') && a.querySelector('section'));
    if (POST_RE.test(location.pathname) && !items.length) {
      // Post pages and the post modal are not always <article>s; their id is in the URL.
      const host = doc.querySelector('div[role="dialog"]') ?? doc.querySelector('main');
      if (host?.querySelector('section')) {
        urlPosts.add(host);
        items.push(host);
      }
    }
    for (const c of commentBlocks(doc)) {
      comments.add(c);
      items.push(c);
    }
    return items;
  },
  id(el) {
    if (comments.has(el)) {
      const m = COMMENT_RE.exec(linkPath(el.querySelector('a[href*="/c/"] time')?.closest('a')));
      return m ? `c:${m[1]}` : null;
    }
    if (urlPosts.has(el)) return POST_RE.exec(location.pathname)?.[1] ?? null;
    return postIdFromLinks(el);
  },
  mount(el) {
    if (comments.has(el)) {
      const link = el.querySelector('a[href*="/c/"] time')?.closest('a');
      return link?.parentElement ? { parent: link.parentElement, before: link.nextSibling } : { parent: el };
    }
    const section = el.querySelector('section');
    if (!section) return null;
    // The first group holds Like / Comment / Share; Save sits in a separate group.
    return { parent: section.firstElementChild ?? section };
  },
};
