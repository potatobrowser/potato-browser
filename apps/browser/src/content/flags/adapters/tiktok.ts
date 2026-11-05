import type { FlagAdapter } from '../types';
import { all, linkPath } from './util';

const ITEMS = [
  'article[data-e2e="recommend-list-item-container"]',
  '[data-e2e="user-post-item"]',
  '[data-e2e="search-card-video"]',
  '[data-e2e="browse-video"]',
  'div[class*="DivVideoDetailContainer"]',
].join(', ');
const VIDEO_RE = /^\/@[^/]+\/(?:video|photo)\/(\d{15,21})/;

export const tiktok: FlagAdapter = {
  platform: 'tiktok',
  hosts: ['tiktok.com'],
  items(doc) {
    return all(doc, ITEMS).filter((el) => !el.parentElement?.closest(ITEMS));
  },
  id(el) {
    const player = el.querySelector('[id^="xgwrapper-"]');
    const m = player && /(\d{15,21})$/.exec(player.id);
    if (m) return m[1]!;
    for (const a of all(el, 'a[href*="/video/"], a[href*="/photo/"]')) {
      const v = VIDEO_RE.exec(linkPath(a));
      if (v) return v[1]!;
    }
    const page = VIDEO_RE.exec(location.pathname);
    return page && el.matches('[data-e2e="browse-video"], div[class*="DivVideoDetailContainer"]') ? page[1]! : null;
  },
  mount(el) {
    const bar = all(el, 'section[class*="SectionActionBarContainer"]').find((s) => s.querySelector('[data-e2e="like-icon"], [data-e2e="share-icon"], [data-e2e="favorite-icon"]'));
    if (bar) {
      const music = bar.querySelector('a[data-e2e="video-music"]');
      return { parent: bar, before: music };
    }
    // Grid tiles: overlay in the tile itself.
    return { parent: el };
  },
};
