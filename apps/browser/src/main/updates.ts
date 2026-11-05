import { net } from 'electron';
import { compareVersions, type ReleaseInfo } from '@noai/shared';
import { ctx } from './context';
import { apiBase, APP_VERSION, isTest } from './paths';

const DAY = 24 * 60 * 60 * 1000;

/** Checks the landing site once a day for a newer release; never downloads anything itself. */
export class UpdateChecker {
  private latest: ReleaseInfo | null = null;
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (isTest()) return;
    setTimeout(() => void this.check(), 15_000);
    this.timer = setInterval(() => void this.check(), DAY);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<ReleaseInfo | null> {
    try {
      const res = await net.fetch(`${apiBase()}/api/v1/releases/latest`, { cache: 'no-store', credentials: 'omit' });
      if (!res.ok) return null;
      const info = (await res.json()) as ReleaseInfo;
      if (typeof info.version !== 'string') return null;
      this.latest = info;
      ctx.windows.broadcast();
      return info;
    } catch {
      return null;
    }
  }

  /** Newer version string, or null when up to date. */
  available(): string | null {
    return this.latest && compareVersions(this.latest.version, APP_VERSION) > 0 ? this.latest.version : null;
  }

  info(): ReleaseInfo | null {
    return this.latest;
  }
}
