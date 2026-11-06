import { contentKey } from '@potato/shared';
import type { FlagMode } from '../../shared/types';
import { BUTTON_TAG, createButton, createPlaceholder, PLACEHOLDER_TAG, type FlagButton } from './ui';
import type { FlagAdapter, FlagsBridge, FlagStatus } from './types';

export const FLAG_ATTR = 'data-potato-flag';

export interface FlagsConfig {
  mode: FlagMode;
  threshold: number;
  showButtons: boolean;
}

interface Item {
  /** Primary key first, then aliases. */
  keys: string[];
  button: FlagButton | null;
  placeholder: HTMLElement | null;
  revealed: boolean;
  busy: boolean;
  error: boolean;
}

const CSS = `
[${FLAG_ATTR}="hidden"] { display: none !important; }
[${FLAG_ATTR}="label"] { outline: 2px solid rgba(217, 119, 6, .75) !important; outline-offset: -2px !important; border-radius: 8px; }
`;

/** Finds posts with the platform adapter, injects flag buttons and applies hide/label modes. */
export class FlagsEngine {
  private items = new Map<Element, Item>();
  private status = new Map<string, FlagStatus>();
  private queued = new Set<string>();
  private config: FlagsConfig;
  private cssKey: string | null = null;
  private observer: MutationObserver | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private lookupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReport = '';
  private running = false;
  private lastHref = location.href;
  /** Bumped when the user flags/unflags a key, so older lookup answers cannot overwrite it. */
  private epoch = new Map<string, number>();

