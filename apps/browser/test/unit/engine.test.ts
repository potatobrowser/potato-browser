import { beforeAll, describe, expect, it, vi } from 'vitest';

const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PotatoBrowser/0.7.0 Chrome/156.0.8078.80 Electron/45.2.3 Safari/537.36';
const app = vi.hoisted(() => ({ userAgentFallback: '' }));
vi.mock('electron', () => ({ app }));

import { applyUserAgent, chromeUserAgent, googleSignInUserAgent } from '../../src/main/engine';

describe('user agents', () => {
  beforeAll(() => {
    (process.versions as Record<string, string>).chrome ??= '156.0.8078.80';
    app.userAgentFallback = ELECTRON_UA;
    applyUserAgent();
  });

  it('presents a plain Chrome UA by default', () => {
    expect(app.userAgentFallback).toBe(chromeUserAgent());
    expect(app.userAgentFallback).not.toMatch(/Electron|Potato/);
  });

  it("gives Google's sign-in hosts Electron's own UA, nothing else", () => {
    expect(googleSignInUserAgent('https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn')).toBe(ELECTRON_UA);
    expect(googleSignInUserAgent('https://accounts.youtube.com/accounts/SetSID')).toBe(ELECTRON_UA);
    for (const url of ['https://www.google.com/', 'https://mail.google.com/', 'https://accounts.google.com.evil.test/', 'https://youtube.com/', 'not a url']) {
      expect(googleSignInUserAgent(url), url).toBeNull();
    }
  });
});
