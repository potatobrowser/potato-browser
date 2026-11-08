import { app, crashReporter } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { apiBase, isTest } from './paths';

let started = false;

/**
 * Opt-in crash reports (Settings > Privacy, or the welcome page): Crashpad writes a minidump when a
 * process crashes and uploads it to potatobrowser.com, which keeps it 90 days. Off by default; while
 * off, Crashpad never starts, so nothing is even written to disk.
 */
export function applyCrashReports(on: boolean): void {
  if (on && !started) {
    crashReporter.start({
      submitURL: `${apiBase()}/api/v1/crashes`,
      productName: 'Potato Browser',
      uploadToServer: true,
      compress: true,
      // At most one upload an hour, so a crash loop cannot flood the service.
      rateLimit: !isTest(),
      // Needed to read the dump: arm64 and x64 builds have different symbols.
      globalExtra: { arch: process.arch },
    });
    started = true;
  } else if (started) {
    crashReporter.setUploadToServer(on);
  }
  if (!on) forgetPending();
}

/** Turning reports off also drops the ones not sent yet. */
function forgetPending(): void {
  let dir = '';
  try {
    dir = app.getPath('crashDumps');
  } catch {
    return;
  }
  for (const sub of ['new', 'pending', 'completed']) {
    try {
      fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
    } catch {}
  }
}
