// Manual check of WebAuthn and passkeys in the real browser on a plain https page: which
// authenticators Chromium in Electron offers on this Mac. Usage: node test/live/webauthn-check.mjs
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-webauthn-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ firstRunDone: true, startup: 'newtab' }));
const app = await electron.launch({ args: ['.'], env: { ...process.env, POTATO_USER_DATA: userData, POTATO_TEST: '1' } });
await app.firstWindow();
await app.evaluate(() => globalThis.__potato.ctx.windows.focused().activeTab.navigate('https://example.com/'));
await new Promise((r) => setTimeout(r, 6000));
const page = app.windows().find((p) => p.url().startsWith('https://example.com'));
const result = await page.evaluate(async () => {
  const out = { secure: window.isSecureContext, hasAPI: 'PublicKeyCredential' in window };
  try {
    out.platformAuthenticator = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (e) {
    out.platformAuthenticator = String(e);
  }
  try {
    out.conditionalMediation = await PublicKeyCredential.isConditionalMediationAvailable?.();
  } catch (e) {
    out.conditionalMediation = String(e);
  }
  try {
    out.capabilities = await PublicKeyCredential.getClientCapabilities?.();
  } catch (e) {
    out.capabilities = String(e);
  }
  // A platform passkey (Touch ID / iCloud Keychain): what happens without any user present.
  const create = (attachment) =>
    Promise.race([
      navigator.credentials
        .create({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rp: { name: 'example', id: 'example.com' },
            user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'potato-check', displayName: 'Potato check' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { authenticatorAttachment: attachment, residentKey: 'required', userVerification: 'required' },
            timeout: 8000,
          },
        })
        .then((c) => 'created ' + c?.type, (e) => `${e.name}: ${e.message}`),
      new Promise((r) => setTimeout(() => r('no answer in 10 s'), 10000)),
    ]);
  out.createPlatform = await create('platform');
  out.createCrossPlatform = await create('cross-platform');
  return out;
});
console.log(JSON.stringify(result, null, 2));
await app.close();
