import type { FlagAdapter } from '../types';
import { all, linkUrl } from './util';

// m.youtube.com (phones) uses ytm-* elements for the same items.
const MOBILE_LOCKUP = 'ytm-video-with-context-renderer, ytm-compact-video-renderer';
const LOCKUP = `ytd-rich-item-renderer, ytd-watch-next-secondary-results-renderer yt-lockup-view-model, ytd-video-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer, ${MOBILE_LOCKUP}`;
const WATCH = 'ytd-watch-metadata, ytm-slim-video-metadata-section-renderer';
const SHORT = 'ytd-reel-video-renderer';
const COMMENT = 'ytd-comment-view-model';
const ADS = 'ytd-ad-slot-renderer, feed-ad-metadata-view-model, ytd-in-feed-ad-layout-renderer, ytm-promoted-sparkles-web-renderer, ytm-promoted-video-renderer, ad-slot-renderer';
const VIDEO_ID = /^[\w-]{11}$/;

function videoIdFromLinks(root: Element): string | null {
  const cls = root.querySelector('[class*="content-id-"]')?.className.toString().match(/content-id-([\w-]{11})/);
  if (cls) return cls[1]!;
  for (const a of all(root, 'a[href*="/watch?v="], a[href^="/shorts/"], a[href*="/shorts/"]')) {
    const u = linkUrl(a);
    if (!u) continue;
    const v = u.searchParams.get('v');
    if (v && VIDEO_ID.test(v)) return v;
    const m = /^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(u.pathname);
    if (m) return m[1]!;
  }
  return null;
}

export const youtube: FlagAdapter = {
  platform: 'youtube',
  hosts: ['youtube.com', 'm.youtube.com'],
  items(doc) {
    const items = all(doc, `${LOCKUP}, ${SHORT}, ${COMMENT}`).filter((el) => !el.querySelector(ADS) && !el.closest(ADS));
    const watch = doc.querySelector(WATCH);
    if (watch && /^\/watch/.test(location.pathname)) items.push(watch);
    // A lockup inside a rich item is the same video; keep the outer one.
    return items.filter((el) => !(el.matches('yt-lockup-view-model') && el.closest('ytd-rich-item-renderer')));
  },
  id(el) {
    if (el.matches(COMMENT)) {
      const u = linkUrl(el.querySelector('#published-time-text a, a[href*="lc="]'));
      const lc = u?.searchParams.get('lc');
      return lc ? `c:${lc}` : null;
    }
    if (el.matches(WATCH)) {
      const flexy = document.querySelector('ytd-watch-flexy[video-id], ytd-watch-grid[video-id]');
      const id = flexy?.getAttribute('video-id') ?? new URL(location.href).searchParams.get('v');
      return id && VIDEO_ID.test(id) ? id : null;
    }
    if (el.matches(SHORT)) {
      const id = el.getAttribute('video-id');
      if (id && VIDEO_ID.test(id)) return id;
    }
    return videoIdFromLinks(el);
  },
  mount(el) {
    if (el.matches(COMMENT)) {
      const header = el.querySelector('#header-author');
      return header ? { parent: header } : null;
    }
    if (el.matches(WATCH)) {
      const buttons = el.querySelector('#top-level-buttons-computed') ?? el.querySelector('#actions') ?? el.querySelector('ytm-slim-video-action-bar-renderer');
      return buttons ? { parent: buttons } : null;
    }
    if (el.matches(SHORT)) {
      const bar = el.querySelector('reel-action-bar-view-model, #actions');
      return bar ? { parent: bar, before: bar.firstChild } : null;
    }
    if (el.matches(MOBILE_LOCKUP)) {
      const byline = el.querySelector('ytm-badge-and-byline-renderer');
      return byline ? { parent: byline } : null;
    }
    const meta = el.querySelector('#metadata-line') ?? [...all(el, '[class*="MetadataRow"], .yt-content-metadata-view-model__metadata-row')].pop();
    return meta ? { parent: meta } : null;
  },
  hideTarget(el) {
    if (el.matches(COMMENT)) return el.querySelector('#content-text')?.closest('#content, #expander') ?? el;
    return el;
  },
};
