// Notarizes a signed .app or .dmg with Apple and staples the ticket. The staple is retried: Apple's
// ticket service drops connections from CI runners now and then (NSURLError -1005), which fails a
// one-shot staple even though notarization succeeded.
// electron-builder runs it after signing each app (afterSign); the release workflow runs it on the
// DMGs: node scripts/notarize.cjs <file>...   Needs APPLE_API_KEY (.p8 path), APPLE_API_KEY_ID and
// APPLE_API_ISSUER.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function credentials() {
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
  return key && keyId && issuer ? ['--key', key, '--key-id', keyId, '--issuer', issuer] : null;
}

async function notarize(file) {
  const creds = credentials();
  if (!creds) throw new Error('APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are needed to notarize');
  const name = path.basename(file);
  // notarytool takes apps as a zip; DMGs as they are.
  const upload = file.endsWith('.app') ? `${file}.zip` : file;
  if (upload !== file) execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', file, upload]);
  try {
    console.log(`notarizing ${name}`);
    const out = execFileSync('xcrun', ['notarytool', 'submit', upload, ...creds, '--wait', '--timeout', '45m', '--output-format', 'json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const res = JSON.parse(out);
    if (res.status !== 'Accepted') {
      let log = '';
      try {
        log = execFileSync('xcrun', ['notarytool', 'log', res.id, ...creds], { encoding: 'utf8' });
      } catch {}
      throw new Error(`notarization of ${name} ended ${res.status} (${res.id})\n${log}`);
    }
    console.log(`notarized ${name} (${res.id})`);
  } finally {
    if (upload !== file) fs.rmSync(upload, { force: true });
  }
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('xcrun', ['stapler', 'staple', file], { stdio: ['ignore', 'ignore', 'inherit'] });
      console.log(`stapled ${name}`);
      return;
    } catch (err) {
      if (attempt >= 6) throw err;
      console.log(`stapling ${name} failed (attempt ${attempt}), retrying in ${attempt * 20}s`);
      await sleep(attempt * 20_000);
    }
  }
}

/** electron-builder afterSign hook: only for builds signed with a Developer ID and given a key. */
module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin' || !process.env.CSC_LINK || !credentials()) return;
  await notarize(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
};

if (require.main === module) {
  (async () => {
    for (const file of process.argv.slice(2)) await notarize(file);
  })().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
