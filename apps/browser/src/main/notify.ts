import { ctx } from './context';

/** Pushes an event to every open internal page (settings, history, bookmarks, downloads). */
export function notifyInternalPages(event: { type: string; [k: string]: unknown }): void {
  for (const tab of ctx.windows.allTabs()) {
    if (!tab.isDestroyed && tab.url.startsWith('noai://')) tab.wc.send('noai:event', event);
  }
}

export function bookmarksChanged(): void {
  ctx.windows.broadcast();
  notifyInternalPages({ type: 'bookmarks' });
}
