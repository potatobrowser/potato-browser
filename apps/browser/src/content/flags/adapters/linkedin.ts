import type { FlagAdapter } from '../types';
import { all, linkPath, outermost, uniq } from './util';

const FEED_ITEM = '[data-testid="mainFeed"] [role="listitem"]';
const LEGACY = 'div.feed-shared-update-v2[data-urn^="urn:li:activity:"], div[data-urn^="urn:li:activity:"]';
const GUEST = 'article[data-activity-urn]';
const COMMENT = '[componentkey^="replaceableComment_urn:li:comment:("], article.comments-comment-entity[data-id^="urn:li:comment:"], [data-semaphore-content-urn^="urn:li:comment:"]';
const ACTION_ICONS = 'svg#thumbs-up-outline-small, svg#comment-small, svg#repost-small, svg#send-privately-small, button[data-view-name="feed-react-button"], button[data-view-name="feed-comment-button"]';

/** Reads the zigzag varint post id from a base64 protobuf commentTools key. */
export function decodeCommentToolsKey(key: string): string | null {
  const b64 = key.split('-')[0]!.replace(/-/g, '+').replace(/_/g, '/');
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length < 4 || bytes[2] !== 0x08) return null;
  const kind = bytes[0] === 0x0a ? 'activity' : bytes[0] === 0x12 ? 'ugcPost' : null;
  if (!kind) return null;
  let value = 0n;
  let shift = 0n;
  for (let i = 3; i < bytes.length; i++) {
    const b = bytes[i]!;
    value |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if ((b & 0x80) === 0) break;
  }
  const decoded = (value >> 1n) ^ -(value & 1n);
  return decoded > 0n ? `${kind}:${decoded.toString()}` : null;
}

function idsOf(el: Element): string[] {
  const ids: string[] = [];
  const urn = el.getAttribute('data-urn') ?? el.getAttribute('data-activity-urn');
  const m0 = urn && /urn:li:(activity|ugcPost|share):(\d+)/.exec(urn);
  if (m0) ids.push(`${m0[1]}:${m0[2]}`);
  const attributed = el.getAttribute('data-attributed-urn');
  const m1 = attributed && /urn:li:(activity|ugcPost|share):(\d+)/.exec(attributed);
  if (m1) ids.push(`${m1[1]}:${m1[2]}`);
  for (const c of all(el, '[id^="translatable-commentary-"]')) {
    const m = /userGeneratedContentId=(\d+)/.exec(c.id);
    if (m) ids.push(`ugcPost:${m[1]}`);
    const a = /activityId=(\d+)|ActivityUrn\(activityId=(\d+)/.exec(c.id);
    if (a) ids.push(`activity:${a[1] ?? a[2]}`);
  }
  for (const c of all(el, '[componentkey*="replaceableCommentTools"]')) {
    const d = decodeCommentToolsKey(c.getAttribute('componentkey') ?? '');
    if (d) ids.push(d);
  }
  for (const a of all(el, 'a[href*="/feed/update/urn:li:"], a[href*="/posts/"]')) {
    const p = linkPath(a);
    const m = /\/feed\/update\/urn:li:(activity|ugcPost|share):(\d+)/.exec(p) ?? /\/posts\/[^/]*-(activity|ugcPost|share)-(\d+)-/.exec(p);
    if (m) ids.push(`${m[1]}:${m[2]}`);
  }
  // Activity ids first: they are what most surfaces show.
  return uniq(ids).sort((a, b) => Number(b.startsWith('activity:')) - Number(a.startsWith('activity:')));
}

export const linkedin: FlagAdapter = {
  platform: 'linkedin',
  hosts: ['linkedin.com', '*.linkedin.com'],
  items(doc) {
    const posts = outermost(all(doc, FEED_ITEM)).filter((li) => li.querySelector('[data-testid="expandable-text-box"]') || li.querySelector(ACTION_ICONS));
    const comments = outermost(all(doc, COMMENT));
    return [...posts, ...all(doc, LEGACY), ...all(doc, GUEST), ...comments];
  },
  id(el) {
    const key = el.getAttribute('componentkey') ?? el.getAttribute('data-id') ?? el.getAttribute('data-semaphore-content-urn') ?? '';
    const c = /urn:li:comment:\(urn:li:(?:activity|ugcPost):\d+,(\d+)\)/.exec(key);
    if (c) return `c:${c[1]}`;
    const ids = idsOf(el);
    if (ids.length) return ids;
    const m = /\/feed\/update\/urn:li:(activity|ugcPost|share):(\d+)/.exec(location.pathname);
    return m && el.matches(FEED_ITEM) ? `${m[1]}:${m[2]}` : null;
  },
  mount(el) {
    const icon = all(el, ACTION_ICONS).find((i) => {
      const owner = i.closest(`${FEED_ITEM}, ${LEGACY}, ${GUEST}, ${COMMENT}`);
      return owner === el;
    });
    const bar = icon?.closest('button')?.parentElement?.parentElement;
    if (bar && el.contains(bar)) return { parent: bar };
    const legacy = el.querySelector('.feed-shared-social-action-bar');
    return legacy ? { parent: legacy } : null;
  },
};
