// Electron 45 no longer downloads its binary on install; fetch it unless a caller opts out
// (the web deploy only needs the worker toolchain).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.log('install-electron: skipped (ELECTRON_SKIP_BINARY_DOWNLOAD)');
  process.exit(0);
}
const require = createRequire(import.meta.url);
const script = require.resolve('electron/install.js');
// GitHub release downloads fail with 5xx now and then.
const waits = [10, 30, 60];
let status = 1;
for (let attempt = 0; ; attempt++) {
  status = spawnSync(process.execPath, [script], { stdio: 'inherit' }).status ?? 1;
  if (status === 0 || attempt === waits.length) break;
  console.log(`install-electron: download failed, retrying in ${waits[attempt]}s`);
  await sleep(waits[attempt] * 1000);
}
process.exit(status);
