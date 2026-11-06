// Production build + electron-builder.
// Usage: node scripts/dist.mjs [--test] [--arch arm64|x64|host]   (default: both DMGs)
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const test = args.includes('--test');
const archArg = args.includes('--arch') ? args[args.indexOf('--arch') + 1] : undefined;
const arch = archArg === 'host' ? process.arch : archArg;
if (arch !== undefined && arch !== 'arm64' && arch !== 'x64') throw new Error(`--arch must be arm64, x64 or host, not ${archArg}`);
const env = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  ...(test ? { POTATO_TEST_BUILD: '1' } : {}),
  ...(arch ? { POTATO_ARCH: arch } : {}),
};
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env });

run(process.execPath, ['scripts/build.mjs', '--prod']);
run(path.join(root, 'node_modules/.bin/electron-builder'), ['--config', 'electron-builder.config.cjs', '--mac', '--publish', 'never']);
