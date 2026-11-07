import { DOMMonitor, type IMessageFromBackground } from '@ghostery/adblocker-content';
import { handlePseudoDirective, querySelectorAll } from '@ghostery/adblocker-extended-selectors';

type Extended = IMessageFromBackground['extended'][number];

export interface CosmeticsStart {
  styles: string;
  scripts: string[];
  extended: Extended[];
}

export interface CosmeticsHost {
  insertCSS(css: string): string;
  removeCSS(key: string): void;
  /** Runs a scriptlet in the page's own world, before page scripts. */
  runScript(code: string): void;
  /** Generic hiding rules for newly seen ids, classes and links. */
  domRules(dom: { classes: string[]; ids: string[]; hrefs: string[] }): Promise<string>;
}

/**
 * Ad blocker cosmetics in one frame: hostname rules and scriptlets at document start, generic
 * rules as ids and classes appear, and procedural selectors (`:has-text`, `:upward`, ...).
 * Modeled on @ghostery/adblocker-webextension-cosmetics.
 */
export class AdblockCosmetics {
  private keys: string[] = [];
  private monitor: DOMMonitor | null = null;
  private extended: Extended[] = [];
  private hidden = new Map<Element, Extended>();
  private pending = new Set<Element>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;

  constructor(private readonly host: CosmeticsHost) {}

  start(first: CosmeticsStart): void {
    this.active = true;
    this.addStyles(first.styles);
    for (const code of first.scripts) {
      try {
        this.host.runScript(code);
      } catch {}
    }
    this.extended = first.extended ?? [];
    const attrs = [...new Set(this.extended.map((e) => e.attribute).filter((a): a is string => !!a))];
    if (attrs.length) this.addStyles(attrs.map((a) => `[${a}] { display: none !important; }`).join('\n'));

    const begin = () => {
      if (!this.active) return;
      this.monitor = new DOMMonitor((update) => {
        if (!this.active) return;
        if (update.type === 'elements') this.queueExtended(update.elements);
        else void this.host.domRules(update).then((css) => this.active && this.addStyles(css)).catch(() => {});
      });
      this.monitor.queryAll(window);
      this.monitor.start(window);
    };
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', begin, { once: true, passive: true });
    else begin();
  }

  stop(): void {
    this.active = false;
    this.monitor?.stop();
    this.monitor = null;
    for (const k of this.keys) this.host.removeCSS(k);
    this.keys = [];
    for (const [el, sel] of this.hidden) if (sel.attribute) el.removeAttribute(sel.attribute);
    this.hidden.clear();
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private addStyles(css: string): void {
    if (css) this.keys.push(this.host.insertCSS(css));
  }

  private queueExtended(elements: Element[]): void {
    if (!this.extended.length || this.pending.has(document.documentElement)) return;
    for (const el of elements) {
      if (el === document.documentElement) {
        this.pending.clear();
        this.pending.add(el);
        break;
      }
      this.pending.add(el);
    }
    // Batched: pages that mutate constantly are checked a few times a second, not per change.
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.applyExtended();
    }, 250);
  }

  private applyExtended(): void {
    if (!this.active) return;
    const roots = [...this.pending].filter((e) => e.isConnected);
    this.pending.clear();
    for (const root of roots) {
      for (const sel of this.extended) {
        let matches: Element[];
        try {
          matches = querySelectorAll(root, sel.ast);
        } catch {
          continue;
        }
        for (const el of matches) {
          if (sel.directive) {
            try {
              handlePseudoDirective(el, sel.directive);
            } catch {}
          } else if (sel.attribute && !this.hidden.has(el)) {
            el.setAttribute(sel.attribute, '');
            this.hidden.set(el, sel);
          }
        }
      }
    }
    for (const [el, sel] of [...this.hidden]) {
      if (!el.isConnected) this.hidden.delete(el);
      else if (sel.attribute && !el.hasAttribute(sel.attribute)) this.hidden.delete(el);
    }
  }
}