  constructor(
    private readonly adapter: FlagAdapter,
    private readonly bridge: FlagsBridge,
    config: FlagsConfig,
  ) {
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.cssKey = this.bridge.insertCSS(CSS);
    const boot = () => {
      this.observer = new MutationObserver((records) => {
        // Ignore mutations caused by our own buttons and placeholders.
        const ours = records.every(
          (r) =>
            r.type === 'childList' &&
            [...r.addedNodes, ...r.removedNodes].every(
              (n) => n instanceof Element && (n.localName === BUTTON_TAG || n.localName === PLACEHOLDER_TAG),
            ),
        );
        if (!ours) this.scheduleScan(150);
      });
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'id', 'thingid', 'data-thingid', 'componentkey', 'video-id', 'data-potato-fbid'],
      });
      this.scheduleScan(0);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
    // SPAs change pages with pushState, sometimes without any DOM mutation.
    setInterval(() => {
      // The full URL: YouTube changes videos with ?v= alone.
      if (location.href !== this.lastHref) {
        this.lastHref = location.href;
        this.scheduleScan(0);
        setTimeout(() => this.scheduleScan(0), 800);
      }
    }, 500);
  }

  stop(): void {
    this.running = false;
    this.observer?.disconnect();
    this.observer = null;
    if (this.cssKey) this.bridge.removeCSS(this.cssKey);
    this.cssKey = null;
    for (const [el, item] of this.items) this.detach(el, item);
    this.items.clear();
    this.report();
  }

  update(config: FlagsConfig): void {
    const needLookups = config.mode !== 'ignore' && this.config.mode === 'ignore';
    this.config = config;
    if (needLookups) for (const item of this.items.values()) item.keys.forEach((k) => this.queue(k));
    for (const [el, item] of this.items) this.render(el, item);
    this.report();
  }

  private scheduleScan(delay: number): void {
    if (this.scanTimer || !this.running) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, delay);
  }

  /** Exposed for tests. */
  scan(): void {
    const seen = new Set<Element>();
    for (const el of this.adapter.items(document)) {
      let raw: string | string[] | null = null;
      try {
        raw = this.adapter.id(el);
      } catch {}
      const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean);
      if (!ids.length) continue;
      seen.add(el);
      const keys = [...new Set(ids.map((id) => contentKey(this.adapter.platform, id)))];
      let item = this.items.get(el);
      if (!item || item.keys[0] !== keys[0]) {
        // A recycled element (virtualized feeds) now shows a different post.
        if (item) this.detach(el, item);
        item = { keys, button: null, placeholder: null, revealed: false, busy: false, error: false };
        this.items.set(el, item);
        keys.forEach((k) => this.queue(k));
      } else if (keys.some((k) => !item!.keys.includes(k))) {
        keys.filter((k) => !item!.keys.includes(k)).forEach((k) => this.queue(k));
        item.keys = [...new Set([...item.keys, ...keys])];
      }
      try {
        this.render(el, item);
      } catch {}
    }
    for (const [el, item] of this.items) {
      if (!seen.has(el) && !el.isConnected) {
        item.placeholder?.remove();
        this.items.delete(el);
      }
    }
    this.report();
  }

  private queue(key: string): void {
    this.queued.add(key);
    if (this.lookupTimer) return;
    this.lookupTimer = setTimeout(() => void this.flushLookups(), 250);
  }

  private async flushLookups(): Promise<void> {
    this.lookupTimer = null;
    const keys = [...this.queued];
    this.queued.clear();
    if (!keys.length) return;
    const started = new Map(keys.map((k) => [k, this.epoch.get(k) ?? 0]));
    try {
      const result = await this.bridge.lookup(keys, this.config.mode === 'ignore');
      for (const [k, v] of Object.entries(result)) {
        if ((this.epoch.get(k) ?? 0) === started.get(k)) this.status.set(k, v);
      }
    } catch {
      return;
    }
    for (const [el, item] of this.items) if (item.keys.some((k) => keys.includes(k))) this.render(el, item);
    this.report();
  }

  /** Combined status of all keys of an item. */
  private statusOf(item: Item): FlagStatus | undefined {
    let s: FlagStatus | undefined;
    for (const k of item.keys) {
      const v = this.status.get(k);
      if (!v) continue;
      s = s ? { n: Math.max(s.n, v.n), mine: s.mine || v.mine } : { ...v };
    }
    return s;
  }

  private flagged(s: FlagStatus | undefined): boolean {
    if (!s) return false;
    return s.mine || (this.config.mode !== 'ignore' && s.n >= this.config.threshold);
  }

  private render(el: Element, item: Item): void {
    const s = this.statusOf(item);
    const target = this.adapter.hideTarget?.(el) ?? el;
    const flagged = this.flagged(s);
    const mode = this.config.mode;

    if (this.config.showButtons || (flagged && mode !== 'ignore')) {
      if (!item.button) item.button = createButton(() => void this.toggle(el, item));
      if (!item.button.host.isConnected || !el.contains(item.button.host)) {
        const mount = this.adapter.mount(el);
        if (mount) mount.parent.insertBefore(item.button.host, mount.before?.parentNode === mount.parent ? mount.before : null);
        else el.prepend(item.button.host);
      }
      const n = s?.n ?? 0;
      const state = item.busy ? 'busy' : item.error ? 'error' : s?.mine ? 'mine' : flagged ? 'flagged' : 'idle';
      item.button.set(state, mode === 'ignore' && !s?.mine ? 0 : n, this.config.threshold);
    } else if (item.button) {
      item.button.host.remove();
      item.button = null;
    }

    const hide = flagged && mode === 'hide' && !item.revealed;
    const label = flagged && (mode === 'label' || (mode === 'hide' && item.revealed));
    const value = hide ? 'hidden' : label ? 'label' : null;
    if (value) target.setAttribute(FLAG_ATTR, value);
    else target.removeAttribute(FLAG_ATTR);

    if (hide) {
      if (!item.placeholder || item.placeholder.nextElementSibling !== target) {
        item.placeholder?.remove();
        item.placeholder = createPlaceholder(s?.n ?? 1, !!s?.mine, () => {
          item.revealed = true;
          this.render(el, item);
          this.report();
        });
        target.parentNode?.insertBefore(item.placeholder, target);
      }
    } else if (item.placeholder) {
      item.placeholder.remove();
      item.placeholder = null;
    }
  }

  private detach(el: Element, item: Item): void {
    item.button?.host.remove();
    item.placeholder?.remove();
    (this.adapter.hideTarget?.(el) ?? el).removeAttribute(FLAG_ATTR);
  }

  private async toggle(el: Element, item: Item): Promise<void> {
    const flag = !this.statusOf(item)?.mine;
    for (const k of item.keys) this.epoch.set(k, (this.epoch.get(k) ?? 0) + 1);
    item.busy = true;
    item.error = false;
    this.render(el, item);
    try {
      const result = await this.bridge.set(item.keys, flag);
      for (const [k, v] of Object.entries(result)) this.status.set(k, v);
      // Flagging something you're looking at should not make it vanish under your cursor.
      if (flag) item.revealed = true;
    } catch {
      item.error = true;
      setTimeout(() => {
        item.error = false;
        this.render(el, item);
      }, 2500);
    } finally {
      item.busy = false;
    }
    for (const [e2, it2] of this.items) if (it2.keys.some((k) => item.keys.includes(k))) this.render(e2, it2);
    this.report();
  }

  private report(): void {
    let hidden = 0;
    let labeled = 0;
    const counted = new Set<string>();
    for (const item of this.items.values()) {
      if (counted.has(item.keys[0]!)) continue;
      counted.add(item.keys[0]!);
      const s = this.statusOf(item);
      if (!this.flagged(s)) continue;
      if (this.config.mode === 'hide' && !item.revealed) hidden++;
      else labeled++;
    }
    const key = `${hidden}|${labeled}`;
    if (key === this.lastReport) return;
    this.lastReport = key;
    this.bridge.report({ platform: this.adapter.platform, hidden, labeled });
  }
}

export { BUTTON_TAG, PLACEHOLDER_TAG };
