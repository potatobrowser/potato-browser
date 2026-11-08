import { app, dialog, autoUpdater as squirrel, session } from 'electron';
import { autoUpdater, type CancellationToken, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { UpdateStatus } from '../shared/types';
import { ctx } from './context';
import { refreshMenuChecks } from './menus';
import { notifyInternalPages } from './notify';
import { apiBase, isTest } from './paths';

declare const __AUTO_UPDATE__: boolean;

const FIRST_CHECK = 10_000;
// Browsers stay open for weeks; a security fix should not wait for a relaunch to be noticed.
const CHECK_EVERY = 4 * 60 * 60 * 1000;
const RETRY_AFTER = 15 * 60 * 1000;
// electron-updater's request timeout never fires with Electron's net module.
const STALLED_AFTER = 5 * 60 * 1000;
// Updates refused this often in one run (say, a copy signed by someone else) stop downloading until relaunch.
const MAX_FAILURES = 2;

function manualReason(): UpdateStatus['manual'] {
  if (typeof __AUTO_UPDATE__ !== 'boolean' || !__AUTO_UPDATE__ || !app.isPackaged) return 'build';
  // Squirrel.Mac cannot replace an app on the DMG or one macOS translocated from Downloads.
  if (!app.isInApplicationsFolder()) return 'location';
  return null;
}

/**
 * Asks potatobrowser.com for a newer release every few hours. Developer ID builds in Applications
 * download it in the background and install it on the next restart or quit (electron-updater
 * checks the zip's hash, Squirrel.Mac that it is signed like the running app); other copies only
 * point to the download page.
 */
export class UpdateService {
  private status: UpdateStatus = { phase: 'idle', version: null, percent: 0, manual: manualReason(), error: null };
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private wired = false;
  private failures = 0;
  /** electron-updater has the zip; Squirrel is checking and staging it. */
  private downloaded = false;
  private restarting = false;
  private lastProgress = 0;

  start(): void {
    if (isTest() || !app.isPackaged) return;
    setTimeout(() => void this.check(), FIRST_CHECK);
    this.timer = setInterval(() => void this.check(), CHECK_EVERY);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
  }

  state(): UpdateStatus {
    return this.status;
  }

  set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    refreshMenuChecks();
    ctx.windows?.broadcast();
    notifyInternalPages({ type: 'update' });
  }

  async check(): Promise<UpdateStatus> {
    // A download in flight or waiting for the restart is not interrupted by another check.
    if (isTest() || this.status.phase === 'downloading' || this.status.phase === 'ready') return this.status;
    this.wire();
    try {
      const r = await autoUpdater.checkForUpdates();
      if (r?.downloadPromise && r.cancellationToken) void this.watch(r.downloadPromise, r.cancellationToken);
    } catch {
      // Reported through the 'error' event.
    }
    return this.status;
  }

  /** Restarts into the downloaded update; the windows and tabs open now come back. */
  async install(): Promise<void> {
    if (this.status.phase !== 'ready') return;
    const active = ctx.downloads.summary(false).active + ctx.downloads.summary(true).active;
    if (active > 0) {
      const win = ctx.windows.focused();
      const opts = {
        type: 'question' as const,
        message: 'Restart to update now?',
        detail: `${active === 1 ? '1 download is' : `${active} downloads are`} not finished and will stop.`,
        buttons: ['Restart', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      };
      const { response } = win ? await dialog.showMessageBox(win.base, opts) : await dialog.showMessageBox(opts);
      if (response !== 0) return;
    }
    ctx.windows.restoreOnNextLaunch();
    this.restarting = true;
    this.restart();
  }

  /** Squirrel quits, swaps the app and opens it again; e2e tests stand in a plain quit. */
  restart = (): void => autoUpdater.quitAndInstall();

  /** Cancels a download that stops making progress, so a stalled connection cannot block updates for the run. */
  private async watch(download: Promise<unknown>, token: CancellationToken): Promise<void> {
    this.lastProgress = Date.now();
    const stall = setInterval(() => {
      if (Date.now() - this.lastProgress > STALLED_AFTER) token.cancel();
    }, 60_000);
    try {
      await download;
    } catch {
      // Cancelling emits no 'error' event.
      if (token.cancelled && this.status.phase === 'downloading') this.failed('The download stalled.');
    } finally {
      clearInterval(stall);
    }
  }

  private retrySoon(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.check(), RETRY_AFTER);
  }

  /** A download that broke off, or an update Squirrel refused or could not restart into. */
  private failed(error: string, refused = false): void {
    if (refused && ++this.failures >= MAX_FAILURES) {
      autoUpdater.autoDownload = false;
      return this.set({ phase: 'available', percent: 0, error });
    }
    this.set({ phase: 'error', percent: 0, error });
    this.retrySoon();
  }

  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    // electron-updater sends a random per-install id for staged rollouts, which we do not use.
    session.fromPartition('electron-updater', { cache: false }).webRequest.onBeforeSendHeaders((details, cb) => {
      const requestHeaders = Object.fromEntries(Object.entries(details.requestHeaders).filter(([k]) => k.toLowerCase() !== 'x-user-staging-id'));
      cb({ requestHeaders });
    });
    autoUpdater.logger = null;
    autoUpdater.autoDownload = this.status.manual === null;
    autoUpdater.autoInstallOnAppQuit = true;
    // Lets a dev build (not packaged) check too; it never downloads.
    autoUpdater.forceDevUpdateConfig = !app.isPackaged;
    // One feed per architecture: electron-updater's own guess reads "ARM" anywhere in `uname -a`,
    // host name included. Intel builds under Rosetta move to the Apple silicon build.
    const arch = process.arch === 'arm64' || app.runningUnderARM64Translation ? 'arm64' : 'x64';
    // GitHub's download servers answer one byte range per request, not several.
    autoUpdater.setFeedURL({ provider: 'generic', url: `${apiBase()}/api/v1/update/mac/${arch}`, useMultipleRangeRequest: false });

    autoUpdater.on('checking-for-update', () => {
      if (this.status.phase !== 'available') this.set({ phase: 'checking', error: null });
    });
    autoUpdater.on('update-not-available', () => this.set({ phase: 'none', version: null, error: null }));
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.downloaded = false;
      this.set(autoUpdater.autoDownload ? { phase: 'downloading', version: info.version, percent: 0 } : { phase: 'available', version: info.version });
    });
    autoUpdater.on('download-progress', (p: ProgressInfo) => {
      this.lastProgress = Date.now();
      const percent = Math.min(99, Math.floor(p.percent));
      if (this.status.phase === 'downloading' && percent !== this.status.percent) this.set({ percent });
    });
    autoUpdater.on('update-downloaded', () => {
      this.downloaded = true;
    });
    // electron-updater's update-downloaded comes before Squirrel has checked the signature
    // and staged the app; only Squirrel's means a restart installs it.
    squirrel.on('update-downloaded', () => {
      this.failures = 0;
      this.set({ phase: 'ready', percent: 100, error: null });
    });
    autoUpdater.on('error', (err: Error) => {
      const error = String(err?.message ?? err).split('\n')[0]!.slice(0, 300);
      if (this.restarting) {
        // The windows closed but the app did not quit: carry on with them reopened.
        this.restarting = false;
        ctx.windows.resumeAfterFailedQuit();
        ctx.adblock.start();
        return this.failed(error, true);
      }
      const { phase } = this.status;
      // A staged update still installs, and a known newer version stays shown.
      if (phase === 'ready' || phase === 'available') return this.set({ error });
      this.failed(error, phase === 'downloading' && this.downloaded);
    });
  }
}
