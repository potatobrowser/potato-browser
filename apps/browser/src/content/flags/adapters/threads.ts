import type { FlagAdapter } from '../types';
import { all, linkPath } from './util';

const PRESSABLE = 'div[data-pressable-container]';
const POST_RE = /^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)/;
const REPLY_PATHS = ['path[d^="M12 3C7.02944 3 3 7.02944 3 12"]', 'path[d^="M12 3a9 9 0 0 0 0 18"]'];

export const threads: FlagAdapter = {
  platform: 'threads',
  hosts: ['threads.com', 'threads.net'],
  items(doc) {
    // A pressable nested inside another one is a quoted/reposted embed, not a post of its own.
    return all(doc, PRESSABLE).filter((p) => !p.parentElement?.closest(PRESSABLE));
  },
  id(el) {
    for (const time of all(el, 'a[href*="/post/"] time')) {
      const a = time.closest('a');
      if (a?.closest(PRESSABLE) !== el) continue;
      const m = POST_RE.exec(linkPath(a));
      if (m) return m[2]!;
    }
    return null;
  },
  mount(el) {
    const reply = all(el, REPLY_PATHS.join(', ')).find((p) => p.closest(PRESSABLE) === el);
    const button = reply?.closest('[role="button"]');
    if (button?.parentElement) return { parent: button.parentElement };
    const like = all(el, 'svg[aria-label]').find((s) => s.closest(PRESSABLE) === el && s.closest('[role="button"]'));
    const row = like?.closest('[role="button"]')?.parentElement;
    return row ? { parent: row } : null;
  },
};
