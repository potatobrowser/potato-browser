import type { FlagAdapter } from '../types';
import { all, linkPath } from './util';

const POST = 'shreddit-post[id^="t3_"]';
const COMMENT = 'shreddit-comment[thingid^="t1_"]';
const SEARCH = 'search-telemetry-tracker[data-thingid^="t3_"]';
const OLD_THING = '.thing[data-fullname^="t3_"]:not(.promoted), .thing[data-fullname^="t1_"]';

export const reddit: FlagAdapter = {
  platform: 'reddit',
  hosts: ['*.reddit.com'],
  items(doc) {
    const items = all(doc, `${POST}, ${COMMENT}, ${OLD_THING}`);
    // Search results render posts without <shreddit-post>.
    for (const t of all(doc, SEARCH)) if (!t.querySelector(POST)) items.push(t);
    // A crosspost nests a post inside another one; flag the outer one only.
    return items.filter((el) => !(el.matches(POST) && el.parentElement?.closest(POST)));
  },
  id(el) {
    if (el.matches(POST)) {
      if (/^t3_[a-z0-9]+$/i.test(el.id)) return el.id;
      const m = /\/comments\/([a-z0-9]+)/i.exec(el.getAttribute('permalink') ?? '');
      return m ? `t3_${m[1]}` : null;
    }
    if (el.matches(COMMENT)) return el.getAttribute('thingid');
    if (el.matches(SEARCH)) return el.getAttribute('data-thingid');
    const full = el.getAttribute('data-fullname');
    if (full) return full;
    const m = /\/comments\/([a-z0-9]+)/i.exec(linkPath(el.querySelector('a[href*="/comments/"]')));
    return m ? `t3_${m[1]}` : null;
  },
  mount(el) {
    if (el.matches(POST)) {
      const credit = el.querySelector(':scope > [slot="credit-bar"]') ?? el.querySelector('[slot="credit-bar"]');
      if (credit) return { parent: credit.firstElementChild?.id?.includes('credit-bar') ? credit.firstElementChild : credit };
      const title = el.querySelector(':scope > [slot="title"]');
      if (title?.parentElement) return { parent: title.parentElement, before: title.nextSibling };
      return { parent: el };
    }
    if (el.matches(COMMENT)) {
      const meta = Array.from(el.querySelectorAll('[slot="commentMeta"]')).find((m) => m.closest(COMMENT) === el);
      if (meta) return { parent: meta };
      const row = Array.from(el.querySelectorAll('[slot="actionRow"]')).find((m) => m.closest(COMMENT) === el);
      return row ? { parent: row } : null;
    }
    if (el.matches(SEARCH)) return { parent: el };
    const buttons = el.querySelector(':scope > .entry ul.flat-list.buttons') ?? el.querySelector('.entry ul.flat-list.buttons');
    if (buttons) {
      const li = document.createElement('li');
      buttons.appendChild(li);
      return { parent: li };
    }
    return null;
  },
  hideTarget(el) {
    if (el.matches(COMMENT)) {
      // Hide the comment text but keep the replies people wrote under it.
      const body = Array.from(el.querySelectorAll('[slot="comment"]')).find((b) => b.closest(COMMENT) === el);
      return body ?? el;
    }
    return el;
  },
};
