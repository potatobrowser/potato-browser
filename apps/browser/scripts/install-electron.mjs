// Electron 45 no longer downloads its binary on install; fetch it unless a caller opts out
// (the web deploy only needs the worker toolchain).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.log('install-electron: skipped (ELECTRON_SKIP_BINARY_DOWNLOAD)');
  process.exit(0);
}
const require = createRequire(import.meta.url);
const script = require.resolve('electron/install.js');
const r = spawnSync(process.execPath, [script], { stdio: 'inherit' });
process.exit(r.status ?? 1);
