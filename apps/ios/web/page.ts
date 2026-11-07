/**
 * Page world script (every frame, document start, before page scripts): removes AI web APIs,
 * adds the Global Privacy Control signal and, on Facebook, the helper that finds post ids.
 * The app writes the options in for `__POTATO_OPTS__` when it installs the script.
 */
import { facebookPageWorldHelper, FB_HELPER_ARGS } from '../../browser/src/content/flags/adapters/facebook';
import { AI_GLOBALS, AI_NAVIGATOR_PROPS } from './ai';

interface PageOptions {
  gpc: boolean;
  facebook: boolean;
}

declare const __POTATO_OPTS__: PageOptions;
const opts = __POTATO_OPTS__;

const scrubbed = new WeakSet<object>();

function scrub(w: Window & typeof globalThis): void {
  if (scrubbed.has(w)) return;
  scrubbed.add(w);
  for (const name of AI_GLOBALS) {
    try {
      if (name in w) delete (w as unknown as Record<string, unknown>)[name];
    } catch {}
  }
  for (const prop of AI_NAVIGATOR_PROPS) {
    try {
      if (prop in w.Navigator.prototype) delete (w.Navigator.prototype as unknown as Record<string, unknown>)[prop];
    } catch {}
  }
}

scrub(window);

// Frames the app's scripts never reach (about:blank, srcdoc) are scrubbed when a page opens them.
try {
  const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  if (desc?.get) {
    const get = new Proxy(desc.get, {
      apply(target, self, args) {
        const w = Reflect.apply(target, self, args) as (Window & typeof globalThis) | null;
        try {
          if (w && w.location.href !== undefined) scrub(w);
        } catch {}
        return w;
      },
    });
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { ...desc, get });
  }
} catch {}

if (opts.gpc) {
  try {
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true, enumerable: true });
  } catch {}
}

if (opts.facebook && window === window.top && /(^|\.)facebook\.com$/.test(location.hostname)) {
  try {
    facebookPageWorldHelper(...FB_HELPER_ARGS);
  } catch {}
}
