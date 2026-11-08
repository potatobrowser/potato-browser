/**
 * Content world script ("potato" WKContentWorld, every frame, document start): the Mac app's
 * in-page engines (AI Shield, flags, ad blocker cosmetics) with a WebKit bridge instead of
 * Electron IPC. Page scripts cannot see this world, its variables or its message handler.
 *
 * The app installs a config script before this one on every main-frame navigation
 * (`window.__potatoConfig`), because WKWebView has no synchronous IPC to ask at document start.
 */
import { AdblockCosmetics, type CosmeticsStart } from '../../browser/src/content/adblock/cosmetics';
import { adapterFor } from '../../browser/src/content/flags/adapters';
import { FlagsEngine } from '../../browser/src/content/flags/engine';
import type { FlagsBridge, FlagStatus } from '../../browser/src/content/flags/types';
import { setOpenShadowRoots } from '../../browser/src/content/flags/ui';
import { ShieldEngine } from '../../browser/src/content/shield/engine';
import { validateRules } from '../../browser/src/content/shield/validate';
import type { PageConfig } from '../../browser/src/shared/types';
import { Styles } from './styles';

export interface IosPageConfig extends PageConfig {
  /** Hostname of the top-level page the config was made for. */
  host: string;
  /** Ad blocker cosmetics for that page's main frame (its scriptlets run in the page world). */
  cosmetics: CosmeticsStart | null;
}

interface Bridge {
  postMessage(message: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    __potatoConfig?: IosPageConfig;
    /** A signed AI Shield rule update, when the app has one (checked again here). */
    __potatoShieldRules?: unknown;
    __potatoApply?: (config: IosPageConfig) => void;
    webkit?: { messageHandlers?: Record<string, Bridge | undefined> };
  }
}

const bridge = window.webkit?.messageHandlers?.potato;

function call<T>(type: string, data: Record<string, unknown> = {}): Promise<T> {
  if (!bridge) return Promise.reject(new Error('no bridge'));
  return bridge.postMessage({ type, ...data }) as Promise<T>;
}

function send(type: string, data: Record<string, unknown> = {}): void {
  call(type, data).catch(() => {});
}

const isTop = window === window.top;
const styles = new Styles();

/** Resources whose URLs the app checks against the filters, to count what was blocked. */
const RESOURCE_SELECTOR = 'script[src], img[src], iframe[src], link[href], video[src], audio[src], source[src], embed[src], object[data]';

class ResourceReporter {
  private seen = new Set<string>();
  private queue: { url: string; type: string }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;

  start(): void {
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') this.collect(r.target as Element);
        else for (const n of r.addedNodes) if (n.nodeType === 1) this.scan(n as Element);
      }
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'data'] });
    this.scan(document.documentElement);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private scan(root: Element): void {
    if (root.matches?.(RESOURCE_SELECTOR)) this.collect(root);
    for (const el of root.querySelectorAll?.(RESOURCE_SELECTOR) ?? []) this.collect(el);
  }

  private collect(el: Element): void {
    const tag = el.localName;
    let raw: string | null = null;
    let type = 'other';
    if (tag === 'script') [raw, type] = [el.getAttribute('src'), 'script'];
    else if (tag === 'img') [raw, type] = [el.getAttribute('src'), 'image'];
    else if (tag === 'iframe') [raw, type] = [el.getAttribute('src'), 'sub_frame'];
    else if (tag === 'link') {
      const rel = (el.getAttribute('rel') ?? '').toLowerCase();
      if (!/stylesheet|preload|prefetch|modulepreload/.test(rel)) return;
      raw = el.getAttribute('href');
      const as = el.getAttribute('as');
      type = rel.includes('stylesheet') || as === 'style' ? 'stylesheet' : as === 'script' || rel === 'modulepreload' ? 'script' : as === 'image' ? 'image' : as === 'font' ? 'font' : 'other';
    } else if (tag === 'video' || tag === 'audio' || tag === 'source') [raw, type] = [el.getAttribute('src'), 'media'];
    else if (tag === 'embed' || tag === 'object') [raw, type] = [el.getAttribute(tag === 'embed' ? 'src' : 'data'), 'object'];
    if (!raw) return;
    let url: string;
    try {
      url = new URL(raw, document.baseURI).href;
    } catch {
      return;
    }
    if (!/^(https?|wss?):/.test(url) || this.seen.has(url) || this.seen.size > 3000) return;
    this.seen.add(url);
    this.queue.push({ url, type });
    this.timer ??= setTimeout(() => this.flush(), 500);
  }

  private flush(): void {
    this.timer = null;
    const items = this.queue.splice(0, 300);
    if (items.length) send('resources', { items });
    if (this.queue.length) this.timer = setTimeout(() => this.flush(), 500);
  }
}

