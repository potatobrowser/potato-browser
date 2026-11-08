// The AI Shield catalog (src/content/shield/rules.ts) as data: its canonical JSON, hash and
// version. The app builds bundle it; the site deploy signs it for the daily rule updates.
// The version lives in src/content/shield/rules.lock.json with the hash it was given for, so the
// apps and the site always agree on it whatever clone they are built from. After changing the
// rules: node apps/browser/scripts/shield-rules.mjs --bump (a unit test fails until then).
// The library part uses only Node built-ins: the site deploy installs apps/web alone and passes
// its own esbuild.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export const RULES_TS = path.join(root, 'src/content/shield/rules.ts');
export const RULES_LOCK = path.join(root, 'src/content/shield/rules.lock.json');
const VALIDATE_TS = path.join(root, 'src/content/shield/validate.ts');

export function readLock() {
  const lock = JSON.parse(fs.readFileSync(RULES_LOCK, 'utf8'));
  if (!Number.isSafeInteger(lock.version) || !/^[0-9a-f]{64}$/.test(lock.hash)) throw new Error(`${RULES_LOCK} is malformed`);
  return lock;
}

/**
 * `build` is esbuild's, `resolveDir` a package that depends on @potato/shared.
 * Returns { rules, json, hash, version, stale, valid, format, keys }; `stale` means the rules
 * changed since the lock was bumped.
 */
export async function loadShieldRules(build, resolveDir) {
  const out = await build({
    stdin: {
      contents: [
        `export { RULES } from ${JSON.stringify(RULES_TS)};`,
        `export { validateRules } from ${JSON.stringify(VALIDATE_TS)};`,
        `export { SHIELD_RULES_FORMAT, SHIELD_RULES_KEYS } from '@potato/shared';`,
      ].join('\n'),
      resolveDir,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'warning',
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  const json = JSON.stringify(mod.RULES);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  const lock = readLock();
  return {
    rules: mod.RULES,
    json,
    hash,
    version: lock.version,
    stale: lock.hash !== hash,
    valid: !!mod.validateRules(JSON.parse(json)),
    format: mod.SHIELD_RULES_FORMAT,
    keys: mod.SHIELD_RULES_KEYS,
  };
}

export const STALE_MESSAGE = 'The AI Shield rules changed since rules.lock.json was bumped: run node apps/browser/scripts/shield-rules.mjs --bump';

// CLI: --bump gives the current rules a new version (newer than any before, the time in seconds).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename) && process.argv.includes('--bump')) {
  const { build } = await import('esbuild');
  const r = await loadShieldRules(build, root);
  if (!r.valid) throw new Error('the rules do not pass src/content/shield/validate.ts');
  if (!r.stale) {
    console.log(`rules.lock.json is current (version ${r.version})`);
  } else {
    const version = Math.max(r.version + 1, Math.floor(Date.now() / 1000));
    fs.writeFileSync(RULES_LOCK, JSON.stringify({ version, hash: r.hash }, null, 2) + '\n');
    console.log(`rules.lock.json: version ${version}, hash ${r.hash.slice(0, 12)}`);
  }
}
