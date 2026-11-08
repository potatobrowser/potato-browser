import { ctx } from './context';
import { isTest } from './paths';
import type { Tab } from './tab';

/** Everything that decides whether a background tab may be unloaded. */
export interface SleepInfo {
  /** A page is loaded and not already on its way to sleep. */
  loaded: boolean;
  /** In front in its window. */
  active: boolean;
  /** Last time it was in front (or opened). */
  lastActive: number;
  /** Its address loads again as it was (not data:, blob: or a scripted about:blank). */
  reloadable: boolean;
  loading: boolean;
  audible: boolean;
  lastAudible: number;
  /** The page asked for the camera, microphone or screen since it loaded. */
  capturing: boolean;
  permissionPrompt: boolean;
  fullscreen: boolean;
  devTools: boolean;
  /** The autofill dropdown is up, or a sign-in waits to be saved. */
  passwords: boolean;
  /** The site may show notifications: a web app that has to keep running. */
  notifications: boolean;
  /** Linked to another loaded tab through window.open, as sign-in popups are. */
  opener: boolean;
  /** When the page last refused to unload (unsaved changes): it gets another full period before the next try. */
  refusedSleepAt: number;
}

/** Background tabs that played sound this recently stay awake (minutes). */
export const AUDIBLE_GRACE = 5;

/** Why the tab has to stay awake, or null when it may sleep. */
export function sleepBlocker(t: SleepInfo, now: number, afterMs: number, audibleMs = AUDIBLE_GRACE * 60_000): string | null {
  if (!t.loaded) return 'not loaded';
  if (t.active) return 'active';
  if (now - t.lastActive < afterMs) return 'recently used';
  if (!t.reloadable) return 'not reloadable';
  if (t.loading) return 'loading';
  if (t.audible || now - t.lastAudible < audibleMs) return 'audio';
  if (t.capturing) return 'capturing';
  if (t.permissionPrompt) return 'permission prompt';
  if (t.fullscreen) return 'fullscreen';
  if (t.devTools) return 'devtools';
  if (t.passwords) return 'passwords';
  if (t.notifications) return 'notifications';
  if (t.opener) return 'opener';
  if (now - t.refusedSleepAt < afterMs) return 'unsaved changes';
  return null;
}

/** Length of a minute for tab sleeping; e2e tests shorten it with POTATO_TEST_MINUTE_MS. */
export function minuteMs(): number {
  const test = Number(process.env.POTATO_TEST_MINUTE_MS);
  return isTest() && test > 0 ? test : 60_000;
}

function openerLinked(tab: Tab): boolean {
  if (tab.wc?.opener && tab.openerTabId !== null && ctx.windows.findTab(tab.openerTabId)?.wc) return true;
  return ctx.windows.allTabs().some((t) => t.openerTabId === tab.id && !!t.wc?.opener);
}

export function sleepInfo(tab: Tab): SleepInfo {
  const wc = tab.wc;
  const win = tab.win;
  return {
    loaded: !!wc && !tab.sleepPending,
    active: win.activeTab === tab,
    lastActive: tab.lastActive,
    reloadable: /^(https?|file|potato):/i.test(tab.url),
    loading: !!wc?.isLoading(),
    audible: !!wc?.isCurrentlyAudible(),
    lastAudible: tab.lastAudible,
    capturing: tab.capturing,
    permissionPrompt: ctx.permissions.hasPrompt(tab.id),
    fullscreen: win.isHtmlFullscreen(tab),
    devTools: !!wc?.isDevToolsOpened(),
    passwords: ctx.passwords.busyWith(tab),
    notifications: ctx.permissions.isAllowed(tab.url, 'notifications', win.isPrivate),
    opener: openerLinked(tab),
    refusedSleepAt: tab.refusedSleepAt,
  };
}

/** Puts background tabs left alone for the "Put unused tabs to sleep" time to sleep. */
export class TabSleeper {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    this.timer ??= setInterval(() => this.tick(), Math.min(60_000, minuteMs()));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = Date.now()): void {
    const minutes = ctx.settings.get().tabs.sleepAfter;
    if (!minutes || ctx.windows.quitting) return;
    const minute = minuteMs();
    for (const tab of ctx.windows.allTabs()) {
      // Cheap checks first: most tabs are in front, asleep or recently used.
      if (!tab.wc || tab.win.activeTab === tab || now - tab.lastActive < minutes * minute) continue;
      if (sleepBlocker(sleepInfo(tab), now, minutes * minute, AUDIBLE_GRACE * minute) === null) tab.sleep();
    }
  }
}