function start(config: IosPageConfig): void {
  let current = config;
  setOpenShadowRoots(config.testHooks);

  // Ad blocker cosmetics: the main frame's come with the config, other frames ask.
  let cosmetics: AdblockCosmetics | null = null;
  let reporter: ResourceReporter | null = null;
  const cosmeticHost = {
    insertCSS: (css: string) => styles.insert(css),
    removeCSS: (key: string) => styles.remove(key),
    // Scriptlets are page world user scripts, installed by the app for the main frame.
    runScript: () => {},
    domRules: (dom: { classes: string[]; ids: string[]; hrefs: string[] }) => call<string>('adblockDom', { dom }).then((css) => (typeof css === 'string' ? css : '')),
  };
  const startAdblock = () => {
    if (cosmetics || !current.adblock.enabled) return;
    const begin = (first: CosmeticsStart | null) => {
      if (cosmetics || !current.adblock.enabled) return;
      cosmetics = new AdblockCosmetics(cosmeticHost);
      cosmetics.start({ styles: first?.styles ?? '', scripts: [], extended: first?.extended ?? [] });
    };
    if (isTop && current.host === location.hostname && current.cosmetics) begin(current.cosmetics);
    else call<CosmeticsStart | null>('adblockFrame').then(begin, () => begin(null));
    if (!reporter) {
      reporter = new ResourceReporter();
      if (document.documentElement) reporter.start();
    }
  };
  const stopAdblock = () => {
    cosmetics?.stop();
    cosmetics = null;
    reporter?.stop();
    reporter = null;
  };
  try {
    startAdblock();
  } catch {}

  const shield = new ShieldEngine(
    {
      insertCSS: (css) => styles.insert(css),
      removeCSS: (key) => styles.remove(key),
      report: (r) => send('shield', { count: r.count, features: r.features, delta: r.delta }),
    },
    location.hostname,
    location.pathname,
    validateRules(window.__potatoShieldRules) ?? undefined,
  );
  try {
    if (shield.active) shield.apply(current.shield);
  } catch {}

  const adapter = isTop ? adapterFor(location.hostname) : null;
  const flagsBridge: FlagsBridge = {
    lookup: (keys, localOnly) => call<Record<string, FlagStatus>>('flagsLookup', { keys, localOnly }),
    set: (keys, vote) => call<Record<string, FlagStatus>>('flagsSet', { keys, vote }),
    report: (r) => send('flagsReport', { platform: r.platform, hidden: r.hidden, labeled: r.labeled }),
    insertCSS: (css) => styles.insert(css),
    removeCSS: (key) => styles.remove(key),
  };
  let flags: FlagsEngine | null = null;
  const flagConfig = () => ({ mode: current.flags.mode, threshold: current.flags.threshold, showButtons: current.flags.showButtons });
  const flagsAllowed = () => !!adapter && current.flags.enabled && !current.flags.disabledPlatforms.includes(adapter.platform);
  const startFlags = () => {
    if (!adapter || flags || !flagsAllowed()) return;
    flags = new FlagsEngine(adapter, flagsBridge, flagConfig());
    flags.start();
  };
  try {
    startFlags();
  } catch {}

  // Settings changes from the app (shield or ads switched for the site, flag mode).
  window.__potatoApply = (next) => {
    current = { ...next, host: current.host, cosmetics: current.cosmetics };
    if (cosmetics && !next.adblock.enabled) stopAdblock();
    else if (!cosmetics && next.adblock.enabled) {
      try {
        startAdblock();
      } catch {}
    }
    try {
      if (shield.active) shield.apply(next.shield);
    } catch {}
    if (flags && !flagsAllowed()) {
      flags.stop();
      flags = null;
    } else if (flags) flags.update(flagConfig());
    else startFlags();
  };

  if (!document.documentElement) return;
  // Pages that rebuild their head or reset adopted sheets would drop ours.
  const keepStyles = () => styles.restore();
  document.addEventListener('DOMContentLoaded', keepStyles, { once: true });
  window.addEventListener('load', keepStyles, { once: true });
  setInterval(keepStyles, 2000);
}

function boot(): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  const config = window.__potatoConfig;
  if (config) {
    start(config);
    return;
  }
  // No config (a document the app did not see coming): ask for one.
  call<IosPageConfig | null>('config').then(
    (c) => c && start(c),
    () => {},
  );
}

try {
  boot();
} catch {}
