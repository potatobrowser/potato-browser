import type { FlagAdapter } from '../types';
import { all, linkPath } from './util';

const ITEM = '[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"]';
const POST_RE = /^\/profile\/([^/]+)\/post\/([a-z0-9]+)/i;
const EMBED = '[data-testid="contentHider-embed"], [aria-label*="quote" i], [data-testid*="Embed"]';

function didOf(el: Element): string | null {
  const img = el.querySelector('img[src*="/did:plc:"], img[src*="/did:web:"]');
  const m = img && /\/(did:(?:plc|web):[a-z0-9.%-]+)\//i.exec(img.getAttribute('src') ?? '');
  return m ? decodeURIComponent(m[1]!) : null;
}

export const bluesky: FlagAdapter = {
  platform: 'bluesky',
  hosts: ['bsky.app'],
  items(doc) {
    return all(doc, ITEM).filter((el) => !el.parentElement?.closest(ITEM));
  },
  id(el) {
    let handle: string | null = null;
    let rkey: string | null = null;
    for (const a of all(el, 'a[href*="/post/"]')) {
      if (a.closest(EMBED) && el.contains(a.closest(EMBED))) continue;
      const m = POST_RE.exec(linkPath(a));
      if (m) {
        handle = m[1]!;
        rkey = m[2]!;
        break;
      }
    }
    if (!rkey && el.matches('[data-testid^="postThreadItem-by-"]')) {
      // The focused post of a thread has no permalink; its id is in the URL.
      const m = POST_RE.exec(location.pathname);
      const author = el.getAttribute('data-testid')?.replace('postThreadItem-by-', '');
      if (m && (!author || m[1] === author || m[1]!.startsWith('did:'))) {
        handle = m[1]!;
        rkey = m[2]!;
      }
    }
    if (!rkey) return null;
    // Handles can change, DIDs cannot: prefer the DID from the avatar URL.
    const did = handle?.startsWith('did:') ? handle : didOf(el);
    return `${did ?? handle}/${rkey}`;
  },
  mount(el) {
    const like = all(el, '[data-testid="likeBtn"]').find((b) => b.closest(ITEM) === el);
    const wrap = like?.parentElement;
    if (wrap?.parentElement) return { parent: wrap.parentElement, before: wrap.nextSibling };
    return null;
  },
};
