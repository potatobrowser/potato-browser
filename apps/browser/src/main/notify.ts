import { ctx } from './context';

/** Pushes an event to every open internal page (settings, history, bookmarks, downloads). */
export function notifyInternalPages(event: { type: string; [k: string]: unknown }): void {
  for (const tab of ctx.windows.allTabs()) {
    if (tab.url.startsWith('potato://')) tab.wc?.send('potato:event', event);
  }
}

export function bookmarksChanged(): void {
  ctx.windows.broadcast();
  notifyInternalPages({ type: 'bookmarks' });
}
