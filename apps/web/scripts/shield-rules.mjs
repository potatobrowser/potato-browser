// Writes src/generated/shield-rules.json: the AI Shield rules for the daily update, signed.
//   --sign  signs with the release key (POTATO_SHIELD_KEY, else
//           ~/.config/potatobrowser/shield-rules-ed25519.pem) and fails without it, so a deploy
//           never ships rules the apps would refuse.
// Without --sign a throwaway key signs them and its public key goes in the file as `testKey`,
// for the Worker tests and the e2e suites (the apps accept it only in test mode).
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadShieldRules, STALE_MESSAGE } from '../../browser/scripts/shield-rules.mjs';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'src', 'generated', 'shield-rules.json');
const sign = process.argv.includes('--sign');

const r = await loadShieldRules(build, root);
// The apps would refuse rules that fail their validator; never sign them.
if (!r.valid) {
  console.error('The AI Shield rules do not pass apps/browser/src/content/shield/validate.ts.');
  process.exit(1);
}
if (r.stale) {
  // A deploy must carry a version the apps can order; tests and wrangler dev only warn.
  console.error(STALE_MESSAGE);
  if (sign) process.exit(1);
}
const payload = JSON.stringify({ format: r.format, version: r.version, hash: r.hash, rules: r.rules });
const rawPublic = (key) => Buffer.from(crypto.createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64');

let key;
let testKey = null;
if (sign) {
  const file = process.env.POTATO_SHIELD_KEY || path.join(os.homedir(), '.config', 'potatobrowser', 'shield-rules-ed25519.pem');
  if (!fs.existsSync(file)) {
    console.error(`No AI Shield signing key at ${file}: the apps would refuse unsigned rules, so nothing is deployed.`);
    process.exit(1);
  }
  key = crypto.createPrivateKey(fs.readFileSync(file));
  if (!r.keys.includes(rawPublic(key))) {
    console.error(`The key at ${file} is not one of SHIELD_RULES_KEYS in packages/shared.`);
    process.exit(1);
  }
} else {
  key = crypto.generateKeyPairSync('ed25519').privateKey;
  testKey = rawPublic(key);
}
const signature = crypto.sign(null, Buffer.from(payload), key).toString('base64');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ version: r.version, hash: r.hash, payload, signature, ...(testKey ? { testKey } : {}) }));
console.log(`AI Shield rules ${r.hash.slice(0, 12)} (version ${r.version}, ${r.rules.length} rules) ${sign ? 'signed' : 'signed with a test key'}`);
