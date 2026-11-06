import { BaseWindow, desktopCapturer, dialog, systemPreferences, type Session, type WebContents } from 'electron';
import type { PermissionPrompt } from '../shared/types';
import { ctx } from './context';
import type { BrowserWindowController } from './window';

type Decision = 'allow' | 'block';

/** Granted silently, like Chrome: no prompt and nothing to remember. */
const ALWAYS_ALLOW = new Set([
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-sanitized-write',
  'storage-access',
  'top-level-storage-access',
  'speaker-selection',
  'display-capture',
]);

const PROMPTABLE = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'idle-detection', 'window-management', 'openExternal']);

interface Pending {
  prompt: PermissionPrompt;
  win: BrowserWindowController;
  key: string;
  isPrivate: boolean;
  resolve: (allow: boolean) => void;
}

function describe(permission: string, details: Record<string, any>): { kind: string; text: string } {
  if (permission === 'media') {
    const types: string[] = details.mediaTypes ?? [];
    const cam = types.includes('video');
    const mic = types.includes('audio');
    const kind = cam && mic ? 'camera+microphone' : cam ? 'camera' : mic ? 'microphone' : 'media';
    return { kind, text: cam && mic ? 'use your camera and microphone' : cam ? 'use your camera' : mic ? 'use your microphone' : 'use media devices' };
  }
  if (permission === 'openExternal') {
    let scheme = 'an external app';
    try {
      scheme = new URL(details.externalURL).protocol.replace(':', '') + ' links';
    } catch {}
    return { kind: 'openExternal', text: `open ${scheme} in another app` };
  }
  const text: Record<string, string> = {
    geolocation: 'know your location',
    notifications: 'show notifications',
    midi: 'use your MIDI devices',
    midiSysex: 'use your MIDI devices',
    'clipboard-read': 'see text and images copied to the clipboard',
    'idle-detection': 'know when you are actively using this device',
    'window-management': 'manage windows on all your displays',
  };
  return { kind: permission, text: text[permission] ?? `use ${permission}` };
}

function originOf(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return '';
  }
}

export class PermissionManager {
  private seq = 1;
  private pending: Pending[] = [];
  /** Decisions made in private windows live only in memory. */
  private privateDecisions = new Map<string, Decision>();

