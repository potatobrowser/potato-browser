// The AI Shield catalog (src/content/shield/rules.ts) as data: its canonical JSON, hash and
// version. The app builds bundle it; the site deploy signs it for the daily rule updates. Both
// derive the version from git, so the same rules always carry the same version.
// Only Node built-ins here: the site deploy installs apps/web alone and passes its own esbuild.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export const RULES_TS = path.join(root, 'src/content/shield/rules.ts');

/** Seconds of the last commit that touched the rules (in a shallow clone, HEAD's), else now. */
function rulesVersion() {
  for (const args of [
    ['log', '-1', '--format=%ct', '--', RULES_TS],
    ['log', '-1', '--format=%ct'],
  ]) {
    try {
      const s = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^\d+$/.test(s)) return Number(s);
    } catch {}
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * `build` is esbuild's, `resolveDir` a package that depends on @potato/shared.
 * Returns { rules, json, hash, version, format, keys }.
 */
export async function loadShieldRules(build, resolveDir) {
  const out = await build({
    stdin: {
      contents: `export { RULES } from ${JSON.stringify(RULES_TS)};\nexport { SHIELD_RULES_FORMAT, SHIELD_RULES_KEYS } from '@potato/shared';`,
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
  return {
    rules: mod.RULES,
    json,
    hash: crypto.createHash('sha256').update(json).digest('hex'),
    version: rulesVersion(),
    format: mod.SHIELD_RULES_FORMAT,
    keys: mod.SHIELD_RULES_KEYS,
  };
}
