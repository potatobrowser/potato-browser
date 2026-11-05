import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron';
import { adapterFor } from '../content/flags/adapters';
import { facebookPageWorldHelper, FB_HELPER_ARGS } from '../content/flags/adapters/facebook';
import { FlagsEngine } from '../content/flags/engine';
import type { FlagsBridge } from '../content/flags/types';
import { ShieldEngine } from '../content/shield/engine';
import { GOOGLE_SIGNIN_HOSTS, GOOGLE_SIGNIN_UA } from '../shared/constants';
import type { PageConfig } from '../shared/types';

/** Internal noai:// pages get a small promise-based API; everything is validated in main. */
function exposeInternalApi(): void {
  contextBridge.exposeInMainWorld('noai', {
    call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('noai:api', method, ...args),
    onEvent: (cb: (e: { type: string }) => void) => {
      const l = (_e: IpcRendererEvent, ev: { type: string }) => cb(ev);
      ipcRenderer.on('noai:event', l);
      return () => ipcRenderer.off('noai:event', l);
    },
  });
}

/** Google blocks sign-in from browsers it can't identify; on its account pages we look like Firefox. */
function spoofFirefoxNavigator(): void {
  contextBridge.executeInMainWorld({
    func: (ua: string) => {
      const define = (prop: string, value: unknown) => {
        try {
          Object.defineProperty(Navigator.prototype, prop, { get: () => value, configurable: true });
        } catch {}
      };
      define('userAgent', ua);
      define('appVersion', '5.0 (Macintosh)');
      define('vendor', '');
      define('userAgentData', undefined);
      define('platform', 'MacIntel');
    },
    args: [GOOGLE_SIGNIN_UA],
  });
}

function startWebPage(): void {
  let config: PageConfig | null = null;
  try {
    config = ipcRenderer.sendSync('page:config', location.href) as PageConfig;
  } catch {
    return;
  }
  if (!config) return;
  let current: PageConfig = config;

  if (GOOGLE_SIGNIN_HOSTS.includes(location.hostname)) spoofFirefoxNavigator();

  const shield = new ShieldEngine(
    {
      insertCSS: (css) => webFrame.insertCSS(css, { cssOrigin: 'user' }),
      removeCSS: (key) => webFrame.removeInsertedCSS(key),
      report: (r) => ipcRenderer.send('page:shield-report', r),
    },
    location.hostname,
    location.pathname,
  );
  if (shield.active) shield.apply(current.shield);

  const isTop = window === window.top;
  const adapter = isTop ? adapterFor(location.hostname) : null;
  const bridge: FlagsBridge = {
    lookup: (keys, localOnly) => ipcRenderer.invoke('page:flags-lookup', keys, localOnly),
    set: (keys, flag) => ipcRenderer.invoke('page:flags-set', keys, flag),
    report: (r) => ipcRenderer.send('page:flags-report', r),
    insertCSS: (css) => webFrame.insertCSS(css, { cssOrigin: 'user' }),
    removeCSS: (key) => webFrame.removeInsertedCSS(key),
  };
  let flags: FlagsEngine | null = null;
  const flagConfig = () => ({ mode: current.flags.mode, threshold: current.flags.threshold, showButtons: current.flags.showButtons });
  const flagsAllowed = () => !!adapter && current.flags.enabled && !current.flags.disabledPlatforms.includes(adapter.platform);
  let helperInstalled = false;
  const startFlags = () => {
    if (!adapter || flags || !flagsAllowed()) return;
    flags = new FlagsEngine(adapter, bridge, flagConfig());
    flags.start();
    if (adapter.platform === 'facebook' && !helperInstalled) {
      helperInstalled = true;
      contextBridge.executeInMainWorld({ func: facebookPageWorldHelper, args: [...FB_HELPER_ARGS] });
    }
  };
  startFlags();

  ipcRenderer.on('page:config', (_e, next: PageConfig) => {
    current = next;
    if (shield.active) shield.apply(next.shield);
    if (flags && !flagsAllowed()) {
      flags.stop();
      flags = null;
    } else if (flags) {
      flags.update(flagConfig());
    } else {
      startFlags();
    }
  });
}

if (location.protocol === 'noai:') {
  if (window === window.top) exposeInternalApi();
} else if (location.protocol === 'http:' || location.protocol === 'https:') {
  startWebPage();
}