  install(ses: Session, isPrivate: boolean): void {
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (ALWAYS_ALLOW.has(permission)) return callback(true);
      if (!PROMPTABLE.has(permission)) return callback(false);
      const origin = originOf((details as any).requestingUrl ?? wc?.getURL());
      if (!origin || origin.startsWith('noai:')) return callback(permission !== 'openExternal' && origin.startsWith('noai:'));
      const { kind, text } = describe(permission, details as Record<string, any>);
      const key = `perm:${kind}`;
      const stored = this.decision(origin, key, isPrivate);
      const finish = (allow: boolean) => {
        if (allow && permission === 'media') void this.ensureSystemMediaAccess((details as any).mediaTypes ?? []).then(callback);
        else callback(allow);
      };
      if (stored) return finish(stored === 'allow');
      const tab = ctx.windows.tabFor(wc);
      if (!tab) return callback(false);
      const prompt: PermissionPrompt = {
        id: this.seq++,
        tabId: tab.id,
        origin,
        description: text,
        kind,
      };
      this.pending.push({ prompt, win: tab.win, key, isPrivate, resolve: finish });
      tab.win.update();
    });

    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      if (ALWAYS_ALLOW.has(permission)) return true;
      const origin = originOf(requestingOrigin);
      if (origin.startsWith('noai:')) return true;
      if (permission === 'media') {
        // A combined grant covers both devices; single grants cover their own device.
        const single = details.mediaType === 'video' ? 'perm:camera' : details.mediaType === 'audio' ? 'perm:microphone' : null;
        return [single, 'perm:camera+microphone'].some((k) => k && this.decision(origin, k, isPrivate) === 'allow');
      }
      return this.decision(origin, `perm:${permission}`, isPrivate) === 'allow';
    });

    ses.setDisplayMediaRequestHandler(
      async (request, callback) => {
        // Only reached when the macOS system picker is unavailable (macOS 13 and 14). The picker
        // is the user's consent, so ask explicitly before sharing anything.
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (!sources[0]) return callback({});
        let site = request.securityOrigin;
        try {
          site = new URL(request.securityOrigin).host || site;
        } catch {}
        const owner = BaseWindow.getFocusedWindow();
        const opts = {
          type: 'question' as const,
          buttons: ['Share Entire Screen', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: `Share your entire screen with ${site}?`,
          detail: 'Everything on your screen, including other apps and notifications, is shared until you stop sharing.',
        };
        const { response } = owner ? await dialog.showMessageBox(owner, opts) : await dialog.showMessageBox(opts);
        callback(response === 0 ? { video: sources[0] } : {});
      },
      { useSystemPicker: true },
    );
  }

  private decision(origin: string, key: string, isPrivate: boolean): Decision | null {
    const v = ctx.db.getSiteSetting(origin, key);
    if (isPrivate) {
      // Private windows inherit blocks, never grants.
      return this.privateDecisions.get(`${origin}|${key}`) ?? (v === 'block' ? 'block' : null);
    }
    return v === 'allow' || v === 'block' ? v : null;
  }

  private async ensureSystemMediaAccess(types: string[]): Promise<boolean> {
    if (process.platform !== 'darwin' || process.env.NOAI_TEST === '1') return true;
    for (const t of types) {
      const media = t === 'video' ? 'camera' : t === 'audio' ? 'microphone' : null;
      if (!media) continue;
      const status = systemPreferences.getMediaAccessStatus(media);
      if (status === 'granted') continue;
      if (!(await systemPreferences.askForMediaAccess(media))) return false;
    }
    return true;
  }

  promptsFor(win: BrowserWindowController): PermissionPrompt[] {
    const active = win.activeTab?.id;
    return this.pending.filter((p) => p.win === win && p.prompt.tabId === active).map((p) => p.prompt);
  }

  respond(id: number, allow: boolean, remember = true): void {
    const i = this.pending.findIndex((p) => p.prompt.id === id);
    if (i < 0) return;
    const [p] = this.pending.splice(i, 1) as [Pending];
    const decision: Decision = allow ? 'allow' : 'block';
    if (remember) {
      if (p.isPrivate) this.privateDecisions.set(`${p.prompt.origin}|${p.key}`, decision);
      else ctx.db.setSiteSetting(p.prompt.origin, p.key, decision);
    }
    p.resolve(allow);
    p.win.update();
  }

  /** A navigation or closed tab dismisses its prompts (treated as "not now"). */
  dropTab(tabId: number): void {
    for (const p of this.pending.filter((x) => x.prompt.tabId === tabId)) this.respond(p.prompt.id, false, false);
  }

  dropWindow(win: BrowserWindowController): void {
    for (const p of this.pending.filter((x) => x.win === win)) {
      this.pending = this.pending.filter((x) => x !== p);
      p.resolve(false);
    }
    if (!ctx.windows.windows.some((w) => w.isPrivate)) this.privateDecisions.clear();
  }

  /** Site permissions for the settings page. */
  list(): { origin: string; kind: string; decision: string }[] {
    return ctx.db
      .siteSettingsByKey('perm:camera+microphone')
      .map((r) => ({ origin: r.site, kind: 'camera+microphone', decision: r.value }))
      .concat(
        ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'openExternal'].flatMap((k) =>
          ctx.db.siteSettingsByKey(`perm:${k}`).map((r) => ({ origin: r.site, kind: k, decision: r.value })),
        ),
      );
  }

  reset(origin: string, kind: string): void {
    ctx.db.setSiteSetting(origin, `perm:${kind}`, null);
  }

  ownerOf(wc: WebContents): boolean {
    return !!ctx.windows.tabFor(wc);
  }
}
