import { net } from 'electron';
import { REPORT_FEATURES, REPORT_PROBLEMS, reportUrl, type SiteReport } from '@potato/shared';
import { apiBase, APP_VERSION } from './paths';

/** "Report this site": the page address and the user's choice, with the app version, nothing else. */
export async function sendReport(pageUrl: string, feature: unknown, problem: unknown): Promise<boolean> {
  const url = reportUrl(pageUrl);
  if (!url || !(REPORT_FEATURES as readonly unknown[]).includes(feature) || !(REPORT_PROBLEMS as readonly unknown[]).includes(problem)) return false;
  const body: SiteReport = { url, feature: feature as SiteReport['feature'], problem: problem as SiteReport['problem'], app: 'mac', version: APP_VERSION };
  try {
    const res = await net.fetch(`${apiBase()}/api/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
