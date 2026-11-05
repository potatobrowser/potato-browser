import type { FlagAdapter } from '../types';
import { all, linkPath } from './util';

const TWEET = 'article[data-testid="tweet"], article[data-tweet-id]';
const STATUS_RE = /^\/(?:[A-Za-z0-9_]{1,20}|i(?:\/web)?)\/status\/(\d{5,25})/;

/** The quoted-tweet card inside a tweet; its links and buttons belong to the quote. */
const inQuote = (el: Element, tweet: Element) => {
  const card = el.closest('div[role="link"]');
  return !!card && tweet.contains(card) && card !== tweet;
};

export const x: FlagAdapter = {
  platform: 'x',
  hosts: ['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com'],
  items(doc) {
    // Promoted tweets live inside placementTracking; skip them.
    return all(doc, TWEET).filter((t) => !t.closest('[data-testid="placementTracking"]') && !t.parentElement?.closest('article'));
  },
  id(el) {
    const own = el.getAttribute('data-tweet-id');
    if (own && /^\d+$/.test(own)) return own;
    for (const time of all(el, 'a[href*="/status/"] time')) {
      const a = time.closest('a');
      if (!a || inQuote(a, el)) continue;
      const m = STATUS_RE.exec(linkPath(a));
      if (m) return m[1]!;
    }
    for (const a of all(el, 'a[href*="/status/"][href$="/analytics"]')) {
      const m = STATUS_RE.exec(linkPath(a));
      if (m && !inQuote(a, el)) return m[1]!;
    }
    // A focused tweet on its own page: the id is in the URL.
    if (el.getAttribute('tabindex') === '-1') {
      const m = STATUS_RE.exec(location.pathname);
      if (m) return m[1]!;
    }
    return null;
  },
  mount(el) {
    const groups = all(el, 'div[role="group"]').filter((g) => !inQuote(g, el) && g.closest('article') === el);
    const bar = groups[groups.length - 1];
    if (bar) {
      const slot = document.createElement('div');
      slot.style.cssText = 'display:flex;align-items:center;justify-content:flex-start;flex:0 0 auto';
      bar.appendChild(slot);
      return { parent: slot };
    }
    const caret = el.querySelector('[data-testid="caret"]');
    return caret?.parentElement ? { parent: caret.parentElement, before: caret } : null;
  },
};
