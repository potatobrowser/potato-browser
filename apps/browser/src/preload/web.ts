import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron';
import { AdblockCosmetics, type CosmeticsStart } from '../content/adblock/cosmetics';
import { adapterFor } from '../content/flags/adapters';
import { facebookPageWorldHelper, FB_HELPER_ARGS } from '../content/flags/adapters/facebook';
import { FlagsEngine } from '../content/flags/engine';
import { setOpenShadowRoots } from '../content/flags/ui';
import type { FlagsBridge } from '../content/flags/types';
import { ShieldEngine } from '../content/shield/engine';
import { GOOGLE_SIGNIN_HOSTS, GOOGLE_SIGNIN_UA } from '../shared/constants';
import type { PageConfig } from '../shared/types';

/** Internal potato:// pages get a small promise-based API; everything is validated in main. */
function exposeInternalApi(): void {
  contextBridge.exposeInMainWorld('potato', {
    call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('potato:api', method, ...args),
    onEvent: (cb: (e: { type: string }) => void) => {
      const l = (_e: IpcRendererEvent, ev: { type: string }) => cb(ev);
      ipcRenderer.on('potato:event', l);
      return () => ipcRenderer.off('potato:event', l);
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
    config = ipcRenderer.sendSync('page:config') as PageConfig;
  } catch {
    return;
  }
  if (!config) return;
  let current: PageConfig = config;
  setOpenShadowRoots(config.testHooks);

  // First, so scriptlets run before any page script.
  let cosmetics: AdblockCosmetics | null = null;
  const startAdblock = (late: boolean) => {
    if (cosmetics || !current.adblock.enabled) return;
    const first = ipcRenderer.sendSync('page:adblock') as CosmeticsStart | null;
    if (!first) return;
    // Scriptlets only make sense before page scripts run; a late start gets the styles.
    if (late) first.scripts = [];
    cosmetics = new AdblockCosmetics({
      insertCSS: (css) => webFrame.insertCSS(css, { cssOrigin: 'user' }),
      removeCSS: (key) => webFrame.removeInsertedCSS(key),
      runScript: (code) => void webFrame.executeJavaScript(code).catch(() => {}),
      domRules: (dom) => ipcRenderer.invoke('page:adblock-dom', dom),
    });
    cosmetics.start(first);
  };
  try {
    startAdblock(false);
  } catch {}

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
  // A failure here must not stop the config listener below from being registered.
  try {
    if (shield.active) shield.apply(current.shield);
  } catch {}

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
  try {
    startFlags();
  } catch {}

  ipcRenderer.on('page:config', (_e, next: PageConfig) => {
    current = next;
    if (cosmetics && !next.adblock.enabled) {
      cosmetics.stop();
      cosmetics = null;
    } else if (!cosmetics && next.adblock.enabled) {
      try {
        startAdblock(true);
      } catch {}
    }
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

if (location.protocol === 'potato:') {
  if (window === window.top) exposeInternalApi();
} else if (location.protocol === 'http:' || location.protocol === 'https:') {
  startWebPage();
}
