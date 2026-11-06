// Production build + electron-builder. Usage: node scripts/dist.mjs [--test]
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const test = process.argv.includes('--test');
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...(test ? { POTATO_TEST_BUILD: '1' } : {}) };
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env });

run(process.execPath, ['scripts/build.mjs', '--prod']);
run(path.join(root, 'node_modules/.bin/electron-builder'), ['--config', 'electron-builder.config.cjs', '--mac', '--publish', 'never']);
